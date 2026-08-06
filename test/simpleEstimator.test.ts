import { describe, expect, it } from 'vitest';
import {
  estimatePromptByCharacterCount,
  MAX_PROMPT_LENGTH,
} from '../src/simpleEstimator';

describe('estimatePromptByCharacterCount', () => {
  it('always gives a longer draft a higher unrounded estimate', () => {
    const short = estimatePromptByCharacterCount(100);
    const medium = estimatePromptByCharacterCount(1_000);
    const long = estimatePromptByCharacterCount(10_000);

    expect(short.estimatedCostUsd).toBeCloseTo(0.002, 8);
    expect(medium.estimatedCostUsd).toBeCloseTo(0.011, 8);
    expect(long.estimatedCostUsd).toBeCloseTo(0.101, 8);
    expect(short.estimatedCostUsd).toBeLessThan(medium.estimatedCostUsd);
    expect(medium.estimatedCostUsd).toBeLessThan(long.estimatedCostUsd);
  });

  it('returns the one supported dollar display format', () => {
    expect(estimatePromptByCharacterCount(100)).toEqual({
      characterCount: 100,
      estimatedTokens: 25,
      estimatedCostUsd: 0.002,
      formattedCost: '$0.00200',
      chipText: 'Est. $0.00200',
    });
  });

  it('accepts an empty count but reports no approximate tokens', () => {
    expect(estimatePromptByCharacterCount(0)).toMatchObject({
      characterCount: 0,
      estimatedTokens: 0,
      formattedCost: '$0.00100',
    });
  });

  it.each([-1, 1.5, Number.NaN, MAX_PROMPT_LENGTH + 1])(
    'rejects invalid character count %s',
    (value) => {
      expect(() => estimatePromptByCharacterCount(value)).toThrow(RangeError);
    },
  );
});
