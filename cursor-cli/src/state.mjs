import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tokenLensHome } from './config.mjs';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Prompt text never reaches disk; only this one-way fingerprint is stored. */
export function fingerprint(prompt) {
  return createHash('sha256').update(String(prompt), 'utf8').digest('hex');
}

export function stateDirectory() {
  return path.join(tokenLensHome(), 'pending');
}

function stateFile(conversationId) {
  const safe = String(conversationId ?? '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);
  if (safe === '') return null;
  return path.join(stateDirectory(), `${safe}.json`);
}

export async function readPending(conversationId) {
  const target = stateFile(conversationId);
  if (target === null) return null;
  try {
    const raw = JSON.parse(await readFile(target, 'utf8'));
    if (typeof raw?.fingerprint !== 'string') return null;
    if (Date.now() - (raw.createdAt ?? 0) > STALE_AFTER_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writePending(conversationId, value) {
  const target = stateFile(conversationId);
  if (target === null) return false;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...value, createdAt: Date.now() })}\n`, 'utf8');
  await rename(temporary, target);
  return true;
}

export async function clearPending(conversationId) {
  const target = stateFile(conversationId);
  if (target !== null) await rm(target, { force: true });
}

export async function prunePending(now = Date.now()) {
  let entries;
  try {
    entries = await readdir(stateDirectory());
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const target = path.join(stateDirectory(), entry);
    try {
      const { mtimeMs } = await stat(target);
      if (now - mtimeMs > STALE_AFTER_MS) {
        await rm(target, { force: true });
        removed += 1;
      }
    } catch {
      // Another process may have removed it first.
    }
  }
  return removed;
}
