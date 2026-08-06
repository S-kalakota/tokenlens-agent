import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helperPath = join(
  repositoryRoot,
  'native/bin/darwin-arm64/tokenlens-ax-observer',
);

const child = spawn(helperPath, [], {
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const closePromise = once(child, 'close');
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});

let sawOversizedLine;
const oversizedLine = new Promise((resolvePromise) => {
  sawOversizedLine = resolvePromise;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  if (stderr.includes('protocol-line-too-long\n')) sawOversizedLine();
});

const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
try {
  // Force the reader to reject before the logical line's LF arrives. The
  // diagnose command that follows is still part of that rejected line and
  // must not execute; only the next complete shutdown frame may execute.
  child.stdin.write(' '.repeat(4 * 1024));
  let enforcementTimer;
  try {
    await Promise.race([
      oversizedLine,
      new Promise((_, reject) => {
        enforcementTimer = setTimeout(
          () => reject(new Error('Native frame limit was not enforced.')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(enforcementTimer);
  }
  child.stdin.write('{"version":1,"command":"diagnose"}\n');
  child.stdin.write('{"version":1,"command":"shutdown"}\n');
  child.stdin.end();

  const [code] = await closePromise;
  assert.equal(code, 0);
  assert.match(stderr, /protocol-line-too-long/);
  const messages = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(messages.map(({ type }) => type), ['permission']);
  console.log('Verified native split-frame rejection.');
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill('SIGKILL');
}
