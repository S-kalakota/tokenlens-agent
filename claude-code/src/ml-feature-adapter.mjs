import { validateFeaturePayload } from './features/validation.mjs';

/**
 * Builds exactly one ordered model row from the named feature payload.
 * JSON property insertion order is deliberately ignored.
 */
export function toModelRow(payload, manifest) {
  validateFeaturePayload(payload, manifest);
  return manifest.feature_order.map((name) => payload.features[name]);
}

/**
 * Transport-neutral envelope for a model runtime such as Python or ONNX.
 * Collection metadata cannot leak into `row` because columns come exclusively
 * from the manifest's feature order.
 */
export function toModelRecord(payload, manifest) {
  const row = toModelRow(payload, manifest);
  return {
    schemaVersion: payload.schema_version,
    modelVersion: manifest.model_version,
    columns: [...manifest.feature_order],
    row,
  };
}

/** A batch-shaped form convenient for runtimes that require a rows matrix. */
export function toModelInput(payload, manifest) {
  const record = toModelRecord(payload, manifest);
  return {
    feature_schema_version: record.schemaVersion,
    model_version: record.modelVersion,
    columns: record.columns,
    rows: [record.row],
  };
}
