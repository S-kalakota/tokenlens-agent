import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  createScanner,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';

export const LEGACY_HOOK_REMOVAL_MIGRATION_VERSION = 1;
export const LEGACY_HOOK_REMOVAL_STATE_KEY =
  'tokenlens.legacyHookRemoval.v1';
export const LEGACY_ESTIMATE_GATE_STATE_KEY = 'enterToEstimateGateV1';

export const LEGACY_HOOK_COMMAND =
  'node .cursor/hooks/tokenlens-before-submit.cjs';
export const LEGACY_HOOK_MARKER =
  'TokenLens managed beforeSubmitPrompt hook';
export const LEGACY_HOOK_CONFIG_RELATIVE_PATH = join(
  '.cursor',
  'hooks.json',
);
export const LEGACY_HOOK_SCRIPT_RELATIVE_PATH = join(
  '.cursor',
  'hooks',
  'tokenlens-before-submit.cjs',
);
export const LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH = join(
  '.tokenlens',
  'bridge.json',
);

const MAX_HOOK_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_HOOK_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_REGISTRATION_BYTES = 4 * 1024;
const UTF8_BOM = '\uFEFF';

export interface LegacyHookRemovalOptions {
  workspaceRoots: readonly string[];
}

/** Stored by the extension in workspaceState after successful root cleanup. */
export interface LegacyHookRemovalMigrationState {
  version: typeof LEGACY_HOOK_REMOVAL_MIGRATION_VERSION;
  completedWorkspaceRoots: string[];
}

export interface LegacyHookRemovalRootResult {
  workspaceRoot: string;
  hookEntriesRemoved: number;
  hookConfigUpdated: boolean;
  hookScriptRemoved: boolean;
  bridgeRegistrationRemoved: boolean;
}

export interface LegacyHookRemovalResult {
  roots: LegacyHookRemovalRootResult[];
}

/**
 * Removes artifacts installed by TokenLens 0.3.1 and earlier.
 *
 * Every workspace is preflighted before any workspace is changed. The caller
 * should invoke this only after the legacy SubmittedPromptBridge has stopped,
 * and should record the exported migration version only after this resolves.
 */
export async function removeLegacyPromptHookArtifacts(
  options: LegacyHookRemovalOptions,
): Promise<LegacyHookRemovalResult> {
  const workspaceRoots = [...new Set(options.workspaceRoots.map((root) => resolve(root)))].sort();
  const plans = await Promise.all(workspaceRoots.map(preflightWorkspace));

  // Recheck the complete preflight set before the first mutation. Individual
  // files are checked again immediately before replacement or deletion.
  await Promise.all(plans.map(verifyWorkspacePlan));

  for (const plan of plans) {
    if (plan.updatedConfig !== undefined) {
      await replaceFileAtomically(
        plan.configPath,
        plan.configSnapshot,
        plan.updatedConfig,
      );
    }
  }

  for (const plan of plans) {
    if (plan.scriptSnapshot !== undefined) {
      await verifyFileSnapshot(plan.scriptPath, plan.scriptSnapshot);
      await unlink(plan.scriptPath);
    }
  }

  for (const plan of plans) {
    if (plan.registrationSnapshot !== undefined) {
      await verifyFileSnapshot(
        plan.registrationPath,
        plan.registrationSnapshot,
      );
      await unlink(plan.registrationPath);
      try {
        await rmdir(dirname(plan.registrationPath));
      } catch {
        // Removing the parent is optional. Preserve it whenever it is not empty
        // or cannot be removed without affecting unrelated content.
      }
    }
  }

  return {
    roots: plans.map((plan) => ({
      workspaceRoot: plan.workspaceRoot,
      hookEntriesRemoved: plan.hookEntriesRemoved,
      hookConfigUpdated: plan.updatedConfig !== undefined,
      hookScriptRemoved: plan.scriptSnapshot !== undefined,
      bridgeRegistrationRemoved: plan.registrationSnapshot !== undefined,
    })),
  };
}

export class LegacyHookRemovalError extends Error {
  public override readonly name = 'LegacyHookRemovalError';
}

interface FileSnapshot {
  contents: Buffer;
  identity: FileIdentity;
}

interface FileIdentity {
  device: number;
  inode: number;
  mode: number;
  modifiedAt: number;
  size: number;
}

interface WorkspacePlan {
  workspaceRoot: string;
  configPath: string;
  configSnapshot: FileSnapshot | undefined;
  updatedConfig: Buffer | undefined;
  hookEntriesRemoved: number;
  scriptPath: string;
  scriptSnapshot: FileSnapshot | undefined;
  registrationPath: string;
  registrationSnapshot: FileSnapshot | undefined;
}

