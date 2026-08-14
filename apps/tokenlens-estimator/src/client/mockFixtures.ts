import type {
  AccessMode,
  EndpointErrorResponse,
  EstimateRequest,
  ReadyEstimate,
} from '../contract';

export type MockScenario =
  | 'auto'
  | 'api-ready'
  | 'subscription-ready'
  | 'over-budget'
  | 'unavailable'
  | 'malformed';

export function createMockPayload(
  scenario: MockScenario,
  request: EstimateRequest,
): unknown {
  switch (scenario) {
    case 'auto':
      return readyFixture(request, request.accessMode, false);
    case 'api-ready':
      return readyFixture(request, 'api', false);
    case 'subscription-ready':
      return readyFixture(request, 'subscription', false);
    case 'over-budget':
      return readyFixture(request, request.accessMode, true);
    case 'unavailable':
      return unavailableFixture();
    case 'malformed':
      return {
        status: 'ready',
        display: {
          chipText: 42,
        },
      };
  }
}

function readyFixture(
  request: EstimateRequest,
  accessMode: AccessMode,
  isOverThreshold: boolean,
): ReadyEstimate {
  const apiDisplay = isOverThreshold
    ? {
        chipText: 'Est. $0.18–$0.25',
        title: 'Claude Sonnet 4 · Estimated API cost',
        summary: 'Estimated range: $0.18–$0.25',
        disclaimer: 'This is a predicted range, not a final bill.',
      }
    : {
        chipText: 'Est. $0.02–$0.06',
        title: 'Claude Sonnet 4 · Estimated API cost',
        summary: 'Estimated range: $0.02–$0.06',
        disclaimer: 'This is a predicted range, not a final bill.',
      };

  const subscriptionDisplay = isOverThreshold
    ? {
        chipText: 'Usage: High',
        title: 'Claude Sonnet 4 · Subscription usage',
        summary: 'Estimated subscription impact: High',
        disclaimer: 'This is a relative usage estimate, not a per-prompt charge.',
      }
    : {
        chipText: 'Usage: Low',
        title: 'Claude Sonnet 4 · Subscription usage',
        summary: 'Estimated subscription impact: Low',
        disclaimer: 'This is a relative usage estimate, not a per-prompt charge.',
      };

  return {
    estimateId: isOverThreshold ? 'est_mock_over_budget' : `est_mock_${accessMode}`,
    status: 'ready',
    provider: 'anthropic',
    model: request.model,
    accessMode,
    display: accessMode === 'api' ? apiDisplay : subscriptionDisplay,
    budget: {
      isOverThreshold,
    },
    metadata: {
      estimatorVersion: 'placeholder-v1',
      generatedAt: '2026-08-05T00:00:00Z',
    },
  };
}

function unavailableFixture(): EndpointErrorResponse {
  return {
    status: 'error',
    error: {
      code: 'ESTIMATOR_UNAVAILABLE',
      message: 'An estimate is temporarily unavailable.',
    },
  };
}
