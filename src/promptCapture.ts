export const MAX_CAPTURED_PROMPT_LENGTH = 1_000_000;

export type CapturedPromptValidation =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

export function validateCapturedPrompt(value: string): CapturedPromptValidation {
  if (value.trim().length === 0) {
    return {
      ok: false,
      message: 'Provide non-empty prompt text before requesting an estimate.',
    };
  }

  if (value.length > MAX_CAPTURED_PROMPT_LENGTH) {
    return {
      ok: false,
      message: 'The prompt is too large to send to the estimator.',
    };
  }

  return { ok: true, prompt: value };
}

export function describeEndpointDestination(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // The endpoint client will surface the safe configuration error.
  }

  return 'the configured endpoint';
}