interface JsoncRemoval {
  contents: string;
  removedCount: number;
}

interface TextDeletion {
  offset: number;
  length: number;
}

async function preflightWorkspace(workspaceRoot: string): Promise<WorkspacePlan> {
  await assertSafeDirectoryLayout(workspaceRoot);

  const configPath = join(workspaceRoot, LEGACY_HOOK_CONFIG_RELATIVE_PATH);
  const scriptPath = join(workspaceRoot, LEGACY_HOOK_SCRIPT_RELATIVE_PATH);
  const registrationPath = join(
    workspaceRoot,
    LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH,
  );

  const configSnapshot = await snapshotOptionalRegularFile(
    configPath,
    MAX_HOOK_CONFIG_BYTES,
    'Cursor hook configuration',
  );
  let updatedConfig: Buffer | undefined;
  let hookEntriesRemoved = 0;
  if (configSnapshot !== undefined) {
    const raw = decodeUtf8(configSnapshot.contents, configPath);
    const removal = removeHookEntriesFromJsonc(raw, configPath);
    hookEntriesRemoved = removal.removedCount;
    if (removal.contents !== raw) {
      updatedConfig = Buffer.from(removal.contents, 'utf8');
    }
  }

  const scriptSnapshot = await snapshotOptionalRegularFile(
    scriptPath,
    MAX_HOOK_SCRIPT_BYTES,
    'legacy hook script',
  );
  if (scriptSnapshot !== undefined) {
    const script = decodeUtf8(scriptSnapshot.contents, scriptPath);
    if (!script.includes(LEGACY_HOOK_MARKER)) {
      throw ambiguous(
        scriptPath,
        'the existing script does not contain the TokenLens ownership marker',
      );
    }
  }

  const registrationSnapshot = await snapshotOptionalRegularFile(
    registrationPath,
    MAX_BRIDGE_REGISTRATION_BYTES,
    'legacy bridge registration',
  );
  if (
    registrationSnapshot !== undefined &&
    !isOwnedBridgeRegistration(registrationSnapshot.contents)
  ) {
    throw ambiguous(
      registrationPath,
      'the existing file does not match the TokenLens bridge registration schema',
    );
  }

  return {
    workspaceRoot,
    configPath,
    configSnapshot,
    updatedConfig,
    hookEntriesRemoved,
    scriptPath,
    scriptSnapshot,
    registrationPath,
    registrationSnapshot,
  };
}

async function verifyWorkspacePlan(plan: WorkspacePlan): Promise<void> {
  await assertSafeDirectoryLayout(plan.workspaceRoot);
  await verifyOptionalSnapshot(plan.configPath, plan.configSnapshot);
  await verifyOptionalSnapshot(plan.scriptPath, plan.scriptSnapshot);
  await verifyOptionalSnapshot(
    plan.registrationPath,
    plan.registrationSnapshot,
  );
}

async function assertSafeDirectoryLayout(workspaceRoot: string): Promise<void> {
  const root = await lstatOptional(workspaceRoot);
  if (root === undefined || !root.isDirectory() || root.isSymbolicLink()) {
    throw ambiguous(
      workspaceRoot,
      'the workspace root is missing, symbolic, or not a directory',
    );
  }

  await assertDirectoryOrMissing(join(workspaceRoot, '.cursor'));
  await assertDirectoryOrMissing(join(workspaceRoot, '.cursor', 'hooks'));
  await assertDirectoryOrMissing(join(workspaceRoot, '.tokenlens'));
}

async function assertDirectoryOrMissing(path: string): Promise<void> {
  const stats = await lstatOptional(path);
  if (stats !== undefined && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw ambiguous(path, 'the path is symbolic or is not a directory');
  }
}

async function snapshotOptionalRegularFile(
  path: string,
  maximumBytes: number,
  description: string,
): Promise<FileSnapshot | undefined> {
  const before = await lstatOptional(path);
  if (before === undefined) {
    return undefined;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw ambiguous(path, `the ${description} is symbolic or is not a regular file`);
  }
  if (before.size > maximumBytes) {
    throw ambiguous(path, `the ${description} is larger than the safe migration limit`);
  }

  const contents = await readFile(path);
  const after = await lstatOptional(path);
  if (
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameIdentity(identity(before), identity(after)) ||
    contents.length !== after.size
  ) {
    throw ambiguous(path, `the ${description} changed while it was inspected`);
  }

  return { contents, identity: identity(after) };
}

