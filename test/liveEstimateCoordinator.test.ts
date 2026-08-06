import { describe, expect, it, vi } from 'vitest';
import {
  LiveEstimateCoordinator,
  type LiveDraftHelper,
  type LiveDraftHelperCallbacks,
} from '../src/liveDraft/liveEstimateCoordinator';
import type { HelperMessage } from '../src/liveDraft/protocol';
import type { EstimateViewState } from '../src/viewState';

class FakeHelper implements LiveDraftHelper {
  public readonly active: boolean[] = [];
  public starts = 0;
  public stops = 0;
  public permissionRequests = 0;
  public diagnostics = 0;

  public constructor(public readonly callbacks: LiveDraftHelperCallbacks) {}
  public async start(): Promise<void> {
    this.starts += 1;
  }
  public setActive(active: boolean): boolean {
    this.active.push(active);
    return true;
  }
  public requestPermission(): boolean {
    this.permissionRequests += 1;
    return true;
  }
  public diagnose(): boolean {
    this.diagnostics += 1;
    return true;
  }
  public async stop(): Promise<void> {
    this.stops += 1;
  }
  public emit(message: HelperMessage): void {
    this.callbacks.onMessage(message);
  }
}

function fixture(options?: { enabled?: boolean; focused?: boolean }) {
  vi.useFakeTimers();
  const states: EstimateViewState[] = [];
  let helper: FakeHelper | undefined;
  const coordinator = new LiveEstimateCoordinator({
    helperPath: '/extension/native/bin/darwin-arm64/tokenlens-ax-observer',
    platform: 'darwin',
    architecture: 'arm64',
    enabled: options?.enabled ?? true,
    windowFocused: options?.focused ?? true,
    onState: (state) => states.push(state),
    dependencies: {
      createHelper: (callbacks) => {
        helper = new FakeHelper(callbacks);
        return helper;
      },
    },
  });
  return { coordinator, states, get helper() { return helper; } };
}

describe('LiveEstimateCoordinator', () => {
  it('starts only when enabled and maps live draft counts to estimates', async () => {
    const test = fixture();
    await test.coordinator.start();
    expect(test.states).toEqual([{ kind: 'waiting-for-chat' }]);
    expect(test.helper?.active).toEqual([true]);

    test.helper?.emit({ version: 1, type: 'permission', trusted: true });
    test.helper?.emit({
      version: 1,
      type: 'draft-length',
      characters: 1_000,
      generation: 1,
      observation: 1,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(test.states.at(-1)).toMatchObject({
      kind: 'estimate',
      estimate: {
        characterCount: 1_000,
        formattedCost: '$0.01100',
      },
    });
    await test.coordinator.dispose();
  });

  it('renders permission, empty, waiting, paused, and unsupported states', async () => {
    const test = fixture();
    await test.coordinator.start();
    const emit = (message: HelperMessage) => test.helper?.emit(message);

    emit({ version: 1, type: 'permission', trusted: false });
    await vi.advanceTimersByTimeAsync(20);
    expect(test.states.at(-1)).toEqual({ kind: 'permission-missing' });

    emit({ version: 1, type: 'permission', trusted: true });
    emit({
      version: 1,
      type: 'state',
      state: 'draft-empty',
      generation: 1,
      observation: 1,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(test.states.at(-1)).toEqual({ kind: 'draft-empty' });

    test.coordinator.setWindowFocused(false);
    expect(test.states.at(-1)).toEqual({ kind: 'paused' });
    expect(test.helper?.active.at(-1)).toBe(false);
    emit({
      version: 1,
      type: 'draft-length',
      characters: 50,
      generation: 2,
      observation: 2,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(test.states.at(-1)).toEqual({ kind: 'paused' });

    test.coordinator.setWindowFocused(true);
    emit({
      version: 1,
      type: 'state',
      state: 'unsupported',
      generation: 3,
      observation: 3,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(test.states.at(-1)).toMatchObject({ kind: 'unavailable' });
    await test.coordinator.dispose();
  });

  it('keeps an unfocused window paused when permission is missing', async () => {
    const test = fixture({ focused: false });
    await test.coordinator.start();

    test.helper?.emit({ version: 1, type: 'permission', trusted: false });
    await vi.advanceTimersByTimeAsync(20);

    expect(test.states.at(-1)).toEqual({ kind: 'paused' });
    await test.coordinator.dispose();
  });

  it('disables, stops, and re-enables the helper deliberately', async () => {
    const test = fixture();
    await test.coordinator.start();
    const first = test.helper;
    await test.coordinator.setEnabled(false);
    expect(first?.stops).toBe(1);
    expect(test.states.at(-1)).toEqual({ kind: 'disabled' });

    await test.coordinator.setEnabled(true);
    expect(test.helper).not.toBe(first);
    expect(test.helper?.starts).toBe(1);
    await test.coordinator.dispose();
  });

  it('does not launch the helper on unsupported platforms', async () => {
    const states: EstimateViewState[] = [];
    const createHelper = vi.fn();
    const coordinator = new LiveEstimateCoordinator({
      helperPath: '/extension/native/bin/darwin-arm64/tokenlens-ax-observer',
      platform: 'linux',
      architecture: 'x64',
      enabled: true,
      windowFocused: true,
      onState: (state) => states.push(state),
      dependencies: { createHelper },
    });
    await coordinator.start();
    expect(createHelper).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ kind: 'unavailable' });
    await coordinator.dispose();
  });
});
