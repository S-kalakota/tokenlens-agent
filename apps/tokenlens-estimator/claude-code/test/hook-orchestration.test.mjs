import { describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS } from '../src/config.mjs';
import { handleHook } from '../src/hook.mjs';
import { fingerprint } from '../src/state.mjs';

const submit = (prompt, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'orchestration-session',
  cwd: '/workspace',
  prompt,
  ...extra,
});

function dependencies(overrides = {}) {
  const estimate = {
    totalUsd: 0.05,
    formattedTotal: '$0.050',
    characters: 12,
    promptTokens: 3,
    contextTokens: 0,
    expectedOutputTokens: 1200,
    model: null,
    family: 'sonnet',
  };

  return {
    appendFeatureLog: vi.fn(async () => {}),
    buildFeatures: vi.fn(async () => ({ fixture: true })),
    clearPending: vi.fn(async () => {}),
    loadConfig: vi.fn(async () => ({ ...CONFIG_DEFAULTS, enabled: true })),
    loadFeatureManifest: vi.fn(async () => ({ fixture: true })),
    predictEstimate: vi.fn(async () => estimate),
    prunePending: vi.fn(async () => 0),
    pruneRepositoryCache: vi.fn(async () => 0),
    random: vi.fn(() => 1),
    readConfiguredModel: vi.fn(async () => null),
    readContextState: vi.fn(async () => ({
      contextTokens: 0,
      model: null,
      available: false,
    })),
    readPending: vi.fn(async () => null),
    setEnabled: vi.fn(async (enabled) => ({ ...CONFIG_DEFAULTS, enabled })),
    writePending: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('hook feature-extraction ordering', () => {
  it.each([
    ['empty prompt', submit('   ')],
    ['slash command', submit('/model opus')],
    ['non-submit event', submit('hello', { hook_event_name: 'Stop' })],
  ])('does not collect or predict for a %s', async (_label, input) => {
    const deps = dependencies();
    expect(await handleHook(input, deps)).toBeNull();
    expect(deps.buildFeatures).not.toHaveBeenCalled();
    expect(deps.appendFeatureLog).not.toHaveBeenCalled();
    expect(deps.predictEstimate).not.toHaveBeenCalled();
    expect(deps.loadFeatureManifest).not.toHaveBeenCalled();
  });

  it('does not collect or predict while disabled', async () => {
    const deps = dependencies({
      loadConfig: vi.fn(async () => ({ ...CONFIG_DEFAULTS, enabled: false })),
    });
    expect(await handleHook(submit('implement it'), deps)).toBeNull();
    expect(deps.readPending).not.toHaveBeenCalled();
    expect(deps.buildFeatures).not.toHaveBeenCalled();
    expect(deps.appendFeatureLog).not.toHaveBeenCalled();
    expect(deps.predictEstimate).not.toHaveBeenCalled();
  });

  it('handles control commands without feature extraction', async () => {
    const deps = dependencies();
    const response = await handleHook(submit('tokenlens status'), deps);
    expect(response.decision).toBe('block');
    expect(response.reason).toContain('TokenLens gate is ON');
    expect(deps.readPending).not.toHaveBeenCalled();
    expect(deps.buildFeatures).not.toHaveBeenCalled();
    expect(deps.appendFeatureLog).not.toHaveBeenCalled();
    expect(deps.predictEstimate).not.toHaveBeenCalled();
  });

  it('allows a matching pending fingerprint before transcript or feature reads', async () => {
    const prompt = 'implement the parser';
    const deps = dependencies({
      readPending: vi.fn(async () => ({ fingerprint: fingerprint(prompt) })),
    });
    expect(await handleHook(submit(prompt), deps)).toBeNull();
    expect(deps.readContextState).not.toHaveBeenCalled();
    expect(deps.loadFeatureManifest).not.toHaveBeenCalled();
    expect(deps.buildFeatures).not.toHaveBeenCalled();
    expect(deps.appendFeatureLog).not.toHaveBeenCalled();
    expect(deps.predictEstimate).not.toHaveBeenCalled();
  });

  it('collects and predicts exactly once for a new prompt', async () => {
    const deps = dependencies();
    const input = submit('implement the parser', { transcript_path: '/session.jsonl' });
    const response = await handleHook(input, deps);

    expect(response.decision).toBe('block');
    expect(deps.readContextState).toHaveBeenCalledOnce();
    expect(deps.buildFeatures).toHaveBeenCalledOnce();
    expect(deps.buildFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: input.prompt, cwd: input.cwd, modelId: null }),
    );
    expect(deps.predictEstimate).toHaveBeenCalledOnce();
    expect(deps.appendFeatureLog).toHaveBeenCalledOnce();
    expect(deps.appendFeatureLog).toHaveBeenCalledWith({
      prompt: input.prompt,
      payload: { fixture: true },
      manifest: { fixture: true },
      sessionId: input.session_id,
    });
    expect(deps.appendFeatureLog.mock.invocationCallOrder[0]).toBeLessThan(
      deps.predictEstimate.mock.invocationCallOrder[0],
    );
    expect(deps.writePending).toHaveBeenCalledWith(input.session_id, {
      fingerprint: fingerprint(input.prompt),
    });
  });

  it('uses the configured model on a first turn with no transcript model', async () => {
    const deps = dependencies({
      readConfiguredModel: vi.fn(async () => 'haiku'),
    });
    const input = submit('explain this repository');
    await handleHook(input, deps);

    expect(deps.readConfiguredModel).toHaveBeenCalledWith({ cwd: input.cwd });
    expect(deps.buildFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'haiku' }),
    );
    expect(deps.predictEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'haiku' }),
    );
  });

  it('prefers an explicit hook model, then the transcript model, over settings', async () => {
    const explicit = dependencies();
    await handleHook(submit('explicit model', { model: 'claude-opus-5' }), explicit);
    expect(explicit.buildFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-opus-5' }),
    );
    expect(explicit.readConfiguredModel).not.toHaveBeenCalled();

    const transcript = dependencies({
      readContextState: vi.fn(async () => ({
        contextTokens: 10,
        model: 'claude-sonnet-5',
        available: true,
      })),
    });
    await handleHook(submit('transcript model'), transcript);
    expect(transcript.buildFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet-5' }),
    );
    expect(transcript.readConfiguredModel).not.toHaveBeenCalled();
  });

  it('clears a stale fingerprint before collecting an edited prompt', async () => {
    const deps = dependencies({
      readPending: vi.fn(async () => ({ fingerprint: fingerprint('old prompt') })),
    });
    await handleHook(submit('edited prompt'), deps);
    expect(deps.clearPending).toHaveBeenCalledWith('orchestration-session');
    expect(deps.clearPending.mock.invocationCallOrder[0]).toBeLessThan(
      deps.buildFeatures.mock.invocationCallOrder[0],
    );
  });

  it('allows predictions strictly below the threshold without writing pending state', async () => {
    const deps = dependencies({
      loadConfig: vi.fn(async () => ({
        ...CONFIG_DEFAULTS,
        enabled: true,
        thresholdUsd: 1,
      })),
    });
    expect(await handleHook(submit('cheap prompt'), deps)).toBeNull();
    expect(deps.buildFeatures).toHaveBeenCalledOnce();
    expect(deps.predictEstimate).toHaveBeenCalledOnce();
    expect(deps.writePending).not.toHaveBeenCalled();
  });

  it('can disable prompt logging without disabling extraction or prediction', async () => {
    const deps = dependencies({
      loadConfig: vi.fn(async () => ({
        ...CONFIG_DEFAULTS,
        enabled: true,
        featureLogging: false,
      })),
    });
    const response = await handleHook(submit('do not log this'), deps);
    expect(response.decision).toBe('block');
    expect(deps.buildFeatures).toHaveBeenCalledOnce();
    expect(deps.appendFeatureLog).not.toHaveBeenCalled();
    expect(deps.predictEstimate).toHaveBeenCalledOnce();
  });

  it('propagates collection, logging, and prediction failures to the fail-open boundary', async () => {
    const collectionFailure = dependencies({
      buildFeatures: vi.fn(async () => {
        throw new Error('collector exploded');
      }),
    });
    await expect(handleHook(submit('collect me'), collectionFailure)).rejects.toThrow(
      'collector exploded',
    );
    expect(collectionFailure.predictEstimate).not.toHaveBeenCalled();

    const logFailure = dependencies({
      appendFeatureLog: vi.fn(async () => {
        throw new Error('log exploded');
      }),
    });
    await expect(handleHook(submit('log me'), logFailure)).rejects.toThrow('log exploded');
    expect(logFailure.predictEstimate).not.toHaveBeenCalled();

    const predictionFailure = dependencies({
      predictEstimate: vi.fn(async () => {
        throw new Error('predictor exploded');
      }),
    });
    await expect(handleHook(submit('predict me'), predictionFailure)).rejects.toThrow(
      'predictor exploded',
    );
  });
});
