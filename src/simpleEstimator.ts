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
export function estimatePromptByCharacterCount(
  characterCount: number,
): PromptEstimate {
  if (
    !Number.isSafeInteger(characterCount) ||
    characterCount < 0 ||
    characterCount > MAX_PROMPT_LENGTH
  ) {
    throw new RangeError(
      `characterCount must be an integer between 0 and ${MAX_PROMPT_LENGTH}.`,
    );
  }

  const estimatedTokens = Math.max(
    characterCount === 0 ? 0 : 1,
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
