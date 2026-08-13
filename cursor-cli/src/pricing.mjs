/**
 * Default USD rates per million tokens.
 *
 * Cursor charges selected third-party models at their provider API price. Auto
 * has Cursor's own published rate. These defaults are estimates and can be
 * overridden in config.json when provider prices or account terms differ.
 */
export const DEFAULT_PRICING = {
  auto: { input: 1.25, output: 6, cachedInput: 0.25 },
  opus: { input: 15, output: 75, cachedInput: 1.5 },
  sonnet: { input: 3, output: 15, cachedInput: 0.3 },
  haiku: { input: 1, output: 5, cachedInput: 0.1 },
};

export const FALLBACK_FAMILY = 'auto';

/** Maps the selected Cursor model id onto a configurable pricing family. */
export function pricingFamilyFor(model) {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  return FALLBACK_FAMILY;
}

/** Resolves per-million-token rates, honoring user overrides. */
export function ratesFor(model, pricing = DEFAULT_PRICING) {
  const family = pricingFamilyFor(model);
  return {
    ...DEFAULT_PRICING[family],
    ...(pricing?.[family] ?? {}),
    family,
  };
}
