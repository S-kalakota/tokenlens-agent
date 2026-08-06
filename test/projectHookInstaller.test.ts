import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSubmittedPromptHook,
  TOKENLENS_HOOK_COMMAND,
  TOKENLENS_HOOK_CONFIG_RELATIVE_PATH,
  TOKENLENS_HOOK_MARKER,
  TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH,
} from '../src/automaticPrompt/projectHookInstaller';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('ensureSubmittedPromptHook', () => {
  it('installs the hook script and config in the project being tested', async () => {
    const sourceRoot = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const sourceScriptPath = join(sourceRoot, 'tokenlens-hook.cjs');
    const sourceScript = `'use strict';\n// ${TOKENLENS_HOOK_MARKER}\n`;
    await writeFile(sourceScriptPath, sourceScript, 'utf8');

    await ensureSubmittedPromptHook({
      workspaceRoots: [workspaceRoot],
      sourceScriptPath,
    });

    expect(
      await readFile(
        join(workspaceRoot, TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH),
        'utf8',
      ),
    ).toBe(sourceScript);
    const config = JSON.parse(
      await readFile(
        join(workspaceRoot, TOKENLENS_HOOK_CONFIG_RELATIVE_PATH),
        'utf8',
      ),
    ) as {
      hooks: { beforeSubmitPrompt: Array<{ command: string; timeout: number }> };
    };
    expect(config.hooks.beforeSubmitPrompt).toEqual([
      { command: TOKENLENS_HOOK_COMMAND, timeout: 2 },
    ]);
  });

  it('preserves JSONC comments and existing hooks without adding duplicates', async () => {
    const sourceRoot = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const sourceScriptPath = join(sourceRoot, 'tokenlens-hook.cjs');
    await writeFile(
      sourceScriptPath,
      `'use strict';\n// ${TOKENLENS_HOOK_MARKER}\n`,
      'utf8',
    );
    const configPath = join(
      workspaceRoot,
      TOKENLENS_HOOK_CONFIG_RELATIVE_PATH,
    );
    await writeNested(
      configPath,
      `{
  // Keep this project hook.
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "node keep.cjs" }],
    "beforeSubmitPrompt": [{ "command": "node also-keep.cjs" }],
  },
}
`,
    );

    await ensureSubmittedPromptHook({
      workspaceRoots: [workspaceRoot],
      sourceScriptPath,
    });
    await ensureSubmittedPromptHook({
      workspaceRoots: [workspaceRoot],
      sourceScriptPath,
    });

    const updated = await readFile(configPath, 'utf8');
    const config = parse(updated) as {
      hooks: {
        beforeShellExecution: Array<{ command: string }>;
        beforeSubmitPrompt: Array<{ command: string }>;
      };
    };
    expect(updated).toContain('// Keep this project hook.');
    expect(config.hooks.beforeShellExecution).toEqual([
      { command: 'node keep.cjs' },
    ]);
    expect(
      config.hooks.beforeSubmitPrompt.filter(
        ({ command }) => command === TOKENLENS_HOOK_COMMAND,
      ),
    ).toHaveLength(1);
    expect(config.hooks.beforeSubmitPrompt).toContainEqual({
      command: 'node also-keep.cjs',
    });
  });

  it('does not overwrite a conflicting project script', async () => {
    const sourceRoot = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const sourceScriptPath = join(sourceRoot, 'tokenlens-hook.cjs');
    const targetScriptPath = join(
      workspaceRoot,
      TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH,
    );
    await writeFile(
      sourceScriptPath,
      `'use strict';\n// ${TOKENLENS_HOOK_MARKER}\n`,
      'utf8',
    );
    await writeNested(targetScriptPath, '// user-owned file\n');

    await expect(
      ensureSubmittedPromptHook({
        workspaceRoots: [workspaceRoot],
        sourceScriptPath,
      }),
    ).rejects.toThrow('will not overwrite');
    expect(await readFile(targetScriptPath, 'utf8')).toBe(
      '// user-owned file\n',
    );
  });

  it('does not install the script when the existing hook config is invalid', async () => {
    const sourceRoot = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const sourceScriptPath = join(sourceRoot, 'tokenlens-hook.cjs');
    const targetScriptPath = join(
      workspaceRoot,
      TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH,
    );
    await writeFile(
      sourceScriptPath,
      `'use strict';\n// ${TOKENLENS_HOOK_MARKER}\n`,
      'utf8',
    );
    await writeNested(
      join(workspaceRoot, TOKENLENS_HOOK_CONFIG_RELATIVE_PATH),
      '{ not valid JSONC',
    );

    await expect(
      ensureSubmittedPromptHook({
        workspaceRoots: [workspaceRoot],
        sourceScriptPath,
      }),
    ).rejects.toThrow('cannot merge');
    await expect(readFile(targetScriptPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokenlens-hook-install-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeNested(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}
