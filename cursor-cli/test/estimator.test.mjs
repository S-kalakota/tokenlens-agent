import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approximateTokens, estimateTurn, formatUsd } from '../src/estimator.mjs';
import { pricingFamilyFor, ratesFor } from '../src/pricing.mjs';

describe('pricing and estimation', () => {
  it('counts prompt characters and approximate tokens', () => {
    assert.deepEqual(approximateTokens('abcde'), { characters: 5, tokens: 2 });
    assert.equal(approximateTokens('👍👍👍👍').characters, 4);
  });

  it('maps Anthropic model names and falls back to Cursor Auto rates', () => {
    assert.equal(pricingFamilyFor('claude-opus-5'), 'opus');
    assert.equal(pricingFamilyFor('claude-sonnet-5'), 'sonnet');
    assert.equal(pricingFamilyFor('claude-haiku-4.5'), 'haiku');
    assert.equal(pricingFamilyFor('gpt-5'), 'auto');
    assert.equal(ratesFor('auto').cachedInput, 0.25);
  });

  it('adds cached context, new input and assumed output', () => {
    const estimate = estimateTurn({
      prompt: 'x'.repeat(4000),
      contextTokens: 100_000,
      model: 'auto',
      expectedOutputTokens: 1000,
    });
    assert.ok(estimate.totalUsd > 0);
    assert.equal(
      estimate.totalUsd,
      estimate.breakdown.cachedInputUsd +
        estimate.breakdown.newInputUsd +
        estimate.breakdown.outputUsd,
    );
  });

  it('formats readable dollar values', () => {
    assert.equal(formatUsd(0.00012), '$0.0001');
    assert.equal(formatUsd(0.0184), '$0.018');
    assert.equal(formatUsd(2.5), '$2.50');
  });
});
