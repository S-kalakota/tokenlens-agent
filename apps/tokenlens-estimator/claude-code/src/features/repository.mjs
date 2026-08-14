import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  readRepositoryCache,
  writeRepositoryCache,
} from './cache.mjs';
import { resolveGitRepository } from './identities.mjs';
import {
  isBinaryBuffer,
  isIncludedCodePath,
  isPathContained,
  repositoryRules,
} from './mentions.mjs';

/** Physical-v1: blank lines count; empty files do not; final newline adds no phantom line. */
export function countPhysicalLines(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(String(buffer ?? ''), 'utf8');
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  if (buffer.at(-1) !== 0x0a) lines += 1;
  return lines;
}

/** Collect bounded source/config/doc counts from the cwd Git repository. */
export async function collectRepositoryMetrics({ cwd, manifest, cache = true, git } = {}) {
  const repository = await resolveGitRepository(cwd, { git });
  if (repository === null) return unavailable('repository_unavailable');
  const warnings = [];
  const rules = repositoryRules(manifest);

  let listed;
  try {
    const arguments_ = ['-C', repository.root, 'ls-files', '-z', '--cached'];
    if (rules.includeUntracked) arguments_.push('--others', '--exclude-standard');
    listed = await repository.git(arguments_);
  } catch {
    return unavailable('repository_file_list_unavailable', repository.root);
  }

  const relativePaths = [...new Set(String(listed).split('\0').filter(Boolean))].sort();
  const allIncludedPaths = relativePaths.filter((relativePath) =>
    isIncludedCodePath(relativePath, manifest),
  );
  const includedPaths = allIncludedPaths.slice(0, rules.maxFiles);
  if (allIncludedPaths.length > includedPaths.length) {
    warnings.push('repository_file_count_limit');
  }

  let cacheKey;
  try {
    cacheKey = await repositoryCacheKey(repository, includedPaths, manifest);
  } catch {
    warnings.push('repository_cache_fingerprint_failed');
  }
  if (cache !== false && cacheKey !== undefined) {
    try {
      const hit = await readFrom(cache, cacheKey);
      if (hit !== null) {
        return {
          codebaseLines: hit.codebaseLines,
          codebaseFiles: hit.codebaseFiles,
          repositoryRoot: repository.root,
          cacheHit: true,
          warnings: unique([...warnings, ...(hit.warnings ?? [])]),
        };
      }
    } catch {
      warnings.push('repository_cache_read_failed');
    }
  }

  const candidates = [];
  const seenRealPaths = new Set();
  let candidateBytes = 0;
  for (const relativePath of includedPaths) {
    const candidate = path.resolve(repository.root, relativePath);
    if (!isPathContained(repository.root, candidate)) continue;

    let resolved;
    let metadata;
    try {
      resolved = await realpath(candidate);
      if (!isPathContained(repository.root, resolved)) {
        warnings.push('repository_symlink_escape');
        continue;
      }
      metadata = await stat(resolved);
    } catch {
      continue;
    }
    if (!metadata.isFile() || metadata.size > rules.maxFileBytes) {
      if (metadata.size > rules.maxFileBytes) warnings.push('repository_file_size_limit');
      continue;
    }
    const realRelativePath = path.relative(repository.root, resolved).split(path.sep).join('/');
    if (!isIncludedCodePath(realRelativePath, manifest) || seenRealPaths.has(resolved)) continue;
    if (candidateBytes + metadata.size > rules.maxTotalBytes) {
      warnings.push('repository_total_size_limit');
      break;
    }
    seenRealPaths.add(resolved);
    candidateBytes += metadata.size;
    candidates.push({
      path: resolved,
      relativePath: realRelativePath,
      size: metadata.size,
    });
  }

  let codebaseLines = 0;
  let codebaseFiles = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (codebaseFiles >= rules.maxFiles) {
      warnings.push('repository_file_count_limit');
      break;
    }
    if (totalBytes + candidate.size > rules.maxTotalBytes) {
      warnings.push('repository_total_size_limit');
      break;
    }

    let buffer;
    try {
      const resolved = await realpath(candidate.path);
      if (resolved !== candidate.path || !isPathContained(repository.root, resolved)) {
        warnings.push('repository_file_changed_during_scan');
        continue;
      }
      buffer = await readFile(candidate.path);
    } catch {
      continue;
    }
    if (buffer.length > rules.maxFileBytes) {
      warnings.push('repository_file_size_limit');
      continue;
    }
    if (totalBytes + buffer.length > rules.maxTotalBytes) {
      warnings.push('repository_total_size_limit');
      break;
    }
    if (isBinaryBuffer(buffer)) {
      warnings.push('repository_binary_file');
      continue;
    }
    totalBytes += buffer.length;
    codebaseFiles += 1;
    codebaseLines += countPhysicalLines(buffer);
  }

  const metrics = { codebaseLines, codebaseFiles };
  if (cache !== false && cacheKey !== undefined) {
    try {
      await writeTo(cache, cacheKey, { ...metrics, warnings: unique(warnings) });
    } catch {
      warnings.push('repository_cache_write_failed');
    }
  }

  return {
    ...metrics,
    repositoryRoot: repository.root,
    cacheHit: false,
    warnings: unique(warnings),
  };
}

