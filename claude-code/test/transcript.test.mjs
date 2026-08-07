import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readContextState } from '../src/transcript.mjs';

async function transcriptWith(lines) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokenlens-transcript-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return file;
}

const assistant = (usage, model = 'claude-sonnet-5') => ({
  type: 'assistant',
  message: { model, usage },
});

describe('readContextState', () => {
  it('reports nothing measurable when there is no transcript', async () => {
    expect(await readContextState('/nope/missing.jsonl')).toEqual({
      contextTokens: 0,
      model: null,
      available: false,
    });
    expect(await readContextState(undefined)).toEqual({
      contextTokens: 0,
      model: null,
      available: false,
    });
  });

  it('sums every input bucket plus the reply that joins the context', async () => {
    const file = await transcriptWith([
      { type: 'user', message: { content: 'hi' } },
      assistant({
        input_tokens: 2,
        cache_creation_input_tokens: 577,
        cache_read_input_tokens: 60_467,
        output_tokens: 1199,
      }),
    ]);
    expect(await readContextState(file)).toEqual({
      contextTokens: 62_245,
      model: 'claude-sonnet-5',
      available: true,
    });
  });

  it('uses the most recent assistant turn', async () => {
    const file = await transcriptWith([
      assistant({ input_tokens: 10, output_tokens: 0 }, 'claude-sonnet-5'),
      assistant({ input_tokens: 900, output_tokens: 100 }, 'claude-opus-5'),
    ]);
    const state = await readContextState(file);
    expect(state.contextTokens).toBe(1000);
    expect(state.model).toBe('claude-opus-5');
  });

  it('skips malformed lines and entries without usage', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tokenlens-transcript-'));
    const file = path.join(directory, 'session.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify(assistant({ input_tokens: 5, output_tokens: 5 })),
        JSON.stringify({ type: 'assistant', message: {} }),
        '{ this is not json',
      ].join('\n'),
      'utf8',
    );
    const state = await readContextState(file);
    expect(state.contextTokens).toBe(10);
  });
});
