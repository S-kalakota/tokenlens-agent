import { createHash } from 'node:crypto';
import type { SubmittedPrompt } from './automaticPrompt/submittedPromptBridge';

const FALLBACK_CONVERSATION_KEY = 'conversation:unknown';

/**
 * Implements the two-Enter workflow without retaining prompt text. The first
 * submission stores a SHA-256 fingerprint in memory; the next identical
 * submission for the same conversation consumes that fingerprint and passes.
 */
export class PromptConfirmationGate {
  private readonly pendingFingerprints = new Map<string, string>();

  public shouldContinue(submission: SubmittedPrompt): boolean {
    const key = submission.conversationId ?? FALLBACK_CONVERSATION_KEY;
    const fingerprint = promptFingerprint(submission.prompt);

    if (this.pendingFingerprints.get(key) === fingerprint) {
      this.pendingFingerprints.delete(key);
      return true;
    }

    this.pendingFingerprints.set(key, fingerprint);
    return false;
  }

  public clear(): void {
    this.pendingFingerprints.clear();
  }
}

function promptFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
