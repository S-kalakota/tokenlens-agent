import type { AccessMode } from '../contract';
import type { EstimatorMode } from '../client/clientFactory';
import type { EstimateViewState } from '../estimateSession';

export interface PresentationContext {
  model: string;
  accessMode: AccessMode;
  estimatorMode: EstimatorMode;
}

export interface StatusBarPresentation {
  text: string;
  accessibilityLabel: string;
  tooltipParagraphs: string[];
  emphasis: 'normal' | 'warning' | 'error';
}

const MODEL_SOURCE_NOTE =
  "Model reflects your TokenLens setting, not a detected value from Cursor's active session.";

export function buildStatusBarPresentation(
  state: EstimateViewState,
  context: PresentationContext,
): StatusBarPresentation {
  const configuredModel = context.model.trim() || 'Not configured';
  const accessLabel = accessModeLabel(context.accessMode);
  const sharedDetails = [
    `Configured model: ${configuredModel}`,
    `Access: ${accessLabel}`,
    `Estimator: ${context.estimatorMode === 'mock' ? 'Local mock' : 'Configured endpoint'}`,
    MODEL_SOURCE_NOTE,
  ];

  switch (state.kind) {
    case 'idle':
      return {
        text: '$(circle-outline) No estimate',
        accessibilityLabel: 'TokenLens, no estimate. Open actions.',
        tooltipParagraphs: [
          'TokenLens',
          'No estimate is available. Click the chip to choose a prompt source.',
          ...sharedDetails,
        ],
        emphasis: 'normal',
      };
    case 'loading':
      return {
        text: '$(loading~spin) Estimating…',
        accessibilityLabel: 'TokenLens is estimating. Open actions.',
        tooltipParagraphs: [
          'TokenLens',
          'Estimate status: Loading',
          ...sharedDetails,
        ],
        emphasis: 'normal',
      };
    case 'ready': {
      const warning = state.estimate.budget.isOverThreshold;
      return {
        text: `${warning ? '$(warning)' : '$(circle-filled)'} ${state.estimate.display.chipText}`,
        accessibilityLabel: `TokenLens, ${state.estimate.display.chipText}, ${warning ? 'above the configured threshold' : 'estimate ready'}. Open actions.`,
        tooltipParagraphs: [
          state.estimate.display.title,
          state.estimate.display.summary,
          `Access: ${accessModeLabel(state.estimate.accessMode)}`,
          `Estimate status: ${warning ? 'Above configured threshold' : 'Ready'}`,
          state.estimate.display.disclaimer,
          `Configured model: ${configuredModel}`,
          MODEL_SOURCE_NOTE,
        ],
        emphasis: warning ? 'warning' : 'normal',
      };
    }
    case 'unavailable':
      return {
        text: '$(error) Estimate unavailable',
        accessibilityLabel: 'TokenLens estimate unavailable. Open actions.',
        tooltipParagraphs: [
          'TokenLens · Estimate unavailable',
          state.error.message,
          'Estimate status: Unavailable',
          ...sharedDetails,
        ],
        emphasis: 'error',
      };
  }
}

function accessModeLabel(accessMode: AccessMode): string {
  return accessMode === 'api' ? 'Token-based API' : 'Subscription';
}
