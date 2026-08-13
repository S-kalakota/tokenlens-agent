import { repositoryRules, resolveSafeCodeFile } from './mentions.mjs';
import { countTokens as trainingCountTokens } from './tokenizer.mjs';
import { stripFencedCode } from './prompt-structure.mjs';

const LEADING_MARKUP = /^[([{<"'`]+/u;
const TRAILING_MARKUP = /[\])}>"'`,.;:!?]+$/u;
const RANGE_SUFFIX = /^(.*?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/iu;

/** Find unique whole-file and line-range references in prompt prose. */
export function parsePathReferences(prompt, manifest) {
  const prose = stripFencedCode(prompt);
  const extensions = (manifest?.repository?.extensions ?? []).map((value) =>
    String(value).toLowerCase(),
  );
  const extensionless = new Set(manifest?.repository?.extensionless_names ?? []);
  const references = [];
  const seen = new Set();

  for (const rawToken of prose.split(/\s+/u)) {
    let token = rawToken;
    const markdownTarget = token.lastIndexOf('](');
    if (markdownTarget >= 0) token = token.slice(markdownTarget + 2);
    token = token.replace(LEADING_MARKUP, '').replace(TRAILING_MARKUP, '');
    if (token === '' || token.startsWith('@') || /^(?:https?|file):\/\//iu.test(token)) continue;

    const range = RANGE_SUFFIX.exec(token);
    const filePath = (range?.[1] ?? token).replace(TRAILING_MARKUP, '');
    if (!looksLikeCodePath(filePath, extensions, extensionless)) continue;

    let lines = null;
    if (range !== null) {
      const start = Number(range[2] ?? range[4]);
      const end = Number(range[3] ?? range[5] ?? start);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        continue;
      }
      lines = { start, end };
    }

    const key = `${filePath}\0${lines?.start ?? ''}\0${lines?.end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ path: filePath, lines });
  }

  return references;
}

export const parseReferences = parsePathReferences;

/**
 * Resolve pre-submit relevant code: accepted `@` files plus explicit bare paths
 * and line ranges. The returned source text remains in memory only.
 */
export async function resolveRelevantCode({
  prompt = '',
  cwd,
  manifest,
  mentionedFiles = [],
  countTokens,
} = {}) {
  const records = new Map();
  const warnings = [];
  const { maxRelevantFiles: maxFiles, maxRelevantBytes: maxTotalBytes } =
    repositoryRules(manifest);
  let totalBytes = 0;
  const providedFiles = Array.isArray(mentionedFiles)
    ? mentionedFiles
    : (mentionedFiles?.files ?? []);

  for (const file of providedFiles) {
    const realPath = file?.realPath ?? file?.path;
    if (typeof realPath !== 'string' || typeof file?.content !== 'string') continue;
    if (records.size >= maxFiles) {
      warnings.push('reference_file_count_limit');
      break;
    }
    const bytes = Buffer.byteLength(file.content);
    if (totalBytes + bytes > maxTotalBytes) {
      warnings.push('reference_total_size_limit');
      break;
    }
    records.set(realPath, { file, wholeFile: true, ranges: [] });
    totalBytes += bytes;
  }

  const references = parsePathReferences(prompt, manifest);
  for (const reference of references) {
    const resolved = await resolveSafeCodeFile(reference.path, { cwd, manifest });
    if (resolved.file === null) {
      warnings.push(`reference_${resolved.warning}`);
      continue;
    }

    const key = resolved.file.realPath;
    if (!records.has(key)) {
      if (records.size >= maxFiles) {
        warnings.push('reference_file_count_limit');
        break;
      }
      const bytes = Buffer.byteLength(resolved.file.content);
      if (totalBytes + bytes > maxTotalBytes) {
        warnings.push('reference_total_size_limit');
        break;
      }
      totalBytes += bytes;
    }
    const current = records.get(key) ?? { file: resolved.file, wholeFile: false, ranges: [] };
    if (reference.lines === null) current.wholeFile = true;
    else if (!current.wholeFile) current.ranges.push(reference.lines);
    records.set(key, current);
  }

  const selections = [];
  const segments = [];
  for (const record of records.values()) {
    if (record.wholeFile) {
      selections.push({ ...record.file, wholeFile: true, ranges: [] });
      segments.push(record.file.content);
      continue;
    }

    const lines = physicalLines(record.file.content);
    if (lines.length === 0) {
      selections.push({ ...record.file, wholeFile: false, ranges: [] });
      continue;
    }
    const clamped = record.ranges.map(({ start, end }) => ({
      start: Math.min(lines.length, Math.max(1, start)),
      end: Math.min(lines.length, Math.max(1, end)),
    }));
    const ranges = mergeRanges(clamped);
    selections.push({ ...record.file, wholeFile: false, ranges });
    for (const { start, end } of ranges) segments.push(lines.slice(start - 1, end).join('\n'));
  }

  const tokenCounter =
    typeof countTokens === 'function'
      ? countTokens
      : (text) => trainingCountTokens(text, manifest?.tokenizer);
  const strategy = manifest?.reference_tokenization?.strategy ?? 'sum-segments';
  let relevantCodeTokens;
  if (strategy === 'sum-segments') {
    relevantCodeTokens = segments.reduce(
      (total, segment) => total + safeTokenCount(tokenCounter(segment)),
      0,
    );
  } else {
    const separator = String(manifest?.reference_tokenization?.separator ?? '\n');
    relevantCodeTokens = safeTokenCount(tokenCounter(segments.join(separator)));
  }

  return {
    references,
    files: selections,
    segments,
    relevantCodeTokens,
    warnings: [...new Set(warnings)],
  };
}

export const collectRelevantCode = resolveRelevantCode;

export function mergeRanges(ranges) {
  const sorted = ranges
    .filter(({ start, end }) => start <= end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end + 1) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function looksLikeCodePath(filePath, extensions, extensionless) {
  const normalized = filePath.replaceAll('\\', '/');
  if (
    normalized === '' ||
    normalized.includes('\0') ||
    normalized.endsWith('/') ||
    normalized.split('/').some((part) => part === '..')
  ) {
    // Traversal is still parsed only when it otherwise resembles a code path so
    // the safe resolver can reject it. A leading ../ is therefore allowed here.
    if (!normalized.startsWith('../')) return false;
  }
  const name = normalized.split('/').at(-1);
  if (extensionless.has(name)) return true;
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function physicalLines(content) {
  if (content === '') return [];
  const normalized = content.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function safeTokenCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
