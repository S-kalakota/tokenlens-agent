import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { countTokens as trainingCountTokens } from './tokenizer.mjs';

const SENTENCE_PUNCTUATION = /["'),.;:!?\]}]+$/u;
const OPENING_PUNCTUATION = /[\s([{"'>]/u;
const LINE_RANGE_SUFFIX = /(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/iu;

/** Replace Markdown code spans with spaces while preserving line boundaries. */
export function maskMarkdownCode(value) {
  const text = String(value ?? '');
  const lines = text.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let fence = null;

  return lines
    .map((line) => {
      const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
      const newline = line.endsWith('\n') ? '\n' : '';
      const markerMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(withoutNewline);
      const marker = markerMatch?.[1];
      const markerRemainder = markerMatch?.[2] ?? '';

      if (fence !== null) {
        const closes =
          marker !== undefined &&
          marker[0] === fence.character &&
          marker.length >= fence.length &&
          /^[ \t]*$/u.test(markerRemainder);
        if (closes) fence = null;
        return `${' '.repeat(withoutNewline.length)}${newline}`;
      }

      if (marker !== undefined) {
        fence = { character: marker[0], length: marker.length };
        return `${' '.repeat(withoutNewline.length)}${newline}`;
      }

      return `${maskInlineCode(withoutNewline)}${newline}`;
    })
    .join('');
}

function maskInlineCode(line) {
  const characters = Array.from(line);
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== '`') continue;

    let width = 1;
    while (characters[index + width] === '`') width += 1;
    const marker = '`'.repeat(width);
    const remainder = characters.slice(index + width).join('');
    const closingOffset = remainder.indexOf(marker);
    if (closingOffset < 0) {
      index += width - 1;
      continue;
    }

    const closing = index + width + Array.from(remainder.slice(0, closingOffset)).length;
    for (let masked = index; masked < closing + width; masked += 1) characters[masked] = ' ';
    index = closing + width - 1;
  }
  return characters.join('');
}

/** Parse unique literal Claude Code `@path` mentions from prompt prose. */
export function parseAtMentions(prompt) {
  const prose = maskMarkdownCode(prompt);
  const mentions = [];
  const seen = new Set();

  for (let index = 0; index < prose.length; index += 1) {
    if (prose[index] !== '@') continue;
    if (index > 0 && !OPENING_PUNCTUATION.test(prose[index - 1])) continue;

    let end = index + 1;
    while (end < prose.length && !/[\s<>`]/u.test(prose[end])) end += 1;
    const mention = prose
      .slice(index + 1, end)
      .replace(SENTENCE_PUNCTUATION, '')
      .replace(LINE_RANGE_SUFFIX, '');
    if (mention === '' || mention.includes('\0') || seen.has(mention)) continue;
    seen.add(mention);
    mentions.push(mention);
    index = end - 1;
  }

  return mentions;
}

export const parseMentions = parseAtMentions;

export function isPathContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function repositoryRules(manifest) {
  const configured = manifest?.repository ?? {};
  return {
    extensions: new Set((configured.extensions ?? []).map((value) => String(value).toLowerCase())),
    extensionlessNames: new Set(configured.extensionless_names ?? []),
    excludedNames: new Set((configured.excluded_names ?? []).map(String)),
    excludedDirectories: new Set((configured.excluded_directories ?? []).map(String)),
    maxFileBytes: positiveInteger(configured.max_file_bytes, 1024 * 1024),
    maxFiles: positiveInteger(configured.max_files, 5_000),
    maxTotalBytes: positiveInteger(configured.max_total_bytes, 32 * 1024 * 1024),
    maxMentionedFiles: positiveInteger(configured.max_mentioned_files, 128),
    maxRelevantFiles: positiveInteger(configured.max_relevant_files, 256),
    maxRelevantBytes: positiveInteger(configured.max_relevant_bytes, 8 * 1024 * 1024),
    includeUntracked: configured.include_untracked === true,
  };
}

/** Whether a repository-relative path belongs to the manifest's code file set. */
export function isIncludedCodePath(relativePath, manifest) {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\0')) {
    return false;
  }

  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return false;
  const rules = repositoryRules(manifest);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part, index) => index < parts.length - 1 && rules.excludedDirectories.has(part))) {
    return false;
  }

  const name = parts.at(-1);
  if (rules.excludedNames.has(name)) return false;
  if (rules.extensionlessNames.has(name)) return true;
  return rules.extensions.has(path.extname(name).toLowerCase());
}

export function isBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return true;
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/** Resolve and read one code path without allowing traversal or symlink escape. */
export async function resolveSafeCodeFile(reference, { cwd, manifest, rootRealPath } = {}) {
  let root;
  try {
    if (
      (rootRealPath !== undefined && !path.isAbsolute(rootRealPath)) ||
      (rootRealPath === undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd)))
    ) {
      return rejected('workspace_unavailable');
    }
    root = rootRealPath ?? (await realpath(cwd));
    if (!(await stat(root)).isDirectory()) return rejected('workspace_unavailable');
  } catch {
    return rejected('workspace_unavailable');
  }

  const raw = String(reference ?? '').replace(/^@/u, '');
  if (raw === '' || raw.includes('\0')) return rejected('invalid_path_reference');
  const candidate = path.resolve(root, raw);
  if (!isPathContained(root, candidate) || candidate === root) return rejected('path_outside_workspace');

  let resolved;
  let metadata;
  try {
    resolved = await realpath(candidate);
    if (!isPathContained(root, resolved) || resolved === root) {
      return rejected('symlink_outside_workspace');
    }
    metadata = await stat(resolved);
  } catch {
    return rejected('file_unavailable');
  }

  if (!metadata.isFile()) return rejected(metadata.isDirectory() ? 'directory_reference' : 'not_regular_file');
  const relativePath = toPosix(path.relative(root, resolved));
  const requestedRelativePath = toPosix(path.relative(root, candidate));
  if (
    !isIncludedCodePath(relativePath, manifest) ||
    !isIncludedCodePath(requestedRelativePath, manifest)
  ) {
    return rejected('unsupported_code_file');
  }

  const { maxFileBytes } = repositoryRules(manifest);
  if (metadata.size > maxFileBytes) return rejected('file_size_limit');

  let buffer;
  try {
    const current = await realpath(candidate);
    if (current !== resolved || !isPathContained(root, current)) {
      return rejected('file_changed_during_read');
    }
    buffer = await readFile(resolved);
  } catch {
    return rejected('file_unreadable');
  }
  if (buffer.length > maxFileBytes) return rejected('file_size_limit');
  if (isBinaryBuffer(buffer)) return rejected('binary_file');

  return {
    file: {
      reference: raw,
      path: resolved,
      realPath: resolved,
      relativePath,
      size: metadata.size,
      content: buffer.toString('utf8'),
    },
    warning: null,
  };
}

/** Resolve, deduplicate and tokenize the prompt's accepted `@` files. */
export async function resolveMentionedFiles({ prompt = '', cwd, manifest, countTokens } = {}) {
  const parsedMentions = parseAtMentions(prompt);
  const { maxMentionedFiles, maxRelevantBytes } = repositoryRules(manifest);
  const mentions = parsedMentions.slice(0, maxMentionedFiles);
  const files = [];
  const warnings = parsedMentions.length > mentions.length ? ['mention_file_count_limit'] : [];
  const seen = new Set();
  let totalBytes = 0;
  let root;

  try {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('absolute cwd required');
    root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    return {
      mentions,
      files,
      attachedCodeTokens: 0,
      nFilesAttached: 0,
      warnings: ['workspace_unavailable'],
    };
  }

  for (const mention of mentions) {
    const result = await resolveSafeCodeFile(mention, { cwd, manifest, rootRealPath: root });
    if (result.file === null) {
      warnings.push(result.warning);
      continue;
    }
    if (seen.has(result.file.realPath)) continue;
    if (totalBytes + result.file.size > maxRelevantBytes) {
      warnings.push('mention_total_size_limit');
      break;
    }
    seen.add(result.file.realPath);
    totalBytes += result.file.size;
    files.push(result.file);
  }

  const tokenCounter =
    typeof countTokens === 'function'
      ? countTokens
      : (text) => trainingCountTokens(text, manifest?.tokenizer);
  const attachedCodeTokens = files.reduce(
    (total, file) => total + safeTokenCount(tokenCounter(file.content)),
    0,
  );

  if (files.length > 0) warnings.push('mention_derived');
  return {
    mentions,
    files,
    attachedCodeTokens,
    nFilesAttached: files.length,
    warnings: unique(warnings),
  };
}

export const collectMentionedFiles = resolveMentionedFiles;

function safeTokenCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rejected(warning) {
  return { file: null, warning };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
