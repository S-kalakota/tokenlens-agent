import {
  estimateRequestSchema,
  estimateResponseSchema,
  type EstimateRequest,
  type EstimateResponse,
} from '../contract';
import { estimateFailure, type EstimateResult } from './types';

export function interpretEstimatorPayload(
  payload: unknown,
  request: EstimateRequest,
): EstimateResult {
  if (!estimateRequestSchema.safeParse(request).success) {
    return estimateFailure(
      'invalid_request',
      'The estimate request is not valid.',
      false,
    );
  }

  const parsed = estimateResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return estimateFailure(
      'invalid_response',
      'The estimator returned an unsupported response.',
      false,
    );
  }

  return resultFromParsedResponse(parsed.data, request);
}

function resultFromParsedResponse(
  response: EstimateResponse,
  request: EstimateRequest,
): EstimateResult {
  if (response.status === 'error') {
    return estimateFailure(
      'endpoint',
      'The estimator could not provide an estimate.',
      true,
      { code: response.error.code },
    );
  }

  if (
    response.provider !== request.provider ||
    response.model !== request.model ||
    response.accessMode !== request.accessMode
  ) {
    return estimateFailure(
      'invalid_response',
      'The estimator response does not match the request settings.',
      false,
    );
  }

  return { ok: true, value: response };
}
