import { normalizeNewlines } from './tokenizer.mjs';

const INLINE_CODE_PATTERN = /(`+)(?!`)([^\n]*?)\1/g;
const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>]+/giu;
const PATH_TOKEN_PATTERN = /(?:^|\s)(?:@?(?:\.\.?[/\\]|[/\\])|@?)[\p{L}\p{N}_.-]+(?:[/\\][\p{L}\p{N}_.@+~-]+)+(?=$|\s|[,:;!?()[\]{}])/gu;
const AT_FILE_PATTERN = /(^|\s)@[\p{L}\p{N}_.-]+(?:[/\\][\p{L}\p{N}_.@+~-]+)*\.[\p{L}\p{N}]+(?=$|\s|[,:;!?()[\]{}])/gu;
const BARE_FILE_PATTERN = /(^|\s)[\p{L}\p{N}_-]+\.[\p{L}\p{N}]+(?=$|\s|[,:;!?()[\]{}])/gu;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/gu;

const ACTION_PATTERN = new RegExp(
  String.raw`^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+)?(?:add|allow|audit|avoid|build|change|clean(?:\s+up)?|compare|configure|count|create|debug|describe|document|ensure|evaluate|exclude|explain|fix|handle|implement|include|inspect|investigate|keep|load|make|modify|preserve|provide|read|refactor|reject|remove|rename|reorganize|repair|replace|respond|restructure|return|review|run|save|set\s+up|show|simplify|store|support|test|update|use|validate|verify|write)\b`,
  'iu',
);
const REQUIREMENT_MARKER_PATTERN = /\b(?:must|need(?:s)?\s+to|should|ensure|do\s+not|only)\b/iu;
const LIST_ITEM_PATTERN = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u;
const HEADING_PATTERN = /^\s{0,3}#{1,6}(?:\s+|$)/u;
const EXAMPLE_PATTERN = /^\s*(?:for\s+example|examples?|e\.g\.)\s*:/iu;

function blankExceptNewlines(value) {
  return value.replace(/[^\n]/g, ' ');
}

/**
 * Removes Markdown fenced blocks without moving anything on a different line.
 * Whitespace replacement keeps later line-oriented parsers deterministic.
 */
export function stripFencedCode(prompt) {
  const text = normalizeNewlines(prompt);
  const lines = text.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let fence = null;

  return lines
    .map((line) => {
      const hasNewline = line.endsWith('\n');
      const content = hasNewline ? line.slice(0, -1) : line;
      const newline = hasNewline ? '\n' : '';
      const markerMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
      const marker = markerMatch?.[1];
      const markerRemainder = markerMatch?.[2] ?? '';

      if (fence !== null) {
        const closes =
          marker !== undefined &&
          marker[0] === fence.character &&
          marker.length >= fence.length &&
          /^[ \t]*$/u.test(markerRemainder);
        if (closes) fence = null;
        return `${' '.repeat(content.length)}${newline}`;
      }

      if (marker !== undefined) {
        fence = { character: marker[0], length: marker.length };
        return `${' '.repeat(content.length)}${newline}`;
      }
      return line;
    })
    .join('');
}

/** Removes Markdown inline-code spans while preserving their width. */
export function stripInlineCode(prompt) {
  return normalizeNewlines(prompt).replace(INLINE_CODE_PATTERN, blankExceptNewlines);
}

/** Removes both fenced and inline code for instruction/question parsing. */
export function stripCode(prompt) {
  return stripInlineCode(stripFencedCode(prompt));
}

export function buildPromptRepresentations(prompt) {
  const rawPrompt = normalizeNewlines(prompt);
  return {
    rawPrompt,
    prosePrompt: stripFencedCode(rawPrompt),
  };
}

function withoutNonTaskTokens(prompt) {
  return stripCode(prompt)
    .replace(URL_PATTERN, ' ')
    .replace(PATH_TOKEN_PATTERN, ' ')
    .replace(AT_FILE_PATTERN, '$1 ')
    .replace(BARE_FILE_PATTERN, '$1 ');
}

/** Counts Unicode task words, excluding code, URLs, and path references. */
export function countTaskWords(prompt) {
  return Array.from(withoutNonTaskTokens(prompt).matchAll(WORD_PATTERN)).length;
}

// Alias matching the feature's noun-first name.
export const taskWordCount = countTaskWords;

function sentenceUnits(text) {
  return text
    .split(/(?<=[.!?])\s+|[;\n]+/u)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function isRequirementUnit(unit, { listItem = false } = {}) {
  if (unit === '' || HEADING_PATTERN.test(unit) || EXAMPLE_PATTERN.test(unit)) return false;

  const question = /\?+\s*$/u.test(unit);
  const explicitMarker = REQUIREMENT_MARKER_PATTERN.test(unit);
  const action = ACTION_PATTERN.test(unit);

  // A question alone is not a requirement. An explicit imperative request or
  // constraint still qualifies, as required by clause-requirements-v1.
  if (question && !(explicitMarker || action)) return false;
  return explicitMarker || action || (listItem && action);
}

/**
 * Counts independently actionable clause/list units. Each Markdown list item is
 * considered once even if it contains several sentences or matches several
 * rules, which also deduplicates imperative + marker matches on one span.
 */
export function countRequirements(prompt) {
  const text = stripCode(prompt);
  let total = 0;

  for (const line of text.split('\n')) {
    if (HEADING_PATTERN.test(line) || EXAMPLE_PATTERN.test(line)) continue;

    const listMatch = LIST_ITEM_PATTERN.exec(line);
    if (listMatch !== null) {
      if (isRequirementUnit(listMatch[1].trim(), { listItem: true })) total += 1;
      continue;
    }

    for (const unit of sentenceUnits(line)) {
      if (isRequirementUnit(unit)) total += 1;
    }
  }

  return total;
}

/**
 * Counts runs of question marks as question units after removing constructs in
 * which `?` is data rather than punctuation.
 */
export function countQuestions(prompt) {
  const prose = stripCode(prompt)
    .replace(URL_PATTERN, ' ')
    .replace(/\\\?/g, ' ');
  return Array.from(prose.matchAll(/\?+/gu)).length;
}

/** All prompt-structure model features in their canonical names. */
export function promptMetrics(prompt) {
  return {
    task_word_count: countTaskWords(prompt),
    n_requirements: countRequirements(prompt),
    question_count: countQuestions(prompt),
  };
}
