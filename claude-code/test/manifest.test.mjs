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
