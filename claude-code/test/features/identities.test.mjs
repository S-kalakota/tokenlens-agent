import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeGitHubOrigin,
  resolveModelId,
  resolveRepositoryIdentity,
} from '../../src/features/identities.mjs';

const run = promisify(execFile);
const manifestPath = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);
let manifest;

beforeAll(async () => {
  manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
});

describe('normalizeGitHubOrigin', () => {
  it.each([
    ['https://github.com/Owner/Repository.git', 'owner/repository'],
    ['git@github.com:Owner/Repository.git', 'owner/repository'],
    ['ssh://git@github.com/Owner/Repository.git', 'owner/repository'],
  ])('normalizes %s', (origin, expected) => {
    expect(normalizeGitHubOrigin(origin)).toBe(expected);
  });

  it('rejects non-GitHub and malformed remotes', () => {
    expect(normalizeGitHubOrigin('git@gitlab.com:owner/repository.git')).toBeNull();
    expect(normalizeGitHubOrigin('/local/repository')).toBeNull();
  });
});

describe('resolveRepositoryIdentity', () => {
  it('maps an origin slug without exposing an absolute path as the model id', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-identity-'));
    await run('git', ['init', '-q', workspace]);
    await run('git', [
      '-C',
      workspace,
      'remote',
      'add',
      'origin',
      'git@github.com:S-kalakota/Cursor_Token_Price_Estimator.git',
    ]);

    const result = await resolveRepositoryIdentity({ cwd: workspace, manifest });
    expect(result.repoId).toBe('cursor_token_price_estimator');
    expect(result.slug).toBe('s-kalakota/cursor_token_price_estimator');
    expect(result.root).toBe(await realpath(workspace));
    expect(result.warnings).toEqual([]);
  });

  it('returns the manifest fallback for non-Git workspaces and unknown mappings', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'tokenlens-identity-'));
    expect(await resolveRepositoryIdentity({ cwd: plain, manifest })).toMatchObject({
      repoId: 'unknown',
      root: null,
      warnings: ['repository_unavailable'],
    });

    const repository = await mkdtemp(path.join(tmpdir(), 'tokenlens-identity-'));
    await run('git', ['init', '-q', repository]);
    await run('git', [
      '-C',
      repository,
      'remote',
      'add',
      'origin',
      'https://github.com/example/unknown.git',
    ]);
    expect(await resolveRepositoryIdentity({ cwd: repository, manifest })).toMatchObject({
      repoId: 'unknown',
      slug: 'example/unknown',
      warnings: ['repository_id_unknown'],
    });
  });

  it('does not resolve a relative cwd against the hook process directory', async () => {
    expect(await resolveRepositoryIdentity({ cwd: '.', manifest })).toMatchObject({
      repoId: 'unknown',
      root: null,
      warnings: ['repository_unavailable'],
    });
  });
});

describe('resolveModelId', () => {
  it.each([
    ['claude-opus-5', 'claude-opus-5'],
    ['CLAUDE-SONNET-5', 'claude-sonnet-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-sonnet-5-20261231', 'claude-sonnet-5'],
    ['opus', 'claude-opus-5'],
    ['sonnet', 'claude-sonnet-5'],
    ['haiku', 'claude-haiku-4-5'],
    ['some-future-model', 'unknown'],
    [null, 'unknown'],
  ])('maps %s to %s', (model, expected) => {
    expect(resolveModelId(model, manifest)).toBe(expected);
  });
});
