import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEstimateRequest,
  type EstimateRequest,
  type ReadyEstimate,
} from '../src/contract';
import {
  HttpEstimatorClient,
  type FetchImplementation,
} from '../src/client/httpEstimatorClient';

const MAXIMUM_RESPONSE_BYTES = 65_536;

function createRequest(): EstimateRequest {
  return buildEstimateRequest({
    prompt: 'Refactor the login flow and add tests.',
    model: 'claude-sonnet-4',
    accessMode: 'api',
    clientVersion: '0.1.0',
    budgetThreshold: 0.1,
  });
}

function createReadyResponse(request: EstimateRequest): ReadyEstimate {
  return {
    estimateId: 'est_http_123',
    status: 'ready',
    provider: request.provider,
    model: request.model,
    accessMode: request.accessMode,
    display: {
      chipText: 'Est. $0.02–$0.06',
      title: 'Claude Sonnet 4 · Estimated API cost',
      summary: 'Estimated range: $0.02–$0.06',
      disclaimer: 'This is a predicted range, not a final bill.',
    },
    budget: {
      isOverThreshold: false,
    },
    metadata: {
      estimatorVersion: 'placeholder-v1',
      generatedAt: '2026-08-05T00:00:00Z',
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HttpEstimatorClient', () => {
  it('serializes the exact request contract in a JSON POST', async () => {
    const request = createRequest();
    const ready = createReadyResponse(request);
    const fetchMock = vi.fn<FetchImplementation>(async () => jsonResponse(ready));
    const client = new HttpEstimatorClient(
      'https://estimator.example/v1/estimates?tenant=test',
      fetchMock,
    );

    await expect(client.estimate(request, { timeoutMs: 2_000 })).resolves.toEqual({
      ok: true,
      value: ready,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      'https://estimator.example/v1/estimates?tenant=test',
    );
    expect(init).toEqual({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
  });

  it('turns a validated endpoint error into prompt-safe client error data', async () => {
    const request = createRequest();
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      jsonResponse(
        {
          status: 'error',
          error: {
            code: 'ESTIMATOR_UNAVAILABLE',
            message: `Could not estimate prompt: ${request.prompt}`,
          },
        },
        503,
      ),
    );

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(request);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'endpoint',
        message: 'The estimator could not provide an estimate.',
        retryable: true,
        code: 'ESTIMATOR_UNAVAILABLE',
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.prompt);
  });

  it.each([
    ['malformed JSON on success', '{not-json', 200, 'invalid_response', undefined],
    ['malformed JSON on HTTP failure', 'upstream failed', 502, 'http', 502],
  ])(
    'handles %s without exposing the response body',
    async (_label, body, status, expectedKind, expectedStatus) => {
      const request = createRequest();
      const responseBody = `${body}${request.prompt}`;
      const fetchMock = vi.fn<FetchImplementation>(async () =>
        new Response(responseBody, { status }),
      );

      const result = await new HttpEstimatorClient(
        'https://estimator.example/v1/estimates',
        fetchMock,
      ).estimate(request);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('Expected an estimator failure.');
      }
      expect(result.error.kind).toBe(expectedKind);
      expect(result.error.statusCode).toBe(expectedStatus);
      expect(JSON.stringify(result)).not.toContain(request.prompt);
    },
  );

  it('rejects schema-invalid JSON without exposing echoed prompt text', async () => {
    const request = createRequest();
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      jsonResponse({
        status: 'ready',
        display: { chipText: 42 },
        debugEcho: request.prompt,
      }),
    );

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(request);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid_response',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.prompt);
  });

  it('rejects a declared oversized response without reading its body', async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const response = {
      body: { cancel, getReader },
      headers: new Headers({
        'Content-Length': String(MAXIMUM_RESPONSE_BYTES + 1),
      }),
      ok: true,
      status: 200,
    } as unknown as Response;
    const fetchMock = vi.fn<FetchImplementation>(async () => response);

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(createRequest());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_response',
        message: 'The estimator response is too large.',
        retryable: false,
      },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
  });

  it('cancels and rejects an undeclared response that exceeds the byte cap', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAXIMUM_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const response = new Response(body, {
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn<FetchImplementation>(async () => response);

    expect(response.headers.has('Content-Length')).toBe(false);
    await expect(
      new HttpEstimatorClient(
        'https://estimator.example/v1/estimates',
        fetchMock,
      ).estimate(createRequest()),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'invalid_response',
        message: 'The estimator response is too large.',
        retryable: false,
      },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts and parses a valid response exactly at the byte cap', async () => {
    const request = createRequest();
    const ready = createReadyResponse(request);
    const serialized = JSON.stringify(ready);
    const serializedBytes = new TextEncoder().encode(serialized).byteLength;
    const responseBody = `${serialized}${' '.repeat(
      MAXIMUM_RESPONSE_BYTES - serializedBytes,
    )}`;
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      new Response(responseBody, {
        headers: {
          'Content-Length': String(MAXIMUM_RESPONSE_BYTES),
          'Content-Type': 'application/json',
        },
      }),
    );

    expect(new TextEncoder().encode(responseBody)).toHaveLength(
      MAXIMUM_RESPONSE_BYTES,
    );
    await expect(
      new HttpEstimatorClient(
        'https://estimator.example/v1/estimates',
        fetchMock,
      ).estimate(request),
    ).resolves.toEqual({
      ok: true,
      value: ready,
    });
  });

  it('rejects a ready payload returned with a non-success status', async () => {
    const request = createRequest();
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      jsonResponse(createReadyResponse(request), 500),
    );

    await expect(
      new HttpEstimatorClient(
        'https://estimator.example/v1/estimates',
        fetchMock,
      ).estimate(request),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'http',
        message: 'The estimator endpoint returned an HTTP error.',
        retryable: true,
        statusCode: 500,
      },
    });
  });

  it.each([
    ['remote HTTPS', 'https://estimator.example/v1/estimates'],
    ['localhost HTTP', 'http://localhost:8787/v1/estimates'],
    ['127.x HTTP', 'http://127.42.8.9:8787/v1/estimates'],
    ['IPv6 loopback HTTP', 'http://[::1]:8787/v1/estimates'],
  ])('accepts an endpoint using %s', async (_label, endpoint) => {
    const request = createRequest();
    const ready = createReadyResponse(request);
    const fetchMock = vi.fn<FetchImplementation>(async () => jsonResponse(ready));

    await expect(
      new HttpEstimatorClient(endpoint, fetchMock).estimate(request),
    ).resolves.toEqual({
      ok: true,
      value: ready,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(endpoint);
  });

  it.each([
    'http://estimator.example/v1/estimates',
    'http://192.168.1.25:8787/v1/estimates',
  ])('rejects remote plaintext HTTP before calling fetch: %s', async (endpoint) => {
    const fetchMock = vi.fn<FetchImplementation>();

    const result = await new HttpEstimatorClient(endpoint, fetchMock).estimate(
      createRequest(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'configuration',
        retryable: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'not a url',
    'ftp://estimator.example/v1/estimates',
    'https://user:secret@estimator.example/v1/estimates',
    'https://estimator.example/v1/estimates#fragment',
  ])('rejects invalid endpoint configuration: %s', async (endpoint) => {
    const fetchMock = vi.fn<FetchImplementation>();

    const result = await new HttpEstimatorClient(endpoint, fetchMock).estimate(
      createRequest(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'configuration',
        retryable: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid request before calling fetch', async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const invalidRequest = {
      ...createRequest(),
      prompt: '   ',
    } as EstimateRequest;

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(invalidRequest);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid_request',
        retryable: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports caller cancellation distinctly and aborts the active fetch', async () => {
    const request = createRequest();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<FetchImplementation>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            'abort',
            () => reject(new Error(`aborted while sending ${request.prompt}`)),
            { once: true },
          );
        }),
    );

    const pendingResult = new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(request, { signal: controller.signal, timeoutMs: 60_000 });

    expect(requestSignal?.aborted).toBe(false);
    controller.abort();

    const result = await pendingResult;
    expect(requestSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'cancelled',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.prompt);
  });

  it('does not call fetch when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<FetchImplementation>();

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(createRequest(), { signal: controller.signal });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'cancelled' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an internal deadline as a timeout and aborts fetch', async () => {
    vi.useFakeTimers();
    const request = createRequest();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<FetchImplementation>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            'abort',
            () => reject(new Error(`timeout while sending ${request.prompt}`)),
            { once: true },
          );
        }),
    );

    const pendingResult = new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(request, { timeoutMs: 1 });

    await vi.advanceTimersByTimeAsync(499);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pendingResult;
    expect(requestSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'timeout',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.prompt);
  });

  it('does not expose a rejected fetch error containing the prompt', async () => {
    const request = createRequest();
    const fetchMock = vi.fn<FetchImplementation>(async () => {
      throw new Error(`network failure for ${request.prompt}`);
    });

    const result = await new HttpEstimatorClient(
      'https://estimator.example/v1/estimates',
      fetchMock,
    ).estimate(request);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'network',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.prompt);
  });
});
