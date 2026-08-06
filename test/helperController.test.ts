import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HelperProcessController,
  type HelperControllerFailure,
  type HelperSpawner,
} from '../src/liveDraft/helperController';
import {
  parseHelperCommandLine,
  type HelperCommand,
  type HelperMessage,
} from '../src/liveDraft/protocol';

const absoluteHelperPath =
  '/installed/tokenlens/native/bin/darwin-arm64/tokenlens-ax-observer';

class FakeHelperProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly commands: HelperCommand[] = [];
  public readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  public exitOnShutdown = false;
  public exitOnSignal = false;

  private input = '';
  private exited = false;
  private closed = false;

  public constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.input += chunk.toString('utf8');
      let newline = this.input.indexOf('\n');
      while (newline !== -1) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const command = parseHelperCommandLine(line);
        this.commands.push(command);
        if (command.command === 'shutdown' && this.exitOnShutdown) {
          queueMicrotask(() => this.exit(0));
        }
        newline = this.input.indexOf('\n');
      }
    });
  }

  public asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  public emitMessage(message: HelperMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  public emitRaw(value: string | Uint8Array): void {
    this.stdout.write(value);
  }

  public exit(code: number | null = 1): void {
    this.emitExit(code);
    this.close(code);
  }

  public emitExit(code: number | null = 1): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.emit('exit', code, null);
  }

  public close(code: number | null = 1): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal) {
      queueMicrotask(() => this.exit(null));
    }
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function injectedDependencies(spawnHelper: HelperSpawner) {
  return {
    spawn: spawnHelper,
    verifyExecutable: vi.fn(async () => undefined),
  };
}

