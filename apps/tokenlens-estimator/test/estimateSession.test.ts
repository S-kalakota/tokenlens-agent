import { describe, expect, it } from 'vitest';

import type { EstimateResult, EstimatorClient, EstimatorError } from '../src/client/types';
import {
  buildEstimateRequest,
  type EstimateRequest,
  type ReadyEstimate,
} from '../src/contract';
import { EstimateSession, type EstimateViewState } from '../src/estimateSession';

const request = buildEstimateRequest({
  prompt: 'TokenLens development fixture prompt.',
  model: 'claude-sonnet-4',
  accessMode: 'api',
  clientVersion: '0.1.0',
  budgetThreshold: 0.1,
});

describe('EstimateSession', () => {
  it('lets only the latest request update the view', async () => {
    const firstResult = deferred<EstimateResult>();
    const secondResult = deferred<EstimateResult>();
    const states: EstimateViewState[] = [];
    let callCount = 0;
    let firstSignal: AbortSignal | undefined;

    const client: EstimatorClient = {
      estimate(_estimateRequest, options) {
        callCount += 1;
        if (callCount === 1) {
          firstSignal = options?.signal;
          return firstResult.promise;
        }

        return secondResult.promise;
      },
    };
    const session = new EstimateSession((state) => states.push(state));

    const firstRun = session.run(client, request, 1_000);
    const secondRun = session.run(client, request, 1_000);

    expect(firstSignal?.aborted).toBe(true);

    const secondEstimate = readyEstimate('est_second', 'Second estimate');
    secondResult.resolve({ ok: true, value: secondEstimate });
    await secondRun;

    firstResult.resolve({
      ok: true,
      value: readyEstimate('est_first', 'Stale first estimate'),
    });
    await firstRun;

    expect(states).toEqual([
      { kind: 'loading' },
      { kind: 'loading' },
      { kind: 'ready', estimate: secondEstimate },
    ]);
    expect(session.isLoading).toBe(false);
  });

  it('cancels the active request on reset and ignores its late result', async () => {
    const pendingResult = deferred<EstimateResult>();
    const states: EstimateViewState[] = [];
    let requestSignal: AbortSignal | undefined;
    const client: EstimatorClient = {
      estimate(_estimateRequest, options) {
        requestSignal = options?.signal;
        return pendingResult.promise;
      },
    };
    const session = new EstimateSession((state) => states.push(state));

    const run = session.run(client, request, 1_000);
    expect(session.isLoading).toBe(true);

    session.reset();

    expect(requestSignal?.aborted).toBe(true);
    expect(session.isLoading).toBe(false);
    expect(states).toEqual([{ kind: 'loading' }, { kind: 'idle' }]);

    pendingResult.resolve({
      ok: true,
      value: readyEstimate('est_late', 'Late estimate'),
    });
    await run;

    expect(states).toEqual([{ kind: 'loading' }, { kind: 'idle' }]);
  });

  it.each(nonCancellationFailures)(
    'maps a $kind client failure to the unavailable state',
    async (error) => {
      const states: EstimateViewState[] = [];
      const client = clientReturning({ ok: false, error });
      const session = new EstimateSession((state) => states.push(state));

      await session.run(client, request, 1_000);

      expect(states).toEqual([
        { kind: 'loading' },
        { kind: 'unavailable', error },
      ]);
      expect(session.isLoading).toBe(false);
    },
  );

  it('maps a client cancellation result back to idle', async () => {
    const states: EstimateViewState[] = [];
    const error: EstimatorError = {
      kind: 'cancelled',
      message: 'The estimator request was cancelled.',
      retryable: false,
    };
    const session = new EstimateSession((state) => states.push(state));

    await session.run(clientReturning({ ok: false, error }), request, 1_000);

    expect(states).toEqual([{ kind: 'loading' }, { kind: 'idle' }]);
    expect(session.isLoading).toBe(false);
  });

  it('maps an unexpected client rejection to a safe network failure', async () => {
    const states: EstimateViewState[] = [];
    const client: EstimatorClient = {
      async estimate() {
        throw new Error('private prompt text must not be exposed');
      },
    };
    const session = new EstimateSession((state) => states.push(state));

    await session.run(client, request, 1_000);

    expect(states).toEqual([
      { kind: 'loading' },
      {
        kind: 'unavailable',
        error: {
          kind: 'network',
          message: 'The estimator endpoint is unavailable.',
          retryable: true,
        },
      },
    ]);
    expect(session.isLoading).toBe(false);
  });
});

const nonCancellationFailures: EstimatorError[] = [
  {
    kind: 'configuration',
    message: 'Configure a valid endpoint.',
    retryable: false,
  },
  {
    kind: 'invalid_request',
    message: 'The estimate request is not valid.',
    retryable: false,
  },
  {
    kind: 'timeout',
    message: 'The estimator request timed out.',
    retryable: true,
  },
  {
    kind: 'network',
    message: 'The estimator endpoint is unavailable.',
    retryable: true,
  },
  {
    kind: 'http',
    message: 'The estimator endpoint returned an HTTP error.',
    retryable: true,
    statusCode: 503,
  },
  {
    kind: 'endpoint',
    message: 'The estimator could not provide an estimate.',
    retryable: true,
    code: 'ESTIMATOR_UNAVAILABLE',
  },
  {
    kind: 'invalid_response',
    message: 'The estimator returned an unsupported response.',
    retryable: false,
  },
];

function clientReturning(result: EstimateResult): EstimatorClient {
  return {
    async estimate(_request: EstimateRequest) {
      return result;
    },
  };
}

function readyEstimate(estimateId: string, chipText: string): ReadyEstimate {
  return {
    estimateId,
    status: 'ready',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    accessMode: 'api',
    display: {
      chipText,
      title: `${chipText} title`,
      summary: `${chipText} summary`,
      disclaimer: `${chipText} disclaimer`,
    },
    budget: {
      isOverThreshold: false,
    },
    metadata: {
      estimatorVersion: 'test-v1',
      generatedAt: '2026-08-05T00:00:00Z',
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
