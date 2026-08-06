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
        'TokenLens estimate gate enabled. Submitted prompts will be stopped. Open actions.',
      tooltipParagraphs: [
        'TokenLens estimate gate is enabled.',
        'Press Enter in Cursor side chat to stop the prompt and see its length-based estimate.',
        'Disable the gate when you want Cursor to run prompts normally.',
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
        'TokenLens stopped the last prompt. Estimated cost $0.01100. Open actions.',
      tooltipParagraphs: [
        'TokenLens · Prompt stopped',
        'Estimated cost: $0.01100',
        'Prompt length: 1,000 characters',
        'Approximate input size: 250 tokens',
        'This is a simple local estimate based only on prompt length.',
        'The Agent did not run. Disable the estimate gate to allow prompts through.',
      ],
    });
  });
});
