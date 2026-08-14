import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfiguredModel } from '../src/claude-settings.mjs';

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('readConfiguredModel', () => {
  it('reads the user default for a first-turn model', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'tokenlens-claude-home-'));
    await writeJson(path.join(home, '.claude', 'settings.json'), { model: 'haiku' });

    expect(await readConfiguredModel({
      homeDirectory: home,
      env: {},
      platform: 'test',
      managedSettingsPath: path.join(home, 'missing-managed.json'),
    })).toBe('haiku');
  });

  it('applies project-local, environment, and managed precedence', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'tokenlens-claude-home-'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-claude-workspace-'));
    const managed = path.join(home, 'managed.json');
    await writeJson(path.join(home, '.claude', 'settings.json'), { model: 'haiku' });
    await writeJson(path.join(workspace, '.claude', 'settings.json'), { model: 'sonnet' });
    await writeJson(path.join(workspace, '.claude', 'settings.local.json'), { model: 'opus' });

    expect(await readConfiguredModel({
      cwd: workspace,
      homeDirectory: home,
      env: {},
      platform: 'test',
      managedSettingsPath: path.join(home, 'missing-managed.json'),
    })).toBe('opus');

    expect(await readConfiguredModel({
      cwd: workspace,
      homeDirectory: home,
      env: { ANTHROPIC_MODEL: 'claude-sonnet-5' },
      platform: 'test',
      managedSettingsPath: path.join(home, 'missing-managed.json'),
    })).toBe('claude-sonnet-5');

    await writeJson(managed, { model: 'claude-opus-5' });
    expect(await readConfiguredModel({
      cwd: workspace,
      homeDirectory: home,
      env: { ANTHROPIC_MODEL: 'claude-sonnet-5' },
      platform: 'test',
      managedSettingsPath: managed,
    })).toBe('claude-opus-5');
  });

  it('returns null for missing or malformed settings', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'tokenlens-claude-home-'));
    await writeJson(path.join(home, '.claude', 'settings.json'), { model: 42 });
    expect(await readConfiguredModel({
      homeDirectory: home,
      env: {},
      platform: 'test',
      managedSettingsPath: path.join(home, 'missing-managed.json'),
    })).toBeNull();
  });
});
