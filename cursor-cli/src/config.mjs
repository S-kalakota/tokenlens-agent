import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PRICING } from './pricing.mjs';

export const CONFIG_DEFAULTS = {
  enabled: true,
  expectedOutputTokens: 1200,
  thresholdUsd: 0,
  pricing: DEFAULT_PRICING,
};

export function tokenLensHome() {
  return process.env.TOKENLENS_HOME ?? path.join(homedir(), '.cursor', 'tokenlens');
}

export function configPath() {
  return path.join(tokenLensHome(), 'config.json');
}

/** Loads config and safely falls back to defaults for missing/corrupt files. */
export async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return { ...CONFIG_DEFAULTS };
    return {
      ...CONFIG_DEFAULTS,
      ...raw,
      pricing: { ...DEFAULT_PRICING, ...(raw.pricing ?? {}) },
    };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

/** Writes config atomically so interruption cannot leave a partial file. */
export async function saveConfig(config) {
  const target = configPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function setEnabled(enabled) {
  const config = await loadConfig();
  const next = { ...config, enabled };
  await saveConfig(next);
  return next;
}
