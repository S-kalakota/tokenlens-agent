import { describe, expect, it } from 'vitest';
import { requestPrediction } from '../src/ml-service-client.mjs';

const PAYLOAD = { schema_version: 'tokenlens.ml-features.v1', features: {}, collection: {} };

function respondWith(body, { status = 200, ok = status < 400 } = {}) {
  return async () => ({
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
}

describe('requestPrediction', () => {
  it('returns the prediction when the service answers', async () => {
    const result = await requestPrediction({
      payload: PAYLOAD,
      fetchImplementation: respondWith({
        status: 'ready',
        output_tokens: 1272,
        interval_80: [572, 2734],
        confidence: 'low',
        notes: ['output_format was unspecified'],
      }),
    });

    expect(result).toEqual({
      ok: true,
      prediction: {
        outputTokens: 1272,
        intervalLow: 572,
        intervalHigh: 2734,
        confidence: 'low',
        notes: ['output_format was unspecified'],
      },
    });
  });

  it('reports an unsupported model as its own outcome, not a generic failure', async () => {
    const result = await requestPrediction({
      payload: PAYLOAD,
      fetchImplementation: respondWith(
        {
          status: 'error',
          error: { code: 'UNSUPPORTED_MODEL', message: "TokenLens does not support 'claude-opus-5'." },
        },
        { status: 422 },
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unsupported_model');
    expect(result.message).toContain('claude-opus-5');
  });

  it('reports an unreachable service rather than throwing', async () => {
    const result = await requestPrediction({
      payload: PAYLOAD,
      fetchImplementation: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: 'unavailable',
      message: 'The TokenLens estimator service is not running.',
    });
  });

  it('rejects a response with no usable prediction', async () => {
    const result = await requestPrediction({
      payload: PAYLOAD,
      fetchImplementation: respondWith({ status: 'ready', output_tokens: 'lots' }),
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('invalid_response');
  });

  it('abandons a service that does not answer in time', async () => {
    const result = await requestPrediction({
      payload: PAYLOAD,
      timeoutMs: 5,
      fetchImplementation: (_endpoint, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    expect(result.kind).toBe('unavailable');
  });
});
