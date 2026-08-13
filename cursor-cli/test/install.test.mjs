import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { installTokenLens, uninstallTokenLens } from '../scripts/install.mjs';

let cursorHome;

beforeEach(async () => {
  cursorHome = await mkdtemp(path.join(tmpdir(), 'tokenlens-cursor-install-'));
});

const readHooks = async () => JSON.parse(await readFile(path.join(cursorHome, 'hooks.json'), 'utf8'));

describe('user hook installer', () => {
  it('installs a stable runtime and preserves existing hooks', async () => {
    const existing = {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ type: 'command', command: 'node existing.mjs' }],
        afterAgentResponse: [{ type: 'command', command: 'node after.mjs' }],
      },
    };
    await writeFile(path.join(cursorHome, 'hooks.json'), JSON.stringify(existing));

    const result = await installTokenLens({ cursorHome });
    const installed = await readHooks();
    assert.equal(installed.hooks.beforeSubmitPrompt.length, 2);
    assert.deepEqual(installed.hooks.beforeSubmitPrompt[0], existing.hooks.beforeSubmitPrompt[0]);
    assert.deepEqual(installed.hooks.afterAgentResponse, existing.hooks.afterAgentResponse);
    assert.match(installed.hooks.beforeSubmitPrompt[1].command, /tokenlens.*runtime.*gate\.mjs/);
    await access(path.join(result.runtime, 'scripts', 'gate.mjs'));
    await access(path.join(result.runtime, 'src', 'gate.mjs'));
  });

  it('is idempotent and uninstalls only TokenLens', async () => {
    await installTokenLens({ cursorHome });
    const second = await installTokenLens({ cursorHome });
    assert.equal(second.replaced, true);
    assert.equal((await readHooks()).hooks.beforeSubmitPrompt.length, 1);

    const removed = await uninstallTokenLens({ cursorHome });
    assert.equal(removed.removed, true);
    assert.equal((await readHooks()).hooks.beforeSubmitPrompt, undefined);
    await assert.rejects(access(removed.runtime));
  });

  it('refuses to overwrite malformed hook configuration', async () => {
    const target = path.join(cursorHome, 'hooks.json');
    await writeFile(target, '{not-json');
    await assert.rejects(installTokenLens({ cursorHome }), /Cannot safely update/);
    assert.equal(await readFile(target, 'utf8'), '{not-json');
  });
});
