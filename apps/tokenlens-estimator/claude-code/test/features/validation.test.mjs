import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  FeatureValidationError,
  validateFeatureManifest,
  validateFeaturePayload,
} from '../../src/features/validation.mjs';

const MANIFEST_PATH = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);

let manifest;

beforeAll(async () => {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
});

function payload(overrides = {}) {
  return {
    schema_version: manifest.feature_schema_version,
    features: {
      ...manifest.defaults,
      output_format: 'patch',
      task_type: 'refactor',
      repo_id: 'cursor_token_price_estimator',
      model_id: 'claude-sonnet-5',
      detail_level: 'concise',
      input_tokens: 42,
      attached_code_tokens: 13,
      relevant_code_tokens: 21,
      task_word_count: 8,
      n_requirements: 2,
      question_count: 1,
      codebase_lines: 100,
      codebase_files: 9,
      n_files_attached: 1,
      ...(overrides.features ?? {}),
    },
    collection: {
      complete: true,
      tokenizer: `${manifest.tokenizer.name}@${manifest.tokenizer.version}`,
      collector_version: manifest.collector_version,
      duration_ms: 7,
      warnings: [],
      parsers: { ...manifest.parsers },
      attachment_semantics: manifest.attachment_semantics,
      ...(overrides.collection ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== 'features' && key !== 'collection'),
    ),
  };
}

describe('feature manifest validation', () => {
  it('accepts the checked-in v1 manifest and fixed feature order', () => {
    expect(validateFeatureManifest(manifest)).toBe(manifest);
    expect(manifest.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(manifest.feature_order).toEqual(FEATURE_ORDER);
    expect(manifest.feature_order).toHaveLength(14);
  });

  it('rejects a reordered model column', () => {
    const invalid = structuredClone(manifest);
    [invalid.feature_order[0], invalid.feature_order[1]] = [
      invalid.feature_order[1],
      invalid.feature_order[0],
    ];
    expect(() => validateFeatureManifest(invalid)).toThrow(/fixed 14 features in model order/);
  });

  it('rejects a different feature schema version', () => {
    const invalid = structuredClone(manifest);
    invalid.feature_schema_version = 'tokenlens.ml-features.v2';
    expect(() => validateFeatureManifest(invalid)).toThrow(
      /manifest\.feature_schema_version must equal "tokenlens\.ml-features\.v1"/,
    );
  });

  it('rejects defaults outside categorical vocabularies', () => {
    const invalid = structuredClone(manifest);
    invalid.defaults.model_id = 'claude-future';
    expect(() => validateFeatureManifest(invalid)).toThrow(
      /manifest\.defaults\.model_id must be in its categorical vocabulary/,
    );
  });

  it('rejects duplicate categorical labels', () => {
    const invalid = structuredClone(manifest);
    invalid.categorical_features.detail_level.push('standard');
    expect(() => validateFeatureManifest(invalid)).toThrow(/contains duplicate value "standard"/);
  });

  it('rejects incompatible tokenizer, repository, and model alias rules', () => {
    const invalid = structuredClone(manifest);
    invalid.tokenizer.characters_per_token = 0;
    invalid.repository.max_files = -1;
    invalid.model_id_resolution.aliases.future = 'future-model';
    expect(() => validateFeatureManifest(invalid)).toThrow(
      /characters_per_token|repository\.max_files|aliases\.future/u,
    );
  });

  it('requires real artifacts and checksums before claiming training compatibility', () => {
    const invalid = structuredClone(manifest);
    invalid.compatibility_status = 'training-locked';
    expect(() => validateFeatureManifest(invalid)).toThrow(
      /preprocessing_artifact|model_artifact|sha256/u,
    );
  });
});

describe('feature payload validation', () => {
  it('accepts an exact canonical payload', () => {
    const value = payload();
    expect(validateFeaturePayload(value, manifest)).toBe(value);
  });

  it('rejects missing and extra feature columns', () => {
    const missing = payload();
    delete missing.features.input_tokens;
    expect(() => validateFeaturePayload(missing, manifest)).toThrow(
      /payload\.features is missing: input_tokens/,
    );

    const extra = payload({ features: { invented_column: 1 } });
    expect(() => validateFeaturePayload(extra, manifest)).toThrow(
      /payload\.features has unknown fields: invented_column/,
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s numeric feature', (_label, value) => {
    expect(() =>
      validateFeaturePayload(payload({ features: { input_tokens: value } }), manifest),
    ).toThrow(/payload\.features\.input_tokens/);
  });

  it('rejects a category outside the manifest vocabulary', () => {
    expect(() =>
      validateFeaturePayload(payload({ features: { task_type: 'migration' } }), manifest),
    ).toThrow(/payload\.features\.task_type must be one of/);
  });

  it('rejects incompatible schema, tokenizer, parser, and collection fields', () => {
    const invalid = payload({
      schema_version: 'tokenlens.ml-features.v2',
      collection: {
        tokenizer: 'different@9.0.0',
        duration_ms: -1,
        warnings: ['repeat', 'repeat'],
        parsers: { ...manifest.parsers, questions: 'other-parser' },
        source_code: 'must never be here',
      },
    });

    let caught;
    try {
      validateFeaturePayload(invalid, manifest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FeatureValidationError);
    expect(caught.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('payload.schema_version'),
        expect.stringContaining('payload.collection has unknown fields: source_code'),
        expect.stringContaining('payload.collection.tokenizer'),
        expect.stringContaining('payload.collection.duration_ms'),
        expect.stringContaining('duplicate value "repeat"'),
        expect.stringContaining('payload.collection.parsers.questions'),
      ]),
    );
  });

  it('rejects collection metadata omitted from the canonical shape', () => {
    const invalid = payload();
    delete invalid.collection.parsers;
    expect(() => validateFeaturePayload(invalid, manifest)).toThrow(
      /payload\.collection is missing: parsers/,
    );
  });
});
