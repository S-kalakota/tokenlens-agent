import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../src/config.mjs';
import { decide, parseControl } from '../src/gate.mjs';
import { fingerprint } from '../src/state.mjs';

const enabled = { ...CONFIG_DEFAULTS, enabled: true };
const estimate = { totalUsd: 0.05, formattedTotal: '$0.050' };

const run = (prompt, overrides = {}) =>
  decide({ prompt, pending: null, config: enabled, estimate, ...overrides });

describe('parseControl', () => {
  it.each([
    ['tokenlens on', 'on'],
    ['tokenlens off', 'off'],
    ['TokenLens OFF', 'off'],
    ['/tokenlens status', 'status'],
    ['  tokenlens  ', 'status'],
  ])('reads %s as %s', (prompt, command) => {
    expect(parseControl(prompt)).toEqual({ command });
  });

  it.each(['tokenlens off please', 'what does tokenlens off do?', 'tokenlensoff'])(
    'ignores %s',
    (prompt) => {
      expect(parseControl(prompt)).toBeNull();
    },
  );
});

describe('decide', () => {
  it('pauses a new prompt and reports the fingerprint to store', () => {
    const decision = run('refactor the parser');
    expect(decision.action).toBe('block');
    expect(decision.fingerprint).toBe(fingerprint('refactor the parser'));
  });

  it('sends the same prompt once it has been estimated', () => {
    const prompt = 'refactor the parser';
    const first = run(prompt);
    const second = run(prompt, { pending: { fingerprint: first.fingerprint } });
    expect(second.action).toBe('allow');
    expect(second.reason).toBe('confirmed');
  });

  it('re-estimates an edited prompt instead of sending it', () => {
    const first = run('refactor the parser');
    const edited = run('refactor the parser and add tests', {
      pending: { fingerprint: first.fingerprint },
    });
    expect(edited.action).toBe('block');
    expect(edited.fingerprint).not.toBe(first.fingerprint);
  });

  it('treats whitespace-only edits as a different prompt', () => {
    const first = run('do the thing');
    const second = run('do the thing ', { pending: { fingerprint: first.fingerprint } });
    expect(second.action).toBe('block');
  });

  it('sends everything while the gate is off', () => {
    const decision = run('refactor the parser', {
      config: { ...enabled, enabled: false },
    });
    expect(decision).toEqual({ action: 'allow', reason: 'gate-disabled' });
  });

  it('never pauses slash commands', () => {
    expect(run('/clear').reason).toBe('slash-command');
    expect(run('/model opus').reason).toBe('slash-command');
  });

  it('handles control phrases before checking whether the gate is on', () => {
    const decision = run('tokenlens on', { config: { ...enabled, enabled: false } });
    expect(decision).toEqual({ action: 'control', command: 'on' });
  });

  it('sends an empty prompt untouched', () => {
    expect(run('   ').reason).toBe('empty-prompt');
  });

  it('skips prompts estimated below the threshold', () => {
    const decision = run('cheap prompt', {
      config: { ...enabled, thresholdUsd: 1 },
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('below-threshold');
  });

  it('still pauses prompts at or above the threshold', () => {
    const decision = run('pricey prompt', {
      config: { ...enabled, thresholdUsd: 0.05 },
    });
    expect(decision.action).toBe('block');
  });
});
