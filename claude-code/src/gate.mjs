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
 * The whole decision, as one pure function.
 *
 * `pending` is the fingerprint stored when this session was last paused, and
 * `estimate` is the already-computed cost of sending `prompt` now.
 */
export function decide({ prompt, pending = null, config, estimate }) {
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

  if (estimate.totalUsd < (config.thresholdUsd ?? 0)) {
    return { action: 'allow', reason: 'below-threshold', estimate };
  }

  return { action: 'block', reason: 'estimated', fingerprint: current, estimate };
}
