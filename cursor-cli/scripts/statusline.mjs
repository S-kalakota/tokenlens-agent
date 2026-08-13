#!/usr/bin/env node
/** Persistent Cursor CLI status line for the currently pending estimate. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUsd } from '../src/estimator.mjs';
import { readPending } from '../src/state.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

async function readPayload() {
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

export function formatPendingLine(pending) {
  if (!Number.isFinite(pending?.costUsd) || pending.costUsd < 0) return '';
  return [
    '\u001b[33m',
    `TokenLens ${formatUsd(pending.costUsd)} pending`,
    ' · ↑ if needed + Enter: send',
    ' · changed: recalculate',
    '\u001b[0m',
  ].join('');
}

async function main() {
  const payload = await readPayload();
  const conversationId = payload?.session_id ?? payload?.conversation_id;
  if (typeof conversationId !== 'string' || conversationId === '') return;
  const pending = await readPending(conversationId);
  const line = formatPendingLine(pending);
  if (line !== '') process.stdout.write(`${line}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // A status-line failure must never interfere with Cursor input.
  });
}
