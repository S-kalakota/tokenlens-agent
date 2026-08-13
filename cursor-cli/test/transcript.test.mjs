import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readContextState } from '../src/transcript.mjs';

async function transcriptWith(lines) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokenlens-cursor-transcript-'));
  const file = path.join(directory, 'conversation.jsonl');
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return file;
}

describe('readContextState', () => {
  it('returns unavailable for a missing transcript', async () => {
    assert.deepEqual(await readContextState('/missing/transcript.jsonl'), {
      contextTokens: 0,
      available: false,
      exact: false,
    });
  });

  it('approximates context from Cursor role/message JSONL', async () => {
    const file = await transcriptWith([
      { role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'How can I help?' }] },
      },
      { type: 'turn_ended', status: 'completed' },
    ]);
    const state = await readContextState(file);
    assert.equal(state.available, true);
    assert.equal(state.exact, false);
    assert.ok(state.contextTokens > 0);
  });

  it('uses exact usage counters when a transcript provides them', async () => {
    const file = await transcriptWith([
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 577,
            cache_read_input_tokens: 60_467,
            output_tokens: 1199,
          },
        },
      },
    ]);
    assert.deepEqual(await readContextState(file), {
      contextTokens: 62_245,
      available: true,
      exact: true,
    });
  });
});
