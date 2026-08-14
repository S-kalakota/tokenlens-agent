import { loadConfig, setEnabled } from './config.mjs';
import { formatControl, formatEstimate } from './format.mjs';
import { parseControl, preflight, decidePrediction } from './gate.mjs';
import { buildFeatures, loadFeatureManifest } from './features/build-features.mjs';
import { pruneRepositoryCache } from './features/cache.mjs';
import { appendFeatureLog } from './feature-log.mjs';
import { readConfiguredModel } from './claude-settings.mjs';
import { predictEstimate } from './ml-predictor.mjs';
import { clearPending, prunePending, readPending, writePending } from './state.mjs';
import { readContextState } from './transcript.mjs';

const PRUNE_PROBABILITY = 0.02;

const DEFAULT_DEPENDENCIES = {
  appendFeatureLog,
  buildFeatures,
  clearPending,
  loadConfig,
  loadFeatureManifest,
  predictEstimate,
  prunePending,
  pruneRepositoryCache,
  random: Math.random,
  readConfiguredModel,
  readContextState,
  readPending,
  setEnabled,
  writePending,
};

export function promptOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;

  // Live Claude Code sends `prompt`; `user_input` is accepted defensively
  // because the published hook reference documents that name.
  for (const key of ['prompt', 'user_input']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return undefined;
}

const nativeBlock = (reason) => ({ decision: 'block', reason });

async function occasionallyPrune(dependencies) {
  if (dependencies.random() < PRUNE_PROBABILITY) {
    await Promise.all([
      dependencies.prunePending(),
      dependencies.pruneRepositoryCache(),
    ]);
  }
}

/**
 * Handles one decoded hook event. `null` means allow/silent stdout.
 *
 * Errors deliberately propagate to the tiny executable wrapper, whose generic
 * catch is the fail-open boundary. Dependency injection keeps the ordering
 * contract testable without leaking feature payloads or prompts to disk.
 */
export async function handleHook(input, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.hook_event_name !== 'UserPromptSubmit') return null;

  const prompt = promptOf(input);
  if (prompt === undefined) return null;

  const sessionId = input.session_id;
  const trimmed = prompt.trim();

  if (trimmed === '') {
    await dependencies.clearPending(sessionId);
    await occasionallyPrune(dependencies);
    return null;
  }

  const control = parseControl(trimmed);
  if (control !== null) {
    let config = await dependencies.loadConfig();
    if (control.command === 'on') {
      config = await dependencies.setEnabled(true);
    } else if (control.command === 'off') {
      config = await dependencies.setEnabled(false);
      await dependencies.clearPending(sessionId);
    }
    await Promise.all([
      dependencies.prunePending(),
      dependencies.pruneRepositoryCache(),
    ]);
    return nativeBlock(formatControl(control.command, config));
  }

  const config = await dependencies.loadConfig();
  if (config.enabled !== true || trimmed.startsWith('/')) {
    await dependencies.clearPending(sessionId);
    await occasionallyPrune(dependencies);
    return null;
  }

  const pending = await dependencies.readPending(sessionId);
  const initial = preflight({ prompt, pending, config });
  if (initial.action === 'allow') {
    await dependencies.clearPending(sessionId);
    await occasionallyPrune(dependencies);
    return null;
  }

  // A mismatched pending fingerprint belongs to an older prompt. Remove it
  // before expensive work so a later extraction/prediction failure cannot
  // leave a stale confirmation behind.
  if (pending !== null) await dependencies.clearPending(sessionId);

  const context = await dependencies.readContextState(input.transcript_path);
  const selectedModel = typeof input.model === 'string' && input.model.trim() !== ''
    ? input.model
    : context.model ?? await dependencies.readConfiguredModel({ cwd: input.cwd });
  const manifest = await dependencies.loadFeatureManifest();
  const payload = await dependencies.buildFeatures({
    prompt,
    cwd: input.cwd,
    modelId: selectedModel,
    transcriptPath: input.transcript_path,
    manifest,
  });
  if (config.featureLogging !== false) {
    await dependencies.appendFeatureLog({ prompt, payload, manifest, sessionId });
  }
  const estimate = await dependencies.predictEstimate({
    payload,
    manifest,
    prompt,
    contextTokens: context.contextTokens,
    model: selectedModel,
    expectedOutputTokens: config.expectedOutputTokens,
    pricing: config.pricing,
  });
  const decision = decidePrediction({
    fingerprint: initial.fingerprint,
    config,
    estimate,
  });

  if (decision.action === 'block') {
    await dependencies.writePending(sessionId, { fingerprint: decision.fingerprint });
    return nativeBlock(formatEstimate(estimate, { contextAvailable: context.available }));
  }

  await occasionallyPrune(dependencies);
  return null;
}
