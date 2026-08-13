import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toModelInput, toModelRecord, toModelRow } from '../src/ml-feature-adapter.mjs';

const MANIFEST_PATH = fileURLToPath(
  new URL('../model/feature-manifest.json', import.meta.url),
);

let manifest;

beforeAll(async () => {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
});

function validPayload() {
  const namedInReverseOrder = Object.fromEntries(
    [...manifest.feature_order]
      .reverse()
      .map((name, reverseIndex) => [name, manifest.feature_order.length - reverseIndex]),
  );

  return {
    schema_version: manifest.feature_schema_version,
    features: {
      ...namedInReverseOrder,
      output_format: 'json',
      task_type: 'feature',
      repo_id: 'unknown',
      model_id: 'claude-opus-5',
      detail_level: 'detailed',
    },
    collection: {
      complete: true,
      tokenizer: `${manifest.tokenizer.name}@${manifest.tokenizer.version}`,
      collector_version: manifest.collector_version,
      duration_ms: 1,
      warnings: ['fixture'],
      parsers: { ...manifest.parsers },
      attachment_semantics: manifest.attachment_semantics,
    },
  };
}

describe('ML feature adapter', () => {
  it('orders a row from the manifest, never JSON insertion order', () => {
    const payload = validPayload();
    expect(Object.keys(payload.features)).not.toEqual(manifest.feature_order);
    expect(toModelRow(payload, manifest)).toEqual(
      manifest.feature_order.map((name) => payload.features[name]),
    );
  });

  it('returns columns and one batch row with schema/model versions', () => {
    const payload = validPayload();
    const row = manifest.feature_order.map((name) => payload.features[name]);

    expect(toModelRecord(payload, manifest)).toEqual({
      schemaVersion: manifest.feature_schema_version,
      modelVersion: manifest.model_version,
      columns: manifest.feature_order,
      row,
    });
    expect(toModelInput(payload, manifest)).toEqual({
      feature_schema_version: manifest.feature_schema_version,
      model_version: manifest.model_version,
      columns: manifest.feature_order,
      rows: [row],
    });
  });

  it('does not expose collection metadata as a model column', () => {
    const adapted = toModelInput(validPayload(), manifest);
    expect(adapted.columns).not.toContain('collection');
    expect(adapted.columns).not.toContain('duration_ms');
    expect(adapted.rows[0]).toHaveLength(14);
  });

  it('validates before adapting', () => {
    const invalid = validPayload();
    invalid.features.codebase_files = -10;
    expect(() => toModelRow(invalid, manifest)).toThrow(
      /payload\.features\.codebase_files/,
    );
  });
});
