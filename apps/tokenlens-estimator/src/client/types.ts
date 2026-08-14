import type { EstimateRequest, ReadyEstimate } from '../contract';

export type EstimatorErrorKind =
  | 'configuration'
  | 'invalid_request'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'endpoint'
  | 'invalid_response';

export interface EstimatorError {
  kind: EstimatorErrorKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  code?: string;
}

export type EstimateResult =
  | { ok: true; value: ReadyEstimate }
  | { ok: false; error: EstimatorError };

export interface EstimateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EstimatorClient {
  estimate(request: EstimateRequest, options?: EstimateOptions): Promise<EstimateResult>;
}

export function estimateFailure(
  kind: EstimatorErrorKind,
  message: string,
  retryable: boolean,
  metadata: Pick<EstimatorError, 'statusCode' | 'code'> = {},
): EstimateResult {
  return {
    ok: false,
    error: {
      kind,
      message,
      retryable,
      ...metadata,
    },
  };
}
