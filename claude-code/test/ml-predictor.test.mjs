import { beforeAll, describe, expect, it } from 'vitest';
import { loadFeatureManifest } from '../src/features/build-features.mjs';
import { predictEstimate } from '../src/ml-predictor.mjs';

let manifest;

beforeAll(async () => {
  manifest = await loadFeatureManifest();
});

function payload(inputTokens = 7) {
  return {
    schema_version: manifest.feature_schema_version,
    features: { ...manifest.defaults, input_tokens: inputTokens },
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

describe('prediction boundary', () => {
  it('validates/orders all features before the local pricing fallback', () => {
    const estimate = predictEstimate({
      payload: payload(7),
      manifest,
      prompt: 'x'.repeat(400),
      contextTokens: 0,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 0,
    });

    expect(estimate.promptTokens).toBe(7);
    expect(estimate.breakdown.newInputUsd).toBeCloseTo((7 * 3.75) / 1_000_000, 12);
    expect(estimate.featureSchemaVersion).toBe('tokenlens.ml-features.v1');
    expect(estimate.modelVersion).toBe('tokenlens-cost-model-v1-pending-artifact');
  });

  it('rejects a feature mismatch before estimating', () => {
    const invalid = payload();
    invalid.features.permission_mode = 'default';
    expect(() =>
      predictEstimate({ payload: invalid, manifest, prompt: 'hello' }),
    ).toThrow(/unknown fields: permission_mode/u);
  });

  it('does not silently use legacy pricing for a different inference runtime', () => {
    const incompatible = structuredClone(manifest);
    incompatible.inference.runtime = 'saved-python-pipeline';
    expect(() =>
      predictEstimate({ payload: payload(), manifest: incompatible, prompt: 'hello' }),
    ).toThrow(/Unsupported TokenLens inference runtime/u);
  });
});
