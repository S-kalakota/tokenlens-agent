import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveMentionedFiles } from '../../src/features/mentions.mjs';
import {
  mergeRanges,
  parsePathReferences,
  resolveRelevantCode,
} from '../../src/features/references.mjs';

const manifestPath = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);
let manifest;

beforeAll(async () => {
  manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
});

describe('parsePathReferences', () => {
  it('recognizes whole files and supported line-range forms outside code', () => {
    const prompt = [
      'Inspect src/a.ts:2-4 and src/a.ts#L8-L10 plus README.md. In src/c.ts: update it.',
      'Include `src/inline.ts`, but ignore @src/attached.ts and https://example.com/src/url.ts.',
      '```',
      'src/fenced.ts',
      '```',
    ].join('\n');

    expect(parsePathReferences(prompt, manifest)).toEqual([
      { path: 'src/a.ts', lines: { start: 2, end: 4 } },
      { path: 'src/a.ts', lines: { start: 8, end: 10 } },
      { path: 'README.md', lines: null },
      { path: 'src/c.ts', lines: null },
      { path: 'src/inline.ts', lines: null },
    ]);
  });

  it('merges overlapping and adjacent ranges deterministically', () => {
    expect(
      mergeRanges([
        { start: 5, end: 8 },
        { start: 1, end: 2 },
        { start: 3, end: 6 },
        { start: 12, end: 12 },
      ]),
    ).toEqual([
      { start: 1, end: 8 },
      { start: 12, end: 12 },
    ]);
  });
});

describe('resolveRelevantCode', () => {
  it('unions mentioned files with bare paths, merges ranges, clamps, and deduplicates', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-references-'));
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n', 'utf8');
    await writeFile(path.join(workspace, 'src', 'b.ts'), 'abc', 'utf8');

    const prompt = [
      '@src/b.ts',
      'Inspect src/a.ts:1-2, src/a.ts#L2-L3, and src/a.ts:4-99.',
      'Also inspect src/b.ts so the whole-file duplicate is counted once.',
    ].join(' ');
    const mentioned = await resolveMentionedFiles({
      prompt,
      cwd: workspace,
      manifest,
      countTokens: (text) => text.length,
    });
    const result = await resolveRelevantCode({
      prompt,
      cwd: workspace,
      manifest,
      mentionedFiles: mentioned,
      countTokens: (text) => text.length,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.find((file) => file.relativePath === 'src/a.ts')).toMatchObject({
      wholeFile: false,
      ranges: [{ start: 1, end: 4 }],
    });
    expect(result.files.find((file) => file.relativePath === 'src/b.ts')).toMatchObject({
      wholeFile: true,
      ranges: [],
    });
    expect(result.relevantCodeTokens).toBe(21);
  });

  it('rejects paths outside cwd without reading them', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'tokenlens-references-'));
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(parent, 'secret.ts'), 'do not read', 'utf8');

    const result = await resolveRelevantCode({
      prompt: 'Inspect ../secret.ts.',
      cwd: workspace,
      manifest,
      countTokens: (text) => text.length,
    });
    expect(result.relevantCodeTokens).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.warnings).toContain('reference_path_outside_workspace');
  });

  it('bounds aggregate relevant source bytes from the manifest', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-references-limit-'));
    await writeFile(path.join(workspace, 'a.ts'), '1234', 'utf8');
    await writeFile(path.join(workspace, 'b.ts'), '5678', 'utf8');
    const limited = structuredClone(manifest);
    limited.repository.max_relevant_bytes = 5;

    const result = await resolveRelevantCode({
      prompt: 'Inspect a.ts and b.ts.',
      cwd: workspace,
      manifest: limited,
      countTokens: (text) => text.length,
    });
    expect(result.files).toHaveLength(1);
    expect(result.relevantCodeTokens).toBe(4);
    expect(result.warnings).toContain('reference_total_size_limit');
  });
});
