import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFeatureLog, featureLogPath } from '../src/feature-log.mjs';
import { loadFeatureManifest } from '../src/features/build-features.mjs';

let manifest;
let previousHome;

beforeAll(async () => {
  manifest = await loadFeatureManifest();
});

beforeEach(async () => {
  previousHome = process.env.TOKENLENS_HOME;
  process.env.TOKENLENS_HOME = await mkdtemp(path.join(tmpdir(), 'tokenlens-feature-log-'));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
  else process.env.TOKENLENS_HOME = previousHome;
});

function payload(overrides = {}) {
  return {
    schema_version: manifest.feature_schema_version,
    features: { ...manifest.defaults, ...overrides },
    collection: {
      complete: true,
      tokenizer: `${manifest.tokenizer.name}@${manifest.tokenizer.version}`,
      collector_version: manifest.collector_version,
      duration_ms: 1,
      warnings: ['training_contract_provisional'],
      parsers: { ...manifest.parsers },
      attachment_semantics: manifest.attachment_semantics,
    },
  };
}

describe('ML feature inspection log', () => {
  it('appends the exact prompt and all 14 ordered features as JSON Lines', async () => {
    const prompt = 'Refactor @src/parser.ts.\nReturn a concise patch.';
    const extracted = payload({
      output_format: 'patch',
      task_type: 'refactor',
      detail_level: 'concise',
      input_tokens: 13,
      n_files_attached: 1,
    });

    await appendFeatureLog({
      prompt,
      payload: extracted,
      manifest,
      sessionId: 'session-a',
      now: () => new Date('2026-08-13T12:34:56.000Z'),
    });
    await appendFeatureLog({
      prompt: 'Second prompt',
      payload: payload({ task_type: 'review' }),
      manifest,
      sessionId: 'session-a',
      now: () => new Date('2026-08-13T12:35:00.000Z'),
    });

    const lines = (await readFile(featureLogPath(), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({
      logged_at: '2026-08-13T12:34:56.000Z',
      session_id: 'session-a',
      schema_version: manifest.feature_schema_version,
      prompt,
      features: extracted.features,
    });
    expect(Object.keys(first.features)).toEqual(manifest.feature_order);
    expect(Object.keys(first.features)).toHaveLength(14);
    expect(first).not.toHaveProperty('collection');
    expect(first).not.toHaveProperty('cwd');
    expect(first).not.toHaveProperty('transcript_path');
  });

  it('creates a private log directory and file', async () => {
    await appendFeatureLog({
      prompt: 'private prompt',
      payload: payload(),
      manifest,
      sessionId: 'session-private',
    });

    const fileMode = (await stat(featureLogPath())).mode & 0o777;
    const directoryMode = (await stat(path.dirname(featureLogPath()))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
  });

  it('refuses to log an invalid feature payload', async () => {
    const invalid = payload();
    delete invalid.features.input_tokens;
    await expect(
      appendFeatureLog({ prompt: 'invalid', payload: invalid, manifest, sessionId: 'bad' }),
    ).rejects.toThrow(/missing: input_tokens/u);
  });
});
