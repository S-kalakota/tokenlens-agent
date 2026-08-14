import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(root, relative), 'utf8'));

describe('plugin manifest', () => {
  it('declares the fields Claude Code requires', async () => {
    const manifest = await readJson('.claude-plugin/plugin.json');
    expect(manifest.name).toBe('tokenlens');
    expect(typeof manifest.description).toBe('string');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('ships disabled so installing it cannot silently gate someone', async () => {
    const manifest = await readJson('.claude-plugin/plugin.json');
    expect(manifest.defaultEnabled).toBe(false);
  });

  it('keeps plugin, package, and marketplace versions aligned', async () => {
    const plugin = await readJson('.claude-plugin/plugin.json');
    const packageManifest = await readJson('package.json');
    const marketplace = JSON.parse(
      await readFile(path.resolve(root, '../.claude-plugin/marketplace.json'), 'utf8'),
    );
    expect(plugin.version).toBe('0.2.0');
    expect(packageManifest.version).toBe(plugin.version);
    expect(marketplace.plugins[0].version).toBe(plugin.version);
  });
});

describe('ML feature contract assets', () => {
  it('ships a plugin-local schema identical to the repository contract', async () => {
    const local = await readFile(
      path.join(root, 'contracts/ml-feature-payload.v1.schema.json'),
      'utf8',
    );
    const canonical = await readFile(
      path.resolve(root, '../contracts/ml-feature-payload.v1.schema.json'),
      'utf8',
    );
    expect(local).toBe(canonical);
  });

  it('keeps schema feature names, categories and version aligned with the manifest', async () => {
    const manifest = await readJson('model/feature-manifest.json');
    const schema = await readJson('contracts/ml-feature-payload.v1.schema.json');
    const featureSchema = schema.properties.features;

    expect(schema.properties.schema_version.const).toBe(manifest.feature_schema_version);
    expect(featureSchema.required).toEqual(manifest.feature_order);
    expect(Object.keys(featureSchema.properties)).toEqual(manifest.feature_order);

    for (const [name, vocabulary] of Object.entries(manifest.categorical_features)) {
      expect(featureSchema.properties[name].enum).toEqual(vocabulary);
    }

    for (const name of Object.keys(manifest.numeric_features)) {
      expect(featureSchema.properties[name].$ref).toBe('#/$defs/count');
      expect(manifest.numeric_features[name].type).toBe(schema.$defs.count.type);
      expect(manifest.numeric_features[name].minimum).toBe(schema.$defs.count.minimum);
    }
    expect(schema.properties.collection.properties.attachment_semantics.const).toBe(
      manifest.attachment_semantics,
    );
  });

  it('points inference at the trained model service and names its limits', async () => {
    const manifest = await readJson('model/feature-manifest.json');
    expect(manifest.compatibility_status).toBe('v1-http-inference');
    expect(manifest.inference.runtime).toBe('tokenlens-http-v1');
    expect(manifest.inference.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
    expect(manifest.inference.timeout_ms).toBeGreaterThan(0);
    // The trained corpus covers these two models and no others. Anything else
    // must be refused rather than estimated.
    expect(manifest.inference.trained_on_models).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
    ]);
  });
});

describe('hooks.json', () => {
  it('registers exactly one UserPromptSubmit command hook', async () => {
    const { hooks } = await readJson('hooks/hooks.json');
    expect(Object.keys(hooks)).toEqual(['UserPromptSubmit']);

    const handlers = hooks.UserPromptSubmit.flatMap((group) => group.hooks);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].type).toBe('command');
    expect(handlers[0].timeout).toBeGreaterThan(0);
  });

  it('points at the gate through CLAUDE_PLUGIN_ROOT, quoted for spaces in paths', async () => {
    const { hooks } = await readJson('hooks/hooks.json');
    const { command } = hooks.UserPromptSubmit[0].hooks[0];
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(command).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"');
  });

  it('resolves to a script that actually exists', async () => {
    await expect(access(path.join(root, 'scripts/gate.mjs'))).resolves.toBeUndefined();
    await expect(access(path.join(root, 'scripts/control.mjs'))).resolves.toBeUndefined();
  });
});

describe('slash command', () => {
  it('is wired to the control script', async () => {
    const command = await readFile(path.join(root, 'commands/tokenlens.md'), 'utf8');
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs');
    expect(command).toContain('argument-hint');
  });
});
