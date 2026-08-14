import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_SCHEMA_PATH = path.join(PLUGIN_ROOT, 'contracts', 'ml-feature-payload.v1.schema.json');

/** A violation of the checked-in JSON Schema contract. */
export class FeatureSchemaError extends TypeError {
  constructor(issues) {
    super(`Invalid TokenLens ML feature schema payload:\n- ${issues.join('\n- ')}`);
    this.name = 'FeatureSchemaError';
    this.issues = issues;
  }
}

export async function loadFeatureSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  const target = path.isAbsolute(schemaPath)
    ? schemaPath
    : path.resolve(PLUGIN_ROOT, schemaPath);
  return JSON.parse(await readFile(target, 'utf8'));
}

/**
 * Validates the subset of JSON Schema 2020-12 used by the checked-in contract.
 * Keeping this small validator local avoids a runtime npm dependency in a
 * Claude Code plugin while still making the schema itself executable.
 */
export function validatePayloadSchema(payload, schema) {
  if (!object(schema)) throw new FeatureSchemaError(['schema must be an object']);
  const issues = [];
  validateNode(payload, schema, schema, '$', issues);
  if (issues.length > 0) throw new FeatureSchemaError(issues);
  return payload;
}

function validateNode(value, definition, root, location, issues) {
  if (!object(definition)) {
    issues.push(`${location} has an invalid schema definition`);
    return;
  }

  if (typeof definition.$ref === 'string') {
    const referenced = resolveLocalReference(root, definition.$ref);
    if (referenced === undefined) {
      issues.push(`${location} uses unresolved schema reference ${definition.$ref}`);
      return;
    }
    validateNode(value, referenced, root, location, issues);
    return;
  }

  if (Object.hasOwn(definition, 'const') && !sameJsonValue(value, definition.const)) {
    issues.push(`${location} must equal ${JSON.stringify(definition.const)}`);
    return;
  }
  if (
    Array.isArray(definition.enum) &&
    !definition.enum.some((candidate) => sameJsonValue(value, candidate))
  ) {
    issues.push(`${location} must be one of ${definition.enum.map(JSON.stringify).join(', ')}`);
    return;
  }

  if (!matchesType(value, definition.type)) {
    issues.push(`${location} must be ${article(definition.type)} ${definition.type}`);
    return;
  }

  if (definition.type === 'object') validateObject(value, definition, root, location, issues);
  else if (definition.type === 'array') validateArray(value, definition, root, location, issues);
  else if (definition.type === 'string') validateString(value, definition, location, issues);
  else if (definition.type === 'integer') validateInteger(value, definition, location, issues);
}

function validateObject(value, definition, root, location, issues) {
  const properties = object(definition.properties) ? definition.properties : {};
  const required = Array.isArray(definition.required) ? definition.required : [];
  for (const name of required) {
    if (!Object.hasOwn(value, name)) issues.push(`${location} is missing required property ${name}`);
  }

  if (definition.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) issues.push(`${location} has unknown property ${name}`);
    }
  }

  for (const [name, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, name)) {
      validateNode(value[name], propertySchema, root, `${location}.${name}`, issues);
    }
  }
}

function validateArray(value, definition, root, location, issues) {
  if (definition.uniqueItems === true) {
    const serialized = value.map((item) => JSON.stringify(item));
    if (new Set(serialized).size !== serialized.length) {
      issues.push(`${location} must contain unique items`);
    }
  }
  if (object(definition.items)) {
    value.forEach((item, index) =>
      validateNode(item, definition.items, root, `${location}[${index}]`, issues),
    );
  }
}

function validateString(value, definition, location, issues) {
  if (Number.isInteger(definition.minLength) && value.length < definition.minLength) {
    issues.push(`${location} must have at least ${definition.minLength} characters`);
  }
  if (typeof definition.pattern === 'string') {
    let pattern;
    try {
      pattern = new RegExp(definition.pattern, 'u');
    } catch {
      issues.push(`${location} uses an invalid schema pattern`);
      return;
    }
    if (!pattern.test(value)) issues.push(`${location} must match ${definition.pattern}`);
  }
}

function validateInteger(value, definition, location, issues) {
  if (Number.isFinite(definition.minimum) && value < definition.minimum) {
    issues.push(`${location} must be at least ${definition.minimum}`);
  }
  if (Number.isFinite(definition.maximum) && value > definition.maximum) {
    issues.push(`${location} must be at most ${definition.maximum}`);
  }
}

function matchesType(value, type) {
  if (type === undefined) return true;
  if (type === 'object') return object(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return false;
}

function resolveLocalReference(root, reference) {
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => (object(value) ? value[part] : undefined), root);
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function article(type) {
  return /^[aeiou]/u.test(String(type)) ? 'an' : 'a';
}
