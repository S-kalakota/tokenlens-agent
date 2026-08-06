import {
  HelperProcessController,
  type HelperControllerFailure,
} from './helperController';
import type { HelperDiagnosticMetadata, HelperMessage } from './protocol';
import { estimatePromptByCharacterCount } from '../simpleEstimator';
import type { EstimateViewState } from '../viewState';

const DEFAULT_RENDER_DEBOUNCE_MS = 20;

export interface LiveDraftHelper {
  start(): Promise<void>;
  setActive(active: boolean): boolean;
  requestPermission(): boolean;
  diagnose(): boolean;
  stop(): Promise<void>;
}

export interface LiveDraftHelperCallbacks {
  onMessage: (message: HelperMessage) => void;
  onFailure: (failure: HelperControllerFailure) => void;
}

export interface LiveEstimateCoordinatorDependencies {
  createHelper?: (callbacks: LiveDraftHelperCallbacks) => LiveDraftHelper;
  setTimer?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface LiveEstimateCoordinatorOptions {
  helperPath: string;
  platform: NodeJS.Platform;
  architecture: string;
  enabled: boolean;
  windowFocused: boolean;
  onState: (state: EstimateViewState) => void;
  onDiagnostic?: (metadata: HelperDiagnosticMetadata) => void;
  dependencies?: LiveEstimateCoordinatorDependencies;
  renderDebounceMs?: number;
}

/**
 * Converts privacy-safe helper events into the one TokenLens chip state. The
 * coordinator never receives or retains prompt text.
 */
export class LiveEstimateCoordinator {
  private readonly onState: (state: EstimateViewState) => void;
  private readonly onDiagnostic: (
    metadata: HelperDiagnosticMetadata,
  ) => void;
  private readonly createHelper: (
    callbacks: LiveDraftHelperCallbacks,
  ) => LiveDraftHelper;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (
    timer: ReturnType<typeof setTimeout>,
  ) => void;
  private readonly renderDebounceMs: number;
  private readonly supported: boolean;

  private enabled: boolean;
  private windowFocused: boolean;
  private trusted: boolean | undefined;
  private helper: LiveDraftHelper | undefined;
  private helperStart: Promise<void> | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingState: EstimateViewState | undefined;
  private disposed = false;

  public constructor(options: LiveEstimateCoordinatorOptions) {
    this.onState = options.onState;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.enabled = options.enabled;
    this.windowFocused = options.windowFocused;
    this.supported =
      options.platform === 'darwin' && options.architecture === 'arm64';
    this.renderDebounceMs = options.renderDebounceMs ?? DEFAULT_RENDER_DEBOUNCE_MS;
    if (
      !Number.isSafeInteger(this.renderDebounceMs) ||
      this.renderDebounceMs < 0
    ) {
      throw new RangeError('renderDebounceMs must be a nonnegative integer.');
    }

    this.setTimer =
      options.dependencies?.setTimer ??
      ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer =
      options.dependencies?.clearTimer ?? ((timer) => clearTimeout(timer));
    this.createHelper =
      options.dependencies?.createHelper ??
      ((callbacks) =>
        new HelperProcessController({
          helperPath: options.helperPath,
          onMessage: callbacks.onMessage,
          onFailure: callbacks.onFailure,
        }));
  }

  public async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.enabled) {
      this.renderImmediately({ kind: 'disabled' });
      return;
    }
    if (!this.supported) {
      this.renderImmediately({
        kind: 'unavailable',
        reason: 'Live estimates currently require native Apple-silicon Cursor on macOS.',
      });
      return;
    }

    this.renderImmediately(
      this.windowFocused ? { kind: 'waiting-for-chat' } : { kind: 'paused' },
    );
    await this.ensureHelperStarted();
    this.helper?.setActive(this.windowFocused);
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.trusted = undefined;
    this.cancelPendingRender();

