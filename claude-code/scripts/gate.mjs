#!/usr/bin/env node
/**
 * TokenLens UserPromptSubmit hook.
 *
 * Claude Code pipes the submitted prompt in on stdin and reads a decision from
 * stdout. Printing nothing sends the prompt; printing `decision: "block"` stops
 * it before any model call happens, which is the whole point: the estimate has
 * to be free.
 *
 * Every failure path here allows the prompt. A broken estimator must never be
 * able to lock someone out of their own session.
 */
import { loadConfig, setEnabled } from '../src/config.mjs';
import { estimateTurn } from '../src/estimator.mjs';
import { formatControl, formatEstimate } from '../src/format.mjs';
import { decide } from '../src/gate.mjs';
import { clearPending, prunePending, readPending, writePending } from '../src/state.mjs';
import { readContextState } from '../src/transcript.mjs';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PRUNE_PROBABILITY = 0.02;

async function readHookInput() {
  const chunks = [];
  let size = 0;
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(chunks.join(''));
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Silence sends the prompt. */
function allow() {}

function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

function promptOf(input) {
  // Live Claude Code sends `prompt`; `user_input` is accepted defensively
  // because the published hook reference documents that name.
  for (const key of ['prompt', 'user_input']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return undefined;
}

async function main() {
  const input = await readHookInput();
  if (input === undefined) return allow();
  if (
    input.hook_event_name !== undefined &&
    input.hook_event_name !== 'UserPromptSubmit'
  ) {
    return allow();
  }

  const prompt = promptOf(input);
  if (prompt === undefined) return allow();

  const sessionId = input.session_id;
  const config = await loadConfig();
  const pending = await readPending(sessionId);
  const context = await readContextState(input.transcript_path);
  const estimate = estimateTurn({
    prompt,
    contextTokens: context.contextTokens,
    model: context.model,
    expectedOutputTokens: config.expectedOutputTokens,
    pricing: config.pricing,
  });

  const decision = decide({ prompt, pending, config, estimate });

  if (decision.action === 'control') {
    let next = config;
    if (decision.command === 'on') {
      next = await setEnabled(true);
    } else if (decision.command === 'off') {
      next = await setEnabled(false);
      await clearPending(sessionId);
    }
    await prunePending();
    return block(formatControl(decision.command, next));
  }

  if (decision.action === 'block') {
    await writePending(sessionId, { fingerprint: decision.fingerprint });
    return block(formatEstimate(estimate, { contextAvailable: context.available }));
  }

  if (pending !== null) await clearPending(sessionId);
  if (Math.random() < PRUNE_PROBABILITY) await prunePending();
  return allow();
}

main().catch(() => {
  // Fail open, loudly enough to debug but without stopping the prompt.
  process.stderr.write('TokenLens skipped this prompt after an internal error.\n');
});
