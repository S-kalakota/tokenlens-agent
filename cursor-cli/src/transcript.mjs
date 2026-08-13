import { open, stat } from 'node:fs/promises';
import { approximateTokens } from './estimator.mjs';

const TAIL_BYTES = 512 * 1024;

/**
 * Reads Cursor's JSONL transcript without retaining or writing its contents.
 * Cursor transcripts do not currently expose billing token counts, so message
 * content is converted to a conservative character-based approximation. The
 * Claude usage shape is also understood for forward/compatibility fixtures.
 */
export async function readContextState(transcriptPath) {
  const empty = { contextTokens: 0, available: false, exact: false };
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return empty;

  let text;
  let truncated;
  try {
    const { size } = await stat(transcriptPath);
    const start = Math.max(0, size - TAIL_BYTES);
    truncated = start > 0;
    const handle = await open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return empty;
  }

  const lines = text.split('\n');
  const lowest = truncated ? 1 : 0;
  let approximateCharacters = 0;
  let sawMessage = false;

  for (let index = lines.length - 1; index >= lowest; index -= 1) {
    const line = lines[index].trim();
    if (line === '') continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = entry?.message?.usage;
    if (entry?.type === 'assistant' && usage && typeof usage === 'object') {
      return {
        contextTokens:
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens) +
          count(usage.output_tokens),
        available: true,
        exact: true,
      };
    }

    if ((entry?.role === 'user' || entry?.role === 'assistant') && entry.message != null) {
      sawMessage = true;
      approximateCharacters += serializedLength(entry.message);
    }
  }

  if (!sawMessage) return empty;
  const { tokens } = approximateTokens('x'.repeat(approximateCharacters));
  return { contextTokens: tokens, available: true, exact: false };
}

function serializedLength(value) {
  try {
    return Array.from(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
