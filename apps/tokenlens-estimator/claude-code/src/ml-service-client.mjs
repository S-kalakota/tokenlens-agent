/**
 * Client for the TokenLens output-token estimator.
 *
 * The trained model is a 1.7 MB scikit-learn pipeline, so it runs as a small
 * local HTTP service rather than inside Node. This module is the whole
 * transport boundary: it posts the already-built feature payload and returns a
 * tagged result. It never builds features and never sees prompt text, because
 * `tokenlens.ml-features.v1` carries neither.
 *
 * Every failure is a value, not a throw. The caller decides how to degrade, and
 * the hook's contract is that a broken estimator can never block a prompt.
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/v1/predict';
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 65_536;

/**
 * @returns {Promise<
 *   | { ok: true, prediction: { outputTokens: number, intervalLow: number,
 *       intervalHigh: number, confidence: string, notes: string[] } }
 *   | { ok: false, kind: 'unsupported_model' | 'invalid_request' |
 *       'unavailable' | 'invalid_response', message: string }
 * >}
 */
export async function requestPrediction({
  payload,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImplementation = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch {
    return failure('unavailable', 'The TokenLens estimator service is not running.');
  } finally {
    clearTimeout(timer);
  }

  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    return failure('invalid_response', 'The estimator response is too large.');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return failure('invalid_response', 'The estimator returned malformed JSON.');
  }

  if (body?.status === 'error') {
    // A refused model is a distinct outcome, not a generic error: the model was
    // never trained on it, so no number exists to show. Saying so is the point.
    const kind = body.error?.code === 'UNSUPPORTED_MODEL'
      ? 'unsupported_model'
      : 'invalid_request';
    return failure(kind, String(body.error?.message ?? 'The estimator refused the payload.'));
  }

  if (!response.ok) {
    return failure('unavailable', `The estimator returned HTTP ${response.status}.`);
  }

  const prediction = readPrediction(body);
  return prediction === undefined
    ? failure('invalid_response', 'The estimator response was missing a prediction.')
    : { ok: true, prediction };
}

function readPrediction(body) {
  const tokens = body?.output_tokens;
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;

  const interval = Array.isArray(body.interval_80) ? body.interval_80 : [];
  const [low, high] = interval;

  return {
    outputTokens: Math.round(tokens),
    intervalLow: Number.isFinite(low) ? Math.round(low) : Math.round(tokens),
    intervalHigh: Number.isFinite(high) ? Math.round(high) : Math.round(tokens),
    confidence: typeof body.confidence === 'string' ? body.confidence : 'unknown',
    notes: Array.isArray(body.notes) ? body.notes.filter((n) => typeof n === 'string') : [],
  };
}

function failure(kind, message) {
  return { ok: false, kind, message };
}

export { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS };
