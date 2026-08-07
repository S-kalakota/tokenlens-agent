/**
 * Published Anthropic list prices in USD per million tokens.
 *
 * `cacheWrite` is the 5-minute ephemeral write rate (1.25x base input) and
 * `cacheRead` is the cache hit rate (0.1x base input). Claude Code caches the
 * conversation aggressively, so almost every token carried into a turn is
 * billed at `cacheRead` rather than `input`.
 *
 * These are list prices, not your bill. Override them in config.json when they
 * change or when your account is priced differently.
 */
export const DEFAULT_PRICING = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export const FALLBACK_FAMILY = 'sonnet';

/**
 * Maps a model id such as `claude-sonnet-5` or `claude-haiku-4-5-20251001`
 * onto a pricing family. Unknown ids fall back to Sonnet so that a new model
 * name never turns into a $0.00 estimate.
 */
export function pricingFamilyFor(model) {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  return FALLBACK_FAMILY;
}

/** Resolves the per-million-token rates for a model, honouring user overrides. */
export function ratesFor(model, pricing = DEFAULT_PRICING) {
  const family = pricingFamilyFor(model);
  const overrides = pricing?.[family];
  return { ...DEFAULT_PRICING[family], ...(overrides ?? {}), family };
}
