import { fingerprint } from './state.mjs';

/** `tokenlens on` / `off` / `status`, with or without a leading slash. */
const CONTROL_PATTERN = /^\/?tokenlens(?:\s+(on|off|status))?\s*$/i;

/** Recognises the zero-cost control phrases the gate handles itself. */
export function parseControl(prompt) {
  const match = CONTROL_PATTERN.exec(String(prompt ?? '').trim());
  if (match === null) return null;
  return { command: (match[1] ?? 'status').toLowerCase() };
}

/**
 * Runs every decision that does not need feature collection or prediction.
 * Keeping this stage separate is important: repository scans and model calls
 * must never run for control commands, disabled gates, or confirmations.
 */
export function preflight({ prompt, pending = null, config }) {
  const text = String(prompt ?? '');
  const trimmed = text.trim();

  if (trimmed === '') {
    return { action: 'allow', reason: 'empty-prompt' };
  }

  const control = parseControl(trimmed);
  if (control !== null) {
    return { action: 'control', command: control.command };
  }

  if (config?.enabled !== true) {
    return { action: 'allow', reason: 'gate-disabled' };
  }

  // Slash commands drive Claude Code itself. Pausing them would break /clear,
  // /model and friends for no benefit, so they always pass through.
  if (trimmed.startsWith('/')) {
    return { action: 'allow', reason: 'slash-command' };
  }

  const current = fingerprint(text);
  if (pending?.fingerprint === current) {
    return { action: 'allow', reason: 'confirmed', fingerprint: current };
  }

  return { action: 'predict', fingerprint: current };
}

/** Applies the configured threshold after a prediction has been produced. */
export function decidePrediction({ fingerprint: current, config, estimate }) {
  if (!estimate || !Number.isFinite(estimate.totalUsd)) {
    throw new TypeError('Prediction must contain a finite totalUsd');
  }

  if (estimate.totalUsd < (config.thresholdUsd ?? 0)) {
    return { action: 'allow', reason: 'below-threshold', estimate };
  }

  return { action: 'block', reason: 'estimated', fingerprint: current, estimate };
}

/**
 * Backwards-compatible one-shot decision helper used by callers that already
 * have an estimate. New orchestration should call `preflight` first.
 */
export function decide({ prompt, pending = null, config, estimate }) {
  const initial = preflight({ prompt, pending, config });
  if (initial.action !== 'predict') return initial;
  return decidePrediction({ fingerprint: initial.fingerprint, config, estimate });
}
