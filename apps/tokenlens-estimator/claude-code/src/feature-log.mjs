import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tokenLensHome } from './config.mjs';
import { validateFeaturePayload } from './features/validation.mjs';

export function featureLogPath() {
  return path.join(tokenLensHome(), 'logs', 'ml-features.jsonl');
}

/**
 * Appends one prompt and its exact validated model features as JSON Lines.
 * Source contents, workspace paths, transcript paths, and collection internals
 * are deliberately excluded from this temporary inspection log.
 */
export async function appendFeatureLog({
  prompt,
  payload,
  manifest,
  sessionId,
  now = () => new Date(),
}) {
  validateFeaturePayload(payload, manifest);

  const features = Object.fromEntries(
    manifest.feature_order.map((name) => [name, payload.features[name]]),
  );
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new TypeError('Feature log clock must return a valid Date');
  }

  const record = {
    logged_at: timestamp.toISOString(),
    session_id: String(sessionId ?? 'unknown'),
    schema_version: payload.schema_version,
    prompt: String(prompt ?? ''),
    features,
  };

  const target = featureLogPath();
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await appendFile(target, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(target, 0o600);
  return record;
}
