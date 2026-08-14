import { describe, expect, it } from 'vitest';

import {
  buildEstimateRequest,
  endpointErrorResponseSchema,
  estimateRequestSchema,
  estimateResponseSchema,
  readyEstimateSchema,
  type EndpointErrorResponse,
  type ReadyEstimate,
} from '../src/contract';

const readyEstimate: ReadyEstimate = {
  estimateId: 'est_contract_123',
  status: 'ready',
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  accessMode: 'api',
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

describe('estimate request contract', () => {
  it('builds only the documented fields and preserves prompt text exactly', () => {
    const prompt = '  Refactor the login flow and add tests.\n';

    expect(
      buildEstimateRequest({
        prompt,
        model: 'claude-sonnet-4',
        accessMode: 'api',
        clientVersion: '0.1.0',
        budgetThreshold: 0.1,
      }),
    ).toEqual({
      prompt,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      accessMode: 'api',
      client: {
        name: 'tokenlens-cursor',
        version: '0.1.0',
      },
      preferences: {
        currency: 'USD',
        budgetThreshold: 0.1,
      },
    });
  });

  it('omits an unset budget threshold and supports subscription mode', () => {
    const request = buildEstimateRequest({
      prompt: 'Explain this selection.',
      model: 'claude-sonnet-4',
      accessMode: 'subscription',
      clientVersion: '0.1.0',
    });

    expect(request.accessMode).toBe('subscription');
    expect(request.preferences).toEqual({ currency: 'USD' });
    expect(Object.hasOwn(request.preferences, 'budgetThreshold')).toBe(false);
  });

  it.each([
    ['blank prompt', { prompt: '   ' }],
    ['blank model', { model: '\t' }],
    ['unknown access mode', { accessMode: 'metered' }],
    ['negative budget threshold', { preferences: { currency: 'USD', budgetThreshold: -0.01 } }],
    ['non-finite budget threshold', { preferences: { currency: 'USD', budgetThreshold: Infinity } }],
  ])('rejects a request with %s', (_label, override) => {
    const validRequest = buildEstimateRequest({
      prompt: 'Add focused tests.',
      model: 'claude-sonnet-4',
      accessMode: 'api',
      clientVersion: '0.1.0',
    });

    expect(
      estimateRequestSchema.safeParse({
        ...validRequest,
        ...override,
      }).success,
    ).toBe(false);
  });
});

describe('estimate response contract', () => {
  it('accepts a complete ready response', () => {
    expect(readyEstimateSchema.parse(readyEstimate)).toEqual(readyEstimate);
    expect(estimateResponseSchema.parse(readyEstimate)).toEqual(readyEstimate);
  });

  it('accepts the endpoint error envelope', () => {
    const response: EndpointErrorResponse = {
      status: 'error',
      error: {
        code: 'ESTIMATOR_UNAVAILABLE',
        message: 'An estimate is temporarily unavailable.',
      },
    };

    expect(endpointErrorResponseSchema.parse(response)).toEqual(response);
    expect(estimateResponseSchema.parse(response)).toEqual(response);
  });

  it('ignores additive response fields for forward compatibility', () => {
    const parsed = estimateResponseSchema.parse({
      ...readyEstimate,
      futureTopLevelField: 'ignored',
      display: {
        ...readyEstimate.display,
        futureDisplayField: 'ignored',
      },
    });

    expect(parsed).toEqual(readyEstimate);
    expect(parsed).not.toHaveProperty('futureTopLevelField');
    expect(parsed.status === 'ready' ? parsed.display : {}).not.toHaveProperty(
      'futureDisplayField',
    );
  });

  it.each([
    ['missing estimate id', { ...readyEstimate, estimateId: undefined }],
    [
      'non-string chip text',
      { ...readyEstimate, display: { ...readyEstimate.display, chipText: 42 } },
    ],
    [
      'blank disclaimer',
      { ...readyEstimate, display: { ...readyEstimate.display, disclaimer: '  ' } },
    ],
    [
      'invalid generated timestamp',
      { ...readyEstimate, metadata: { ...readyEstimate.metadata, generatedAt: 'yesterday' } },
    ],
    ['unsupported status', { ...readyEstimate, status: 'loading' }],
    [
      'invalid endpoint error code',
      { status: 'error', error: { code: 'NOT SAFE', message: 'Unavailable.' } },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(estimateResponseSchema.safeParse(payload).success).toBe(false);
  });
});
