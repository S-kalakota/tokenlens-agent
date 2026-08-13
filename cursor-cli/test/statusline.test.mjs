import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { formatPendingLine } from '../scripts/statusline.mjs';
import { clearPending, writePending } from '../src/state.mjs';

const STATUSLINE = fileURLToPath(new URL('../scripts/statusline.mjs', import.meta.url));
let home;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'tokenlens-cursor-statusline-'));
  process.env.TOKENLENS_HOME = home;
});

function runStatusLine(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATUSLINE], {
      env: { ...process.env, TOKENLENS_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('persistent estimate status line', () => {
  it('shows a pending cost and confirmation choices', async () => {
    await writePending('conversation-1', { fingerprint: 'a'.repeat(64), costUsd: 0.0123 });
    const result = await runStatusLine({ session_id: 'conversation-1' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /TokenLens \$0\.012 pending/);
    assert.match(result.stdout, /↑ if needed \+ Enter: send/);
    assert.match(result.stdout, /changed: recalculate/);
  });

  it('clears after confirmation state is removed', async () => {
    await writePending('conversation-1', { fingerprint: 'a'.repeat(64), costUsd: 0.01 });
    await clearPending('conversation-1');
    assert.equal((await runStatusLine({ session_id: 'conversation-1' })).stdout, '');
  });

  it('does not render invalid state values', () => {
    assert.equal(formatPendingLine({ costUsd: '\u001b[31mbad' }), '');
    assert.equal(formatPendingLine({ costUsd: -1 }), '');
  });
});
