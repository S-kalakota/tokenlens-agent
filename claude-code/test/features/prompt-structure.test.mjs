import { describe, expect, it } from 'vitest';
import {
  buildPromptRepresentations,
  countQuestions,
  countRequirements,
  countTaskWords,
  promptMetrics,
  stripCode,
  stripFencedCode,
  stripInlineCode,
} from '../../src/features/prompt-structure.mjs';

describe('prompt representations', () => {
  it('normalizes newlines and blanks fenced code while preserving line positions', () => {
    const prompt = 'Before\r\n```js\r\nreturn valid JSON?\r\n```\rAfter';
    const stripped = stripFencedCode(prompt);

    expect(stripped).not.toContain('return valid JSON');
    expect(stripped.split('\n')).toHaveLength(5);
    expect(stripped).toContain('Before');
    expect(stripped).toContain('After');
  });

  it('blanks inline code independently from prose', () => {
    expect(stripInlineCode('Explain `a ? b : c` now.')).toMatch(/^Explain\s+now\.$/);
    expect(stripCode('Explain `value`\n```js\nhidden\n```')).not.toMatch(/value|hidden/);
  });

  it('builds raw and fenced-code-free prose forms', () => {
    expect(buildPromptRepresentations('Do it.\r\n```\r\ncode\r\n```')).toEqual({
      rawPrompt: 'Do it.\n```\ncode\n```',
      prosePrompt: expect.not.stringContaining('code'),
    });
  });

  it('accepts a longer Markdown closing fence without hiding later prose', () => {
    const prompt = '```js\nquestion?\n````\nExplain this?';
    const stripped = stripFencedCode(prompt);
    expect(stripped).not.toContain('question?');
    expect(stripped).toContain('Explain this?');
    expect(countQuestions(prompt)).toBe(1);
  });

  it('does not treat a fence marker with an info string as a closing fence', () => {
    const prompt = '```txt\n```js\nhidden?\n```\nVisible?';
    expect(countQuestions(prompt)).toBe(1);
  });
});

describe('task word count', () => {
  it('counts Unicode prose and contractions but excludes paths and code', () => {
    const prompt = "Add café support to @src/parser.ts; don't count `const value = 1`.";
    expect(countTaskWords(prompt)).toBe(6);
  });

  it('does not count fenced examples, URLs, punctuation, or Markdown markers', () => {
    const prompt = 'Review **this** at https://example.test/a?x=1.\n```js\ntwo hidden words\n```';
    expect(countTaskWords(prompt)).toBe(3);
  });

  it('does not count a bare filename as task prose', () => {
    expect(countTaskWords('Review README.md now.')).toBe(2);
  });

  it('uses zero for missing or empty input', () => {
    expect(countTaskWords()).toBe(0);
    expect(countTaskWords('')).toBe(0);
  });
});

describe('requirement count', () => {
  it('counts imperative prose, actionable list items, and constraints once each', () => {
    const prompt = [
      'Refactor the parser.',
      '- Preserve the public API.',
      '- Add tests for empty input.',
      'Do not add dependencies.',
    ].join('\n');
    expect(countRequirements(prompt)).toBe(4);
  });

  it('deduplicates a unit that is both imperative and marker-based', () => {
    expect(countRequirements('Ensure the tests must pass.')).toBe(1);
  });

  it('ignores headings, non-actionable bullets, examples, ordinary questions, and code', () => {
    const prompt = [
      '# Requirements',
      '- Existing parser behavior',
      'Example: Add a cache.',
      'How does this work?',
      '```md',
      '- Add hidden behavior.',
      '```',
    ].join('\n');
    expect(countRequirements(prompt)).toBe(0);
  });

  it('counts a question only when it also has an explicit action or constraint', () => {
    expect(countRequirements('Can you add a regression test?')).toBe(1);
    expect(countRequirements('Can you ensure this must remain compatible?')).toBe(1);
  });
});

describe('question count', () => {
  it('counts question units and treats repeated punctuation as one', () => {
    expect(countQuestions('Why now? What changed??? Is it safe?')).toBe(3);
  });

  it('ignores URLs, escaped punctuation, inline code, and fenced code', () => {
    const prompt = [
      'Open https://example.test/search?q=why and explain it\\?',
      'Evaluate `ready ? yes : no`.',
      '```js',
      'why???',
      '```',
      'What remains?',
    ].join('\n');
    expect(countQuestions(prompt)).toBe(1);
  });

  it('does not infer an unstated question', () => {
    expect(countQuestions('Explain why this happens.')).toBe(0);
  });
});

describe('promptMetrics', () => {
  it('returns only the three canonical numeric prompt-structure features', () => {
    expect(promptMetrics('Add café support. Why now?')).toEqual({
      task_word_count: 5,
      n_requirements: 1,
      question_count: 1,
    });
  });
});
