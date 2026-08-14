const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

export const FEATURE_SCHEMA_VERSION = 'tokenlens.ml-features.v1';

export const FEATURE_ORDER = Object.freeze([
  'output_format',
  'task_type',
  'repo_id',
  'model_id',
  'detail_level',
  'input_tokens',
  'attached_code_tokens',
  'relevant_code_tokens',
  'task_word_count',
  'n_requirements',
  'question_count',
  'codebase_lines',
  'codebase_files',
  'n_files_attached',
]);

export const CATEGORICAL_FEATURES = Object.freeze([
  'output_format',
  'task_type',
  'repo_id',
  'model_id',
  'detail_level',
]);

export const NUMERIC_FEATURES = Object.freeze([
  'input_tokens',
  'attached_code_tokens',
  'relevant_code_tokens',
  'task_word_count',
  'n_requirements',
  'question_count',
  'codebase_lines',
  'codebase_files',
  'n_files_attached',
]);

const COLLECTION_KEYS = Object.freeze([
  'complete',
  'tokenizer',
  'collector_version',
  'duration_ms',
  'warnings',
  'parsers',
  'attachment_semantics',
]);

const PARSER_KEYS = Object.freeze([
  'categorical',
  'requirements',
  'questions',
  'mentions',
  'references',
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** A contract violation between collection and the saved model manifest. */
export class FeatureValidationError extends TypeError {
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues : [String(issues)];
    super(`Invalid TokenLens ML feature contract:\n- ${normalized.join('\n- ')}`);
    this.name = 'FeatureValidationError';
    this.issues = normalized;
  }
}

/**
 * Validates the parts of the feature manifest that define the model boundary.
 * The remaining manifest sections configure collectors and are validated by
 * those collectors when used.
 */
export function validateFeatureManifest(manifest) {
  const issues = collectManifestIssues(manifest);
  if (issues.length > 0) throw new FeatureValidationError(issues);
  return manifest;
}

/** Alias kept terse for callers loading the manifest during hook startup. */
export const validateManifest = validateFeatureManifest;

/**
 * Strictly validates a canonical payload against the supplied model manifest.
 * It rejects unknown fields instead of silently allowing them into inference.
 */
export function validateFeaturePayload(payload, manifest) {
  validateFeatureManifest(manifest);
  const issues = collectPayloadIssues(payload, manifest);
  if (issues.length > 0) throw new FeatureValidationError(issues);
  return payload;
}

/** Semantic alias for call sites that prefer assertion-style naming. */
export const assertValidFeaturePayload = validateFeaturePayload;

function collectManifestIssues(manifest) {
  const issues = [];
  if (!isObject(manifest)) return ['manifest must be an object'];

  if (manifest.feature_schema_version !== FEATURE_SCHEMA_VERSION) {
    issues.push(
      `manifest.feature_schema_version must equal ${JSON.stringify(FEATURE_SCHEMA_VERSION)}`,
    );
  }
  requireNonEmptyString(manifest.model_version, 'manifest.model_version', issues);
  if (!SEMVER_PATTERN.test(String(manifest.collector_version ?? ''))) {
    issues.push('manifest.collector_version must be a semantic version');
  }

  compareOrderedKeys(manifest.feature_order, FEATURE_ORDER, 'manifest.feature_order', issues);
  validateCategoryManifest(manifest, issues);
  validateNumericManifest(manifest, issues);
  validateDefaults(manifest, issues);
  validateTokenizerManifest(manifest.tokenizer, issues);
  validateParserManifest(manifest.parsers, issues);
  validateClassifierManifest(manifest, issues);
  validateModelResolution(manifest, issues);
  validateRepositoryManifest(manifest.repository, issues);
  validateReferenceTokenization(manifest.reference_tokenization, issues);
  validateInferenceManifest(manifest, issues);
  requireNonEmptyString(manifest.attachment_semantics, 'manifest.attachment_semantics', issues);

  return issues;
}

function validateCategoryManifest(manifest, issues) {
  const categories = manifest.categorical_features;
  if (!isObject(categories)) {
    issues.push('manifest.categorical_features must be an object');
    return;
  }

  compareKeySet(categories, CATEGORICAL_FEATURES, 'manifest.categorical_features', issues);
  for (const name of CATEGORICAL_FEATURES) {
    const values = categories[name];
    if (!Array.isArray(values) || values.length === 0) {
      issues.push(`manifest.categorical_features.${name} must be a non-empty array`);
      continue;
    }

    const unique = new Set();
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) {
        issues.push(`manifest.categorical_features.${name} must contain non-empty strings`);
        continue;
      }
      if (unique.has(value)) {
        issues.push(`manifest.categorical_features.${name} contains duplicate value ${JSON.stringify(value)}`);
      }
      unique.add(value);
    }
  }
}

