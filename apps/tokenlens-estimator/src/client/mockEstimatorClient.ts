import { estimateRequestSchema, type EstimateRequest } from '../contract';
import { abortableDelay, createAbortScope } from './abortScope';
import { createMockPayload, type MockScenario } from './mockFixtures';
import { interpretEstimatorPayload } from './responseValidation';
import {
  estimateFailure,
  type EstimateOptions,
  type EstimateResult,
  type EstimatorClient,
} from './types';

export class MockEstimatorClient implements EstimatorClient {
  public constructor(
    private readonly scenario: MockScenario,
    private readonly delayMs: number,
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

    const abortScope = createAbortScope(options.signal, options.timeoutMs);
    try {
      if (abortScope.source() !== undefined) {
        return cancellationResult(abortScope.source());
      }

      await abortableDelay(this.delayMs, abortScope.signal);
      return interpretEstimatorPayload(
        createMockPayload(this.scenario, parsedRequest.data),
        parsedRequest.data,
      );
    } catch {
      return cancellationResult(abortScope.source());
    } finally {
      abortScope.dispose();
    }
  }
}

function cancellationResult(
  source: 'cancelled' | 'timeout' | undefined,
): EstimateResult {
  return source === 'timeout'
    ? estimateFailure('timeout', 'The estimator request timed out.', true)
    : estimateFailure('cancelled', 'The estimator request was cancelled.', false);
}
