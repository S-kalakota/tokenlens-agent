import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEstimatorClient } from '../src/client/clientFactory';
import { HttpEstimatorClient } from '../src/client/httpEstimatorClient';
import { MockEstimatorClient } from '../src/client/mockEstimatorClient';
import type {
  EstimateResult,
  EstimatorError,
} from '../src/client/types';
import {
  buildEstimateRequest,
  type AccessMode,
  type EstimateRequest,
  type ReadyEstimate,
} from '../src/contract';
import { EstimateSession, type EstimateViewState } from '../src/estimateSession';

const MODEL = 'claude-sonnet-4-test';
const PRIVATE_PROMPT = 'private prompt that must not appear in an estimate result';

describe('MockEstimatorClient ready scenarios', () => {
  it.each([
    {
      accessMode: 'api' as const,
      chipText: 'Est. $0.02–$0.06',
      title: 'Claude Sonnet 4 · Estimated API cost',
      summary: 'Estimated range: $0.02–$0.06',
      disclaimer: 'This is a predicted range, not a final bill.',
    },
    {
      accessMode: 'subscription' as const,
      chipText: 'Usage: Low',
      title: 'Claude Sonnet 4 · Subscription usage',
      summary: 'Estimated subscription impact: Low',
      disclaimer: 'This is a relative usage estimate, not a per-prompt charge.',
    },
  ])('auto returns display-ready $accessMode semantics', async (expected) => {
    const result = await new MockEstimatorClient('auto', 0).estimate(
      request(expected.accessMode),
    );
    const estimate = expectReady(result);

    expect(estimate).toMatchObject({
      status: 'ready',
      provider: 'anthropic',
      model: MODEL,
      accessMode: expected.accessMode,
      display: {
        chipText: expected.chipText,
        title: expected.title,
        summary: expected.summary,
        disclaimer: expected.disclaimer,
      },
      budget: { isOverThreshold: false },
    });
    expect(JSON.stringify(estimate)).not.toContain(PRIVATE_PROMPT);
  });

  it('returns the explicit API fixture for an API request', async () => {
    const estimate = expectReady(
      await new MockEstimatorClient('api-ready', 0).estimate(request('api')),
    );

    expect(estimate.accessMode).toBe('api');
    expect(estimate.estimateId).toBe('est_mock_api');
    expect(estimate.display.chipText).toContain('$');
    expect(estimate.display.disclaimer).toContain('predicted range');
    expect(estimate.display.disclaimer).not.toContain('subscription');
  });

  it('returns the explicit subscription fixture for a subscription request', async () => {
    const estimate = expectReady(
      await new MockEstimatorClient('subscription-ready', 0).estimate(
        request('subscription'),
      ),
    );

    expect(estimate.accessMode).toBe('subscription');
    expect(estimate.estimateId).toBe('est_mock_subscription');
    expect(estimate.display.chipText).not.toContain('$');
    expect(estimate.display.disclaimer).toContain('not a per-prompt charge');
  });

  it.each([
    ['api-ready', 'subscription'],
    ['subscription-ready', 'api'],
  ] as const)(
    'fails closed when %s conflicts with the requested %s access mode',
    async (scenario, accessMode) => {
      const result = await new MockEstimatorClient(scenario, 0).estimate(
        request(accessMode),
      );
      const error = expectFailure(result);

      expect(error).toEqual({
        kind: 'invalid_response',
        message: 'The estimator response does not match the request settings.',
        retryable: false,
      });
    },
  );

  it.each([
    {
      accessMode: 'api' as const,
      chipText: 'Est. $0.18–$0.25',
      summary: 'Estimated range: $0.18–$0.25',
    },
    {
      accessMode: 'subscription' as const,
      chipText: 'Usage: High',
      summary: 'Estimated subscription impact: High',
    },
  ])('marks the $accessMode over-budget fixture without changing modes', async (expected) => {
    const estimate = expectReady(
      await new MockEstimatorClient('over-budget', 0).estimate(
        request(expected.accessMode),
      ),
    );

    expect(estimate.accessMode).toBe(expected.accessMode);
    expect(estimate.estimateId).toBe('est_mock_over_budget');
    expect(estimate.budget.isOverThreshold).toBe(true);
    expect(estimate.display.chipText).toBe(expected.chipText);
    expect(estimate.display.summary).toBe(expected.summary);
  });
});

