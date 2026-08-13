import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function cursorCliConfigPath() {
  const directory = process.env.CURSOR_CONFIG_DIR?.trim() || path.join(homedir(), '.cursor');
  return path.join(directory, 'cli-config.json');
}

/** Ask Cursor to rerun TokenLens's event-driven status-line command. */
export async function refreshStatusLine(expectedScriptPath) {
  if (typeof expectedScriptPath !== 'string' || expectedScriptPath === '') return false;
  const target = cursorCliConfigPath();
  let temporary;
  try {
    const original = await readFile(target, 'utf8');
    const config = JSON.parse(original);
    const command = config?.statusLine?.command;
    if (typeof command !== 'string') return false;
    const normalizedCommand = command.replaceAll('\\', '/');
    const normalizedScript = expectedScriptPath.replaceAll('\\', '/');
    if (!normalizedCommand.includes(normalizedScript)) return false;
    const base = command.replace(/\s+--tokenlens-refresh=\d+$/, '');
    const refreshed = `${base} --tokenlens-refresh=${Date.now()}`;
    const next = original.replace(JSON.stringify(command), JSON.stringify(refreshed));
    if (next === original) return false;
    temporary = `${target}.${process.pid}.tokenlens.tmp`;
    await writeFile(temporary, next, 'utf8');
    await rename(temporary, target);
    return true;
  } catch {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}
