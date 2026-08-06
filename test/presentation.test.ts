import { describe, expect, it } from 'vitest';

import type { ReadyEstimate } from '../src/contract';
import type { EstimateViewState } from '../src/estimateSession';
import {
  buildStatusBarPresentation,
  type PresentationContext,
} from '../src/ui/presentation';

const MODEL_SOURCE_NOTE =
  "Model reflects your TokenLens setting, not a detected value from Cursor's active session.";

const context: PresentationContext = {
  model: 'claude-sonnet-4',
  accessMode: 'api',
  estimatorMode: 'endpoint',
};

describe('buildStatusBarPresentation', () => {
  it('renders the idle state with configuration details and model disclosure', () => {
    const presentation = buildStatusBarPresentation({ kind: 'idle' }, context);

    expect(presentation).toEqual({
      text: '$(circle-outline) No estimate',
      accessibilityLabel: 'TokenLens, no estimate. Open actions.',
      tooltipParagraphs: [
        'TokenLens',
        'No estimate is available. Click the chip to choose a prompt source.',
        'Configured model: claude-sonnet-4',
        'Access: Token-based API',
        'Estimator: Configured endpoint',
        MODEL_SOURCE_NOTE,
      ],
      emphasis: 'normal',
    });
  });

  it('renders the loading state with configuration details and model disclosure', () => {
    const presentation = buildStatusBarPresentation({ kind: 'loading' }, context);

    expect(presentation).toEqual({
      text: '$(loading~spin) Estimating…',
      accessibilityLabel: 'TokenLens is estimating. Open actions.',
      tooltipParagraphs: [
        'TokenLens',
        'Estimate status: Loading',
        'Configured model: claude-sonnet-4',
        'Access: Token-based API',
        'Estimator: Configured endpoint',
        MODEL_SOURCE_NOTE,
      ],
      emphasis: 'normal',
    });
  });

  it('renders a ready API estimate with its endpoint-provided display content', () => {
    const estimate = readyEstimate('api', false);
    const presentation = buildStatusBarPresentation(
      { kind: 'ready', estimate },
      context,
    );

    expect(presentation).toEqual({
      text: '$(circle-filled) Est. $0.02–$0.06',
      accessibilityLabel:
        'TokenLens, Est. $0.02–$0.06, estimate ready. Open actions.',
      tooltipParagraphs: [
        'Endpoint title',
        'Endpoint summary',
        'Access: Token-based API',
        'Estimate status: Ready',
        'Endpoint disclaimer',
        'Configured model: claude-sonnet-4',
        MODEL_SOURCE_NOTE,
      ],
      emphasis: 'normal',
    });
  });

  it('renders a ready subscription estimate with its endpoint-provided display content', () => {
    const estimate = readyEstimate('subscription', false);
    const presentation = buildStatusBarPresentation(
      { kind: 'ready', estimate },
      { ...context, accessMode: 'subscription' },
    );

    expect(presentation).toEqual({
      text: '$(circle-filled) Usage: Low',
      accessibilityLabel:
        'TokenLens, Usage: Low, estimate ready. Open actions.',
      tooltipParagraphs: [
        'Endpoint title',
        'Endpoint summary',
        'Access: Subscription',
        'Estimate status: Ready',
        'Endpoint disclaimer',
        'Configured model: claude-sonnet-4',
        MODEL_SOURCE_NOTE,
      ],
      emphasis: 'normal',
    });
  });

  it('renders the unavailable state with its safe error and model disclosure', () => {
    const state: EstimateViewState = {
      kind: 'unavailable',
      error: {
        kind: 'timeout',
        message: 'The estimator request timed out.',
        retryable: true,
      },
    };

    const presentation = buildStatusBarPresentation(state, context);

    expect(presentation).toEqual({
      text: '$(error) Estimate unavailable',
      accessibilityLabel: 'TokenLens estimate unavailable. Open actions.',
      tooltipParagraphs: [
        'TokenLens · Estimate unavailable',
        'The estimator request timed out.',
        'Estimate status: Unavailable',
        'Configured model: claude-sonnet-4',
        'Access: Token-based API',
        'Estimator: Configured endpoint',
        MODEL_SOURCE_NOTE,
      ],
      emphasis: 'error',
    });
  });

  it('uses the warning presentation when the endpoint marks an estimate over budget', () => {
    const estimate = readyEstimate('api', true);
    const presentation = buildStatusBarPresentation(
      { kind: 'ready', estimate },
      context,
    );

    expect(presentation.text).toBe('$(warning) Est. $0.18–$0.25');
    expect(presentation.emphasis).toBe('warning');
    expect(presentation.accessibilityLabel).toContain(
      'above the configured threshold',
    );
    expect(presentation.tooltipParagraphs).toContain(
      'Estimate status: Above configured threshold',
    );
    expect(presentation.tooltipParagraphs).toContain(MODEL_SOURCE_NOTE);
    expect(presentation.tooltipParagraphs).toContain(
      'Configured model: claude-sonnet-4',
    );
  });
});

function readyEstimate(
  accessMode: ReadyEstimate['accessMode'],
  isOverThreshold: boolean,
): ReadyEstimate {
  return {
    estimateId: isOverThreshold ? 'est_over_budget' : 'est_ready',
    status: 'ready',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    accessMode,
    display: {
      chipText:
        accessMode === 'subscription'
          ? 'Usage: Low'
          : isOverThreshold
            ? 'Est. $0.18–$0.25'
            : 'Est. $0.02–$0.06',
      title: 'Endpoint title',
      summary: 'Endpoint summary',
      disclaimer: 'Endpoint disclaimer',
    },
    budget: {
      isOverThreshold,
    },
    metadata: {
      estimatorVersion: 'test-v1',
      generatedAt: '2026-08-05T00:00:00Z',
    },
  };
}
