import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.dirname(root);
const readJson = async (base, relative) =>
  JSON.parse(await readFile(path.join(base, relative), 'utf8'));

describe('Cursor plugin metadata', () => {
  it('declares a valid native Cursor plugin', async () => {
    const manifest = await readJson(root, '.cursor-plugin/plugin.json');
    assert.equal(manifest.name, 'tokenlens-cursor-cli');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof manifest.description, 'string');
    assert.equal(manifest.hooks, './hooks/hooks.json');
  });

  it('is listed by the repository marketplace', async () => {
    const marketplace = await readJson(repositoryRoot, '.cursor-plugin/marketplace.json');
    const plugin = marketplace.plugins.find((entry) => entry.name === 'tokenlens-cursor-cli');
    assert.equal(plugin.source, './cursor-cli');
  });
});

describe('native hook wiring', () => {
  it('registers exactly one fail-open beforeSubmitPrompt hook', async () => {
    const { version, hooks } = await readJson(root, 'hooks/hooks.json');
    assert.equal(version, 1);
    assert.deepEqual(Object.keys(hooks), ['beforeSubmitPrompt']);
    assert.equal(hooks.beforeSubmitPrompt.length, 1);
    assert.equal(hooks.beforeSubmitPrompt[0].failClosed, false);
    assert.match(hooks.beforeSubmitPrompt[0].command, /scripts\/gate\.mjs/);
  });

  it('ships each referenced script', async () => {
    await access(path.join(root, 'scripts/gate.mjs'));
    await access(path.join(root, 'scripts/control.mjs'));
  });

  it('provides the same hook directly for this checkout', async () => {
    const { hooks } = await readJson(repositoryRoot, '.cursor/hooks.json');
    const projectHook = hooks.beforeSubmitPrompt[0];
    assert.equal(projectHook.failClosed, false);
    assert.equal(projectHook.command, 'node "cursor-cli/scripts/gate.mjs"');
  });
});
