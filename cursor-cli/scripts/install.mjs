#!/usr/bin/env node
/** Install TokenLens as a user-level Cursor hook without plugin feature flags. */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK_EVENT = 'beforeSubmitPrompt';

function defaultCursorHome() {
  return path.join(homedir(), '.cursor');
}

function shellQuote(value) {
  if (process.platform === 'win32') return `"${String(value).replaceAll('"', '""')}"`;
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runtimePaths(cursorHome) {
  const runtime = path.join(cursorHome, 'tokenlens', 'runtime');
  const gate = path.join(runtime, 'scripts', 'gate.mjs');
  return { runtime, gate };
}

async function readHooks(target) {
  try {
    const value = JSON.parse(await readFile(target, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('the root value is not an object');
    }
    if (value.hooks !== undefined && (typeof value.hooks !== 'object' || value.hooks === null)) {
      throw new Error('"hooks" is not an object');
    }
    if (value.hooks?.[HOOK_EVENT] !== undefined && !Array.isArray(value.hooks[HOOK_EVENT])) {
      throw new Error(`"hooks.${HOOK_EVENT}" is not an array`);
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, hooks: {} };
    throw new Error(`Cannot safely update ${target}: ${error.message}`, { cause: error });
  }
}

function isTokenLensEntry(entry, gate) {
  if (entry?.type !== 'command' || typeof entry.command !== 'string') return false;
  const normalizedCommand = entry.command.replaceAll('\\', '/');
  const normalizedGate = gate.replaceAll('\\', '/');
  return normalizedCommand.includes(normalizedGate);
}

async function writeJsonAtomically(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function installTokenLens({ cursorHome = defaultCursorHome() } = {}) {
  const hooksPath = path.join(cursorHome, 'hooks.json');
  const { runtime, gate } = runtimePaths(cursorHome);
  const hooksFile = await readHooks(hooksPath);
  const existing = hooksFile.hooks?.[HOOK_EVENT] ?? [];
  const retained = existing.filter((entry) => !isTokenLensEntry(entry, gate));

  await mkdir(runtime, { recursive: true });
  await cp(path.join(PACKAGE_ROOT, 'src'), path.join(runtime, 'src'), {
    recursive: true,
    force: true,
  });
  await mkdir(path.join(runtime, 'scripts'), { recursive: true });
  await cp(path.join(PACKAGE_ROOT, 'scripts', 'gate.mjs'), gate, { force: true });
  await cp(
    path.join(PACKAGE_ROOT, 'scripts', 'control.mjs'),
    path.join(runtime, 'scripts', 'control.mjs'),
    { force: true },
  );

  const next = {
    ...hooksFile,
    version: 1,
    hooks: {
      ...(hooksFile.hooks ?? {}),
      [HOOK_EVENT]: [
        ...retained,
        {
          type: 'command',
          command: `node ${shellQuote(gate)}`,
          timeout: 10,
          failClosed: false,
        },
      ],
    },
  };
  await writeJsonAtomically(hooksPath, next);
  return { hooksPath, runtime, replaced: retained.length !== existing.length };
}

export async function uninstallTokenLens({ cursorHome = defaultCursorHome() } = {}) {
  const hooksPath = path.join(cursorHome, 'hooks.json');
  const { runtime, gate } = runtimePaths(cursorHome);
  const hooksFile = await readHooks(hooksPath);
  const existing = hooksFile.hooks?.[HOOK_EVENT] ?? [];
  const retained = existing.filter((entry) => !isTokenLensEntry(entry, gate));

  if (retained.length !== existing.length) {
    const nextHooks = { ...(hooksFile.hooks ?? {}) };
    if (retained.length === 0) delete nextHooks[HOOK_EVENT];
    else nextHooks[HOOK_EVENT] = retained;
    await writeJsonAtomically(hooksPath, { ...hooksFile, hooks: nextHooks });
  }
  await rm(runtime, { recursive: true, force: true });
  return { hooksPath, runtime, removed: retained.length !== existing.length };
}

async function main() {
  if (process.argv.includes('--uninstall')) {
    const result = await uninstallTokenLens();
    process.stdout.write(
      result.removed
        ? `Removed TokenLens from ${result.hooksPath}\n`
        : `TokenLens was not registered in ${result.hooksPath}\n`,
    );
    return;
  }

  const result = await installTokenLens();
  process.stdout.write(
    `${result.replaced ? 'Updated' : 'Installed'} TokenLens in ${result.hooksPath}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
