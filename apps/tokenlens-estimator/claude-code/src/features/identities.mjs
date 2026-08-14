import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isPathContained } from './mentions.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_MAP = new URL('../../model/repo-id-map.json', import.meta.url);

export async function gitOutput(args, { execFileImpl = execFileAsync } = {}) {
  const result = await execFileImpl('git', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 1000,
  });
  return typeof result === 'string' ? result : result.stdout;
}

/** Resolve a real Git top level from the hook-provided cwd. */
export async function resolveGitRepository(cwd, { git } = {}) {
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) return null;
  let workspace;
  try {
    workspace = await realpath(cwd);
    if (!(await stat(workspace)).isDirectory()) return null;
  } catch {
    return null;
  }

  const run = typeof git === 'function' ? git : (args) => gitOutput(args);
  try {
    const reportedRoot = String(await run(['-C', workspace, 'rev-parse', '--show-toplevel'])).trim();
    const root = await realpath(reportedRoot);
    if (!isPathContained(root, workspace)) return null;
    return { workspace, root, git: run };
  } catch {
    return null;
  }
}

/** Normalize supported GitHub HTTPS and SSH remotes to a private local slug. */
export function normalizeGitHubOrigin(origin) {
  const value = String(origin ?? '').trim();
  let pathname;

  const scp = /^(?:[^@\s]+@)?github\.com:([^\s]+)$/iu.exec(value);
  if (scp !== null) {
    pathname = scp[1];
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() !== 'github.com') return null;
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  }

  const slug = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '').toLowerCase();
  return /^[^/\s]+\/[^/\s]+$/u.test(slug) ? slug : null;
}

export async function loadRepoIdMap(url = DEFAULT_REPO_MAP) {
  try {
    const parsed = JSON.parse(await readFile(url, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Map cwd's GitHub origin to the manifest's privacy-safe training category. */
export async function resolveRepositoryIdentity({ cwd, manifest, repoIdMap, git } = {}) {
  const fallback = acceptedFallback('repo_id', manifest, 'unknown');
  const repository = await resolveGitRepository(cwd, { git });
  if (repository === null) {
    return { repoId: fallback, root: null, slug: null, warnings: ['repository_unavailable'] };
  }

  let origin;
  try {
    origin = await repository.git(['-C', repository.root, 'remote', 'get-url', 'origin']);
  } catch {
    return {
      repoId: fallback,
      root: repository.root,
      slug: null,
      warnings: ['repository_origin_unavailable'],
    };
  }

  const slug = normalizeGitHubOrigin(origin);
  if (slug === null) {
    return {
      repoId: fallback,
      root: repository.root,
      slug: null,
      warnings: ['repository_origin_unsupported'],
    };
  }

  const mapping = repoIdMap ?? (await loadRepoIdMap());
  const normalizedMapping = Object.fromEntries(
    Object.entries(mapping).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const mapped = normalizedMapping[slug];
  const accepted = new Set(manifest?.categorical_features?.repo_id ?? []);
  if (typeof mapped !== 'string' || !accepted.has(mapped)) {
    return {
      repoId: fallback,
      root: repository.root,
      slug,
      warnings: ['repository_id_unknown'],
    };
  }

  return { repoId: mapped, root: repository.root, slug, warnings: [] };
}

export const resolveRepoId = resolveRepositoryIdentity;

/** Resolve transcript model names without conflating identity with pricing family. */
export function resolveModelId(modelId, manifest) {
  const resolution = manifest?.model_id_resolution ?? {};
  const accepted = new Set(manifest?.categorical_features?.model_id ?? []);
  const fallback = accepted.has(resolution.fallback)
    ? resolution.fallback
    : accepted.has('unknown')
      ? 'unknown'
      : [...accepted][0];
  if (typeof modelId !== 'string' || modelId.trim() === '') return fallback ?? 'unknown';

  const normalized = modelId.trim().toLowerCase();
  const aliases = resolution.aliases ?? {};
  const exact = aliases[normalized];
  if (typeof exact === 'string' && accepted.has(exact)) return exact;
  if (accepted.has(normalized)) return normalized;

  let withoutDate = normalized;
  try {
    const datedSuffix = new RegExp(resolution.dated_suffix_pattern ?? '-\\d{8}$', 'u');
    withoutDate = normalized.replace(datedSuffix, '');
  } catch {
    withoutDate = normalized.replace(/-\d{8}$/u, '');
  }
  const datedAlias = aliases[withoutDate];
  if (typeof datedAlias === 'string' && accepted.has(datedAlias)) return datedAlias;
  if (accepted.has(withoutDate)) return withoutDate;
  return fallback ?? 'unknown';
}

function acceptedFallback(feature, manifest, proposed) {
  const accepted = new Set(manifest?.categorical_features?.[feature] ?? []);
  const configured = manifest?.defaults?.[feature];
  if (typeof configured === 'string' && accepted.has(configured)) return configured;
  if (accepted.has(proposed)) return proposed;
  return [...accepted][0] ?? proposed;
}
