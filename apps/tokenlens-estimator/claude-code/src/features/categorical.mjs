import { readFileSync } from 'node:fs';
import { stripFencedCode } from './prompt-structure.mjs';

const FEATURE_MANIFEST = JSON.parse(
  readFileSync(new URL('../../model/feature-manifest.json', import.meta.url), 'utf8'),
);

const OUTPUT_SIGNALS = {
  json: [
    /\b(?:respond|return|output|provide|emit|format)(?:\s+(?:it|the\s+(?:answer|response|result)))?\s+(?:as|in|with)\s+(?:valid\s+)?json\b/iu,
    /\b(?:respond\s+with|return|output|provide|emit)\s+(?:valid\s+)?json\b/iu,
    /\b(?:valid\s+json|json\s+object)\b/iu,
  ],
  patch: [
    /\b(?:unified\s+diff|diff\s+only|patch\s+only)\b/iu,
    /\b(?:show|return|output|provide|respond\s+with)\s+(?:a\s+|the\s+)?(?:(?:concise|detailed|minimal)\s+)?(?:patch|diff)\b/iu,
  ],
  table: [
    /\b(?:return|show|output|provide|format)(?:\s+(?:it|the\s+(?:answer|response|result)))?\s+(?:as|in)\s+(?:a\s+)?table\b/iu,
    /\b(?:tabular\s+format|csv\s+table)\b/iu,
  ],
  markdown: [
    /\b(?:write|return|output|provide|respond|format)(?:\s+(?:it|the\s+(?:answer|response|result)))?\s+(?:as|in)\s+markdown\b/iu,
    /\b(?:markdown\s+document|write\s+(?:a\s+)?readme)\b/iu,
  ],
  plain_text: [
    /\bplain[ -]text\b/iu,
    /\b(?:respond|return|explain|write)(?:\s+(?:it|the\s+(?:answer|response|result)))?\s+(?:only\s+)?in\s+prose\b/iu,
  ],
  code: [
    /\b(?:implement|write\s+(?:the\s+)?code|create\s+(?:the\s+|a\s+)?file|add\s+(?:the\s+|a\s+)?(?:function|class|module|component|endpoint))\b/iu,
  ],
};

const TASK_SIGNALS = {
  bug_fix: [
    [/(?:\bbug\s*fix\b|\bfix(?:es|ing|ed)?\b|\bdebug(?:ging)?\b)/iu, 3],
    [/\b(?:broken|error|regression|failing|failure|crash(?:es|ing|ed)?)\b/iu, 1],
  ],
  feature: [
    [/(?:\bnew\s+feature\b|\badd\s+(?:support|a|an|the)\b|\bimplement(?:ing|ed)?\b)/iu, 3],
    [/\b(?:add|build|create|support)\b/iu, 1],
  ],
  refactor: [
    [/\b(?:refactor|restructure|reorganize)(?:s|ing|ed)?\b/iu, 3],
    [/\b(?:simplify|clean\s+up)(?:ing|ed)?\b/iu, 1],
  ],
  test: [
    [/\b(?:add|write|create)\s+(?:focused\s+|unit\s+|integration\s+)?tests?\b/iu, 3],
    [/\b(?:test\s+coverage|reproduce\s+with\s+a\s+test)\b/iu, 3],
    [/\btests?\b/iu, 1],
  ],
  configuration: [
    [/\b(?:configure|configuration|set\s*up|ci\s+(?:setting|configuration)|environment\s+(?:setting|configuration))\b/iu, 3],
    [/\b(?:manifest|config)\b/iu, 1],
  ],
  documentation: [
    [/\b(?:api\s+docs?|write\s+(?:a\s+)?guide|update\s+(?:the\s+)?readme)\b/iu, 3],
    [/\b(?:document(?:ation|ing|ed)?|readme|guide|comments?)\b/iu, 1],
  ],
  review: [
    [/\b(?:code\s+review|find\s+issues)\b/iu, 3],
    [/\b(?:review|audit|inspect|critique)(?:s|ing|ed)?\b/iu, 2],
  ],
  research: [
    [/\b(?:compare\s+options|evaluate\s+approaches)\b/iu, 3],
    [/\b(?:investigate|research|evaluate)(?:s|ing|ed)?\b/iu, 2],
  ],
  explanation: [
    [/\b(?:how|why)\s+does\b/iu, 3],
    [/\bwhat\s+(?:is|are|does)\b/iu, 3],
    [/\b(?:explain|describe)(?:s|ing|ed)?\b/iu, 2],
  ],
};

