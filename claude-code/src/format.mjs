import { formatUsd } from './estimator.mjs';

const number = (value) => value.toLocaleString('en-US');

function table(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}   ${value}`).join('\n');
}

/** The message shown in place of the prompt when the gate pauses it. */
export function formatEstimate(estimate, { contextAvailable = true } = {}) {
  const rows = [
    ['Estimated cost', estimate.formattedTotal],
    ['This prompt', `${number(estimate.characters)} chars ~ ${number(estimate.promptTokens)} tokens`],
    [
      'Context re-sent',
      contextAvailable
        ? `${number(estimate.contextTokens)} tokens`
        : 'first turn, nothing carried in yet',
    ],
    ['Assumed reply', `${number(estimate.expectedOutputTokens)} tokens`],
    ['Model', estimate.model ?? `unknown, priced as ${estimate.family}`],
  ];

  return [
    'TokenLens paused this prompt. Nothing was sent, so nothing was billed.',
    '',
    table(rows),
    '',
    'Press UP then ENTER to send it unchanged. Edit it and you get a fresh estimate.',
    'Type "tokenlens off" to stop gating.',
  ].join('\n');
}

/** Confirmation shown after a `tokenlens on|off|status` control phrase. */
export function formatControl(command, config) {
  const state = config.enabled ? 'ON' : 'OFF';
  const lines = [];

  if (command === 'on') lines.push('TokenLens gate is now ON.');
  else if (command === 'off') lines.push('TokenLens gate is now OFF.');
  else lines.push(`TokenLens gate is ${state}.`);

  lines.push(
    '',
    table([
      ['Gate', state],
      ['Threshold', config.thresholdUsd > 0 ? `${formatUsd(config.thresholdUsd)} (cheaper prompts pass)` : 'none, every prompt is estimated'],
      ['Assumed reply', `${number(config.expectedOutputTokens)} tokens`],
    ]),
    '',
    'Commands: tokenlens on | tokenlens off | tokenlens status',
  );

  return lines.join('\n');
}
