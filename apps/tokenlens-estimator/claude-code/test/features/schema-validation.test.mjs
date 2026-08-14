import { beforeAll, describe, expect, it } from 'vitest';
import {
  FeatureSchemaError,
  loadFeatureSchema,
  validatePayloadSchema,
} from '../../src/features/schema-validation.mjs';
import { loadFeatureManifest } from '../../src/features/build-features.mjs';

let manifest;
let schema;

beforeAll(async () => {
  [manifest, schema] = await Promise.all([loadFeatureManifest(), loadFeatureSchema()]);
});

function validPayload() {
  return {
    schema_version: manifest.feature_schema_version,
    features: { ...manifest.defaults },
    collection: {
      complete: true,
      tokenizer: `${manifest.tokenizer.name}@${manifest.tokenizer.version}`,
      collector_version: manifest.collector_version,
      duration_ms: 0,
      warnings: [],
      parsers: { ...manifest.parsers },
      attachment_semantics: manifest.attachment_semantics,
    },
  };
}

describe('executable ML payload JSON Schema', () => {
  it('accepts one canonical payload using the checked-in schema', () => {
    const payload = validPayload();
    expect(validatePayloadSchema(payload, schema)).toBe(payload);
  });

  it('rejects extra/missing properties and wrong categories', () => {
    const payload = validPayload();
    delete payload.features.input_tokens;
    payload.features.permission_mode = 'default';
    payload.features.output_format = 'yaml';

    expect(() => validatePayloadSchema(payload, schema)).toThrow(FeatureSchemaError);
    try {
      validatePayloadSchema(payload, schema);
    } catch (error) {
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining('missing required property input_tokens'),
          expect.stringContaining('unknown property permission_mode'),
          expect.stringContaining('output_format must be one of'),
        ]),
      );
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid numeric feature %s',
    (value) => {
      const payload = validPayload();
      payload.features.codebase_lines = value;
      expect(() => validatePayloadSchema(payload, schema)).toThrow(FeatureSchemaError);
    },
  );

  it('rejects duplicate warnings and invalid collection metadata', () => {
    const payload = validPayload();
    payload.collection.warnings = ['same', 'same'];
    payload.collection.collector_version = 'not-semver';
    expect(() => validatePayloadSchema(payload, schema)).toThrow(/unique items|must match/u);
  });
});
