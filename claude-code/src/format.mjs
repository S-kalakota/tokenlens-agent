import { formatUsd } from './estimator.mjs';

const number = (value) => value.toLocaleString('en-US');

function table(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}   ${value}`).join('\n');
}

/**
 * Describes the reply-length figure honestly, because the same row means very
 * different things depending on where the number came from: a measured
 * prediction, a flat guess, or a refusal.
 */
function replyRow(estimate) {
  if (estimate.predictionSource === 'model') {
    const range = `${number(estimate.predictedOutputLow)}-${number(estimate.predictedOutputHigh)}`;
    const confidence = estimate.predictionConfidence === 'low'
      ? ', low confidence'
      : '';
    return ['Predicted reply', `${number(estimate.predictedOutputTokens)} tokens (80% ${range}${confidence})`];
  }

  if (estimate.modelSupported === false) {
    return ['Reply length', `not predicted, ${estimate.model ?? 'this model'} is unsupported`];
  }

  const suffix = estimate.estimatorUnavailable ? ' (estimator offline, flat assumption)' : '';
  return ['Assumed reply', `${number(estimate.expectedOutputTokens)} tokens${suffix}`];
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
    replyRow(estimate),
    ['Model', estimate.model ?? `unknown, priced as ${estimate.family}`],
  ];

  const caveats = [];
  if (estimate.modelSupported === false) {
    caveats.push(
      `TokenLens does not support ${estimate.model ?? 'this model'}. The reply-length`,
      'model was trained on claude-haiku-4-5 and claude-sonnet-5 only, so the cost',
      'above prices the prompt and context but assumes a flat reply length.',
    );
  } else if (estimate.estimatorUnavailable) {
    caveats.push('The reply-length estimator is offline, so the reply is a flat assumption.');
  }

  return [
    'TokenLens paused this prompt. Nothing was sent, so nothing was billed.',
    '',
    table(rows),
    ...(caveats.length === 0 ? [] : ['', ...caveats]),
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
