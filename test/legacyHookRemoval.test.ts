import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH,
  LEGACY_HOOK_COMMAND,
  LEGACY_HOOK_CONFIG_RELATIVE_PATH,
  LEGACY_HOOK_MARKER,
  LEGACY_HOOK_REMOVAL_MIGRATION_VERSION,
  LEGACY_HOOK_REMOVAL_STATE_KEY,
  LEGACY_HOOK_SCRIPT_RELATIVE_PATH,
  LegacyHookRemovalError,
  removeLegacyPromptHookArtifacts,
} from '../src/automaticPrompt/legacyHookRemoval';

const temporaryRoots: string[] = [];
const TOKEN = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('removeLegacyPromptHookArtifacts', () => {
  it('removes only owned legacy artifacts and preserves config mode', async () => {
    const root = await temporaryRoot();
    const ownedProperty = `"beforeSubmitPrompt":[{"command":"${LEGACY_HOOK_COMMAND}","timeout":2}]`;
    const config = `{
  // Keep this root comment.
  "version": 1,
  "hooks": {
    // Keep this hooks comment.
    ${ownedProperty}
  },
  "settings": { "keep": true },
}
`;
    const expected = config.replace(ownedProperty, '');
    const configPath = await writeConfig(root, config);
    await chmod(configPath, 0o640);
    await writeOwnedScript(root);
    await writeRegistration(root);

    const result = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    expect(await readFile(configPath, 'utf8')).toBe(expected);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    await expectMissing(join(root, LEGACY_HOOK_SCRIPT_RELATIVE_PATH));
    await expectMissing(join(root, LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH));
    await expectMissing(join(root, '.tokenlens'));
    expect(result).toEqual({
      roots: [
        {
          workspaceRoot: root,
          hookEntriesRemoved: 1,
          hookConfigUpdated: true,
          hookScriptRemoved: true,
          bridgeRegistrationRemoved: true,
        },
      ],
    });
  });

  it('surgically preserves unrelated JSONC bytes, comments, CRLF, tabs, and hooks', async () => {
    const root = await temporaryRoot();
    const ownedEntry = `{"command":"${LEGACY_HOOK_COMMAND}","timeout":2}`;
    const config = [
      '{',
      '\t// Keep every unrelated setting and comment.',
      '\t"settings": { "theme": "keep" },',
      '\t"hooks": {',
      '\t\t"beforeShellExecution": [{"command":"node keep-shell.cjs"}],',
      '\t\t"beforeSubmitPrompt": [',
      '\t\t\t{"command":"node keep-before.cjs"}, // keep inline',
      `\t\t\t${ownedEntry} /* keep separator comment */,`,
      '\t\t\t// keep the comment belonging to the next hook',
      '\t\t\t{"command":"node keep-after.cjs"},',
      '\t\t],',
      '\t\t"afterFileEdit": [{"command":"node keep-edit.cjs"}],',
      '\t},',
      '}',
      '',
    ].join('\r\n');
    const expected = config.replace(
      `${ownedEntry} /* keep separator comment */,`,
      ' /* keep separator comment */',
    );
    const configPath = await writeConfig(root, config);

    await removeLegacyPromptHookArtifacts({ workspaceRoots: [root] });

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toBe(expected);
    expect(updated).toContain('\r\n');
    const parsed = parse(updated) as {
      settings: { theme: string };
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(parsed.settings).toEqual({ theme: 'keep' });
    expect(parsed.hooks.beforeSubmitPrompt).toEqual([
      { command: 'node keep-before.cjs' },
      { command: 'node keep-after.cjs' },
    ]);
    expect(parsed.hooks.beforeShellExecution).toEqual([
      { command: 'node keep-shell.cjs' },
    ]);
    expect(parsed.hooks.afterFileEdit).toEqual([
      { command: 'node keep-edit.cjs' },
    ]);
  });

  it('removes the property after all exact duplicate entries are removed', async () => {
    const root = await temporaryRoot();
    const ownedProperty = `"beforeSubmitPrompt":[{"command":"${LEGACY_HOOK_COMMAND}"},{"command":"${LEGACY_HOOK_COMMAND}","timeout":99}],`;
    const config = `{
  "hooks": {
    // This comment remains in place.
    ${ownedProperty}
    "afterSubmitPrompt": [{"command":"node keep.cjs"}],
  },
}
`;
    const expected = config.replace(ownedProperty, '');
    const configPath = await writeConfig(root, config);

    const result = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    expect(await readFile(configPath, 'utf8')).toBe(expected);
    expect(result.roots[0]).toMatchObject({
      hookEntriesRemoved: 2,
      hookConfigUpdated: true,
    });
  });

  it('removes non-adjacent exact entries while retaining surviving array order', async () => {
    const root = await temporaryRoot();
    const config = `{
  "hooks": {
    "beforeSubmitPrompt": [
      {"command":"${LEGACY_HOOK_COMMAND}"},
      {"command":"node keep-first.cjs"},
      {"command":"${LEGACY_HOOK_COMMAND}","timeout":7},
      {"command":"node keep-last.cjs"}
    ]
  }
}
`;
    const configPath = await writeConfig(root, config);

    const result = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    const updated = await readFile(configPath, 'utf8');
    expect(
      (parse(updated) as { hooks: { beforeSubmitPrompt: unknown[] } }).hooks
        .beforeSubmitPrompt,
    ).toEqual([
      { command: 'node keep-first.cjs' },
      { command: 'node keep-last.cjs' },
    ]);
    expect(result.roots[0]?.hookEntriesRemoved).toBe(2);
  });

  it('preserves comments nested inside an owned entry while removing its syntax', async () => {
    const root = await temporaryRoot();
    const config = `{
  "hooks": {
    "beforeSubmitPrompt": [
      {
        // Preserve even a comment inside the retired entry.
        "command": "${LEGACY_HOOK_COMMAND}"
      },
      { "command": "node keep.cjs" }
    ]
  }
}
`;
    const configPath = await writeConfig(root, config);

    await removeLegacyPromptHookArtifacts({ workspaceRoots: [root] });

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toContain(
      '// Preserve even a comment inside the retired entry.',
    );
    expect(updated).not.toContain(LEGACY_HOOK_COMMAND);
    expect((parse(updated) as { hooks: { beforeSubmitPrompt: unknown[] } }).hooks)
      .toEqual({ beforeSubmitPrompt: [{ command: 'node keep.cjs' }] });
  });

  it('preserves nested comments when removing the now-empty property', async () => {
    const root = await temporaryRoot();
    const config = `{
  "hooks": {
    "beforeSubmitPrompt": [
      {
        // Preserve this nested migration note.
        "command": "${LEGACY_HOOK_COMMAND}"
      }
    ]
  }
}
`;
    const configPath = await writeConfig(root, config);

    await removeLegacyPromptHookArtifacts({ workspaceRoots: [root] });

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toContain('// Preserve this nested migration note.');
    expect(updated).not.toContain('beforeSubmitPrompt');
    expect((parse(updated) as { hooks: object }).hooks).toEqual({});
  });

  it('leaves lookalike commands byte-for-byte unchanged', async () => {
    const root = await temporaryRoot();
    const config = `{
  "hooks": {
    "beforeSubmitPrompt": [
      {"command":"node  .cursor/hooks/tokenlens-before-submit.cjs"},
      {"command":"${LEGACY_HOOK_COMMAND} --unsafe-argument"},
      {"command":"/usr/bin/node .cursor/hooks/tokenlens-before-submit.cjs"},
      {"command":"node .cursor/hooks/other.cjs"}
    ],
    "afterSubmitPrompt": []
  }
}
`;
    const configPath = await writeConfig(root, config);

    const first = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });
    const second = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect(first.roots[0]).toMatchObject({
      hookEntriesRemoved: 0,
      hookConfigUpdated: false,
    });
    expect(second).toEqual(first);
  });

  it('does not remove an already-empty beforeSubmitPrompt property', async () => {
    const root = await temporaryRoot();
    const config = `{
  // An empty user-owned hook list remains present.
  "hooks": { "beforeSubmitPrompt": [] },
  "settings": { "keep": true },
}
`;
    const configPath = await writeConfig(root, config);

    const result = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect(result.roots[0]).toMatchObject({
      hookEntriesRemoved: 0,
      hookConfigUpdated: false,
    });
  });

  it('is idempotent after a successful full cleanup', async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, exactOnlyConfig());
    await writeOwnedScript(root);
    await writeRegistration(root);

    const first = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root, root],
    });
    const afterFirst = await readFile(configPath, 'utf8');
    const second = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    expect(first.roots).toHaveLength(1);
    expect(second.roots).toEqual([
      {
        workspaceRoot: root,
        hookEntriesRemoved: 0,
        hookConfigUpdated: false,
        hookScriptRemoved: false,
        bridgeRegistrationRemoved: false,
      },
    ]);
    expect(await readFile(configPath, 'utf8')).toBe(afterFirst);
  });

  it('preflights every root before changing any root', async () => {
    const safeRoot = await temporaryRoot();
    const ambiguousRoot = await temporaryRoot();
    const safeConfigPath = await writeConfig(safeRoot, exactOnlyConfig());
    const safeConfig = await readFile(safeConfigPath, 'utf8');
    await writeOwnedScript(safeRoot);
    await writeRegistration(safeRoot);
    await writeConfig(ambiguousRoot, '{ invalid JSONC');

    await expect(
      removeLegacyPromptHookArtifacts({
        workspaceRoots: [safeRoot, ambiguousRoot],
      }),
    ).rejects.toBeInstanceOf(LegacyHookRemovalError);

    expect(await readFile(safeConfigPath, 'utf8')).toBe(safeConfig);
    expect(await readFile(join(safeRoot, LEGACY_HOOK_SCRIPT_RELATIVE_PATH), 'utf8'))
      .toContain(LEGACY_HOOK_MARKER);
    expect(
      JSON.parse(
        await readFile(
          join(safeRoot, LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH),
          'utf8',
        ),
      ),
    ).toMatchObject({ version: 1 });
  });

  it.each([
    ['non-object root', '[]'],
    ['non-object hooks', '{"hooks":[]}'],
    [
      'non-array beforeSubmitPrompt',
      '{"hooks":{"beforeSubmitPrompt":{}}}',
    ],
    [
      'duplicate hooks properties',
      '{"hooks":{},"hooks":{"beforeSubmitPrompt":[]}}',
    ],
    [
      'duplicate beforeSubmitPrompt properties',
      '{"hooks":{"beforeSubmitPrompt":[],"beforeSubmitPrompt":[]}}',
    ],
    [
      'duplicate command properties',
      `{"hooks":{"beforeSubmitPrompt":[{"command":"${LEGACY_HOOK_COMMAND}","command":"node keep.cjs"}]}}`,
    ],
  ])('fails closed for an ambiguous config with %s', async (_label, config) => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, config);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toBeInstanceOf(LegacyHookRemovalError);
    expect(await readFile(configPath, 'utf8')).toBe(config);
  });

  it('does not modify config or delete a user-owned script', async () => {
    const root = await temporaryRoot();
    const config = exactOnlyConfig();
    const configPath = await writeConfig(root, config);
    const scriptPath = join(root, LEGACY_HOOK_SCRIPT_RELATIVE_PATH);
    await writeNested(scriptPath, '// User-owned script.\n');

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('does not contain the TokenLens ownership marker');

    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect(await readFile(scriptPath, 'utf8')).toBe('// User-owned script.\n');
  });

  it('refuses a symbolic hook script without following or deleting it', async () => {
    const root = await temporaryRoot();
    const config = exactOnlyConfig();
    const configPath = await writeConfig(root, config);
    const target = join(root, 'user-script.cjs');
    const scriptPath = join(root, LEGACY_HOOK_SCRIPT_RELATIVE_PATH);
    await writeFile(target, `// ${LEGACY_HOOK_MARKER}\n`, 'utf8');
    await mkdir(dirname(scriptPath), { recursive: true });
    await symlink(target, scriptPath);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('symbolic');

    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect(await readFile(target, 'utf8')).toContain(LEGACY_HOOK_MARKER);
    expect(await readFile(scriptPath, 'utf8')).toContain(LEGACY_HOOK_MARKER);
  });

  it('refuses a symbolic hook configuration without following it', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'user-hooks.json');
    const configPath = join(root, LEGACY_HOOK_CONFIG_RELATIVE_PATH);
    const config = exactOnlyConfig();
    await writeFile(target, config, 'utf8');
    await mkdir(dirname(configPath), { recursive: true });
    await symlink(target, configPath);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('symbolic');

    expect(await readFile(target, 'utf8')).toBe(config);
    expect(await readFile(configPath, 'utf8')).toBe(config);
  });

  it('refuses symbolic artifact parent directories before editing config', async () => {
    const root = await temporaryRoot();
    const config = exactOnlyConfig();
    const configPath = await writeConfig(root, config);
    const targetDirectory = join(root, 'user-tokenlens-directory');
    await mkdir(targetDirectory);
    await symlink(targetDirectory, join(root, '.tokenlens'));

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('symbolic');
    expect(await readFile(configPath, 'utf8')).toBe(config);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    [
      'wrong version',
      JSON.stringify({ version: 2, port: 1234, token: TOKEN }),
    ],
    [
      'out-of-range port',
      JSON.stringify({ version: 1, port: 65_536, token: TOKEN }),
    ],
    [
      'invalid token',
      JSON.stringify({ version: 1, port: 1234, token: 'not-a-token' }),
    ],
    [
      'additional field',
      JSON.stringify({
        version: 1,
        port: 1234,
        token: TOKEN,
        owner: 'someone-else',
      }),
    ],
  ])('preserves an ambiguous bridge registration with %s', async (_label, value) => {
    const root = await temporaryRoot();
    const config = exactOnlyConfig();
    const configPath = await writeConfig(root, config);
    const registrationPath = join(
      root,
      LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH,
    );
    await writeNested(registrationPath, value);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('does not match the TokenLens bridge registration schema');

    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect(await readFile(registrationPath, 'utf8')).toBe(value);
  });

  it('removes a valid registration but preserves unrelated files in its directory', async () => {
    const root = await temporaryRoot();
    const registrationPath = await writeRegistration(root);
    const unrelatedPath = join(root, '.tokenlens', 'keep.txt');
    await writeFile(unrelatedPath, 'keep me\n', 'utf8');

    const result = await removeLegacyPromptHookArtifacts({
      workspaceRoots: [root],
    });

    await expectMissing(registrationPath);
    expect(await readFile(unrelatedPath, 'utf8')).toBe('keep me\n');
    expect(result.roots[0]).toMatchObject({
      bridgeRegistrationRemoved: true,
      hookConfigUpdated: false,
      hookScriptRemoved: false,
    });
  });

  it('refuses a symbolic bridge registration without following it', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'user-registration.json');
    const registrationPath = join(
      root,
      LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH,
    );
    const registration = JSON.stringify({
      version: 1,
      port: 45_678,
      token: TOKEN,
    });
    await writeFile(target, registration, 'utf8');
    await mkdir(dirname(registrationPath), { recursive: true });
    await symlink(target, registrationPath);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('symbolic');

    expect(await readFile(target, 'utf8')).toBe(registration);
    expect(await readFile(registrationPath, 'utf8')).toBe(registration);
  });

  it('fails closed on invalid UTF-8 without rewriting the hook config', async () => {
    const root = await temporaryRoot();
    const configPath = join(root, LEGACY_HOOK_CONFIG_RELATIVE_PATH);
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, invalidUtf8);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [root] }),
    ).rejects.toThrow('not valid UTF-8');

    expect(await readFile(configPath)).toEqual(invalidUtf8);
  });

  it('refuses a symbolic workspace root', async () => {
    const target = await temporaryRoot();
    const parent = await temporaryRoot();
    const linkedRoot = join(parent, 'linked-workspace');
    await symlink(target, linkedRoot);

    await expect(
      removeLegacyPromptHookArtifacts({ workspaceRoots: [linkedRoot] }),
    ).rejects.toThrow('workspace root is missing, symbolic, or not a directory');
  });

  it('preserves a UTF-8 BOM during a surgical update', async () => {
    const root = await temporaryRoot();
    const config = `\uFEFF${exactOnlyConfig()}`;
    const configPath = await writeConfig(root, config);

    await removeLegacyPromptHookArtifacts({ workspaceRoots: [root] });

    const updated = await readFile(configPath, 'utf8');
    expect(updated.startsWith('\uFEFF')).toBe(true);
    expect(updated).not.toContain(LEGACY_HOOK_COMMAND);
  });

  it('exports stable migration identifiers for extension workspace state', () => {
    expect(LEGACY_HOOK_REMOVAL_MIGRATION_VERSION).toBe(1);
    expect(LEGACY_HOOK_REMOVAL_STATE_KEY).toBe(
      'tokenlens.legacyHookRemoval.v1',
    );
  });
});

function exactOnlyConfig(): string {
  return `{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "${LEGACY_HOOK_COMMAND}", "timeout": 2 }
    ]
  }
}
`;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokenlens-legacy-removal-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeConfig(root: string, contents: string): Promise<string> {
  const path = join(root, LEGACY_HOOK_CONFIG_RELATIVE_PATH);
  await writeNested(path, contents);
  return path;
}

async function writeOwnedScript(root: string): Promise<string> {
  const path = join(root, LEGACY_HOOK_SCRIPT_RELATIVE_PATH);
  await writeNested(path, `'use strict';\n// ${LEGACY_HOOK_MARKER}\n`);
  return path;
}

async function writeRegistration(root: string): Promise<string> {
  const path = join(root, LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH);
  await writeNested(
    path,
    `${JSON.stringify({ version: 1, port: 45_678, token: TOKEN })}\n`,
  );
  return path;
}

async function writeNested(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}
