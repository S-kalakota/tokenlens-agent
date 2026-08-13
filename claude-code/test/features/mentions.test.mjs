import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  isIncludedCodePath,
  parseAtMentions,
  resolveMentionedFiles,
} from '../../src/features/mentions.mjs';

const manifestPath = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);
let manifest;

beforeAll(async () => {
  manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
});

describe('parseAtMentions', () => {
  it('parses unique boundary-delimited paths and strips sentence punctuation', () => {
    const prompt = [
      'Use @src/a.ts:20-80, (@src/b.ts), and "@src/c.ts". Ignore user@example.com.',
      '`@inline.ts` and @src/a.ts are not two more files.',
      '```js',
      '@fenced.ts',
      '```',
    ].join('\n');

    expect(parseAtMentions(prompt)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('does not treat pasted-image placeholders as attachments', () => {
    expect(parseAtMentions('Inspect [Image #1] and explain it.')).toEqual([]);
  });

  it('keeps mentions hidden when a code line resembles a closing fence with info', () => {
    const prompt = '```txt\n```js\n@hidden.ts\n```\nUse @shown.ts.';
    expect(parseAtMentions(prompt)).toEqual(['shown.ts']);
  });
});

describe('manifest file inclusion', () => {
  it('accepts configured code files and rejects secrets, dependencies and lockfiles', () => {
    expect(isIncludedCodePath('src/index.ts', manifest)).toBe(true);
    expect(isIncludedCodePath('Dockerfile', manifest)).toBe(true);
    expect(isIncludedCodePath('.env', manifest)).toBe(false);
    expect(isIncludedCodePath('node_modules/pkg/index.js', manifest)).toBe(false);
    expect(isIncludedCodePath('package-lock.json', manifest)).toBe(false);
  });
});

describe('resolveMentionedFiles', () => {
  it('contains real paths, rejects unsafe files, and deduplicates symlink aliases', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'tokenlens-mentions-'));
    const workspace = path.join(parent, 'workspace');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'accepted.ts'), 'four', 'utf8');
    await symlink('src/accepted.ts', path.join(workspace, 'alias.ts'));
    await writeFile(path.join(workspace, 'src', 'binary.ts'), Buffer.from([0x61, 0, 0x62]));
    await writeFile(path.join(workspace, 'src', 'large.ts'), 'x'.repeat(20), 'utf8');
    await writeFile(path.join(parent, 'outside.ts'), 'outside', 'utf8');
    await symlink(path.join(parent, 'outside.ts'), path.join(workspace, 'escape.ts'));

    const limited = structuredClone(manifest);
    limited.repository.max_file_bytes = 10;
    const result = await resolveMentionedFiles({
      prompt: [
        '@src/accepted.ts @alias.ts @src/accepted.ts',
        '@src/ @src/missing.ts @src/binary.ts @src/large.ts',
        '@../outside.ts @escape.ts',
      ].join(' '),
      cwd: workspace,
      manifest: limited,
      countTokens: (text) => text.length,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/accepted.ts']);
    expect(result.nFilesAttached).toBe(1);
    expect(result.attachedCodeTokens).toBe(4);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'directory_reference',
        'file_unavailable',
        'binary_file',
        'file_size_limit',
        'path_outside_workspace',
        'symlink_outside_workspace',
        'mention_derived',
      ]),
    );
  });

  it('uses explicit zero defaults for a missing workspace', async () => {
    const result = await resolveMentionedFiles({
      prompt: '@src/index.ts',
      cwd: '/definitely/not/a/tokenlens/workspace',
      manifest,
    });
    expect(result).toMatchObject({
      files: [],
      attachedCodeTokens: 0,
      nFilesAttached: 0,
      warnings: ['workspace_unavailable'],
    });
  });

  it('bounds aggregate accepted mention bytes from the manifest', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-mentions-limit-'));
    await writeFile(path.join(workspace, 'a.ts'), '1234', 'utf8');
    await writeFile(path.join(workspace, 'b.ts'), '5678', 'utf8');
    const limited = structuredClone(manifest);
    limited.repository.max_relevant_bytes = 5;

    const result = await resolveMentionedFiles({
      prompt: '@a.ts @b.ts',
      cwd: workspace,
      manifest: limited,
      countTokens: (text) => text.length,
    });
    expect(result.nFilesAttached).toBe(1);
    expect(result.attachedCodeTokens).toBe(4);
    expect(result.warnings).toContain('mention_total_size_limit');
  });

  it('rejects a relative cwd instead of depending on the hook process directory', async () => {
    expect(
      await resolveMentionedFiles({
        prompt: '@src/index.ts',
        cwd: '.',
        manifest,
      }),
    ).toMatchObject({
      files: [],
      attachedCodeTokens: 0,
      nFilesAttached: 0,
      warnings: ['workspace_unavailable'],
    });
  });
});
