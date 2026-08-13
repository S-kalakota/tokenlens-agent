import { estimateTurn } from './estimator.mjs';
import { toModelRecord } from './ml-feature-adapter.mjs';

/**
 * Validates and orders one feature payload at the prediction boundary.
 *
 * The trained preprocessing/model artifact is intentionally not embedded in
 * this repository yet. Until one is supplied, TokenLens retains its existing
 * deterministic pricing estimator, but it consumes `input_tokens` through the
 * same ordered model row. Replacing this function with a local service, ONNX
 * runtime, or saved-pipeline client does not change feature collection.
 */
export function predictEstimate({
  payload,
  manifest,
  prompt,
  contextTokens,
  model,
  expectedOutputTokens,
  pricing,
}) {
  if (manifest?.inference?.runtime !== 'legacy-pricing-fallback') {
    throw new Error(`Unsupported TokenLens inference runtime: ${manifest?.inference?.runtime ?? 'missing'}`);
  }
  if (manifest.compatibility_status === 'training-locked') {
    throw new Error('The trained-model runtime is not installed');
  }
  const modelInput = toModelRecord(payload, manifest);
  const inputTokensIndex = modelInput.columns.indexOf('input_tokens');

  const estimate = estimateTurn({
    prompt,
    featureInputTokens: modelInput.row[inputTokensIndex],
    contextTokens,
    model,
    expectedOutputTokens,
    pricing,
  });

  return {
    ...estimate,
    featureSchemaVersion: modelInput.schemaVersion,
    modelVersion: modelInput.modelVersion,
  };
}
