import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONFIG_DEFAULTS } from '../src/config.mjs';
import { decide, parseControl } from '../src/gate.mjs';
import { fingerprint } from '../src/state.mjs';

const enabled = { ...CONFIG_DEFAULTS, enabled: true };
const estimate = { totalUsd: 0.05, formattedTotal: '$0.050' };
const run = (prompt, overrides = {}) =>
  decide({ prompt, pending: null, config: enabled, estimate, ...overrides });

describe('parseControl', () => {
  it('reads on, off and status controls', () => {
    assert.deepEqual(parseControl('tokenlens on'), { command: 'on' });
    assert.deepEqual(parseControl('/tokenlens OFF'), { command: 'off' });
    assert.deepEqual(parseControl(' TokenLens '), { command: 'status' });
    assert.equal(parseControl('what does tokenlens off do?'), null);
  });
});

describe('decide', () => {
  it('blocks a new prompt and allows the identical confirmation', () => {
    const prompt = 'refactor the parser';
    const first = run(prompt);
    assert.equal(first.action, 'block');
    assert.equal(first.fingerprint, fingerprint(prompt.trim()));

    const second = run(prompt, { pending: { fingerprint: first.fingerprint } });
    assert.equal(second.action, 'allow');
    assert.equal(second.reason, 'confirmed');
  });

  it('allows Cursor history recall with surrounding whitespace', () => {
    const first = run('refactor the parser');
    const recalled = run('refactor the parser\n', {
      pending: { fingerprint: first.fingerprint },
    });
    assert.equal(recalled.reason, 'confirmed');
  });

  it('re-estimates edits and lets Cursor slash commands through', () => {
    const first = run('do the thing');
    assert.equal(
      run('do the thing carefully', { pending: { fingerprint: first.fingerprint } }).action,
      'block',
    );
    assert.equal(run('/model auto').reason, 'slash-command');
  });

  it('honors disabled state and the configured threshold', () => {
    assert.equal(run('hello', { config: { ...enabled, enabled: false } }).reason, 'gate-disabled');
    assert.equal(run('hello', { config: { ...enabled, thresholdUsd: 1 } }).reason, 'below-threshold');
  });
});