function validateNumericManifest(manifest, issues) {
  const numerics = manifest.numeric_features;
  if (!isObject(numerics)) {
    issues.push('manifest.numeric_features must be an object');
    return;
  }

  compareKeySet(numerics, NUMERIC_FEATURES, 'manifest.numeric_features', issues);
  for (const name of NUMERIC_FEATURES) {
    const definition = numerics[name];
    if (!isObject(definition)) {
      issues.push(`manifest.numeric_features.${name} must be an object`);
      continue;
    }
    if (definition.type !== 'integer') {
      issues.push(`manifest.numeric_features.${name}.type must be "integer"`);
    }
    if (!Number.isInteger(definition.minimum) || definition.minimum < 0) {
      issues.push(`manifest.numeric_features.${name}.minimum must be a non-negative integer`);
    }
    if (
      definition.maximum !== undefined &&
      (!Number.isSafeInteger(definition.maximum) || definition.maximum < definition.minimum)
    ) {
      issues.push(`manifest.numeric_features.${name}.maximum must be a safe integer at least minimum`);
    }
  }
}

function validateDefaults(manifest, issues) {
  const defaults = manifest.defaults;
  if (!isObject(defaults)) {
    issues.push('manifest.defaults must be an object');
    return;
  }

  compareKeySet(defaults, FEATURE_ORDER, 'manifest.defaults', issues);
  if (isObject(manifest.categorical_features)) {
    for (const name of CATEGORICAL_FEATURES) {
      if (!manifest.categorical_features[name]?.includes(defaults[name])) {
        issues.push(`manifest.defaults.${name} must be in its categorical vocabulary`);
      }
    }
  }
  if (isObject(manifest.numeric_features)) {
    for (const name of NUMERIC_FEATURES) {
      validateNumericValue(
        defaults[name],
        manifest.numeric_features[name],
        `manifest.defaults.${name}`,
        issues,
      );
    }
  }
}

function validateTokenizerManifest(tokenizer, issues) {
  if (!isObject(tokenizer)) {
    issues.push('manifest.tokenizer must be an object');
    return;
  }
  requireNonEmptyString(tokenizer.name, 'manifest.tokenizer.name', issues);
  requireNonEmptyString(tokenizer.version, 'manifest.tokenizer.version', issues);
  if (!Number.isInteger(tokenizer.characters_per_token) || tokenizer.characters_per_token <= 0) {
    issues.push('manifest.tokenizer.characters_per_token must be a positive integer');
  }
  if (tokenizer.normalization !== 'newline-only') {
    issues.push('manifest.tokenizer.normalization must equal "newline-only"');
  }
}

function validateParserManifest(parsers, issues) {
  if (!isObject(parsers)) {
    issues.push('manifest.parsers must be an object');
    return;
  }
  compareKeySet(parsers, PARSER_KEYS, 'manifest.parsers', issues);
  for (const name of PARSER_KEYS) {
    requireNonEmptyString(parsers[name], `manifest.parsers.${name}`, issues);
  }
}

function validateClassifierManifest(manifest, issues) {
  validateVocabularyOrder(
    manifest.output_format_precedence,
    manifest.categorical_features?.output_format,
    'manifest.output_format_precedence',
    issues,
  );
  validateVocabularyOrder(
    manifest.task_type_tie_break,
    manifest.categorical_features?.task_type,
    'manifest.task_type_tie_break',
    issues,
  );
}

