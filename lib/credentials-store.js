/**
 * Credentials store: AccessKey/SecretKey saved from the settings page.
 *
 * Where they live: <profile>/.dsh-plugin-list-sync/credentials.json — the
 * plugin's own private state directory, deliberately SEPARATE from both the
 * synced plugin-list files (they never travel in a manifest) and the cordis
 * patch layer (they never land in a config file a sync could overwrite).
 *
 * Priority: this file beats the DSH_PLUGIN_SYNC_S3_KEY/SECRET env vars when
 * present (the user typed them in the UI on purpose); clearing the saved pair
 * through the settings page falls back to the environment.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const CREDENTIALS_FILE = 'credentials.json';

/** Absolute path of the credentials file inside a profile's plugin state dir. */
export function credentialsPath(profileDir) {
  return join(profileDir, '.dsh-plugin-list-sync', CREDENTIALS_FILE);
}

/** Read the saved pair; null when absent or malformed. */
export function loadCredentials(profileDir) {
  const path = credentialsPath(profileDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.accessKeyId !== 'string' || typeof parsed?.secretAccessKey !== 'string') return null;
    if (parsed.accessKeyId === '' || parsed.secretAccessKey === '') return null;
    return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
  } catch {
    return null;
  }
}

/** Persist the pair. Non-empty after trim, no line breaks even before trimming. */
export function saveCredentials(profileDir, accessKeyId, secretAccessKey) {
  const raw = { ak: accessKeyId, sk: secretAccessKey };
  for (const [slot, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error('credentials must be strings');
    if (/[\r\n]/.test(value)) throw new Error('credentials must not contain line breaks');
    if (value.length > 256) throw new Error('credentials exceed 256 characters');
    raw[slot] = value.trim();
  }
  if (raw.ak === '' || raw.sk === '') throw new Error('both accessKeyId and secretAccessKey are required');
  const path = credentialsPath(profileDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ accessKeyId: raw.ak, secretAccessKey: raw.sk, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs: best effort */ }
  return { saved: true };
}

/** Remove the saved pair (falls back to env vars). Idempotent. */
export function clearCredentials(profileDir) {
  const path = credentialsPath(profileDir);
  if (existsSync(path)) rmSync(path, { force: true });
  return { cleared: true };
}

/** Where a usable credential would come from right now: 'saved' | 'env' | null. */
export function credentialsSource(profileDir) {
  if (loadCredentials(profileDir) !== null) return 'saved';
  if (process.env.DSH_PLUGIN_SYNC_S3_KEY && process.env.DSH_PLUGIN_SYNC_S3_SECRET) return 'env';
  return null;
}
