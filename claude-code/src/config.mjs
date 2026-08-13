import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PRICING } from './pricing.mjs';

export const CONFIG_DEFAULTS = {
  /** The gate only runs while this is true; "tokenlens off" flips it. */
  enabled: true,
  /** Assumed reply length. Agentic turns with tool loops run well past this. */
  expectedOutputTokens: 1200,
  /** Prompts estimated below this dollar amount are sent without pausing. */
  thresholdUsd: 0,
  /** Temporary inspection log containing exact prompts and all 14 features. */
  featureLogging: true,
  /** Per-million-token overrides, merged over the built-in list prices. */
  pricing: DEFAULT_PRICING,
};

export function tokenLensHome() {
  return process.env.TOKENLENS_HOME ?? path.join(homedir(), '.claude', 'tokenlens');
}

export function configPath() {
  return path.join(tokenLensHome(), 'config.json');
}

/** Loads config, falling back to defaults for a missing or corrupt file. */
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

/** Writes config atomically so a crash mid-write cannot corrupt the gate. */
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
