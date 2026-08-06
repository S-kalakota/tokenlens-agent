import { describe, expect, it } from 'vitest';
import { estimatePromptByLength } from '../src/simpleEstimator';

describe('estimatePromptByLength', () => {
  it('always gives a longer prompt a higher unrounded estimate', () => {
    const short = estimatePromptByLength('a'.repeat(100));
    const medium = estimatePromptByLength('a'.repeat(1_000));
    const long = estimatePromptByLength('a'.repeat(10_000));

    expect(short.estimatedCostUsd).toBeCloseTo(0.002, 8);
    expect(medium.estimatedCostUsd).toBeCloseTo(0.011, 8);
    expect(long.estimatedCostUsd).toBeCloseTo(0.101, 8);
    expect(short.estimatedCostUsd).toBeLessThan(medium.estimatedCostUsd);
    expect(medium.estimatedCostUsd).toBeLessThan(long.estimatedCostUsd);
  });

  it('returns the one supported dollar display format', () => {
    expect(estimatePromptByLength('a'.repeat(100))).toMatchObject({
      characterCount: 100,
      estimatedTokens: 25,
      formattedCost: '$0.00200',
      chipText: 'Est. $0.00200',
    });
  });

  it('counts Unicode characters rather than UTF-16 code units', () => {
    expect(estimatePromptByLength('A🙂B').characterCount).toBe(3);
  });
});
