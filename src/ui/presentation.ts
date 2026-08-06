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
      accessibilityLabel: `TokenLens stopped the last prompt. Estimated cost ${state.estimate.formattedCost}. Open actions.`,
      tooltipParagraphs: [
        'TokenLens · Prompt stopped',
        `Estimated cost: ${state.estimate.formattedCost}`,
        `Prompt length: ${state.estimate.characterCount.toLocaleString('en-US')} characters`,
        `Approximate input size: ${state.estimate.estimatedTokens.toLocaleString('en-US')} tokens`,
        'This is a simple local estimate based only on prompt length.',
        'The Agent did not run. Disable the estimate gate to allow prompts through.',
      ],
    };
  }

  return context.gateEnabled
    ? {
        text: '$(shield) Enter → estimate',
        accessibilityLabel:
          'TokenLens estimate gate enabled. Submitted prompts will be stopped. Open actions.',
        tooltipParagraphs: [
          'TokenLens estimate gate is enabled.',
          'Press Enter in Cursor side chat to stop the prompt and see its length-based estimate.',
          'Disable the gate when you want Cursor to run prompts normally.',
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
