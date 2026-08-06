import { describe, expect, it } from 'vitest';
import { estimatePromptByCharacterCount } from '../src/simpleEstimator';
import { buildStatusBarPresentation } from '../src/ui/presentation';
import type { EstimateViewState } from '../src/viewState';

describe('buildStatusBarPresentation', () => {
  it.each<[EstimateViewState, string]>([
    [{ kind: 'disabled' }, '$(circle-slash) Live estimate off'],
    [{ kind: 'permission-missing' }, '$(lock) Grant Accessibility'],
    [{ kind: 'paused' }, '$(debug-pause) Live estimate paused'],
    [
      { kind: 'waiting-for-chat' },
      '$(comment-discussion) Waiting for Cursor chat',
    ],
    [{ kind: 'draft-empty' }, '$(edit) Start typing for estimate'],
    [{ kind: 'unavailable' }, '$(warning) Live estimate unavailable'],
  ])('presents $state.kind as one status-chip state', (state, text) => {
    const presentation = buildStatusBarPresentation(state);
    expect(presentation.text).toBe(text);
    expect(presentation.accessibilityLabel).toMatch(/TokenLens/);
    expect(presentation.tooltipParagraphs.length).toBeGreaterThan(0);
  });

  it('shows the live dollar estimate and normal one-Enter workflow', () => {
    const presentation = buildStatusBarPresentation({
      kind: 'estimate',
      estimate: estimatePromptByCharacterCount(1_000),
    });
    expect(presentation).toEqual({
      text: 'Est. $0.01100',
      accessibilityLabel: 'TokenLens estimated cost $0.01100. Open actions.',
      tooltipParagraphs: [
        'TokenLens · Live prompt estimate',
        'Estimated cost: $0.01100',
        'Prompt length: 1,000 characters',
        'Approximate input size: 250 tokens',
        'This is a simple local estimate based only on character count, not a provider quote.',
        'Press Enter once to submit normally. TokenLens does not intercept Enter.',
      ],
    });
    expect(JSON.stringify(presentation)).not.toMatch(/second Enter|paused the prompt/i);
  });
});
