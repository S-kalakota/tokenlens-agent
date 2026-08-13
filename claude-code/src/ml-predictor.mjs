import { estimateTurn } from './estimator.mjs';
import { toModelRecord } from './ml-feature-adapter.mjs';
import { requestPrediction } from './ml-service-client.mjs';

/**
 * Validates and orders one feature payload at the prediction boundary, then
 * turns it into a cost estimate.
 *
 * Two runtimes are supported:
 *
 *   legacy-pricing-fallback  the original behaviour. Reply length is the flat
 *                            `expectedOutputTokens` assumption from config.
 *   tokenlens-http-v1        the trained model, served locally. Reply length is
 *                            predicted per prompt from the same ordered row.
 *
 * The ordered model row is built identically either way, so feature collection
 * is unaffected by which runtime is configured.
 *
 * Degradation is deliberate and visible:
 *   - service down / malformed  -> fall back to the flat assumption, flagged
 *                                  `estimatorUnavailable`, because a broken
 *                                  estimator must never block a prompt.
 *   - model not in training set -> `modelSupported: false` and NO predicted
 *                                  length. The predictor knows Haiku 4.5 and
 *                                  Sonnet 5 only; inventing a number for Opus
 *                                  would be a confident guess wearing the
 *                                  clothes of a measurement.
 */
export async function predictEstimate({
  payload,
  manifest,
  prompt,
  contextTokens,
  model,
  expectedOutputTokens,
  pricing,
  requestPredictionImplementation = requestPrediction,
}) {
  const runtime = manifest?.inference?.runtime;
  if (runtime !== 'legacy-pricing-fallback' && runtime !== 'tokenlens-http-v1') {
    throw new Error(`Unsupported TokenLens inference runtime: ${runtime ?? 'missing'}`);
  }
  if (manifest.compatibility_status === 'training-locked') {
    throw new Error('The trained-model runtime is not installed');
  }

  const modelInput = toModelRecord(payload, manifest);
  const inputTokensIndex = modelInput.columns.indexOf('input_tokens');
  const featureInputTokens = modelInput.row[inputTokensIndex];

  const base = {
    featureSchemaVersion: modelInput.schemaVersion,
    modelVersion: modelInput.modelVersion,
    predictionSource: 'assumption',
    modelSupported: true,
  };

  if (runtime === 'legacy-pricing-fallback') {
    return {
      ...estimateTurn({ prompt, featureInputTokens, contextTokens, model, expectedOutputTokens, pricing }),
      ...base,
    };
  }

  const result = await requestPredictionImplementation({
    payload,
    endpoint: manifest.inference.endpoint,
    timeoutMs: manifest.inference.timeout_ms,
  });

  if (!result.ok) {
    const estimate = estimateTurn({
      prompt, featureInputTokens, contextTokens, model, expectedOutputTokens, pricing,
    });
    return result.kind === 'unsupported_model'
      ? { ...estimate, ...base, modelSupported: false, estimatorMessage: result.message }
      : { ...estimate, ...base, estimatorUnavailable: true, estimatorMessage: result.message };
  }

  const { prediction } = result;
  return {
    ...estimateTurn({
      prompt,
      featureInputTokens,
      contextTokens,
      model,
      expectedOutputTokens: prediction.outputTokens,
      pricing,
    }),
    ...base,
    predictionSource: 'model',
    predictedOutputTokens: prediction.outputTokens,
    predictedOutputLow: prediction.intervalLow,
    predictedOutputHigh: prediction.intervalHigh,
    predictionConfidence: prediction.confidence,
    predictionNotes: prediction.notes,
  };
}
