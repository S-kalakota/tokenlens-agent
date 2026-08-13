import { fingerprint } from './state.mjs';

const CONTROL_PATTERN = /^\/?tokenlens(?:\s+(on|off|status))?\s*$/i;

export function parseControl(prompt) {
  const match = CONTROL_PATTERN.exec(String(prompt ?? '').trim());
  if (match === null) return null;
  return { command: (match[1] ?? 'status').toLowerCase() };
}

/** Pure decision function shared by the hook and unit tests. */
export function decide({ prompt, pending = null, config, estimate }) {
  const text = String(prompt ?? '');
  const trimmed = text.trim();

  if (trimmed === '') return { action: 'allow', reason: 'empty-prompt' };

  const control = parseControl(trimmed);
  if (control !== null) return { action: 'control', command: control.command };

  if (config?.enabled !== true) return { action: 'allow', reason: 'gate-disabled' };

  // Cursor slash commands operate the CLI itself and must never be gated.
  if (trimmed.startsWith('/')) return { action: 'allow', reason: 'slash-command' };

  // Cursor CLI history recall may append a trailing newline to a blocked
  // prompt. Ignore surrounding whitespace for confirmation while preserving
  // edits anywhere inside the prompt.
  const current = fingerprint(trimmed);
  if (pending?.fingerprint === current) {
    return { action: 'allow', reason: 'confirmed', fingerprint: current };
  }

  if (estimate.totalUsd < (config.thresholdUsd ?? 0)) {
    return { action: 'allow', reason: 'below-threshold', estimate };
  }

  return { action: 'block', reason: 'estimated', fingerprint: current, estimate };
}
