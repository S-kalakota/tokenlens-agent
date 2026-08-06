import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';

export const TOKENLENS_HOOK_COMMAND =
  'node .cursor/hooks/tokenlens-before-submit.cjs';
export const TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH = join(
  '.cursor',
  'hooks',
  'tokenlens-before-submit.cjs',
);
export const TOKENLENS_HOOK_CONFIG_RELATIVE_PATH = join(
  '.cursor',
  'hooks.json',
);
export const TOKENLENS_HOOK_MARKER =
  'TokenLens managed beforeSubmitPrompt hook';

const TOKENLENS_HOOK = {
  command: TOKENLENS_HOOK_COMMAND,
  timeout: 2,
};

export interface ProjectHookInstallerOptions {
  workspaceRoots: readonly string[];
  sourceScriptPath: string;
}

interface PreparedWorkspace {
  configContents: string;
  configPath: string;
  scriptContents: string | undefined;
  scriptPath: string;
}

/**
 * Installs TokenLens's forwarding hook into every open project. Existing valid
 * Cursor hook configuration is merged and comments are preserved.
 */
export async function ensureSubmittedPromptHook(
  options: ProjectHookInstallerOptions,
): Promise<void> {
  const roots = [...new Set(options.workspaceRoots)];
  if (roots.length === 0) {
    throw new Error('A file-system workspace is required for the Cursor hook.');
  }

  const sourceScript = await readFile(options.sourceScriptPath, 'utf8');
  if (!sourceScript.includes(TOKENLENS_HOOK_MARKER)) {
    throw new Error('The bundled TokenLens hook script is missing its marker.');
  }

  // Preflight every root before writing so a bad config in one root does not
  // leave the other roots partially installed.
  const prepared = await Promise.all(
    roots.map(async (root) =>
      prepareWorkspace(root, options.sourceScriptPath, sourceScript),
    ),
  );

  for (const workspace of prepared) {
    await mkdir(dirname(workspace.scriptPath), { recursive: true });
    if (workspace.scriptContents !== undefined) {
      await writeFile(workspace.scriptPath, workspace.scriptContents, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    await mkdir(dirname(workspace.configPath), { recursive: true });
    // Write even when the content was already correct. Cursor watches this file,
    // so enabling the gate also repairs a window that missed an earlier reload.
    await writeFile(workspace.configPath, workspace.configContents, 'utf8');
  }
}

async function prepareWorkspace(
  workspaceRoot: string,
  sourceScriptPath: string,
  sourceScript: string,
): Promise<PreparedWorkspace> {
  const configPath = join(workspaceRoot, TOKENLENS_HOOK_CONFIG_RELATIVE_PATH);
  const scriptPath = join(workspaceRoot, TOKENLENS_HOOK_SCRIPT_RELATIVE_PATH);
  const currentConfig = await readOptional(configPath);
  const currentScript =
    resolve(sourceScriptPath) === resolve(scriptPath)
      ? sourceScript
      : await readOptional(scriptPath);

  if (
    currentScript !== undefined &&
    currentScript !== sourceScript &&
    !currentScript.includes(TOKENLENS_HOOK_MARKER)
  ) {
    throw new Error(
      `TokenLens will not overwrite the existing file at ${scriptPath}.`,
    );
  }

  return {
    configContents: addTokenLensHook(currentConfig, configPath),
    configPath,
    scriptContents:
      resolve(sourceScriptPath) === resolve(scriptPath) ||
      currentScript === sourceScript
        ? undefined
        : sourceScript,
    scriptPath,
  };
}

function addTokenLensHook(
  currentConfig: string | undefined,
  configPath: string,
): string {
  if (currentConfig === undefined || currentConfig.trim() === '') {
    return `${JSON.stringify(
      {
        version: 1,
        hooks: { beforeSubmitPrompt: [TOKENLENS_HOOK] },
      },
      null,
      2,
    )}\n`;
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(currentConfig, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const firstError = errors[0];
    const description =
      firstError === undefined
        ? 'unknown parse error'
        : `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`;
    throw new Error(
      `TokenLens cannot merge ${configPath}: ${description}. Fix that file and enable the gate again.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `TokenLens cannot merge ${configPath}: the root value must be an object.`,
    );
  }

  let updated = currentConfig;
  if (parsed.version === undefined) {
    updated = applyJsoncChange(updated, ['version'], 1);
  } else if (
    typeof parsed.version !== 'number' ||
    !Number.isInteger(parsed.version) ||
    parsed.version < 1
  ) {
    throw new Error(
      `TokenLens cannot merge ${configPath}: "version" must be a positive integer.`,
    );
  }

  const reparsed: unknown = parse(updated);
  if (!isRecord(reparsed)) {
    throw new Error(`TokenLens could not update ${configPath}.`);
  }

  if (reparsed.hooks === undefined) {
    return ensureFinalNewline(
      applyJsoncChange(updated, ['hooks'], {
        beforeSubmitPrompt: [TOKENLENS_HOOK],
      }),
    );
  }
  if (!isRecord(reparsed.hooks)) {
    throw new Error(
      `TokenLens cannot merge ${configPath}: "hooks" must be an object.`,
    );
  }

  const existing = reparsed.hooks.beforeSubmitPrompt;
  if (existing === undefined) {
    return ensureFinalNewline(
      applyJsoncChange(
        updated,
        ['hooks', 'beforeSubmitPrompt'],
        [TOKENLENS_HOOK],
      ),
    );
  }
  if (!Array.isArray(existing)) {
    throw new Error(
      `TokenLens cannot merge ${configPath}: "beforeSubmitPrompt" must be an array.`,
    );
  }

  const alreadyInstalled = existing.some(
    (entry) => isRecord(entry) && entry.command === TOKENLENS_HOOK_COMMAND,
  );
  return alreadyInstalled
    ? ensureFinalNewline(updated)
    : ensureFinalNewline(
        applyJsoncChange(updated, ['hooks', 'beforeSubmitPrompt'], [
          ...existing,
          TOKENLENS_HOOK,
        ]),
      );
}

function applyJsoncChange(
  contents: string,
  path: (string | number)[],
  value: unknown,
): string {
  const formattingOptions: FormattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: contents.includes('\r\n') ? '\r\n' : '\n',
  };
  return applyEdits(
    contents,
    modify(contents, path, value, { formattingOptions }),
  );
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureFinalNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
