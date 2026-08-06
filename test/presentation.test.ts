import { describe, expect, it } from 'vitest';
import { estimatePromptByLength } from '../src/simpleEstimator';
import { buildStatusBarPresentation } from '../src/ui/presentation';

describe('buildStatusBarPresentation', () => {
  it('shows that prompts run normally while the gate is off', () => {
    expect(
      buildStatusBarPresentation({ kind: 'idle' }, { gateEnabled: false }),
    ).toEqual({
      text: '$(circle-slash) Estimate gate off',
      accessibilityLabel: 'TokenLens estimate gate disabled. Open actions.',
      tooltipParagraphs: [
        'TokenLens estimate gate is disabled.',
        'Cursor prompts run normally. Click the chip to enable Enter-to-estimate behavior.',
      ],
    });
  });

  it('explains the Enter-to-estimate behavior while enabled', () => {
    expect(
      buildStatusBarPresentation({ kind: 'idle' }, { gateEnabled: true }),
    ).toEqual({
      text: '$(shield) Enter → estimate',
      accessibilityLabel:
        'TokenLens estimate gate enabled. First Enter estimates; second unchanged Enter sends. Open actions.',
      tooltipParagraphs: [
        'TokenLens estimate gate is enabled.',
        'First Enter in Cursor side chat pauses the prompt and shows its length-based estimate.',
        'Second Enter sends it if it is unchanged. Editing it requires a new estimate first.',
      ],
    });
  });

  it('shows the single dollar estimate for a stopped prompt', () => {
    const estimate = estimatePromptByLength('a'.repeat(1_000));

    expect(
      buildStatusBarPresentation(
        { kind: 'blocked', estimate },
        { gateEnabled: true },
      ),
    ).toEqual({
      text: '$(stop-circle) Est. $0.01100',
      accessibilityLabel:
        'TokenLens estimated and paused the last prompt. Estimated cost $0.01100. Press Enter again unchanged to send. Open actions.',
      tooltipParagraphs: [
        'TokenLens · Prompt estimated and paused',
        'Estimated cost: $0.01100',
        'Prompt length: 1,000 characters',
        'Approximate input size: 250 tokens',
        'This is a simple local estimate based only on prompt length.',
        'The Agent did not run. Press Enter again without editing to send the prompt.',
        'If you edit it, the next Enter estimates again and one more Enter sends it.',
      ],
    });
  });
});
