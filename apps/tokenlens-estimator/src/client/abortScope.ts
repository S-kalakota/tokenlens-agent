export type AbortSource = 'cancelled' | 'timeout';

export interface AbortScope {
  signal: AbortSignal;
  source(): AbortSource | undefined;
  dispose(): void;
}

const MINIMUM_TIMEOUT_MS = 500;
const MAXIMUM_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(MAXIMUM_TIMEOUT_MS, Math.max(MINIMUM_TIMEOUT_MS, timeoutMs));
}

export function createAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortScope {
  const controller = new AbortController();
  let abortSource: AbortSource | undefined;

  const abortFromParent = () => {
    if (abortSource === undefined) {
      abortSource = 'cancelled';
      controller.abort();
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeout = setTimeout(() => {
    if (abortSource === undefined) {
      abortSource = 'timeout';
      controller.abort();
    }
  }, normalizeTimeout(timeoutMs));

  return {
    signal: controller.signal,
    source: () => abortSource,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('ABORTED'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, milliseconds));

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('ABORTED'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
