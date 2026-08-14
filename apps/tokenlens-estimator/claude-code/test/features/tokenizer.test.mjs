import { describe, expect, it } from 'vitest';
import {
  TOKENIZER,
  countTokens,
  normalizeNewlines,
  tokenize,
  tokenizerLabel,
} from '../../src/features/tokenizer.mjs';

describe('training tokenizer', () => {
  it('is pinned to the checked-in manifest definition', () => {
    expect(TOKENIZER).toEqual({
      name: 'tokenlens-unicode-char4',
      version: '1.0.0',
      characters_per_token: 4,
      normalization: 'newline-only',
    });
    expect(tokenizerLabel()).toBe('tokenlens-unicode-char4@1.0.0');
  });

  it('normalizes CRLF and lone CR without trimming or Unicode normalization', () => {
    expect(normalizeNewlines('  e\u0301\r\nnext\rlast  ')).toBe('  e\u0301\nnext\nlast  ');
  });

  it.each([
    ['', 0],
    ['abcd', 1],
    ['abcde', 2],
    ['👍👍👍👍', 1],
    ['👍👍👍👍a', 2],
    ['ab\r\nc', 1],
  ])('counts %j as %i tokens', (text, expected) => {
    expect(countTokens(text)).toBe(expected);
    expect(tokenize(text)).toBe(expected);
  });

  it('uses the documented zero default for non-string optional input', () => {
    expect(countTokens()).toBe(0);
    expect(countTokens(null)).toBe(0);
  });

  it('rejects incompatible tokenizer configuration instead of guessing', () => {
    expect(() => countTokens('abc', { characters_per_token: 0 })).toThrow(TypeError);
    expect(() => tokenizerLabel({ name: 'tokenlens' })).toThrow(TypeError);
  });
});
