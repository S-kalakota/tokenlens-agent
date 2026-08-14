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
import { handleHook } from '../src/hook.mjs';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

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

async function main() {
  const input = await readHookInput();
  if (input === undefined) return;

  const decision = await handleHook(input);
  if (decision !== null) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  }
}

main().catch(() => {
  // Fail open, loudly enough to debug but without stopping the prompt.
  process.stderr.write('TokenLens skipped this prompt after an internal error.\n');
});