async function verifyOptionalSnapshot(
  path: string,
  expected: FileSnapshot | undefined,
): Promise<void> {
  if (expected === undefined) {
    if ((await lstatOptional(path)) !== undefined) {
      throw ambiguous(path, 'the path appeared after migration preflight');
    }
    return;
  }
  await verifyFileSnapshot(path, expected);
}

async function verifyFileSnapshot(
  path: string,
  expected: FileSnapshot,
): Promise<void> {
  const actual = await snapshotOptionalRegularFile(
    path,
    Math.max(expected.contents.length, 1),
    'migration target',
  );
  if (
    actual === undefined ||
    !sameIdentity(actual.identity, expected.identity) ||
    !actual.contents.equals(expected.contents)
  ) {
    throw ambiguous(path, 'the file changed after migration preflight');
  }
}

async function replaceFileAtomically(
  path: string,
  expected: FileSnapshot | undefined,
  contents: Buffer,
): Promise<void> {
  if (expected === undefined) {
    throw ambiguous(path, 'TokenLens will not create a hook configuration during cleanup');
  }
  await verifyFileSnapshot(path, expected);

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tokenlens-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, {
      flag: 'wx',
      mode: expected.identity.mode & 0o7777,
    });
    await chmod(temporaryPath, expected.identity.mode & 0o7777);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function removeHookEntriesFromJsonc(
  source: string,
  configPath: string,
): JsoncRemoval {
  const hasBom = source.startsWith(UTF8_BOM);
  const jsonc = hasBom ? source.slice(UTF8_BOM.length) : source;
  const errors: ParseError[] = [];
  const root = parseTree(jsonc, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || root === undefined) {
    const first = errors[0];
    const reason =
      first === undefined
        ? 'the JSONC document is empty'
        : `${printParseErrorCode(first.error)} at offset ${first.offset}`;
    throw ambiguous(configPath, `the Cursor hook configuration is invalid (${reason})`);
  }
  if (root.type !== 'object') {
    throw ambiguous(configPath, 'the Cursor hook configuration root is not an object');
  }

  const hooksProperty = singleProperty(root, 'hooks', configPath);
  if (hooksProperty === undefined) {
    return { contents: source, removedCount: 0 };
  }
  const hooks = propertyValue(hooksProperty, configPath);
  if (hooks.type !== 'object') {
    throw ambiguous(configPath, 'the "hooks" property is not an object');
  }

  const beforeSubmitProperty = singleProperty(
    hooks,
    'beforeSubmitPrompt',
    configPath,
  );
  if (beforeSubmitProperty === undefined) {
    return { contents: source, removedCount: 0 };
  }
  const beforeSubmit = propertyValue(beforeSubmitProperty, configPath);
  if (beforeSubmit.type !== 'array') {
    throw ambiguous(configPath, 'the "beforeSubmitPrompt" property is not an array');
  }

  const entries = beforeSubmit.children ?? [];
  const matching = entries.filter((entry) =>
    isExactTokenLensHookEntry(entry, configPath),
  );
  if (matching.length === 0) {
    return { contents: source, removedCount: 0 };
  }

  const updated =
    matching.length === entries.length
      ? deleteNodesSurgically(jsonc, hooks, [beforeSubmitProperty])
      : deleteNodesSurgically(jsonc, beforeSubmit, matching);
  validateUpdatedJsonc(updated, configPath);
  return {
    contents: hasBom ? `${UTF8_BOM}${updated}` : updated,
    removedCount: matching.length,
  };
}

function isExactTokenLensHookEntry(
  entry: JsonNode,
  configPath: string,
): boolean {
  if (entry.type !== 'object') {
    return false;
  }
  const command = singleProperty(entry, 'command', configPath);
  if (command === undefined) {
    return false;
  }
  const value = propertyValue(command, configPath);
  return value.type === 'string' && value.value === LEGACY_HOOK_COMMAND;
}

function singleProperty(
  object: JsonNode,
  name: string,
  configPath: string,
): JsonNode | undefined {
  const matches = (object.children ?? []).filter(
    (child) =>
      child.type === 'property' &&
      child.children?.[0]?.type === 'string' &&
      child.children[0].value === name,
  );
  if (matches.length > 1) {
    throw ambiguous(configPath, `the JSONC document has duplicate "${name}" properties`);
  }
  return matches[0];
}

function propertyValue(property: JsonNode, configPath: string): JsonNode {
  const value = property.children?.[1];
  if (value === undefined) {
    throw ambiguous(configPath, 'the JSONC document contains an incomplete property');
  }
  return value;
}

