import { describe, expect, it } from 'vitest';
import {
  classifyDetailLevel,
  classifyOutputFormat,
  classifyPrompt,
  classifyTaskType,
} from '../../src/features/categorical.mjs';

describe('output-format classifier', () => {
  it.each([
    ['Return the result as valid JSON.', 'json'],
    ['Return JSON.', 'json'],
    ['Show a unified diff.', 'patch'],
    ['Return a concise patch.', 'patch'],
    ['Provide the result as a table.', 'table'],
    ['Write the response in Markdown.', 'markdown'],
    ['Explain it in prose.', 'plain_text'],
    ['Implement a cache module.', 'code'],
    ['Review src/config.json for mistakes.', 'unspecified'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classifyOutputFormat(prompt)).toBe(expected);
  });

  it('uses manifest precedence for conflicting explicit formats', () => {
    expect(classifyOutputFormat('Return a Markdown table as valid JSON.')).toBe('json');
  });

  it('ignores format words inside fenced code', () => {
    expect(classifyOutputFormat('Review this example:\n```txt\nreturn valid JSON\n```')).toBe(
      'unspecified',
    );
  });
});

describe('task-type classifier', () => {
  it.each([
    ['Fix the failing parser regression.', 'bug_fix'],
    ['Configure the CI environment setting.', 'configuration'],
    ['Document the endpoint in the API docs.', 'documentation'],
    ['Explain why this cache is invalidated.', 'explanation'],
    ['What is this code base doing in 2 lines', 'explanation'],
    ['Implement support for streamed replies.', 'feature'],
    ['Refactor the parser into smaller modules.', 'refactor'],
    ['Investigate and compare options for storage.', 'research'],
    ['Audit this patch and find issues.', 'review'],
    ['Write unit tests for empty input.', 'test'],
    ['Hello there.', 'other'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classifyTaskType(prompt)).toBe(expected);
  });

  it('prefers the primary imperative over background keywords', () => {
    expect(classifyTaskType('The old parser is broken. Add support for CSV input.')).toBe(
      'feature',
    );
  });

  it('uses the manifest tie break for equal-scoring intents', () => {
    expect(classifyTaskType('Fix and implement.')).toBe('bug_fix');
  });

  it('ignores example lines and fenced code', () => {
    const prompt = 'Example: fix a regression.\nReview the implementation.\n```txt\nadd tests\n```';
    expect(classifyTaskType(prompt)).toBe('review');
  });
});

describe('detail-level classifier', () => {
  it.each([
    ['Keep the answer concise.', 'concise'],
    ['Explain this code base in 2 lines.', 'concise'],
    ['Explain this code base in 200 lines.', 'standard'],
    ['Cover all edge cases in a thorough response.', 'detailed'],
    ['Explain the behavior.', 'standard'],
    ['Be concise but also comprehensive.', 'standard'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classifyDetailLevel(prompt)).toBe(expected);
  });

  it('does not infer detail from prompt length', () => {
    expect(classifyDetailLevel('word '.repeat(2_000))).toBe('standard');
  });

  it('returns all three canonical categorical feature names together', () => {
    expect(classifyPrompt('Briefly implement it and return valid JSON.')).toEqual({
      output_format: 'json',
      task_type: 'feature',
      detail_level: 'concise',
    });
  });
});
