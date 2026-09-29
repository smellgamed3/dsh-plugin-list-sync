/**
 * Persistent, non-secret synchronization settings.
 *
 * Browser localStorage is convenient for a settings form but disappears when
 * no page is open. Automation runs in the Host, so it needs a profile-local
 * source of truth. This file stores endpoint/options and automation policy;
 * credentials stay exclusively in credentials.json and are never accepted by
 * this module.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SETTINGS_FILE = 'settings.json';
const STATE_DIR = '.dsh-plugin-list-sync';

export const DEFAULT_SETTINGS = Object.freeze({
  s3: Object.freeze({
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'dsh-plugin-list-sync',
    forcePathStyle: true,
    allowInsecure: false,
    serverSideEncryption: false,
  }),
  includePatchConfig: false,
  machineLabel: '',
  automation: Object.freeze({
    autoUpload: false,
    uploadDebounceSeconds: 8,
    autoCheck: false,
    checkIntervalMinutes: 15,
  }),
});

export function settingsPath(profileDir) {
  return join(profileDir, STATE_DIR, SETTINGS_FILE);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value, fallback, max = 512) {
  if (typeof value !== 'string') return fallback;
  const result = value.trim();
  return result.length <= max ? result : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Normalize untrusted JSON into the one settings shape persisted by this
 * plugin. Unknown keys and all credential-like fields are discarded.
 */
export function normalizeSettings(value = {}) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const s3Source = source.s3 !== null && typeof source.s3 === 'object' && !Array.isArray(source.s3) ? source.s3 : {};
  const automationSource = source.automation !== null && typeof source.automation === 'object' && !Array.isArray(source.automation) ? source.automation : {};
  return {
    s3: {
      endpoint: text(s3Source.endpoint, DEFAULT_SETTINGS.s3.endpoint, 1024),
      region: text(s3Source.region, DEFAULT_SETTINGS.s3.region, 128) || DEFAULT_SETTINGS.s3.region,
      bucket: text(s3Source.bucket, DEFAULT_SETTINGS.s3.bucket, 128),
      prefix: text(s3Source.prefix, DEFAULT_SETTINGS.s3.prefix, 512),
      forcePathStyle: bool(s3Source.forcePathStyle, DEFAULT_SETTINGS.s3.forcePathStyle),
      allowInsecure: bool(s3Source.allowInsecure, DEFAULT_SETTINGS.s3.allowInsecure),
      serverSideEncryption: bool(s3Source.serverSideEncryption, DEFAULT_SETTINGS.s3.serverSideEncryption),
    },
    includePatchConfig: bool(source.includePatchConfig, DEFAULT_SETTINGS.includePatchConfig),
    machineLabel: text(source.machineLabel, DEFAULT_SETTINGS.machineLabel, 128),
    automation: {
      autoUpload: bool(automationSource.autoUpload, DEFAULT_SETTINGS.automation.autoUpload),
      uploadDebounceSeconds: boundedInteger(automationSource.uploadDebounceSeconds, DEFAULT_SETTINGS.automation.uploadDebounceSeconds, 3, 300),
      autoCheck: bool(automationSource.autoCheck, DEFAULT_SETTINGS.automation.autoCheck),
      checkIntervalMinutes: boundedInteger(automationSource.checkIntervalMinutes, DEFAULT_SETTINGS.automation.checkIntervalMinutes, 1, 1440),
    },
  };
}

/** Read persisted settings; null means the profile has never saved any. */
export function loadSettings(profileDir) {
  const path = settingsPath(profileDir);
  if (!existsSync(path)) return null;
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Atomic write avoids a half-written JSON file if DSH exits mid-save. */
export function saveSettings(profileDir, value) {
  const settings = normalizeSettings(value);
  const path = settingsPath(profileDir);
  const dir = join(profileDir, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return settings;
}
