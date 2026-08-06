import type { EstimateViewState } from '../viewState';

export interface PresentationContext {
  gateEnabled: boolean;
}

export interface StatusBarPresentation {
  text: string;
  accessibilityLabel: string;
  tooltipParagraphs: string[];
}

export function buildStatusBarPresentation(
  state: EstimateViewState,
  context: PresentationContext,
): StatusBarPresentation {
  if (state.kind === 'blocked') {
    return {
      text: `$(stop-circle) ${state.estimate.chipText}`,
      accessibilityLabel: `TokenLens estimated and paused the last prompt. Estimated cost ${state.estimate.formattedCost}. Press Enter again unchanged to send. Open actions.`,
      tooltipParagraphs: [
        'TokenLens · Prompt estimated and paused',
        `Estimated cost: ${state.estimate.formattedCost}`,
        `Prompt length: ${state.estimate.characterCount.toLocaleString('en-US')} characters`,
        `Approximate input size: ${state.estimate.estimatedTokens.toLocaleString('en-US')} tokens`,
        'This is a simple local estimate based only on prompt length.',
        'The Agent did not run. Press Enter again without editing to send the prompt.',
        'If you edit it, the next Enter estimates again and one more Enter sends it.',
      ],
    };
  }

  return context.gateEnabled
    ? {
        text: '$(shield) Enter → estimate',
        accessibilityLabel:
          'TokenLens estimate gate enabled. First Enter estimates; second unchanged Enter sends. Open actions.',
        tooltipParagraphs: [
          'TokenLens estimate gate is enabled.',
          'First Enter in Cursor side chat pauses the prompt and shows its length-based estimate.',
          'Second Enter sends it if it is unchanged. Editing it requires a new estimate first.',
        ],
      }
    : {
        text: '$(circle-slash) Estimate gate off',
        accessibilityLabel: 'TokenLens estimate gate disabled. Open actions.',
        tooltipParagraphs: [
          'TokenLens estimate gate is disabled.',
          'Cursor prompts run normally. Click the chip to enable Enter-to-estimate behavior.',
        ],
      };
}