function deleteNodesSurgically(
  source: string,
  container: JsonNode,
  targets: readonly JsonNode[],
): string {
  const children = container.children ?? [];
  const deletions = new Map<string, TextDeletion>();

  for (const target of targets) {
    const index = children.indexOf(target);
    if (index < 0) {
      throw new LegacyHookRemovalError(
        'TokenLens could not construct a safe legacy-hook edit.',
      );
    }
    addSyntaxDeletionsPreservingTrivia(source, target, deletions);

    const nextBoundary =
      children[index + 1]?.offset ?? container.offset + container.length - 1;
    const followingComma = commaBetween(
      source,
      target.offset + target.length,
      nextBoundary,
    );
    if (followingComma !== undefined) {
      addDeletion(deletions, { offset: followingComma, length: 1 });
      continue;
    }

    const previous = children[index - 1];
    if (previous !== undefined) {
      const precedingComma = commaBetween(
        source,
        previous.offset + previous.length,
        target.offset,
      );
      if (precedingComma === undefined) {
        throw new LegacyHookRemovalError(
          'TokenLens could not locate a safe legacy-hook separator.',
        );
      }
      addDeletion(deletions, { offset: precedingComma, length: 1 });
    }
  }

  let updated = source;
  const ordered = [...deletions.values()].sort(
    (left, right) => right.offset - left.offset,
  );
  for (const deletion of ordered) {
    updated =
      updated.slice(0, deletion.offset) +
      updated.slice(deletion.offset + deletion.length);
  }
  return updated;
}

function addSyntaxDeletionsPreservingTrivia(
  source: string,
  node: JsonNode,
  deletions: Map<string, TextDeletion>,
): void {
  const endOffset = node.offset + node.length;
  const scanner = createScanner(source, false);
  scanner.setPosition(node.offset);

  while (true) {
    const token = scanner.scan();
    const offset = scanner.getTokenOffset();
    if (token === SyntaxKind.EOF || offset >= endOffset) {
      return;
    }
    if (
      token !== SyntaxKind.Trivia &&
      token !== SyntaxKind.LineBreakTrivia &&
      token !== SyntaxKind.LineCommentTrivia &&
      token !== SyntaxKind.BlockCommentTrivia
    ) {
      addDeletion(deletions, {
        offset,
        length: Math.min(scanner.getTokenLength(), endOffset - offset),
      });
    }
  }
}

function addDeletion(
  deletions: Map<string, TextDeletion>,
  deletion: TextDeletion,
): void {
  deletions.set(`${deletion.offset}:${deletion.length}`, deletion);
}

function commaBetween(
  source: string,
  startOffset: number,
  endOffset: number,
): number | undefined {
  const scanner = createScanner(source, true);
  scanner.setPosition(startOffset);
  const token = scanner.scan();
  return token === SyntaxKind.CommaToken && scanner.getTokenOffset() < endOffset
    ? scanner.getTokenOffset()
    : undefined;
}

function validateUpdatedJsonc(source: string, configPath: string): void {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (root === undefined || errors.length > 0) {
    throw ambiguous(
      configPath,
      'TokenLens could not produce a valid surgical hook removal',
    );
  }
}

function isOwnedBridgeRegistration(contents: Buffer): boolean {
  if (contents.length > MAX_BRIDGE_REGISTRATION_BYTES) {
    return false;
  }
  try {
    const decoded = decodeUtf8(contents, LEGACY_BRIDGE_REGISTRATION_RELATIVE_PATH);
    const value: unknown = JSON.parse(
      decoded.startsWith(UTF8_BOM) ? decoded.slice(UTF8_BOM.length) : decoded,
    );
    if (!isRecord(value)) {
      return false;
    }
    const keys = Object.keys(value).sort();
    return (
      keys.length === 3 &&
      keys[0] === 'port' &&
      keys[1] === 'token' &&
      keys[2] === 'version' &&
      value.version === 1 &&
      typeof value.port === 'number' &&
      Number.isInteger(value.port) &&
      value.port >= 1 &&
      value.port <= 65_535 &&
      typeof value.token === 'string' &&
      /^[a-f0-9]{64}$/.test(value.token)
    );
  } catch {
    return false;
  }
}

function decodeUtf8(contents: Buffer, path: string): string {
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      // Keep a BOM in the returned string so a surgical rewrite can preserve it.
      ignoreBOM: true,
    }).decode(contents);
  } catch {
    throw ambiguous(path, 'the file is not valid UTF-8');
  }
}

async function lstatOptional(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function identity(stats: Stats): FileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    modifiedAt: stats.mtimeMs,
    size: stats.size,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedAt === right.modifiedAt &&
    left.size === right.size
  );
}

function ambiguous(path: string, reason: string): LegacyHookRemovalError {
  return new LegacyHookRemovalError(
    `TokenLens left ${path} unchanged because ${reason}.`,
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
