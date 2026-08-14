import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../../model/feature-manifest.json', import.meta.url), 'utf8'),
);

/** The tokenizer definition pinned by the provisional v1 feature contract. */
export const TOKENIZER = Object.freeze({ ...manifest.tokenizer });

/**
 * The provisional v1 contract normalizes only line endings. It does not
 * apply NFC/NFKC normalization or trim the submitted text.
 */
export function normalizeNewlines(text) {
  const value = typeof text === 'string' ? text : '';
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Counts Unicode code points with the approximation pinned by the manifest.
 * Returning an integer (rather than token strings) is intentional: this
 * tokenizer is the manifest-defined char/4 approximation, not a vocabulary-based
 * tokenizer.
 */
export function countTokens(text, tokenizer = TOKENIZER) {
  const charactersPerToken = tokenizer?.characters_per_token;
  if (!Number.isInteger(charactersPerToken) || charactersPerToken <= 0) {
    throw new TypeError('Tokenizer characters_per_token must be a positive integer');
  }

  const normalized = normalizeNewlines(text);
  const characters = Array.from(normalized).length;
  return characters === 0 ? 0 : Math.ceil(characters / charactersPerToken);
}

/** Clear, short alias for feature collectors. */
export const tokenize = countTokens;

/** Stable metadata value written to the collection envelope. */
export function tokenizerLabel(tokenizer = TOKENIZER) {
  const name = typeof tokenizer?.name === 'string' ? tokenizer.name : '';
  const version = typeof tokenizer?.version === 'string' ? tokenizer.version : '';
  if (name === '' || version === '') {
    throw new TypeError('Tokenizer name and version are required');
  }
  return `${name}@${version}`;
}
