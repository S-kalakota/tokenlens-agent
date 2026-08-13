import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { cursorCliConfigPath, refreshStatusLine } from '../src/statusline.mjs';

let configHome;
let configPath;

beforeEach(async () => {
  configHome = await mkdtemp(path.join(tmpdir(), 'tokenlens-cursor-config-'));
  process.env.CURSOR_CONFIG_DIR = configHome;
  configPath = path.join(configHome, 'cli-config.json');
});

describe('status-line refresh signal', () => {
  it('signals a refresh only when config references the expected TokenLens script', async () => {
    const script = path.join(configHome, 'runtime', 'scripts', 'statusline.mjs');
    await writeFile(
      configPath,
      JSON.stringify({ statusLine: { type: 'command', command: `node '${script}'` } }),
    );
    assert.equal(await refreshStatusLine(script), true);
    const updated = await readFile(configPath, 'utf8');
    assert.match(updated, /--tokenlens-refresh=\d+/);
    assert.match(updated, /runtime.*statusline\.mjs/);
  });

  it('leaves unrelated custom status lines byte-for-byte unchanged', async () => {
    const original = JSON.stringify({ statusLine: { command: 'node custom-status.mjs' } });
    await writeFile(configPath, original);
    const before = await stat(configPath);
    assert.equal(await refreshStatusLine('/some/tokenlens/statusline.mjs'), false);
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal((await stat(configPath)).mtimeMs, before.mtimeMs);
  });

  it('respects the isolated Cursor config directory', () => {
    assert.equal(cursorCliConfigPath(), path.join(configHome, 'cli-config.json'));
  });
});
