export interface PromptEstimate {
  characterCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  formattedCost: string;
  chipText: string;
}

export const MAX_PROMPT_LENGTH = 1_000_000;

const BASE_ESTIMATE_USD = 0.001;
const COST_PER_CHARACTER_USD = 0.00001;
const CHARACTERS_PER_TOKEN = 4;

/**
 * A deliberately simple local estimate. It is not model pricing: every extra
 * character increases the unrounded estimate by a fixed amount.
 */
export function estimatePromptByLength(prompt: string): PromptEstimate {
  const characterCount = Array.from(prompt).length;
  const estimatedTokens = Math.max(
    1,
    Math.ceil(characterCount / CHARACTERS_PER_TOKEN),
  );
  const estimatedCostUsd =
    BASE_ESTIMATE_USD + characterCount * COST_PER_CHARACTER_USD;
  const formattedCost = `$${estimatedCostUsd.toFixed(5)}`;

  return {
    characterCount,
    estimatedTokens,
    estimatedCostUsd,
    formattedCost,
    chipText: `Est. ${formattedCost}`,
  };
}

export function blockedPromptMessage(estimate: PromptEstimate): string {
  return [
    'TokenLens paused this prompt before the Agent ran.',
    `Estimated cost: ${estimate.formattedCost}`,
    `Prompt length: ${estimate.characterCount.toLocaleString('en-US')} characters (about ${estimate.estimatedTokens.toLocaleString('en-US')} tokens).`,
    'Press Enter again without editing to send this prompt.',
    'If you edit it, the next Enter recalculates the estimate and one more Enter sends it.',
  ].join('\n');
}
