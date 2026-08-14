import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tokenLensHome } from './config.mjs';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Prompt text is never written to disk. Only this fingerprint is stored, which
 * is enough to prove the second submission is the same prompt as the one that
 * was estimated.
 */
export function fingerprint(prompt) {
  return createHash('sha256').update(String(prompt), 'utf8').digest('hex');
}

export function stateDirectory() {
  return path.join(tokenLensHome(), 'pending');
}

function stateFile(sessionId) {
  // Session ids are UUIDs, but never trust one straight into a path.
  const safe = String(sessionId ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return path.join(stateDirectory(), `${safe || 'unknown'}.json`);
}

/** Returns the fingerprint awaiting confirmation for a session, if any. */
export async function readPending(sessionId) {
  try {
    const raw = JSON.parse(await readFile(stateFile(sessionId), 'utf8'));
    if (typeof raw?.fingerprint !== 'string') return null;
    if (Date.now() - (raw.createdAt ?? 0) > STALE_AFTER_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writePending(sessionId, value) {
  const target = stateFile(sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...value, createdAt: Date.now() })}\n`,
    'utf8',
  );
  await rename(temporary, target);
}

export async function clearPending(sessionId) {
  await rm(stateFile(sessionId), { force: true });
}

/** Drops fingerprints from sessions that ended without confirming. */
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
      // Another process cleaned up first; nothing to do.
    }
  }
  return removed;
}
