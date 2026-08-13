import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFeatures, loadFeatureManifest } from '../../src/features/build-features.mjs';
import { countTokens } from '../../src/features/tokenizer.mjs';

const run = promisify(execFile);
let manifest;
let previousHome;

beforeAll(async () => {
  manifest = await loadFeatureManifest();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
  else process.env.TOKENLENS_HOME = previousHome;
});

async function makeRepository({ files, origin }) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-variation-'));
  await run('git', ['init', '-q', workspace]);
  if (origin) {
    await run('git', ['-C', workspace, 'remote', 'add', 'origin', origin]);
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(workspace, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  await run('git', ['-C', workspace, 'add', '-A']);
  return workspace;
}

describe('all-feature variation audit', () => {
  it('changes every canonical feature when its intended signal changes', async () => {
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-variation-home-'));

    const knownOrigin = 'https://github.com/example/known.git';
    const repoIdMap = { 'example/known': 'cursor_token_price_estimator' };
    const smallRepository = await makeRepository({
      origin: knownOrigin,
      files: { 'src/only.ts': 'one line\n' },
    });
    const largeRepository = await makeRepository({
      origin: knownOrigin,
      files: {
        'src/attached.ts': 'export const attached = true;\n',
        'src/relevant.ts': 'export const first = 1;\nexport const second = 2;\n',
      },
    });
    const unknownRepository = await makeRepository({
      origin: 'https://github.com/example/unknown.git',
      files: { 'src/only.ts': 'one line\n' },
    });

    const collect = ({
      prompt = 'Hello there.',
      cwd = smallRepository,
      modelId = 'haiku',
    } = {}) => buildFeatures({ prompt, cwd, modelId, manifest, repoIdMap });

    const baseline = await collect();
    const outputFormat = await collect({ prompt: 'Return JSON.' });
    const taskType = await collect({ prompt: 'Fix the broken parser regression.' });
    const repositoryIdentity = await collect({ cwd: unknownRepository });
    const modelIdentity = await collect({ modelId: 'opus' });
    const detailLevel = await collect({ prompt: 'Keep the answer concise.' });
    const longerInput = await collect({ prompt: 'Hello there with substantially more text.' });
    const largeBaseline = await collect({ cwd: largeRepository });
    const attached = await collect({
      cwd: largeRepository,
      prompt: 'Review @src/attached.ts',
    });
    const relevant = await collect({
      cwd: largeRepository,
      prompt: 'Inspect src/relevant.ts',
    });
    const moreWords = await collect({
      prompt: 'Explain the repository architecture in simple terms.',
    });
    const requirements = await collect({
      prompt: 'Add caching. Preserve compatibility.',
    });
    const questions = await collect({
      prompt: 'Why now? What changed?',
    });

    expect(baseline.features.output_format).toBe('unspecified');
    expect(outputFormat.features.output_format).toBe('json');

    expect(baseline.features.task_type).toBe('other');
    expect(taskType.features.task_type).toBe('bug_fix');

    expect(baseline.features.repo_id).toBe('cursor_token_price_estimator');
    expect(repositoryIdentity.features.repo_id).toBe('unknown');

    expect(baseline.features.model_id).toBe('claude-haiku-4-5');
    expect(modelIdentity.features.model_id).toBe('claude-opus-5');

    expect(baseline.features.detail_level).toBe('standard');
    expect(detailLevel.features.detail_level).toBe('concise');

    expect(longerInput.features.input_tokens).toBe(
      countTokens('Hello there with substantially more text.', manifest.tokenizer),
    );
    expect(longerInput.features.input_tokens).toBeGreaterThan(baseline.features.input_tokens);

    expect(largeBaseline.features.attached_code_tokens).toBe(0);
    expect(attached.features.attached_code_tokens).toBeGreaterThan(0);

    expect(largeBaseline.features.relevant_code_tokens).toBe(0);
    expect(relevant.features.relevant_code_tokens).toBeGreaterThan(0);

    expect(moreWords.features.task_word_count).toBeGreaterThan(
      baseline.features.task_word_count,
    );

    expect(baseline.features.n_requirements).toBe(0);
    expect(requirements.features.n_requirements).toBe(2);

    expect(baseline.features.question_count).toBe(0);
    expect(questions.features.question_count).toBe(2);

    expect(baseline.features.codebase_lines).toBe(1);
    expect(largeBaseline.features.codebase_lines).toBe(3);

    expect(baseline.features.codebase_files).toBe(1);
    expect(largeBaseline.features.codebase_files).toBe(2);

    expect(largeBaseline.features.n_files_attached).toBe(0);
    expect(attached.features.n_files_attached).toBe(1);

    expect(Object.keys(baseline.features)).toEqual(manifest.feature_order);
    expect(Object.keys(baseline.features)).toHaveLength(14);
  });
});
