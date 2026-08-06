import { describe, expect, it } from 'vitest';
import { PromptConfirmationGate } from '../src/promptConfirmationGate';

describe('PromptConfirmationGate', () => {
  it('blocks the first Enter and allows the second unchanged Enter', () => {
    const gate = new PromptConfirmationGate();
    const submission = {
      prompt: 'Explain this function.',
      conversationId: 'conversation-a',
    };

    expect(gate.shouldContinue(submission)).toBe(false);
    expect(gate.shouldContinue(submission)).toBe(true);
    expect(gate.shouldContinue(submission)).toBe(false);
  });

  it('requires two new Enters after the estimated prompt is edited', () => {
    const gate = new PromptConfirmationGate();
    const original = {
      prompt: 'Explain this function.',
      conversationId: 'conversation-a',
    };
    const edited = {
      prompt: 'Explain this function and add tests.',
      conversationId: 'conversation-a',
    };

    expect(gate.shouldContinue(original)).toBe(false);
    expect(gate.shouldContinue(edited)).toBe(false);
    expect(gate.shouldContinue(edited)).toBe(true);
  });

  it('keeps confirmations separate between conversations', () => {
    const gate = new PromptConfirmationGate();
    const firstConversation = {
      prompt: 'Use the same prompt text.',
      conversationId: 'conversation-a',
    };
    const secondConversation = {
      prompt: 'Use the same prompt text.',
      conversationId: 'conversation-b',
    };

    expect(gate.shouldContinue(firstConversation)).toBe(false);
    expect(gate.shouldContinue(secondConversation)).toBe(false);
    expect(gate.shouldContinue(firstConversation)).toBe(true);
    expect(gate.shouldContinue(secondConversation)).toBe(true);
  });

  it('forgets pending confirmation when cleared', () => {
    const gate = new PromptConfirmationGate();
    const submission = { prompt: 'Do the work.' };

    expect(gate.shouldContinue(submission)).toBe(false);
    gate.clear();
    expect(gate.shouldContinue(submission)).toBe(false);
  });
});
