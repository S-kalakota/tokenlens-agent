import { describe, expect, it } from 'vitest';

import {
  describeEndpointDestination,
  MAX_CAPTURED_PROMPT_LENGTH,
  validateCapturedPrompt,
} from '../src/promptCapture';

describe('validateCapturedPrompt', () => {
  it.each(['', '   ', '\n\t'])('rejects blank prompt text', (prompt) => {
    expect(validateCapturedPrompt(prompt)).toEqual({
      ok: false,
      message: 'Provide non-empty prompt text before requesting an estimate.',
    });
  });

  it('rejects prompt text above the capture limit', () => {
    const prompt = 'x'.repeat(MAX_CAPTURED_PROMPT_LENGTH + 1);

    expect(validateCapturedPrompt(prompt)).toEqual({
      ok: false,
      message: 'The prompt is too large to send to the estimator.',
    });
  });

  it('preserves accepted prompt text exactly', () => {
    const prompt = '  Refactor this selection.\nKeep the indentation.  \n';

    expect(validateCapturedPrompt(prompt)).toEqual({ ok: true, prompt });
  });

  it('accepts prompt text exactly at the capture limit', () => {
    const prompt = 'x'.repeat(MAX_CAPTURED_PROMPT_LENGTH);

    expect(validateCapturedPrompt(prompt)).toEqual({ ok: true, prompt });
  });
});

describe('describeEndpointDestination', () => {
  it('returns only the origin for an HTTP(S) endpoint', () => {
    expect(
      describeEndpointDestination(
        'https://user:secret@estimator.example:8443/v1/estimates?token=private#details',
      ),
    ).toBe('https://estimator.example:8443');
  });

  it('supports local HTTP endpoint origins', () => {
    expect(
      describeEndpointDestination('http://localhost:8787/v1/estimates'),
    ).toBe('http://localhost:8787');
  });

  it.each([
    'not a URL containing private-endpoint-details',
    'file:///private/estimator.json',
    'javascript:private-endpoint-details',
  ])('uses a generic destination for an invalid or unsupported endpoint', (endpoint) => {
    const destination = describeEndpointDestination(endpoint);

    expect(destination).toBe('the configured endpoint');
    expect(destination).not.toContain('private');
  });
});
