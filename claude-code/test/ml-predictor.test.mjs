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

/** The manifest ships the HTTP runtime; older behaviour is still supported. */
function legacyManifest() {
  const legacy = structuredClone(manifest);
  legacy.compatibility_status = 'provisional-v1-awaiting-training-artifacts';
  legacy.inference = {
    runtime: 'legacy-pricing-fallback',
    preprocessing_artifact: null,
    preprocessing_sha256: null,
    model_artifact: null,
    model_sha256: null,
  };
  return legacy;
}

const predicts = (prediction) => async () => ({ ok: true, prediction });
const refuses = (kind, message) => async () => ({ ok: false, kind, message });

describe('prediction boundary', () => {
  it('validates/orders all features before the local pricing fallback', async () => {
    const estimate = await predictEstimate({
      payload: payload(7),
      manifest: legacyManifest(),
      prompt: 'x'.repeat(400),
      contextTokens: 0,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 0,
    });

    expect(estimate.promptTokens).toBe(7);
    expect(estimate.breakdown.newInputUsd).toBeCloseTo((7 * 3.75) / 1_000_000, 12);
    expect(estimate.featureSchemaVersion).toBe('tokenlens.ml-features.v1');
    expect(estimate.predictionSource).toBe('assumption');
  });

  it('rejects a feature mismatch before estimating', async () => {
    const invalid = payload();
    invalid.features.permission_mode = 'default';
    await expect(
      predictEstimate({ payload: invalid, manifest, prompt: 'hello' }),
    ).rejects.toThrow(/unknown fields: permission_mode/u);
  });

  it('does not silently use legacy pricing for a different inference runtime', async () => {
    const incompatible = structuredClone(manifest);
    incompatible.inference.runtime = 'saved-python-pipeline';
    await expect(
      predictEstimate({ payload: payload(), manifest: incompatible, prompt: 'hello' }),
    ).rejects.toThrow(/Unsupported TokenLens inference runtime/u);
  });

  it('prices the predicted reply length when the service answers', async () => {
    const estimate = await predictEstimate({
      payload: payload(7),
      manifest,
      prompt: 'hello',
      contextTokens: 0,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 1200,
      requestPredictionImplementation: predicts({
        outputTokens: 400,
        intervalLow: 220,
        intervalHigh: 860,
        confidence: 'medium',
        notes: [],
      }),
    });

    expect(estimate.predictionSource).toBe('model');
    expect(estimate.expectedOutputTokens).toBe(400);
    expect(estimate.predictedOutputTokens).toBe(400);
    // Priced off the prediction, not the 1,200-token assumption.
    expect(estimate.breakdown.outputUsd).toBeCloseTo((400 * 15) / 1_000_000, 12);
  });

  it('refuses to predict a reply length for an untrained model', async () => {
    const estimate = await predictEstimate({
      payload: payload(7),
      manifest,
      prompt: 'hello',
      contextTokens: 0,
      model: 'claude-opus-5',
      expectedOutputTokens: 1200,
      requestPredictionImplementation: refuses(
        'unsupported_model',
        "TokenLens does not support 'claude-opus-5'.",
      ),
    });

    expect(estimate.modelSupported).toBe(false);
    expect(estimate.predictedOutputTokens).toBeUndefined();
    expect(estimate.predictionSource).toBe('assumption');
    expect(estimate.estimatorMessage).toContain('claude-opus-5');
  });

  it('falls back to the flat assumption when the service is offline', async () => {
    const estimate = await predictEstimate({
      payload: payload(7),
      manifest,
      prompt: 'hello',
      contextTokens: 0,
      model: 'claude-sonnet-5',
      expectedOutputTokens: 1200,
      requestPredictionImplementation: refuses('unavailable', 'not running'),
    });

    expect(estimate.estimatorUnavailable).toBe(true);
    expect(estimate.modelSupported).toBe(true);
    expect(estimate.expectedOutputTokens).toBe(1200);
  });
});