    if (!enabled) {
      const helper = this.helper;
      this.helper = undefined;
      this.helperStart = undefined;
      this.renderImmediately({ kind: 'disabled' });
      await helper?.stop();
      return;
    }
    await this.start();
  }

  public setWindowFocused(focused: boolean): void {
    if (this.disposed || this.windowFocused === focused) return;
    this.windowFocused = focused;
    if (!this.enabled || !this.supported) return;

    this.cancelPendingRender();
    this.helper?.setActive(focused);
    if (!focused) {
      this.renderImmediately({ kind: 'paused' });
    } else if (this.trusted === false) {
      this.renderImmediately({ kind: 'permission-missing' });
    } else {
      this.renderImmediately({ kind: 'waiting-for-chat' });
    }
  }

  public async requestPermission(): Promise<boolean> {
    if (this.disposed || !this.enabled || !this.supported) return false;
    await this.ensureHelperStarted();
    return this.helper?.requestPermission() ?? false;
  }

  public async diagnose(): Promise<boolean> {
    if (this.disposed || !this.enabled || !this.supported) return false;
    await this.ensureHelperStarted();
    return this.helper?.diagnose() ?? false;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingRender();
    const helper = this.helper;
    this.helper = undefined;
    this.helperStart = undefined;
    await helper?.stop();
  }

  private async ensureHelperStarted(): Promise<void> {
    if (this.helperStart !== undefined) {
      await this.helperStart;
      return;
    }
    if (this.helper === undefined) {
      this.helper = this.createHelper({
        onMessage: (message) => this.handleMessage(message),
        onFailure: (failure) => this.handleFailure(failure),
      });
    }

    const start = this.helper.start();
    this.helperStart = start;
    try {
      await start;
    } finally {
      if (this.helperStart === start) this.helperStart = undefined;
    }
  }

  private handleMessage(message: HelperMessage): void {
    if (this.disposed || !this.enabled) return;
    if (message.type === 'diagnostic') {
      this.onDiagnostic(message.metadata);
      return;
    }
    if (message.type === 'permission') {
      this.trusted = message.trusted;
      if (!this.windowFocused) {
        this.scheduleRender({ kind: 'paused' });
      } else if (!message.trusted) {
        this.scheduleRender({ kind: 'permission-missing' });
      } else {
        this.scheduleRender({ kind: 'waiting-for-chat' });
      }
      return;
    }
    if (!this.windowFocused) return;

    if (message.type === 'draft-length') {
      this.scheduleRender(
        message.characters === 0
          ? { kind: 'draft-empty' }
          : {
              kind: 'estimate',
              estimate: estimatePromptByCharacterCount(message.characters),
            },
      );
      return;
    }
    if (message.type === 'state') {
      switch (message.state) {
        case 'waiting-for-cursor':
          this.scheduleRender({ kind: 'paused' });
          return;
        case 'waiting-for-chat':
          this.scheduleRender({ kind: 'waiting-for-chat' });
          return;
        case 'draft-empty':
          this.scheduleRender({ kind: 'draft-empty' });
          return;
        case 'unsupported':
          this.scheduleRender({
            kind: 'unavailable',
            reason: 'This Cursor version does not expose a safely identifiable chat field.',
          });
          return;
      }
    }
    if (message.type === 'error') {
      this.scheduleRender({
        kind: 'unavailable',
        reason:
          message.code === 'draft-too-large'
            ? 'This draft is larger than TokenLens can estimate safely.'
            : 'The local accessibility helper reported an unavailable state.',
      });
    }
  }

  private handleFailure(failure: HelperControllerFailure): void {
    if (this.disposed || !this.enabled) return;
    const reason =
      failure.code === 'helper-not-executable'
        ? 'The packaged macOS helper is missing or is not executable.'
        : failure.code === 'restart-exhausted'
          ? 'The local accessibility helper stopped repeatedly.'
          : 'The local accessibility helper could not run safely.';
    this.scheduleRender({ kind: 'unavailable', reason });
  }

  private scheduleRender(state: EstimateViewState): void {
    if (this.disposed) return;
    this.pendingState = state;
    if (this.renderTimer !== undefined) return;
    this.renderTimer = this.setTimer(() => {
      this.renderTimer = undefined;
      const next = this.pendingState;
      this.pendingState = undefined;
      if (next !== undefined && !this.disposed) this.onState(next);
    }, this.renderDebounceMs);
  }

  private renderImmediately(state: EstimateViewState): void {
    this.cancelPendingRender();
    if (!this.disposed) this.onState(state);
  }

  private cancelPendingRender(): void {
    if (this.renderTimer !== undefined) {
      this.clearTimer(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.pendingState = undefined;
  }
}
