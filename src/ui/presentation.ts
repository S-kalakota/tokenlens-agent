import type { EstimateViewState } from '../viewState';

export interface StatusBarPresentation {
  text: string;
  accessibilityLabel: string;
  tooltipParagraphs: string[];
}

export function buildStatusBarPresentation(
  state: EstimateViewState,
): StatusBarPresentation {
  switch (state.kind) {
    case 'disabled':
      return {
        text: '$(circle-slash) Live estimate off',
        accessibilityLabel: 'TokenLens live estimate disabled. Open actions.',
        tooltipParagraphs: [
          'TokenLens live estimate is disabled.',
          'Cursor prompts submit normally. Click the chip to enable live estimates.',
        ],
      };
    case 'permission-missing':
      return {
        text: '$(lock) Grant Accessibility',
        accessibilityLabel:
          'TokenLens needs macOS Accessibility permission. Open actions.',
        tooltipParagraphs: [
          'TokenLens needs macOS Accessibility permission.',
          'macOS grants broad UI-reading access. TokenLens restricts itself to counting characters in the focused Cursor chat field and never sends prompt text to the extension.',
          'Click the chip to request permission or open System Settings.',
        ],
      };
    case 'paused':
      return {
        text: '$(debug-pause) Live estimate paused',
        accessibilityLabel:
          'TokenLens live estimate paused because this Cursor window is not focused. Open actions.',
        tooltipParagraphs: [
          'TokenLens live estimate is paused.',
          'Focus this Cursor window to resume local draft-length observation.',
        ],
      };
    case 'waiting-for-chat':
      return {
        text: '$(comment-discussion) Waiting for Cursor chat',
        accessibilityLabel:
          'TokenLens is waiting for the Cursor chat input. Open actions.',
        tooltipParagraphs: [
          'TokenLens is enabled and waiting for Cursor chat.',
          'Focus the native side-chat prompt box to begin estimating.',
        ],
      };
    case 'draft-empty':
      return {
        text: '$(edit) Start typing for estimate',
        accessibilityLabel:
          'TokenLens found an empty Cursor chat draft. Open actions.',
        tooltipParagraphs: [
          'TokenLens found the focused Cursor chat field.',
          'Start typing to see a local length-based estimate.',
        ],
      };
    case 'estimate':
      return {
        text: state.estimate.chipText,
        accessibilityLabel: `TokenLens estimated cost ${state.estimate.formattedCost}. Open actions.`,
        tooltipParagraphs: [
          'TokenLens · Live prompt estimate',
          `Estimated cost: ${state.estimate.formattedCost}`,
          `Prompt length: ${state.estimate.characterCount.toLocaleString('en-US')} characters`,
          `Approximate input size: ${state.estimate.estimatedTokens.toLocaleString('en-US')} tokens`,
          'This is a simple local estimate based only on character count, not a provider quote.',
          'Press Enter once to submit normally. TokenLens does not intercept Enter.',
        ],
      };
    case 'unavailable':
      return {
        text: '$(warning) Live estimate unavailable',
        accessibilityLabel: 'TokenLens live estimate unavailable. Open actions.',
        tooltipParagraphs: [
          'TokenLens live estimate is unavailable.',
          state.reason ??
            'The native macOS helper could not observe a supported Cursor chat field.',
          'Cursor prompts are unaffected and submit normally.',
        ],
      };
  }
}