export const collectCodebaseMetrics = collectRepositoryMetrics;

async function repositoryCacheKey(repository, includedPaths, manifest) {
  let head = 'unborn';
  try {
    head = String(await repository.git(['-C', repository.root, 'rev-parse', 'HEAD'])).trim();
  } catch {
    // An unborn repository is still scannable and its file metadata fingerprints it.
  }

  let workingTree = '';
  try {
    workingTree = String(
      await repository.git([
        '-C',
        repository.root,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        '.',
      ]),
    );
  } catch {
    // Status is part of correctness when the working tree is dirty. If it
    // cannot be read, bypass the cache rather than risk a stale count.
    throw new Error('working tree fingerprint unavailable');
  }

  const dirtyContent = [];
  const included = new Set(includedPaths);
  for (const relativePath of dirtyPaths(workingTree)) {
    if (!included.has(relativePath)) continue;
    dirtyContent.push([relativePath, await fingerprintWorkingFile(repository.root, relativePath)]);
  }

  const identity = {
    repository: repository.root,
    head,
    files: includedPaths,
    workingTree,
    dirtyContent,
    inclusionRuleVersion: manifest?.repository?.inclusion_rule_version ?? 'unknown',
    lineCountVersion: manifest?.repository?.line_count ?? 'unknown',
    collectorVersion: manifest?.collector_version ?? 'unknown',
    repositoryRules: manifest?.repository ?? {},
  };
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

function dirtyPaths(status) {
  const records = String(status).split('\0');
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code.includes('R') || code.includes('C')) index += 1;
  }
  return [...new Set(paths)].sort();
}

async function fingerprintWorkingFile(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  if (!isPathContained(root, candidate)) return 'outside';
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      return `symlink:${await readlink(candidate)}`;
    }
    if (!metadata.isFile()) return `type:${metadata.mode}`;
    const buffer = await readFile(candidate);
    return `file:${createHash('sha256').update(buffer).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

async function readFrom(cache, key) {
  if (cache === true || cache === undefined) return readRepositoryCache(key);
  if (typeof cache.read === 'function') return cache.read(key);
  return null;
}

async function writeTo(cache, key, metrics) {
  if (cache === true || cache === undefined) return writeRepositoryCache(key, metrics);
  if (typeof cache.write === 'function') return cache.write(key, metrics);
  return undefined;
}

function unavailable(warning, repositoryRoot = null) {
  return {
    codebaseLines: 0,
    codebaseFiles: 0,
    repositoryRoot,
    cacheHit: false,
    warnings: [warning],
  };
}

function unique(values) {
  return [...new Set(values)];
}