describe('MockEstimatorClient unavailable and malformed scenarios', () => {
  it('maps the unavailable fixture to a redacted, retryable endpoint failure', async () => {
    const result = await new MockEstimatorClient('unavailable', 0).estimate(
      request('api'),
    );
    const error = expectFailure(result);

    expect(error).toEqual({
      kind: 'endpoint',
      message: 'The estimator could not provide an estimate.',
      retryable: true,
      code: 'ESTIMATOR_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_PROMPT);
    expect(JSON.stringify(result)).not.toContain(
      'An estimate is temporarily unavailable.',
    );
  });

  it('maps the malformed fixture to a safe, non-retryable invalid-response failure', async () => {
    const result = await new MockEstimatorClient('malformed', 0).estimate(
      request('subscription'),
    );
    const error = expectFailure(result);

    expect(error).toEqual({
      kind: 'invalid_response',
      message: 'The estimator returned an unsupported response.',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_PROMPT);
  });

  it('rejects an invalid request before returning fixture data', async () => {
    const invalidRequest = {
      ...request('api'),
      prompt: '   ',
    } as EstimateRequest;

    const result = await new MockEstimatorClient('auto', 10_000).estimate(
      invalidRequest,
    );

    expect(expectFailure(result)).toEqual({
      kind: 'invalid_request',
      message: 'The estimate request is not valid.',
      retryable: false,
    });
  });
});

describe('MockEstimatorClient delay, loading, cancellation, and timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays pending for the configured delay while EstimateSession reports loading', async () => {
    vi.useFakeTimers();
    const states: EstimateViewState[] = [];
    const session = new EstimateSession((state) => states.push(state));
    const run = session.run(
      new MockEstimatorClient('auto', 750),
      request('api'),
      5_000,
    );

    expect(states.map(({ kind }) => kind)).toEqual(['loading']);
    expect(session.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(749);
    expect(states.map(({ kind }) => kind)).toEqual(['loading']);
    expect(session.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(states.map(({ kind }) => kind)).toEqual(['loading', 'ready']);
    expect(states[1]).toMatchObject({
      kind: 'ready',
      estimate: { accessMode: 'api' },
    });
    expect(session.isLoading).toBe(false);
    session.dispose();
  });

  it('cancels a delayed fixture through the caller signal', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = new MockEstimatorClient('auto', 5_000).estimate(
      request('subscription'),
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    expect(expectFailure(await pending)).toEqual({
      kind: 'cancelled',
      message: 'The estimator request was cancelled.',
      retryable: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns cancellation immediately when the caller signal is already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    const result = await new MockEstimatorClient('auto', 5_000).estimate(
      request('api'),
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    expect(expectFailure(result).kind).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a fixture whose delay exceeds the request timeout', async () => {
    vi.useFakeTimers();
    const pending = new MockEstimatorClient('auto', 2_000).estimate(
      request('api'),
      { timeoutMs: 500 },
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(expectFailure(await pending)).toEqual({
      kind: 'timeout',
      message: 'The estimator request timed out.',
      retryable: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a fixture complete before a later timeout', async () => {
    vi.useFakeTimers();
    const pending = new MockEstimatorClient('auto', 250).estimate(
      request('subscription'),
      { timeoutMs: 500 },
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(expectReady(await pending).accessMode).toBe('subscription');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createEstimatorClient', () => {
  it('switches between the mock and endpoint implementations without source changes', async () => {
    const fetchImplementation = vi.fn(async () => new Response('{}'));
    const mock = createEstimatorClient(
      {
        mode: 'mock',
        endpoint: 'https://example.test/v1/estimates',
        mockScenario: 'auto',
        mockDelayMs: 0,
      },
      fetchImplementation,
    );
    const endpoint = createEstimatorClient(
      {
        mode: 'endpoint',
        endpoint: 'https://example.test/v1/estimates',
        mockScenario: 'malformed',
        mockDelayMs: 30_000,
      },
      fetchImplementation,
    );

    expect(mock).toBeInstanceOf(MockEstimatorClient);
    expect(endpoint).toBeInstanceOf(HttpEstimatorClient);
    expect(expectReady(await mock.estimate(request('api'))).accessMode).toBe('api');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

function request(accessMode: AccessMode): EstimateRequest {
  return buildEstimateRequest({
    prompt: PRIVATE_PROMPT,
    model: MODEL,
    accessMode,
    clientVersion: '0.1.0-test',
    budgetThreshold: 0.1,
  });
}

function expectReady(result: EstimateResult): ReadyEstimate {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected a ready estimate, received ${result.error.kind}`);
  }

  return result.value;
}

function expectFailure(result: EstimateResult): EstimatorError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected an estimate failure');
  }

  return result.error;
}
