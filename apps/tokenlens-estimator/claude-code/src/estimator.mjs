import { ratesFor } from './pricing.mjs';

const CHARACTERS_PER_TOKEN = 4;
const PER_MILLION = 1_000_000;

/** Rough character-based token count. Good to roughly +/-15% for English prose. */
export function approximateTokens(text) {
  const characters = Array.from(typeof text === 'string' ? text : '').length;
  return { characters, tokens: characters === 0 ? 0 : Math.ceil(characters / CHARACTERS_PER_TOKEN) };
}

/**
 * Estimates what the next model call costs.
 *
 * Unlike the Cursor build, which priced the prompt alone, this accounts for the
 * dominant cost in Claude Code: the entire conversation is re-sent on every
 * turn. A 200-character prompt on top of 60k tokens of context is billed almost
 * entirely on that context.
 *
 *   cache read  = context already in the window, at the cache-hit rate
 *   new input   = this prompt, written into the cache
 *   output      = the reply, at the assumed length
 */
export function estimateTurn({
  prompt = '',
  featureInputTokens,
  contextTokens = 0,
  model,
  expectedOutputTokens = 1200,
  pricing,
} = {}) {
  const rates = ratesFor(model, pricing);
  const measured = approximateTokens(prompt);
  const promptTokens = Number.isSafeInteger(featureInputTokens) && featureInputTokens >= 0
    ? featureInputTokens
    : measured.tokens;
  const { characters } = measured;
  const context = Math.max(0, Math.round(contextTokens) || 0);

  const cacheReadUsd = (context * rates.cacheRead) / PER_MILLION;
  const newInputUsd = (promptTokens * rates.cacheWrite) / PER_MILLION;
  const outputUsd = (Math.max(0, expectedOutputTokens) * rates.output) / PER_MILLION;
  const totalUsd = cacheReadUsd + newInputUsd + outputUsd;

  return {
    model: model ?? null,
    family: rates.family,
    characters,
    promptTokens,
    contextTokens: context,
    expectedOutputTokens: Math.max(0, expectedOutputTokens),
    breakdown: { cacheReadUsd, newInputUsd, outputUsd },
    totalUsd,
    formattedTotal: formatUsd(totalUsd),
  };
}

/**
 * Money is rendered at the precision that makes it readable: sub-cent estimates
 * keep four decimals so a longer prompt visibly costs more, larger ones round
 * to cents.
 */
export function formatUsd(amount) {
  const value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
