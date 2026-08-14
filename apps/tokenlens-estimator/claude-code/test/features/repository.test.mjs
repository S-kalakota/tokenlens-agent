import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  collectRepositoryMetrics,
  countPhysicalLines,
} from '../../src/features/repository.mjs';

const run = promisify(execFile);
const manifestPath = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);
let manifest;
let previousHome;

beforeAll(async () => {
  manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
  else process.env.TOKENLENS_HOME = previousHome;
});

describe('countPhysicalLines', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\n\nthree\n', 3],
    ['one\r\ntwo\r\n', 2],
  ])('counts %j as %i physical lines', (content, expected) => {
    expect(countPhysicalLines(Buffer.from(content))).toBe(expected);
  });
});

describe('collectRepositoryMetrics', () => {
  it('uses one bounded file set, excludes unsafe files, caches, and invalidates changes', async () => {
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-repo-cache-'));
    const parent = await mkdtemp(path.join(tmpdir(), 'tokenlens-repository-'));
    const repository = path.join(parent, 'repository');
    await mkdir(path.join(repository, 'src'), { recursive: true });
    await mkdir(path.join(repository, 'node_modules', 'pkg'), { recursive: true });
    await run('git', ['init', '-q', repository]);

    await writeFile(path.join(repository, 'src', 'a.ts'), 'one\n\nthree\n', 'utf8');
    await writeFile(path.join(repository, 'src', 'empty.py'), '', 'utf8');
    await writeFile(path.join(repository, 'docs.md'), 'hello', 'utf8');
    await writeFile(path.join(repository, 'src', 'real.js'), 'x\n', 'utf8');
    await symlink('real.js', path.join(repository, 'src', 'alias.js'));
    await writeFile(path.join(repository, 'src', 'binary.ts'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(repository, 'package-lock.json'), '{}', 'utf8');
    await writeFile(path.join(repository, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf8');
    await writeFile(path.join(parent, 'external.ts'), 'external', 'utf8');
    await symlink(path.join(parent, 'external.ts'), path.join(repository, 'src', 'external.ts'));
    await run('git', ['-C', repository, 'add', '-A']);

    const first = await collectRepositoryMetrics({ cwd: path.join(repository, 'src'), manifest });
    expect(first).toMatchObject({
      codebaseFiles: 4,
      codebaseLines: 5,
      repositoryRoot: await realpath(repository),
      cacheHit: false,
    });
    expect(first.warnings).toEqual(
      expect.arrayContaining(['repository_binary_file', 'repository_symlink_escape']),
    );

    const second = await collectRepositoryMetrics({ cwd: repository, manifest });
    expect(second).toMatchObject({
      codebaseFiles: 4,
      codebaseLines: 5,
      cacheHit: true,
    });

    await writeFile(path.join(repository, 'docs.md'), 'hello\nworld', 'utf8');
    const changed = await collectRepositoryMetrics({ cwd: repository, manifest });
    expect(changed).toMatchObject({
      codebaseFiles: 4,
      codebaseLines: 6,
      cacheHit: false,
    });

    await writeFile(path.join(repository, 'docs.md'), 'alpha\nbeta!', 'utf8');
    const sameSize = await collectRepositoryMetrics({ cwd: repository, manifest });
    expect(sameSize).toMatchObject({
      codebaseFiles: 4,
      codebaseLines: 6,
      cacheHit: false,
    });
  });

  it('returns documented zero defaults outside Git', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-non-git-'));
    expect(await collectRepositoryMetrics({ cwd: workspace, manifest, cache: false })).toEqual({
      codebaseLines: 0,
      codebaseFiles: 0,
      repositoryRoot: null,
      cacheHit: false,
      warnings: ['repository_unavailable'],
    });
  });

  it('honors manifest file and total-byte limits deterministically', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'tokenlens-repository-'));
    await run('git', ['init', '-q', repository]);
    await writeFile(path.join(repository, 'a.ts'), '1234', 'utf8');
    await writeFile(path.join(repository, 'b.ts'), '5678', 'utf8');
    await run('git', ['-C', repository, 'add', '-A']);
    const limited = structuredClone(manifest);
    limited.repository.max_files = 1;
    limited.repository.max_total_bytes = 5;

    const result = await collectRepositoryMetrics({ cwd: repository, manifest: limited, cache: false });
    expect(result.codebaseFiles).toBe(1);
    expect(result.warnings).toContain('repository_file_count_limit');
  });
});
