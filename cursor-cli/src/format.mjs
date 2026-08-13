import { formatUsd } from './estimator.mjs';

const number = (value) => value.toLocaleString('en-US');

function table(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}   ${value}`).join('\n');
}

export function formatEstimate(estimate, context = {}) {
  let contextValue = 'first turn, nothing carried in yet';
  if (context.available) {
    contextValue = `${context.exact ? '' : '~'}${number(estimate.contextTokens)} tokens`;
  }
  let modelValue = estimate.model ?? `unknown, priced as ${estimate.family}`;
  if (
    estimate.model &&
    estimate.family === 'auto' &&
    !estimate.model.toLowerCase().includes('auto')
  ) {
    modelValue = `${estimate.model} (Auto fallback rates)`;
  }

  return [
    'TokenLens paused this prompt. Nothing was sent, so nothing was billed.',
    '',
    table([
      ['Estimated cost', estimate.formattedTotal],
      ['This prompt', `${number(estimate.characters)} chars ~ ${number(estimate.promptTokens)} tokens`],
      ['Context re-sent', contextValue],
      ['Assumed reply', `${number(estimate.expectedOutputTokens)} tokens`],
      ['Model', modelValue],
    ]),
    '',
    'Press UP, then ENTER, to recall and send it unchanged.',
    'Edit the recalled prompt and you get a fresh estimate.',
    'Type "tokenlens off" to stop gating.',
    '',
    'Estimate only: Cursor may make multiple model calls and provider rates can change.',
  ].join('\n');
}

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
      [
        'Threshold',
        config.thresholdUsd > 0
          ? `${formatUsd(config.thresholdUsd)} (cheaper prompts pass)`
          : 'none, every prompt is estimated',
      ],
      ['Assumed reply', `${number(config.expectedOutputTokens)} tokens`],
    ]),
    '',
    'Commands: tokenlens on | tokenlens off | tokenlens status',
  );

  return lines.join('\n');
}
