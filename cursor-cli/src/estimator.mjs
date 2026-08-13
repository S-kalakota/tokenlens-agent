import { ratesFor } from './pricing.mjs';

const CHARACTERS_PER_TOKEN = 4;
const PER_MILLION = 1_000_000;

/** Rough character-based token count for prompt and transcript estimates. */
export function approximateTokens(text) {
  const characters = Array.from(typeof text === 'string' ? text : '').length;
  return {
    characters,
    tokens: characters === 0 ? 0 : Math.ceil(characters / CHARACTERS_PER_TOKEN),
  };
}

export function estimateTurn({
  prompt = '',
  contextTokens = 0,
  model,
  expectedOutputTokens = 1200,
  pricing,
} = {}) {
  const rates = ratesFor(model, pricing);
  const { characters, tokens: promptTokens } = approximateTokens(prompt);
  const context = Math.max(0, Math.round(contextTokens) || 0);
  const output = Math.max(0, Math.round(expectedOutputTokens) || 0);

  const cachedInputUsd = (context * rates.cachedInput) / PER_MILLION;
  const newInputUsd = (promptTokens * rates.input) / PER_MILLION;
  const outputUsd = (output * rates.output) / PER_MILLION;
  const totalUsd = cachedInputUsd + newInputUsd + outputUsd;

  return {
    model: typeof model === 'string' && model !== '' ? model : null,
    family: rates.family,
    characters,
    promptTokens,
    contextTokens: context,
    expectedOutputTokens: output,
    breakdown: { cachedInputUsd, newInputUsd, outputUsd },
    totalUsd,
    formattedTotal: formatUsd(totalUsd),
  };
}

export function formatUsd(amount) {
  const value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