function validateVocabularyOrder(value, vocabulary, label, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${label} must be a non-empty array`);
    return;
  }
  const allowed = new Set(Array.isArray(vocabulary) ? vocabulary : []);
  const seen = new Set();
  for (const category of value) {
    if (!allowed.has(category)) issues.push(`${label} contains unsupported category ${JSON.stringify(category)}`);
    if (seen.has(category)) issues.push(`${label} contains duplicate category ${JSON.stringify(category)}`);
    seen.add(category);
  }
}

function validateModelResolution(manifest, issues) {
  const resolution = manifest.model_id_resolution;
  if (!isObject(resolution)) {
    issues.push('manifest.model_id_resolution must be an object');
    return;
  }
  const allowed = new Set(manifest.categorical_features?.model_id ?? []);
  if (!allowed.has(resolution.fallback)) {
    issues.push('manifest.model_id_resolution.fallback must be in the model_id vocabulary');
  }
  if (!isObject(resolution.aliases)) {
    issues.push('manifest.model_id_resolution.aliases must be an object');
  } else {
    for (const [alias, category] of Object.entries(resolution.aliases)) {
      if (alias === '') issues.push('manifest.model_id_resolution.aliases keys must be non-empty');
      if (!allowed.has(category)) {
        issues.push(`manifest.model_id_resolution.aliases.${alias} must be in the model_id vocabulary`);
      }
    }
  }
  requireNonEmptyString(
    resolution.dated_suffix_pattern,
    'manifest.model_id_resolution.dated_suffix_pattern',
    issues,
  );
  try {
    new RegExp(resolution.dated_suffix_pattern, 'u');
  } catch {
    issues.push('manifest.model_id_resolution.dated_suffix_pattern must be a valid regular expression');
  }
}

function validateRepositoryManifest(repository, issues) {
  if (!isObject(repository)) {
    issues.push('manifest.repository must be an object');
    return;
  }
  if (typeof repository.include_untracked !== 'boolean') {
    issues.push('manifest.repository.include_untracked must be a boolean');
  }
  for (const name of [
    'extensions',
    'extensionless_names',
    'excluded_names',
    'excluded_directories',
  ]) {
    validateUniqueStrings(repository[name], `manifest.repository.${name}`, issues);
  }
  for (const name of [
    'max_file_bytes',
    'max_files',
    'max_total_bytes',
    'max_mentioned_files',
    'max_relevant_files',
    'max_relevant_bytes',
  ]) {
    if (!Number.isSafeInteger(repository[name]) || repository[name] <= 0) {
      issues.push(`manifest.repository.${name} must be a positive safe integer`);
    }
  }
  requireNonEmptyString(repository.line_count, 'manifest.repository.line_count', issues);
  requireNonEmptyString(
    repository.inclusion_rule_version,
    'manifest.repository.inclusion_rule_version',
    issues,
  );
}

function validateReferenceTokenization(value, issues) {
  if (!isObject(value)) {
    issues.push('manifest.reference_tokenization must be an object');
    return;
  }
  if (!['sum-segments', 'concatenate'].includes(value.strategy)) {
    issues.push('manifest.reference_tokenization.strategy must be "sum-segments" or "concatenate"');
  }
  if (typeof value.separator !== 'string') {
    issues.push('manifest.reference_tokenization.separator must be a string');
  }
}

function validateInferenceManifest(manifest, issues) {
  if (manifest.payload_schema !== 'contracts/ml-feature-payload.v1.schema.json') {
    issues.push(
      'manifest.payload_schema must equal "contracts/ml-feature-payload.v1.schema.json"',
    );
  }
  requireNonEmptyString(manifest.compatibility_status, 'manifest.compatibility_status', issues);
  const inference = manifest.inference;
  if (!isObject(inference)) {
    issues.push('manifest.inference must be an object');
    return;
  }
  requireNonEmptyString(inference.runtime, 'manifest.inference.runtime', issues);

  const artifactFields = [
    ['preprocessing_artifact', 'preprocessing_sha256'],
    ['model_artifact', 'model_sha256'],
  ];
  if (manifest.compatibility_status === 'training-locked') {
    if (inference.runtime === 'legacy-pricing-fallback') {
      issues.push('manifest.inference.runtime cannot use legacy pricing when training-locked');
    }
    for (const [artifact, checksum] of artifactFields) {
      requireNonEmptyString(inference[artifact], `manifest.inference.${artifact}`, issues);
      if (typeof inference[checksum] !== 'string' || !/^[a-f0-9]{64}$/u.test(inference[checksum])) {
        issues.push(`manifest.inference.${checksum} must be a lowercase SHA-256 checksum`);
      }
    }
  } else if (manifest.compatibility_status === 'provisional-v1-awaiting-training-artifacts') {
    for (const [artifact, checksum] of artifactFields) {
      if (inference[artifact] !== null || inference[checksum] !== null) {
        issues.push(`manifest.inference.${artifact} and ${checksum} must remain null while provisional`);
      }
    }
  } else if (manifest.compatibility_status === 'v1-http-inference') {
    // The trained pipeline is a Python artifact owned by the estimator service,
    // so this repository holds no local file to checksum. What must be pinned
    // instead is where the service lives and which models it can answer for --
    // an unlisted model has to be refused, never estimated.
    if (inference.runtime !== 'tokenlens-http-v1') {
      issues.push('manifest.inference.runtime must be tokenlens-http-v1 for HTTP inference');
    }
    requireNonEmptyString(inference.endpoint, 'manifest.inference.endpoint', issues);
    if (!Number.isInteger(inference.timeout_ms) || inference.timeout_ms <= 0) {
      issues.push('manifest.inference.timeout_ms must be a positive integer');
    }
    validateUniqueStrings(
      inference.trained_on_models,
      'manifest.inference.trained_on_models',
      issues,
    );
    if (Array.isArray(inference.trained_on_models) && inference.trained_on_models.length === 0) {
      issues.push('manifest.inference.trained_on_models must name at least one model');
    }
  } else {
    issues.push('manifest.compatibility_status must be a recognized compatibility state');
  }
}

function validateUniqueStrings(value, label, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      issues.push(`${label} must contain non-empty strings`);
      continue;
    }
    if (seen.has(item)) issues.push(`${label} contains duplicate value ${JSON.stringify(item)}`);
    seen.add(item);
  }
}

function collectPayloadIssues(payload, manifest) {
  const issues = [];
  if (!isObject(payload)) return ['payload must be an object'];

  compareKeySet(payload, ['schema_version', 'features', 'collection'], 'payload', issues);
  if (payload.schema_version !== manifest.feature_schema_version) {
    issues.push(
      `payload.schema_version must equal ${JSON.stringify(manifest.feature_schema_version)}`,
    );
  }

  validateFeatures(payload.features, manifest, issues);
  validateCollection(payload.collection, manifest, issues);
  return issues;
}

function validateFeatures(features, manifest, issues) {
  if (!isObject(features)) {
    issues.push('payload.features must be an object');
    return;
  }

  compareKeySet(features, manifest.feature_order, 'payload.features', issues);
  for (const name of CATEGORICAL_FEATURES) {
    if (!manifest.categorical_features[name].includes(features[name])) {
      issues.push(
        `payload.features.${name} must be one of ${manifest.categorical_features[name]
          .map((value) => JSON.stringify(value))
          .join(', ')}`,
      );
    }
  }
  for (const name of NUMERIC_FEATURES) {
    validateNumericValue(
      features[name],
      manifest.numeric_features[name],
      `payload.features.${name}`,
      issues,
    );
  }
}

function validateCollection(collection, manifest, issues) {
  if (!isObject(collection)) {
    issues.push('payload.collection must be an object');
    return;
  }

  compareKeySet(collection, COLLECTION_KEYS, 'payload.collection', issues);
  if (typeof collection.complete !== 'boolean') {
    issues.push('payload.collection.complete must be a boolean');
  }

  const expectedTokenizer = `${manifest.tokenizer.name}@${manifest.tokenizer.version}`;
  if (collection.tokenizer !== expectedTokenizer) {
    issues.push(`payload.collection.tokenizer must equal ${JSON.stringify(expectedTokenizer)}`);
  }
  if (collection.collector_version !== manifest.collector_version) {
    issues.push(
      `payload.collection.collector_version must equal ${JSON.stringify(manifest.collector_version)}`,
    );
  }
  validateCount(collection.duration_ms, 'payload.collection.duration_ms', issues);

  if (!Array.isArray(collection.warnings)) {
    issues.push('payload.collection.warnings must be an array');
  } else {
    const unique = new Set();
    for (const warning of collection.warnings) {
      if (typeof warning !== 'string' || warning.length === 0) {
        issues.push('payload.collection.warnings must contain non-empty strings');
        continue;
      }
      if (unique.has(warning)) {
        issues.push(`payload.collection.warnings contains duplicate value ${JSON.stringify(warning)}`);
      }
      unique.add(warning);
    }
  }

  if (!isObject(collection.parsers)) {
    issues.push('payload.collection.parsers must be an object');
  } else {
    compareKeySet(collection.parsers, PARSER_KEYS, 'payload.collection.parsers', issues);
    for (const name of PARSER_KEYS) {
      if (collection.parsers[name] !== manifest.parsers[name]) {
        issues.push(
          `payload.collection.parsers.${name} must equal ${JSON.stringify(manifest.parsers[name])}`,
        );
      }
    }
  }

  if (collection.attachment_semantics !== manifest.attachment_semantics) {
    issues.push(
      `payload.collection.attachment_semantics must equal ${JSON.stringify(manifest.attachment_semantics)}`,
    );
  }
}

function validateNumericValue(value, definition, label, issues) {
  if (!isObject(definition)) return;
  if (!Number.isSafeInteger(value)) {
    issues.push(`${label} must be a finite safe integer`);
    return;
  }
  if (value < definition.minimum) {
    issues.push(`${label} must be at least ${definition.minimum}`);
  }
  if (definition.maximum !== undefined && value > definition.maximum) {
    issues.push(`${label} must be at most ${definition.maximum}`);
  }
}

function validateCount(value, label, issues) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_COUNT) {
    issues.push(`${label} must be a finite non-negative safe integer`);
  }
}

function compareOrderedKeys(actual, expected, label, issues) {
  if (!Array.isArray(actual)) {
    issues.push(`${label} must be an array`);
    return;
  }
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    issues.push(`${label} must contain the fixed 14 features in model order`);
  }
}

function compareKeySet(object, expected, label, issues) {
  const actual = Object.keys(object);
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.hasOwn(object, key));
  const extra = actual.filter((key) => !expectedSet.has(key));
  if (missing.length > 0) issues.push(`${label} is missing: ${missing.join(', ')}`);
  if (extra.length > 0) issues.push(`${label} has unknown fields: ${extra.join(', ')}`);
}

function requireNonEmptyString(value, label, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} must be a non-empty string`);
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
