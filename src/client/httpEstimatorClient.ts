import { estimateRequestSchema, type EstimateRequest } from '../contract';
import { createAbortScope } from './abortScope';
import { interpretEstimatorPayload } from './responseValidation';
import {
  estimateFailure,
  type EstimateOptions,
  type EstimateResult,
  type EstimatorClient,
} from './types';

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const MAXIMUM_RESPONSE_BYTES = 65_536;

export class HttpEstimatorClient implements EstimatorClient {
  public constructor(
    private readonly endpoint: string,
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
  ) {}

  public async estimate(
    request: EstimateRequest,
    options: EstimateOptions = {},
  ): Promise<EstimateResult> {
    const parsedRequest = estimateRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return estimateFailure(
        'invalid_request',
        'The estimate request is not valid.',
        false,
      );
    }

    const endpoint = parseEndpoint(this.endpoint);
    if (endpoint === undefined) {
      return estimateFailure(
        'configuration',
        'Configure an HTTPS estimator endpoint, or use HTTP only for loopback development.',
        false,
      );
    }

    const abortScope = createAbortScope(options.signal, options.timeoutMs);

    try {
      if (abortScope.source() !== undefined) {
        return abortFailure(abortScope.source());
      }

      const response = await this.fetchImplementation(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parsedRequest.data),
        signal: abortScope.signal,
        redirect: 'error',
      });

      if (abortScope.source() !== undefined) {
        return abortFailure(abortScope.source());
      }

      const responseBody = await readBoundedResponseBody(response);
      if (!responseBody.ok) {
        return estimateFailure(
          'invalid_response',
          'The estimator response is too large.',
          false,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseBody.text) as unknown;
      } catch {
        return response.ok
          ? estimateFailure(
              'invalid_response',
              'The estimator returned an unsupported response.',
              false,
            )
          : httpFailure(response.status);
      }

      const result = interpretEstimatorPayload(payload, parsedRequest.data);
      if (!response.ok && (result.ok || result.error.kind === 'invalid_response')) {
        return httpFailure(response.status);
      }

      return result;
    } catch {
      const source = abortScope.source();
      return source === undefined
        ? estimateFailure(
            'network',
            'The estimator endpoint is unavailable.',
            true,
          )
        : abortFailure(source);
    } finally {
      abortScope.dispose();
    }
  }
}

type BoundedResponseBody =
  | { ok: true; text: string }
  | { ok: false };

async function readBoundedResponseBody(
  response: Response,
): Promise<BoundedResponseBody> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAXIMUM_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      return { ok: false };
    }
  }

  if (response.body === null) {
    return { ok: true, text: '' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      text += decoder.decode();
      return { ok: true, text };
    }

    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The response is already being discarded.
      }
      return { ok: false };
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded.
  }
}

function parseEndpoint(value: string): URL | undefined {
  try {
    const endpoint = new URL(value);
    if (
      (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.hash !== '' ||
      (endpoint.protocol === 'http:' && !isLoopbackHostname(endpoint.hostname))
    ) {
      return undefined;
    }

    return endpoint;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') {
    return true;
  }

  const ipv4Parts = normalized.split('.');
  return (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    ipv4Parts[0] === '127'
  );
}

function abortFailure(source: 'cancelled' | 'timeout' | undefined): EstimateResult {
  return source === 'timeout'
    ? estimateFailure('timeout', 'The estimator request timed out.', true)
    : estimateFailure('cancelled', 'The estimator request was cancelled.', false);
}

function httpFailure(statusCode: number): EstimateResult {
  return estimateFailure(
    'http',
    'The estimator endpoint returned an HTTP error.',
    statusCode >= 500 || statusCode === 429,
    { statusCode },
  );
}