describe('HelperProcessController', () => {
  it('rejects a relative helper path before attempting to spawn', () => {
    expect(
      () =>
        new HelperProcessController({
          helperPath: 'native/bin/tokenlens-ax-observer',
          onMessage: () => undefined,
        }),
    ).toThrow(/absolute/i);
  });

  it('spawns the absolute helper with private pipes and sends strict commands', async () => {
    const helper = new FakeHelperProcess();
    helper.exitOnShutdown = true;
    const spawnHelper = vi.fn<HelperSpawner>(() => helper.asChildProcess());
    const dependencies = injectedDependencies(spawnHelper);
    const messages: HelperMessage[] = [];
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: (message) => messages.push(message),
      dependencies,
    });

    await controller.start();

    expect(dependencies.verifyExecutable).toHaveBeenCalledWith(
      absoluteHelperPath,
    );
    expect(spawnHelper).toHaveBeenCalledWith(absoluteHelperPath, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(helper.commands).toEqual([
      { version: 1, command: 'set-active', active: false, generation: 0 },
    ]);

    expect(controller.setActive(true)).toBe(true);
    expect(controller.requestPermission()).toBe(true);
    expect(controller.diagnose()).toBe(true);
    expect(helper.commands.slice(1)).toEqual([
      { version: 1, command: 'set-active', active: true, generation: 1 },
      { version: 1, command: 'request-permission' },
      { version: 1, command: 'diagnose' },
    ]);

    const permission: HelperMessage = {
      version: 1,
      type: 'permission',
      trusted: true,
    };
    helper.emitMessage(permission);
    expect(messages).toEqual([permission]);

    await controller.stop();
  });

  it('drops stale observations and messages from an earlier activation generation', async () => {
    const helper = new FakeHelperProcess();
    helper.exitOnShutdown = true;
    const messages: HelperMessage[] = [];
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: (message) => messages.push(message),
      dependencies: injectedDependencies(() => helper.asChildProcess()),
    });
    await controller.start();
    controller.setActive(true);

    const waiting: HelperMessage = {
      version: 1,
      type: 'state',
      state: 'waiting-for-chat',
      generation: 1,
      observation: 3,
    };
    const currentDraft: HelperMessage = {
      version: 1,
      type: 'draft-length',
      characters: 100,
      generation: 1,
      observation: 3,
    };
    helper.emitMessage(waiting);
    helper.emitMessage(currentDraft);
    helper.emitMessage({
      version: 1,
      type: 'draft-length',
      characters: 99,
      generation: 1,
      observation: 2,
    });

    controller.setActive(false);
    helper.emitMessage({
      version: 1,
      type: 'draft-length',
      characters: 101,
      generation: 1,
      observation: 4,
    });
    controller.setActive(true);
    helper.emitMessage({
      version: 1,
      type: 'draft-length',
      characters: 102,
      generation: 1,
      observation: 99,
    });
    const resumedDraft: HelperMessage = {
      version: 1,
      type: 'draft-length',
      characters: 103,
      generation: 3,
      observation: 5,
    };
    helper.emitMessage(resumedDraft);

    expect(messages).toEqual([waiting, currentDraft, resumedDraft]);
    await controller.stop();
  });

  it('drains a final stdout frame after process exit and before close', async () => {
    const helper = new FakeHelperProcess();
    const messages: HelperMessage[] = [];
    const failures: HelperControllerFailure[] = [];
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: (message) => messages.push(message),
      onFailure: (failure) => failures.push(failure),
      dependencies: injectedDependencies(() => helper.asChildProcess()),
    });
    await controller.start();
    controller.setActive(true);

    const finalMessage: HelperMessage = {
      version: 1,
      type: 'draft-length',
      characters: 88,
      generation: 1,
      observation: 4,
    };
    const frame = `${JSON.stringify(finalMessage)}\n`;
    const split = frame.length - 3;
    const stopping = controller.stop();
    helper.emitRaw(frame.slice(0, split));
    helper.emitExit(0);
    expect(failures).toEqual([]);
    helper.emitRaw(frame.slice(split));
    helper.close(0);
    await stopping;

    expect(messages).toEqual([finalMessage]);
    expect(failures).toEqual([]);
  });

  it('terminates malformed helper output without forwarding embedded text', async () => {
    const helper = new FakeHelperProcess();
    helper.exitOnSignal = true;
    const messages: HelperMessage[] = [];
    const failures: HelperControllerFailure[] = [];
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: (message) => messages.push(message),
      onFailure: (failure) => failures.push(failure),
      restartPolicy: { maximumAttempts: 0 },
      dependencies: injectedDependencies(() => helper.asChildProcess()),
    });
    await controller.start();

    helper.emitRaw(
      `${JSON.stringify({
        version: 1,
        type: 'draft-length',
        characters: 12,
        generation: 0,
        observation: 1,
        text: 'private prompt',
      })}\n`,
    );

    expect(messages).toEqual([]);
    expect(failures).toContainEqual({ code: 'protocol-violation' });
    expect(helper.signals).toContain('SIGKILL');
    expect(JSON.stringify(failures)).not.toContain('private prompt');
    await controller.stop();
  });

  it('restarts crashes with exponential backoff and a fixed attempt limit', async () => {
    vi.useFakeTimers();
    const helpers: FakeHelperProcess[] = [];
    const failures: HelperControllerFailure[] = [];
    const spawnHelper = vi.fn<HelperSpawner>(() => {
      const helper = new FakeHelperProcess();
      helpers.push(helper);
      return helper.asChildProcess();
    });
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: () => undefined,
      onFailure: (failure) => failures.push(failure),
      restartPolicy: {
        maximumAttempts: 2,
        initialDelayMs: 10,
        maximumDelayMs: 100,
      },
      dependencies: injectedDependencies(spawnHelper),
    });
    await controller.start();
    expect(helpers).toHaveLength(1);

    helpers[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(helpers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers).toHaveLength(2);

    helpers[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(helpers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers).toHaveLength(3);

    helpers[2]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helpers).toHaveLength(3);
    expect(failures).toContainEqual({ code: 'restart-exhausted' });
    await controller.stop();
  });

  it.each<HelperMessage>([
    { version: 1, type: 'permission', trusted: false },
    {
      version: 1,
      type: 'state',
      state: 'unsupported',
      generation: 1,
      observation: 1,
    },
  ])('does not restart after $type reports a terminal state', async (message) => {
    vi.useFakeTimers();
    const helpers: FakeHelperProcess[] = [];
    const spawnHelper = vi.fn<HelperSpawner>(() => {
      const helper = new FakeHelperProcess();
      helpers.push(helper);
      return helper.asChildProcess();
    });
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: () => undefined,
      restartPolicy: { initialDelayMs: 10 },
      dependencies: injectedDependencies(spawnHelper),
    });
    await controller.start();
    controller.setActive(true);

    helpers[0]?.emitMessage(message);
    helpers[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(helpers).toHaveLength(1);
    await controller.stop();
  });

  it('sends shutdown and allows a cooperative helper to exit without a signal', async () => {
    const helper = new FakeHelperProcess();
    helper.exitOnShutdown = true;
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: () => undefined,
      dependencies: injectedDependencies(() => helper.asChildProcess()),
    });
    await controller.start();

    await controller.stop();

    expect(helper.commands.at(-1)).toEqual({
      version: 1,
      command: 'shutdown',
    });
    expect(helper.stdin.writableEnded).toBe(true);
    expect(helper.signals).toEqual([]);
  });

  it('uses SIGTERM after the graceful shutdown deadline', async () => {
    vi.useFakeTimers();
    const helper = new FakeHelperProcess();
    helper.exitOnSignal = true;
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: () => undefined,
      restartPolicy: { shutdownGraceMs: 25 },
      dependencies: injectedDependencies(() => helper.asChildProcess()),
    });
    await controller.start();

    const stopping = controller.stop();
    await vi.advanceTimersByTimeAsync(25);
    await stopping;

    expect(helper.signals).toEqual(['SIGTERM']);
  });

  it('fails closed when the absolute helper is not executable', async () => {
    const helper = new FakeHelperProcess();
    const spawnHelper = vi.fn<HelperSpawner>(() => helper.asChildProcess());
    const failures: HelperControllerFailure[] = [];
    const controller = new HelperProcessController({
      helperPath: absoluteHelperPath,
      onMessage: () => undefined,
      onFailure: (failure) => failures.push(failure),
      dependencies: {
        spawn: spawnHelper,
        verifyExecutable: vi.fn(async () => {
          throw new Error('missing helper at a private path');
        }),
      },
    });

    await controller.start();

    expect(spawnHelper).not.toHaveBeenCalled();
    expect(failures).toEqual([{ code: 'helper-not-executable' }]);
    await controller.stop();
  });
});
