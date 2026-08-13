import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

async function modelFromSettings(settingsPath) {
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    return typeof settings?.model === 'string' && settings.model.trim() !== ''
      ? settings.model.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort first-turn model lookup using Claude Code's documented settings
 * precedence. Later turns use the exact model recorded in the transcript.
 */
export async function readConfiguredModel({
  cwd,
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  managedSettingsPath,
} = {}) {
  const configDirectory = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== ''
    ? env.CLAUDE_CONFIG_DIR
    : path.join(homeDirectory, '.claude');

  let model = await modelFromSettings(path.join(configDirectory, 'settings.json'));

  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    model = (await modelFromSettings(path.join(cwd, '.claude', 'settings.json'))) ?? model;
    model = (await modelFromSettings(path.join(cwd, '.claude', 'settings.local.json'))) ?? model;
  }

  if (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.trim() !== '') {
    model = env.ANTHROPIC_MODEL.trim();
  }

  const managedPath = managedSettingsPath ?? (
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json'
  );
  model = (await modelFromSettings(managedPath)) ?? model;
  return model;
}
