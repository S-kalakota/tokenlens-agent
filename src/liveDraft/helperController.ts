import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  encodeHelperCommand,
  HelperMessageDecoder,
  LIVE_DRAFT_PROTOCOL_VERSION,
  type HelperCommand,
  type HelperMessage,
} from './protocol';

const DEFAULT_RESTART_ATTEMPTS = 3;
const DEFAULT_INITIAL_RESTART_DELAY_MS = 250;
const DEFAULT_MAXIMUM_RESTART_DELAY_MS = 4_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;

export interface HelperSpawnOptions {
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
}

export type HelperSpawner = (
  executablePath: string,
  args: readonly string[],
  options: HelperSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface HelperControllerDependencies {
  spawn?: HelperSpawner;
  verifyExecutable?: (executablePath: string) => Promise<void>;
  setTimer?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface HelperRestartPolicy {
  maximumAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  shutdownGraceMs?: number;
}

export type HelperControllerFailureCode =
  | 'helper-not-executable'
  | 'protocol-violation'
  | 'restart-exhausted'
  | 'spawn-failed'
  | 'write-failed';

export interface HelperControllerFailure {
  code: HelperControllerFailureCode;
}

export interface HelperProcessControllerOptions {
  helperPath: string;
  onMessage: (message: HelperMessage) => void;
  onFailure?: (failure: HelperControllerFailure) => void;
  restartPolicy?: HelperRestartPolicy;
  dependencies?: HelperControllerDependencies;
}

interface HelperSession {
  readonly process: ChildProcessWithoutNullStreams;
  readonly decoder: HelperMessageDecoder;
  readonly exitWaiters: Set<() => void>;
  latestObservation: number;
  processExited: boolean;
  terminated: boolean;
  protocolFailed: boolean;
}

/**
 * Owns the local accessibility helper process. It accepts only an absolute
 * executable path, always uses private pipes with `shell: false`, and never
 * exposes stderr or thrown process errors to callers.
 */
export class HelperProcessController {
  private readonly helperPath: string;
  private readonly onMessage: (message: HelperMessage) => void;
  private readonly onFailure: (
    failure: HelperControllerFailure,
  ) => void;
  private readonly spawnHelper: HelperSpawner;
  private readonly verifyExecutable: (
    executablePath: string,
  ) => Promise<void>;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (
    timer: ReturnType<typeof setTimeout>,
  ) => void;
  private readonly maximumRestartAttempts: number;
  private readonly initialRestartDelayMs: number;
  private readonly maximumRestartDelayMs: number;
  private readonly shutdownGraceMs: number;

  private session: HelperSession | undefined;
  private desiredRunning = false;
  private desiredActive = false;
  private activationGeneration = 0;
  private restartSuppressed = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private launchPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  public constructor(options: HelperProcessControllerOptions) {
    if (!isAbsolute(options.helperPath)) {
      throw new TypeError('The TokenLens helper path must be absolute.');
    }

    const dependencies = options.dependencies;
    const restartPolicy = options.restartPolicy;
    this.helperPath = options.helperPath;
    this.onMessage = options.onMessage;
    this.onFailure = options.onFailure ?? (() => undefined);
    this.spawnHelper = dependencies?.spawn ?? defaultSpawn;
    this.verifyExecutable =
      dependencies?.verifyExecutable ?? verifyExecutableFile;
    this.setTimer =
      dependencies?.setTimer ??
      ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = dependencies?.clearTimer ?? ((timer) => clearTimeout(timer));
    this.maximumRestartAttempts = nonnegativeInteger(
      restartPolicy?.maximumAttempts,
      DEFAULT_RESTART_ATTEMPTS,
      'maximumAttempts',
    );
    this.initialRestartDelayMs = nonnegativeInteger(
      restartPolicy?.initialDelayMs,
      DEFAULT_INITIAL_RESTART_DELAY_MS,
      'initialDelayMs',
    );
    this.maximumRestartDelayMs = nonnegativeInteger(
      restartPolicy?.maximumDelayMs,
      DEFAULT_MAXIMUM_RESTART_DELAY_MS,
      'maximumDelayMs',
    );
    this.shutdownGraceMs = nonnegativeInteger(
      restartPolicy?.shutdownGraceMs,
      DEFAULT_SHUTDOWN_GRACE_MS,
      'shutdownGraceMs',
    );
  }

  public async start(): Promise<void> {
    if (!this.desiredRunning) {
      this.desiredRunning = true;
      this.restartSuppressed = false;
      this.restartAttempts = 0;
    }
    this.clearScheduledRestart();
    await this.launch();
  }

  public setActive(active: boolean): boolean {
    if (this.desiredActive === active) {
      return this.session !== undefined;
    }

    this.desiredActive = active;
    this.activationGeneration = nextSequenceNumber(this.activationGeneration);
    if (this.session !== undefined) {
      this.session.latestObservation = -1;
    }
    return this.send({
      version: LIVE_DRAFT_PROTOCOL_VERSION,
      command: 'set-active',
      active,
      generation: this.activationGeneration,
    });
  }

  public requestPermission(): boolean {
    this.restartSuppressed = false;
    return this.send({
      version: LIVE_DRAFT_PROTOCOL_VERSION,
      command: 'request-permission',
    });
  }

  public diagnose(): boolean {
    return this.send({
      version: LIVE_DRAFT_PROTOCOL_VERSION,
      command: 'diagnose',
    });
  }

  public async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.desiredRunning = false;
    this.restartSuppressed = true;
    this.clearScheduledRestart();
    const session = this.session;
    if (session === undefined) {
      return;
    }

    const stopPromise = this.stopSession(session);
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
      }
    }
  }

  private async launch(): Promise<void> {
    if (
      !this.desiredRunning ||
      this.session !== undefined ||
      this.restartTimer !== undefined
    ) {
      return;
    }
    if (this.launchPromise !== undefined) {
      return this.launchPromise;
    }

    const launchPromise = this.launchInternal();
    this.launchPromise = launchPromise;
    try {
      await launchPromise;
    } finally {
      if (this.launchPromise === launchPromise) {
        this.launchPromise = undefined;
      }
    }
  }

  private async launchInternal(): Promise<void> {
    try {
      await this.verifyExecutable(this.helperPath);
    } catch {
      this.restartSuppressed = true;
      this.reportFailure('helper-not-executable');
      return;
    }

    if (!this.desiredRunning || this.session !== undefined) {
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnHelper(this.helperPath, [], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.reportFailure('spawn-failed');
      this.scheduleRestart();
      return;
    }

    const session: HelperSession = {
      process: child,
      decoder: new HelperMessageDecoder(),
      exitWaiters: new Set(),
      latestObservation: -1,
      processExited: false,
      terminated: false,
      protocolFailed: false,
    };
    this.session = session;
    this.attach(session);
    this.sendToSession(session, {
      version: LIVE_DRAFT_PROTOCOL_VERSION,
      command: 'set-active',
      active: this.desiredActive,
      generation: this.activationGeneration,
    });
  }

  private attach(session: HelperSession): void {
    session.process.stdout.on('data', (chunk: Buffer | string) => {
      if (this.session !== session || session.protocolFailed) {
        return;
      }
      try {
        const messages = session.decoder.push(chunk);
        for (const message of messages) {
          this.handleMessage(session, message);
        }
      } catch {
        this.failProtocol(session);
      }
    });
    session.process.stdout.on('error', () => this.failProtocol(session));
    session.process.stdin.on('error', () => {
      // Broken-pipe details are deliberately discarded.
    });
    session.process.stderr.on('error', () => {
      // Helper diagnostics are prompt-safe codes, but are not logged here.
    });
    session.process.stderr.resume();
    session.process.once('error', () => {
      if (this.session === session) {
        this.reportFailure('spawn-failed');
        this.terminateUnexpectedly(session);
      }
    });
    session.process.once('exit', () => this.handleProcessExit(session));
    session.process.once('close', () => this.handleProcessClose(session));
  }

  private handleMessage(session: HelperSession, message: HelperMessage): void {
    if (
      message.type === 'state' ||
      message.type === 'draft-length' ||
      message.type === 'error'
    ) {
      if (message.generation !== this.activationGeneration) {
        return;
      }
      if (!this.desiredActive) {
        return;
      }
      if (message.type !== 'error') {
        if (message.observation < session.latestObservation) {
          return;
        }
        session.latestObservation = message.observation;
      }
    }

    if (message.type === 'permission') {
      this.restartSuppressed = !message.trusted;
    } else if (message.type === 'state' && message.state === 'unsupported') {
      this.restartSuppressed = true;
    }

    try {
      this.onMessage(message);
    } catch {
      // Consumer failures must not tear down the extension host or helper.
    }
  }

  private failProtocol(session: HelperSession): void {
    if (this.session !== session || session.protocolFailed) {
      return;
    }
    session.protocolFailed = true;
    this.reportFailure('protocol-violation');
    this.terminateUnexpectedly(session);
  }

  private terminateUnexpectedly(session: HelperSession): void {
    try {
      session.process.kill('SIGKILL');
    } catch {
      // The failed helper may already have exited.
    }
  }

  private handleProcessExit(session: HelperSession): void {
    if (session.processExited) {
      return;
    }
    session.processExited = true;

    for (const resolve of session.exitWaiters) {
      resolve();
    }
    session.exitWaiters.clear();
  }

  /** Finalize only after Node reports that all stdio streams are closed. */
  private handleProcessClose(session: HelperSession): void {
    if (session.terminated) return;
    this.handleProcessExit(session);
    session.terminated = true;

    if (!session.protocolFailed) {
      try {
        session.decoder.finish();
      } catch {
        session.protocolFailed = true;
        this.reportFailure('protocol-violation');
      }
    }

    if (this.session !== session) {
      return;
    }
    this.session = undefined;

    if (this.desiredRunning && !this.restartSuppressed) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (
      !this.desiredRunning ||
      this.restartSuppressed ||
      this.restartTimer !== undefined ||
      this.session !== undefined
    ) {
      return;
    }

    if (this.restartAttempts >= this.maximumRestartAttempts) {
      this.restartSuppressed = true;
      this.reportFailure('restart-exhausted');
      return;
    }

    const delay = Math.min(
      this.initialRestartDelayMs * 2 ** this.restartAttempts,
      this.maximumRestartDelayMs,
    );
    this.restartAttempts += 1;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined;
      void this.launch();
    }, delay);
  }

  private clearScheduledRestart(): void {
    if (this.restartTimer !== undefined) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private send(command: HelperCommand): boolean {
    const session = this.session;
    return session === undefined ? false : this.sendToSession(session, command);
  }

  private sendToSession(
    session: HelperSession,
    command: HelperCommand,
    reportFailure = true,
  ): boolean {
    if (session.terminated || session.process.stdin.writableEnded) {
      return false;
    }

    try {
      session.process.stdin.write(encodeHelperCommand(command), 'utf8');
      return true;
    } catch {
      if (reportFailure) {
        this.reportFailure('write-failed');
      }
      return false;
    }
  }

  private async stopSession(session: HelperSession): Promise<void> {
    this.sendToSession(
      session,
      {
        version: LIVE_DRAFT_PROTOCOL_VERSION,
        command: 'shutdown',
      },
      false,
    );
    session.process.stdin.end();

    if (await this.waitForExit(session, this.shutdownGraceMs)) {
      return;
    }

    try {
      session.process.kill('SIGTERM');
    } catch {
      // Continue to the final bounded wait.
    }
    if (await this.waitForExit(session, this.shutdownGraceMs)) {
      return;
    }

    try {
      session.process.kill('SIGKILL');
    } catch {
      // The process may have exited between the wait and fallback kill.
    }
    if (!(await this.waitForExit(session, this.shutdownGraceMs))) {
      // A child that cannot report exit after SIGKILL is unusable. Force the
      // local bookkeeping closed without interpreting any pending stdout.
      session.protocolFailed = true;
      this.handleProcessExit(session);
      this.handleProcessClose(session);
    }
  }

  private async waitForExit(
    session: HelperSession,
    milliseconds: number,
  ): Promise<boolean> {
    if (session.processExited) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimer(timer);
        session.exitWaiters.delete(onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = this.setTimer(() => finish(false), milliseconds);
      session.exitWaiters.add(onExit);
      if (session.processExited) {
        finish(true);
      }
    });
  }

  private reportFailure(code: HelperControllerFailureCode): void {
    try {
      this.onFailure({ code });
    } catch {
      // Failure reporting is never allowed to destabilize the controller.
    }
  }
}

function defaultSpawn(
  executablePath: string,
  args: readonly string[],
  _options: HelperSpawnOptions,
): ChildProcessWithoutNullStreams {
  return spawn(executablePath, [...args], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function verifyExecutableFile(executablePath: string): Promise<void> {
  const information = await stat(executablePath);
  if (!information.isFile()) {
    throw new Error('The TokenLens helper is not a regular file.');
  }
  await access(executablePath, constants.X_OK);
}

function nonnegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
  return resolved;
}

function nextSequenceNumber(current: number): number {
  return current === Number.MAX_SAFE_INTEGER ? 0 : current + 1;
}