const DETAIL_SIGNALS = {
  concise: /\b(?:brief|briefly|concise|concisely|minimal|short|just\s+the\s+answer)\b/iu,
  detailed: /\b(?:detailed|thorough|comprehensive|step[ -]by[ -]step|all\s+edge\s+cases|production[ -]ready)\b/iu,
};

function hasCompactLimit(text) {
  const limits = {
    line: 5,
    sentence: 5,
    word: 100,
    bullet: 5,
  };
  for (const match of text.matchAll(/\b(?:in|within|using|under)\s+(\d+)\s+(lines?|sentences?|words?|bullets?)\b/giu)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase().replace(/s$/u, '');
    if (Number.isSafeInteger(amount) && amount > 0 && amount <= limits[unit]) return true;
  }
  return false;
}

function normalizedInstructions(prompt) {
  return stripFencedCode(prompt).normalize('NFKC').toLocaleLowerCase('en-US');
}

function allowed(manifest, feature, candidate) {
  const vocabulary = manifest?.categorical_features?.[feature];
  return Array.isArray(vocabulary) && vocabulary.includes(candidate);
}

function fallback(manifest, feature, hardDefault) {
  const candidate = manifest?.defaults?.[feature];
  return allowed(manifest, feature, candidate) ? candidate : hardDefault;
}

function withoutExamples(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:for\s+example|examples?|e\.g\.)\s*:/iu.test(line))
    .join('\n');
}

export function classifyOutputFormat(prompt, manifest = FEATURE_MANIFEST) {
  const text = normalizedInstructions(prompt);
  const precedence = Array.isArray(manifest?.output_format_precedence)
    ? manifest.output_format_precedence
    : [];

  for (const category of precedence) {
    if (!allowed(manifest, 'output_format', category)) continue;
    if (OUTPUT_SIGNALS[category]?.some((pattern) => pattern.test(text))) return category;
  }

  return fallback(manifest, 'output_format', 'unspecified');
}

function primaryClause(text) {
  const clauses = text.split(/(?<=[.!?])\s+|[;\n]+/u).map((part) => part.trim());
  return clauses.find((part) => /^(?:(?:please|kindly)\s+)?(?:add|audit|build|compare|configure|create|debug|describe|document|evaluate|explain|fix|implement|inspect|investigate|refactor|research|review|set\s*up|test|update|write)\b/iu.test(part)) ?? '';
}

function scoreCategory(text, rules) {
  let score = 0;
  for (const [pattern, weight] of rules) {
    if (pattern.test(text)) score += weight;
  }
  return score;
}

export function classifyTaskType(prompt, manifest = FEATURE_MANIFEST) {
  const text = withoutExamples(normalizedInstructions(prompt));
  const primary = primaryClause(text);
  const tieBreak = Array.isArray(manifest?.task_type_tie_break)
    ? manifest.task_type_tie_break
    : [];

  let best = fallback(manifest, 'task_type', 'other');
  let bestScore = 0;

  for (const category of tieBreak) {
    if (!allowed(manifest, 'task_type', category)) continue;
    const rules = TASK_SIGNALS[category] ?? [];
    const score = scoreCategory(text, rules) + (primary === '' ? 0 : scoreCategory(primary, rules) * 2);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }

  return best;
}

export function classifyDetailLevel(prompt, manifest = FEATURE_MANIFEST) {
  const text = normalizedInstructions(prompt);
  const concise = DETAIL_SIGNALS.concise.test(text) || hasCompactLimit(text);
  const detailed = DETAIL_SIGNALS.detailed.test(text);

  if (concise !== detailed) {
    const category = concise ? 'concise' : 'detailed';
    if (allowed(manifest, 'detail_level', category)) return category;
  }

  return fallback(manifest, 'detail_level', 'standard');
}

export function classifyPrompt(prompt, manifest = FEATURE_MANIFEST) {
  return {
    output_format: classifyOutputFormat(prompt, manifest),
    task_type: classifyTaskType(prompt, manifest),
    detail_level: classifyDetailLevel(prompt, manifest),
  };
}
