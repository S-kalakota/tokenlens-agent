import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFeatures, loadFeatureManifest } from '../../src/features/build-features.mjs';
import { countTaskWords, countRequirements } from '../../src/features/prompt-structure.mjs';
import { countTokens } from '../../src/features/tokenizer.mjs';

const run = promisify(execFile);
const manifestPath = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);
const atMentionPayloadPath = fileURLToPath(
  new URL('./fixtures/claude-user-prompt-submit-at-mention.json', import.meta.url),
);
let manifest;
let previousHome;

beforeAll(async () => {
  manifest = await loadFeatureManifest(manifestPath);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
  else process.env.TOKENLENS_HOME = previousHome;
});

describe('buildFeatures', () => {
  it('assembles exactly the canonical 14 named values and keeps source data out', async () => {
    const secretPrompt = 'private prompt';
    const secretSource = 'private source contents';
    const times = [100, 173];
    const payload = await buildFeatures(
      {
        prompt: secretPrompt,
        cwd: '/private/workspace',
        modelId: 'claude-opus-5',
        manifest,
        repoIdMap: {},
      },
      {
        now: () => times.shift(),
        countTokens: (text) => Array.from(text).length,
        classifyPrompt: () => ({
          output_format: 'patch',
          task_type: 'refactor',
          detail_level: 'concise',
        }),
        promptMetrics: () => ({
          task_word_count: 8,
          n_requirements: 2,
          question_count: 1,
        }),
        resolveRepositoryIdentity: vi.fn(async () => ({
          repoId: 'cursor_token_price_estimator',
          root: '/private/workspace',
          slug: 'private/repository',
          warnings: [],
        })),
        collectRepositoryMetrics: vi.fn(async () => ({
          codebaseLines: 18_422,
          codebaseFiles: 142,
          repositoryRoot: '/private/workspace',
          warnings: [],
        })),
        resolveMentionedFiles: vi.fn(async () => ({
          files: [{ realPath: '/private/workspace/a.ts', content: secretSource }],
          attachedCodeTokens: 1_380,
          nFilesAttached: 1,
          warnings: ['mention_derived'],
        })),
        resolveRelevantCode: vi.fn(async () => ({
          relevantCodeTokens: 1_500,
          segments: [secretSource],
          warnings: [],
        })),
      },
    );

    expect(payload.features).toEqual({
      output_format: 'patch',
      task_type: 'refactor',
      repo_id: 'cursor_token_price_estimator',
      model_id: 'claude-opus-5',
      detail_level: 'concise',
      input_tokens: secretPrompt.length,
      attached_code_tokens: 1_380,
      relevant_code_tokens: 1_500,
      task_word_count: 8,
      n_requirements: 2,
      question_count: 1,
      codebase_lines: 18_422,
      codebase_files: 142,
      n_files_attached: 1,
    });
    expect(Object.keys(payload.features)).toEqual(manifest.feature_order);
    expect(payload.collection).toEqual({
      complete: true,
      tokenizer: 'tokenlens-unicode-char4@1.0.0',
      collector_version: '1.0.0',
      duration_ms: 73,
      warnings: [
        'mention_derived',
        'model_selection_may_lag',
        'single_root_only',
        'training_contract_provisional',
      ],
      parsers: manifest.parsers,
      attachment_semantics: 'mention_derived',
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secretPrompt);
    expect(serialized).not.toContain(secretSource);
    expect(serialized).not.toContain('/private/workspace');
    expect(serialized).not.toContain('private/repository');
    expect(serialized).not.toContain('contextTokens');
  });

  it('returns explicit defaults and warnings instead of throwing for unavailable inputs', async () => {
    const payload = await buildFeatures({
      prompt: '',
      cwd: '/definitely/not/a/tokenlens/workspace',
      modelId: null,
      manifest,
      repoIdMap: {},
    });

    expect(payload.features).toMatchObject({
      repo_id: 'unknown',
      model_id: 'unknown',
      input_tokens: 0,
      attached_code_tokens: 0,
      relevant_code_tokens: 0,
      codebase_lines: 0,
      codebase_files: 0,
      n_files_attached: 0,
    });
    expect(payload.collection.complete).toBe(false);
    expect(payload.collection.warnings).toEqual(
      expect.arrayContaining([
        'model_id_fallback',
        'repository_unavailable',
        'single_root_only',
        'workspace_unavailable',
      ]),
    );
  });

  it('pins the supplied Claude hook contract where @ mentions remain literal', async () => {
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-at-home-'));
    const fixture = JSON.parse(await readFile(atMentionPayloadPath, 'utf8'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-at-payload-'));
    await mkdir(path.join(workspace, 'src'));
    await run('git', ['init', '-q', workspace]);
    await writeFile(path.join(workspace, 'src', 'parser.ts'), 'export {};\n', 'utf8');
    await run('git', ['-C', workspace, 'add', '-A']);

    expect(fixture.hook_event_name).toBe('UserPromptSubmit');
    expect(fixture.prompt).toContain('@src/parser.ts');
    expect(fixture).not.toHaveProperty('attachments');

    const payload = await buildFeatures({
      ...fixture,
      cwd: workspace,
      modelId: null,
      manifest,
      repoIdMap: {},
    });
    expect(payload.features.n_files_attached).toBe(1);
    expect(payload.features.attached_code_tokens).toBeGreaterThan(0);
    expect(payload.features.relevant_code_tokens).toBe(
      payload.features.attached_code_tokens,
    );
  });

  it('collects a deterministic golden payload from a real hook-style fixture', async () => {
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-golden-home-'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens golden workspace-'));
    await mkdir(path.join(workspace, 'src'));
    await run('git', ['init', '-q', workspace]);
    await run('git', [
      '-C',
      workspace,
      'remote',
      'add',
      'origin',
      'git@github.com:S-kalakota/Cursor_Token_Price_Estimator.git',
    ]);
    await writeFile(path.join(workspace, 'src', 'attached.ts'), 'abcd', 'utf8');
    await writeFile(path.join(workspace, 'src', 'range.ts'), 'aaaa\nbbbb\ncccc\n', 'utf8');
    await writeFile(path.join(workspace, 'README.md'), 'docs\n', 'utf8');
    await run('git', ['-C', workspace, 'add', '-A']);

    const transcriptPath = path.join(workspace, 'session.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
      'utf8',
    );

    const prompt = [
      'Refactor @src/attached.ts and inspect src/range.ts:2-3.',
      '- Preserve the public API.',
      '- Return a patch.',
      'Keep the response concise. Why now?',
    ].join('\n');
    const payload = await buildFeatures({ prompt, cwd: workspace, transcriptPath, manifest });

    expect(payload.features).toEqual({
      output_format: 'patch',
      task_type: 'refactor',
      repo_id: 'cursor_token_price_estimator',
      model_id: 'claude-haiku-4-5',
      detail_level: 'concise',
      input_tokens: countTokens(prompt, manifest.tokenizer),
      attached_code_tokens: 1,
      relevant_code_tokens: 4,
      task_word_count: countTaskWords(prompt),
      n_requirements: countRequirements(prompt),
      question_count: 1,
      codebase_lines: 5,
      codebase_files: 3,
      n_files_attached: 1,
    });
    expect(payload.features.n_requirements).toBe(4);
    expect(payload.collection.complete).toBe(true);
    expect(payload.collection.warnings).toEqual(
      expect.arrayContaining(['mention_derived', 'model_selection_may_lag', 'single_root_only']),
    );

    const cacheDirectory = path.join(process.env.TOKENLENS_HOME, 'repository-cache');
    const cacheEntries = await readdir(cacheDirectory);
    expect(cacheEntries).toHaveLength(1);
    const persisted = await readFile(path.join(cacheDirectory, cacheEntries[0]), 'utf8');
    expect(persisted).not.toContain(prompt);
    expect(persisted).not.toContain('abcd');
    expect(persisted).not.toContain(workspace);
  });
});
