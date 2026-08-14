import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tokenLensHome } from '../config.mjs';

export const REPOSITORY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function repositoryCacheDirectory() {
  return path.join(tokenLensHome(), 'repository-cache');
}

function cacheFile(key) {
  const safe = createHash('sha256').update(String(key), 'utf8').digest('hex');
  return path.join(repositoryCacheDirectory(), `${safe}.json`);
}

export async function readRepositoryCache(
  key,
  { now = Date.now(), maxAgeMs = REPOSITORY_CACHE_MAX_AGE_MS } = {},
) {
  try {
    const value = JSON.parse(await readFile(cacheFile(key), 'utf8'));
    if (!validMetrics(value)) return null;
    if (!Number.isFinite(value.createdAt) || now - value.createdAt > maxAgeMs) return null;
    return { ...value, warnings: validWarnings(value.warnings) };
  } catch {
    return null;
  }
}

export async function writeRepositoryCache(key, metrics) {
  if (!validMetrics(metrics)) throw new TypeError('Repository cache metrics must be non-negative integers');
  const target = cacheFile(key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const value = {
    codebaseLines: metrics.codebaseLines,
    codebaseFiles: metrics.codebaseFiles,
    warnings: validWarnings(metrics.warnings),
    createdAt: Date.now(),
  };
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temporary, target);
  return value;
}

export async function pruneRepositoryCache(
  now = Date.now(),
  maxAgeMs = REPOSITORY_CACHE_MAX_AGE_MS,
) {
  let entries;
  try {
    entries = await readdir(repositoryCacheDirectory());
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(repositoryCacheDirectory(), entry);
    try {
      const metadata = await stat(target);
      if (now - metadata.mtimeMs <= maxAgeMs) continue;
      await rm(target, { force: true });
      removed += 1;
    } catch {
      // Concurrent hook invocations may prune the same entry.
    }
  }
  return removed;
}

export const readCache = readRepositoryCache;
export const writeCache = writeRepositoryCache;
export const pruneCache = pruneRepositoryCache;

function validMetrics(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.codebaseLines) &&
    value.codebaseLines >= 0 &&
    Number.isInteger(value.codebaseFiles) &&
    value.codebaseFiles >= 0
  );
}

function validWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((warning) => typeof warning === 'string' && warning !== ''))];
}
