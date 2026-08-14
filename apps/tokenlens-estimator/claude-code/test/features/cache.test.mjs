import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pruneRepositoryCache,
  readRepositoryCache,
  repositoryCacheDirectory,
  writeRepositoryCache,
} from '../../src/features/cache.mjs';

let previousHome;

beforeEach(async () => {
  previousHome = process.env.TOKENLENS_HOME;
  process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-cache-'));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
  else process.env.TOKENLENS_HOME = previousHome;
});

describe('repository metrics cache', () => {
  it('round-trips counts without persisting paths or source', async () => {
    await writeRepositoryCache('private/repository/path', {
      codebaseLines: 42,
      codebaseFiles: 3,
      warnings: ['repository_binary_file'],
    });
    expect(await readRepositoryCache('private/repository/path')).toMatchObject({
      codebaseLines: 42,
      codebaseFiles: 3,
      warnings: ['repository_binary_file'],
    });

    const [entry] = await readdir(repositoryCacheDirectory());
    const persisted = await readFile(path.join(repositoryCacheDirectory(), entry), 'utf8');
    expect(persisted).not.toContain('private/repository/path');
    expect(Object.keys(JSON.parse(persisted)).sort()).toEqual([
      'codebaseFiles',
      'codebaseLines',
      'createdAt',
      'warnings',
    ]);
  });

  it('treats expired entries as misses and prunes them on the shared schedule', async () => {
    await writeRepositoryCache('old-key', { codebaseLines: 1, codebaseFiles: 1 });
    const future = Date.now() + 25 * 60 * 60 * 1000;
    expect(await readRepositoryCache('old-key', { now: future })).toBeNull();
    expect(await pruneRepositoryCache(future)).toBe(1);
    expect(await readdir(repositoryCacheDirectory())).toEqual([]);
  });

  it('rejects invalid metrics instead of poisoning future reads', async () => {
    await expect(
      writeRepositoryCache('bad', { codebaseLines: -1, codebaseFiles: 1 }),
    ).rejects.toThrow(TypeError);
  });
});
