import { describe, expect, it } from 'vitest';
import { approximateTokens, estimateTurn, formatUsd } from '../src/estimator.mjs';
import { pricingFamilyFor, ratesFor } from '../src/pricing.mjs';

describe('approximateTokens', () => {
  it('counts an empty prompt as zero tokens', () => {
    expect(approximateTokens('')).toEqual({ characters: 0, tokens: 0 });
  });

  it('rounds partial tokens up', () => {
    expect(approximateTokens('abcde')).toEqual({ characters: 5, tokens: 2 });
  });

  it('counts astral characters as single characters', () => {
    expect(approximateTokens('👍👍👍👍').characters).toBe(4);
  });
});

describe('pricingFamilyFor', () => {
  it.each([
    ['claude-opus-5', 'opus'],
    ['claude-sonnet-5', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
  ])('maps %s to %s', (model, family) => {
    expect(pricingFamilyFor(model)).toBe(family);
  });

  it('falls back to sonnet for unknown or missing models', () => {
    expect(pricingFamilyFor('some-future-model')).toBe('sonnet');
    expect(pricingFamilyFor(undefined)).toBe('sonnet');
  });
});

describe('ratesFor', () => {
  it('merges user overrides over the built-in list price', () => {
    const rates = ratesFor('claude-sonnet-5', { sonnet: { output: 99 } });
    expect(rates.output).toBe(99);
    expect(rates.cacheRead).toBe(0.3);
  });
});

describe('estimateTurn', () => {
  it('prices context at the cache-read rate, not the input rate', () => {
    const estimate = estimateTurn({
      prompt: '',
      contextTokens: 1_000_000,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 0,
    });
    // 1M cached tokens at $0.30/M, not $3.00/M.
    expect(estimate.totalUsd).toBeCloseTo(0.3, 10);
  });

  it('adds prompt, context and output into the total', () => {
    const estimate = estimateTurn({
      prompt: 'x'.repeat(4000), // 1000 tokens
      contextTokens: 100_000,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 1000,
    });
    const { cacheReadUsd, newInputUsd, outputUsd } = estimate.breakdown;
    expect(cacheReadUsd).toBeCloseTo(0.03, 10);
    expect(newInputUsd).toBeCloseTo(0.00375, 10);
    expect(outputUsd).toBeCloseTo(0.015, 10);
    expect(estimate.totalUsd).toBeCloseTo(cacheReadUsd + newInputUsd + outputUsd, 10);
  });

  it('costs more on Opus than Sonnet for identical work', () => {
    const args = { prompt: 'hello', contextTokens: 50_000, expectedOutputTokens: 1000 };
    const opus = estimateTurn({ ...args, model: 'claude-opus-5' });
    const sonnet = estimateTurn({ ...args, model: 'claude-sonnet-5' });
    expect(opus.totalUsd).toBeGreaterThan(sonnet.totalUsd);
  });

  it('grows monotonically with prompt length', () => {
    const short = estimateTurn({ prompt: 'a'.repeat(100), model: 'claude-sonnet-5' });
    const long = estimateTurn({ prompt: 'a'.repeat(10_000), model: 'claude-sonnet-5' });
    expect(long.totalUsd).toBeGreaterThan(short.totalUsd);
  });

  it('survives missing and negative inputs', () => {
    const estimate = estimateTurn({ contextTokens: -5, expectedOutputTokens: -10 });
    expect(estimate.contextTokens).toBe(0);
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.family).toBe('sonnet');
  });
});

describe('formatUsd', () => {
  it.each([
    [0.00012, '$0.0001'],
    [0.0184, '$0.018'],
    [2.5, '$2.50'],
    [-1, '$0.0000'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});
