import { open, stat } from 'node:fs/promises';

/** Transcripts grow without bound; the newest entries are all we need. */
const TAIL_BYTES = 512 * 1024;

/**
 * Reads the size of the context that will be re-sent on the next turn, plus the
 * model currently answering, from the session transcript.
 *
 * The last assistant message's usage tells us exactly how many tokens were in
 * the window when it was produced. Its own output then joins the context for
 * the following turn, so it is counted too.
 *
 * Returns zeroed values for a first prompt, an unreadable path, or a transcript
 * with no assistant turn yet. The caller must never fail because of this.
 */
export async function readContextState(transcriptPath) {
  const empty = { contextTokens: 0, model: null, available: false };
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
  // Only skip the opening line when the tail read actually cut into a record.
  // On a transcript small enough to read whole, line 0 is a complete entry.
  const lowest = truncated ? 1 : 0;
  for (let index = lines.length - 1; index >= lowest; index -= 1) {
    const line = lines[index].trim();
    if (line === '') continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;

    const message = entry.message ?? {};
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const contextTokens =
      count(usage.input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.output_tokens);

    return {
      contextTokens,
      model: typeof message.model === 'string' ? message.model : null,
      available: true,
    };
  }

  return empty;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
