#!/usr/bin/env node
/** Cursor beforeSubmitPrompt hook: JSON in, native Cursor decision JSON out. */
import { fileURLToPath } from 'node:url';
import { loadConfig, setEnabled } from '../src/config.mjs';
import { estimateTurn } from '../src/estimator.mjs';
import { formatControl, formatEstimate } from '../src/format.mjs';
import { decide } from '../src/gate.mjs';
import { clearPending, prunePending, readPending, writePending } from '../src/state.mjs';
import { refreshStatusLine } from '../src/statusline.mjs';
import { readContextState } from '../src/transcript.mjs';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PRUNE_PROBABILITY = 0.02;
const STATUSLINE_SCRIPT = fileURLToPath(new URL('./statusline.mjs', import.meta.url));

async function clearConfirmation(conversationId) {
  await clearPending(conversationId);
  await refreshStatusLine(STATUSLINE_SCRIPT);
}

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
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function allow() {
  respond({ continue: true });
}

function block(userMessage) {
  respond({ continue: false, user_message: userMessage });
}

async function main() {
  const input = await readHookInput();
  if (input === undefined) return allow();
  if (
    input.hook_event_name !== undefined &&
    !['beforeSubmitPrompt', 'UserPromptSubmit'].includes(input.hook_event_name)
  ) {
    return allow();
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  const conversationId = input.conversation_id ?? input.session_id;
  if (prompt === undefined || typeof conversationId !== 'string' || conversationId === '') {
    return allow();
  }

  const config = await loadConfig();
  const pending = await readPending(conversationId);
  const transcriptPath = input.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH;
  const context = await readContextState(transcriptPath);
  const model = typeof input.model === 'string' ? input.model : input.model_id;
  const estimate = estimateTurn({
    prompt,
    contextTokens: context.contextTokens,
    model,
    expectedOutputTokens: config.expectedOutputTokens,
    pricing: config.pricing,
  });
  const decision = decide({ prompt, pending, config, estimate });

  if (decision.action === 'control') {
    let next = config;
    if (decision.command === 'on') next = await setEnabled(true);
    else if (decision.command === 'off') {
      next = await setEnabled(false);
      await clearConfirmation(conversationId);
    }
    await prunePending();
    return block(formatControl(decision.command, next));
  }

  if (decision.action === 'block') {
    const stored = await writePending(conversationId, {
      fingerprint: decision.fingerprint,
      costUsd: decision.estimate.totalUsd,
    });
    // If confirmation state cannot be stored, fail open instead of trapping the user.
    if (!stored) return allow();
    const statusLineActive = await refreshStatusLine(STATUSLINE_SCRIPT);
    return block(formatEstimate(estimate, { ...context, statusLineActive }));
  }

  if (pending !== null) await clearConfirmation(conversationId);
  if (Math.random() < PRUNE_PROBABILITY) await prunePending();
  return allow();
}

main().catch(() => {
  process.stderr.write('TokenLens skipped this prompt after an internal error.\n');
  allow();
});
