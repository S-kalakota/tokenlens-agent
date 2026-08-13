import { fingerprint } from './state.mjs';

const CONTROL_PATTERN = /^\/?tokenlens(?:\s+(on|off|status))?\s*$/i;

export function parseControl(prompt) {
  const match = CONTROL_PATTERN.exec(String(prompt ?? '').trim());
  if (match === null) return null;
  return { command: (match[1] ?? 'status').toLowerCase() };
}

/**
 * Cursor history recall appends one line ending to blocked prompts. Remove only
 * that transport artifact; user-authored whitespace remains part of identity.
 */
export function confirmationPrompt(prompt) {
  const text = String(prompt ?? '');
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
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

  const current = fingerprint(text);
  const recalled = fingerprint(confirmationPrompt(text));
  if (pending?.fingerprint === current || pending?.fingerprint === recalled) {
    return { action: 'allow', reason: 'confirmed', fingerprint: pending.fingerprint };
  }

  if (estimate.totalUsd < (config.thresholdUsd ?? 0)) {
    return { action: 'allow', reason: 'below-threshold', estimate };
  }

  return { action: 'block', reason: 'estimated', fingerprint: current, estimate };
}
