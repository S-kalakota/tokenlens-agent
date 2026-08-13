import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

const GATE = fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));
let home;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'tokenlens-cursor-home-'));
});

function runHook(payload, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE], {
      env: { ...process.env, TOKENLENS_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr, decision: JSON.parse(stdout.trim()) });
    });
    child.stdin.end(stdin ?? JSON.stringify(payload));
  });
}

const submit = (prompt, extra = {}) => ({
  conversation_id: 'conversation-under-test',
  hook_event_name: 'beforeSubmitPrompt',
  model: 'auto',
  prompt,
  ...extra,
});

describe('Cursor beforeSubmitPrompt hook', () => {
  it('pauses once, then allows the identical prompt', async () => {
    const prompt = 'rewrite the billing module';
    const first = await runHook(submit(prompt));
    assert.equal(first.code, 0);
    assert.equal(first.decision.continue, false);
    assert.match(first.decision.user_message, /Estimated cost\s+\$/);
    assert.match(first.decision.user_message, /Model\s+auto/);
    assert.match(first.decision.user_message, /Press UP, then ENTER/);

    // Cursor's history recall can add a trailing newline.
    const second = await runHook(submit(`${prompt}\n`));
    assert.deepEqual(second.decision, { continue: true });
  });

  it('pauses again after an edit and isolates conversations', async () => {
    await runHook(submit('rewrite the billing module'));
    assert.equal((await runHook(submit('rewrite it carefully'))).decision.continue, false);
    assert.equal(
      (
        await runHook(
          submit('rewrite the billing module', { conversation_id: 'another-conversation' }),
        )
      ).decision.continue,
      false,
    );
  });

  it('handles controls without sending them to the model', async () => {
    assert.match((await runHook(submit('tokenlens off'))).decision.user_message, /now OFF/);
    assert.deepEqual((await runHook(submit('passes while disabled'))).decision, {
      continue: true,
    });
    assert.match((await runHook(submit('tokenlens on'))).decision.user_message, /now ON/);
  });

  it('fails open on malformed or incomplete input', async () => {
    for (const stdin of ['', 'not json', '[]', '{"prompt":42}']) {
      const result = await runHook(null, { stdin });
      assert.equal(result.code, 0);
      assert.deepEqual(result.decision, { continue: true });
    }
  });

  it('stores only a fingerprint, never prompt text', async () => {
    const secret = 'my-very-secret-prompt-text';
    await runHook(submit(secret));
    const pending = path.join(home, 'pending');
    const files = await readdir(pending);
    assert.equal(files.length, 1);
    const stored = await readFile(path.join(pending, files[0]), 'utf8');
    assert.doesNotMatch(stored, new RegExp(secret));
    assert.match(JSON.parse(stored).fingerprint, /^[a-f0-9]{64}$/);
  });
});
