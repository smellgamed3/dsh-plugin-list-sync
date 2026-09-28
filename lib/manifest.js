/**
 * Manifest: the portable projection of a profile's plugin-list configuration.
 *
 * What "plugin list configuration" means here — exactly the two files that
 * define which third-party plugins a DSH profile runs and how:
 *
 *   package.json      → dependencies (name → version) + dsh.profile.bundles
 *   cordis.patch.yml  → the user patch layer (disabled rows, config overrides)
 *
 * Anything else (sessions, credentials, workspaces) is deliberately out of
 * scope. Official @deepseek-ai/* bundles are filtered out because they track
 * the DSH runtime each client installed — syncing them would re-create the
 * exact peer-dependency breakage this plugin was designed to avoid.
 *
 * LLM provider config (the `llm-pi-ai`-style provider blocks inside
 * cordis.patch.yml) carries baseURLs and model catalogs. They can be useful
 * to sync, but they may also embed topology the operator does not want on a
 * shared bucket — so `includePatchConfig` defaults to FALSE and rows whose
 * config is dropped keep only their structural keys (id/name/disabled).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FORMAT = 'dsh-plugin-list-sync/manifest';
export const MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const SELF_PACKAGE = 'dsh-plugin-list-sync';

/** Structural keys a patch row keeps when config is excluded. */
const STRUCTURAL_ROW_KEYS = new Set(['id', 'name', 'disabled']);

/** Rows whose config is considered provider-shaped (LLM gateways) when the operator excludes it. */
const PROVIDER_CONFIG_ROW_IDS = new Set(['llm-pi-ai', 'agent-default-model']);

/** Official scope: always local, never synced. */
function isOfficial(name) {
  return typeof name === 'string' && name.startsWith('@deepseek-ai/');
}

/** npm-style package name: bare or @scope/name, no punctuation beyond ._-~/ */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-._~]+$/;

/** Deterministic JSON text (stable key order for readable diffs; undefined dropped). */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Parse YAML minimally — we only need to round-trip the patch as TEXT, never interpret it here. */
export function readPatchText(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/**
 * Build a manifest from a live profile directory.
 *
 * @param {string} profileDir - absolute profile directory (holds package.json).
 * @param {{revision?: number, label?: string, includePatchConfig?: boolean, dshVersion?: string}} options
 */
export function buildManifest(profileDir, options = {}) {
  const pkgPath = join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('profile package.json not found');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const dependencies = pkg.dependencies ?? {};
  const packages = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (isOfficial(name)) continue;
    if (name === SELF_PACKAGE) continue; // self-bootstrap: present everywhere the plugin runs
    packages[name] = typeof version === 'string' ? version : String(version);
  }

  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((b) => typeof b === 'string' && !isOfficial(b) && b !== SELF_PACKAGE)
    : [];

  const patch = projectPatch(readPatchText(profileDir), {
    includeConfig: options.includePatchConfig === true,
  });

  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    revision: Number.isFinite(options.revision) ? options.revision : 0,
    updatedAt: new Date().toISOString(),
    source: { label: typeof options.label === 'string' && options.label ? options.label : undefined },
    runtime: options.dshVersion ? { dshVersion: options.dshVersion } : {},
    packages,
    bundles,
    patch,
  };
}

/**
 * Parse the patch layer into rows WITHOUT a YAML dependency. Two top-level
 * shapes exist in real profiles:
 *
 *   - id: <entry-id>         override rows (disabled / name / config)
 *     name: <module-name>
 *
 *   - insert:                 insert lists introducing package rows
 *     - id: <row-id>
 *       name: <package-name>
 *
 * Rows coming from an insert list are tagged __insertOfficial when their
 * package is official or this plugin itself, so projectPatch can drop them
 * while keeping overrides intact.
 */
export function parsePatchRows(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: true, rows: [] };
  const lines = text.split(/\r?\n/);
  const rows = [];
  let current = null;
  let inConfig = false;
  let configLines = [];
  let inInsert = false;
  const commit = () => {
    if (current === null) return;
    if (configLines.length > 0) current.config = configLines.join('\n');
    rows.push(current);
    current = null;
    inConfig = false;
    configLines = [];
  };
  for (const rawLine of lines) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trimEnd();
    if (indent === 0 && line.startsWith('- ')) {
      commit();
      const body = line.slice(2).trim();
      if (body === 'insert:') { inInsert = true; inConfig = false; continue; }
      if (body === '{') { current = {}; continue; }
      const eq = body.indexOf(':');
      if (eq === -1) { current = { unknown: body }; continue; }
      const key = body.slice(0, eq).trim();
      const value = body.slice(eq + 1).trim();
      current = value === '' ? { [key]: null } : { [key]: parseScalar(value) };
      continue;
    }
    if (indent === 0 && !line.startsWith('- ') && !line.startsWith(' ')) {
      // Top-level mapping key (e.g. `insert:` on its own line).
      if (line.trim() === 'insert:') { inInsert = true; inConfig = false; continue; }
      if (line.trim() === '[]') { inInsert = false; continue; }
      continue;
    }
    if (current === null) {
      if (/^\[\s*\]\s*$/.test(line.trim())) continue;
      continue;
    }
    if (inInsert) {
      // Inside an insert list, nested rows appear at indent >= 4.
      const nested = line.trim();
      if (nested.startsWith('- ')) {
        commit();
        const body = nested.slice(2).trim();
        const eq = body.indexOf(':');
        current = eq === -1 ? { unknown: body } : { [body.slice(0, eq).trim()]: parseScalar(body.slice(eq + 1).trim()) };
        if (typeof current.name === 'string' && (isOfficial(current.name) || current.name === SELF_PACKAGE)) {
          current.__insertOfficial = true;
        }
        continue;
      }
      const eq2 = nested.indexOf(':');
      if (eq2 !== -1) {
        const key = nested.slice(0, eq2).trim();
        const value = nested.slice(eq2 + 1).trim();
        if (value === '') { inConfig = true; configLines = []; continue; }
        current[key] = parseScalar(value);
        if (key === 'name' && (isOfficial(String(value)) || value === SELF_PACKAGE)) {
          current.__insertOfficial = true;
        }
      }
      continue;
    }
    if (inConfig || line.trim().startsWith('config:')) {
      if (line.trim() === 'config:') { inConfig = true; continue; }
      configLines.push(line);
      continue;
    }
    const eq2 = line.trim().indexOf(':');
    if (eq2 === -1) { configLines.push(line); continue; }
    const key = line.trim().slice(0, eq2).trim();
    const value = line.trim().slice(eq2 + 1).trim();
    if (value === '') { inConfig = true; configLines = []; continue; }
    current[key] = parseScalar(value);
  }
  commit();
  return { ok: true, rows };
}

function parseScalar(value) {
  const v = value.trim().replace(/^['"]|['"]$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return v;
}

/**
 * Project patch text into the manifest's patch field: full text when config
 * is included; structural rows only otherwise.
 */
export function projectPatch(text, { includeConfig }) {
  const parsed = parsePatchRows(text);
  if (!parsed.ok) return { kind: 'text', text };
  if (includeConfig) return { kind: 'text', text: text.trimEnd() };
  // Override rows (`- id:` entries) are preserved structurally whatever their
  // `name` points at: disabling a built-in plugin is a real cross-machine
  // difference. Only INSERT-list entries that pull official/self packages are
  // dropped — those rows belong to each client's own runtime.
  const toStructural = (row) => {
    const out = {};
    for (const key of STRUCTURAL_ROW_KEYS) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    return out;
  };
  return { kind: 'rows', rows: parsed.rows.filter((row) => !row.__insertOfficial).map(toStructural) };
}

/**
 * Render patch rows back into cordis.patch.yml text (rows form only).
 */
export function renderPatch(patch) {
  if (patch?.kind === 'text') return patch.text;
  if (patch?.kind !== 'rows' || !Array.isArray(patch.rows)) return '';
  const lines = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# synced by dsh-plugin-list-sync.',
  ];
  for (const row of patch.rows) {
    lines.push(`- id: ${yamlScalar(row.id)}`);
    if (row.name !== undefined) lines.push(`  name: ${yamlScalar(row.name)}`);
    if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`);
  }
  return lines.join('\n') + '\n';
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

/** Whether a patch row id belongs to provider/LLM config that the operator may want to exclude. */
export function rowIsProviderConfig(row) {
  return PROVIDER_CONFIG_ROW_IDS.has(typeof row === 'string' ? row : row?.id);
}

/**
 * Strict download-side validation (the validatedBackup discipline): any field
 * outside the schema makes the whole manifest unusable rather than partially
 * applied.
 */
export function validateManifest(value) {
  if (value === null || typeof value !== 'object') return { ok: false, error: 'manifest is not an object' };
  if (value.format !== MANIFEST_FORMAT || value.version !== MANIFEST_VERSION) {
    return { ok: false, error: `unsupported manifest format/version (want ${MANIFEST_FORMAT} v${MANIFEST_VERSION})` };
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    return { ok: false, error: 'manifest revision must be a non-negative integer' };
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return { ok: false, error: 'manifest updatedAt is not a valid timestamp' };
  }
  if (value.source !== undefined && (typeof value.source !== 'object' || Array.isArray(value.source))) {
    return { ok: false, error: 'manifest source must be an object' };
  }
  if (value.packages === null || typeof value.packages !== 'object' || Array.isArray(value.packages)) {
    return { ok: false, error: 'manifest packages must be an object' };
  }
  for (const [name, version] of Object.entries(value.packages)) {
    if (!PACKAGE_NAME_RE.test(name) || name.startsWith('@deepseek-ai/')) {
      return { ok: false, error: `manifest package name rejected: ${name}` };
    }
    if (typeof version !== 'string' || version.length > 128 || /[\r\n]/.test(version)) {
      return { ok: false, error: `manifest package version rejected: ${name}` };
    }
  }
  if (!Array.isArray(value.bundles)) return { ok: false, error: 'manifest bundles must be an array' };
  for (const entry of value.bundles) {
    if (typeof entry !== 'string' || !PACKAGE_NAME_RE.test(entry) || entry.startsWith('@deepseek-ai/')) {
      return { ok: false, error: 'manifest bundle entry rejected' };
    }
  }
  if (value.patch !== undefined && value.patch !== null) {
    if (typeof value.patch !== 'object' || Array.isArray(value.patch)) {
      return { ok: false, error: 'manifest patch must be an object' };
    }
    if (value.patch.kind === 'text') {
      if (typeof value.patch.text !== 'string') return { ok: false, error: 'manifest patch.text must be a string' };
    } else if (value.patch.kind === 'rows') {
      if (!Array.isArray(value.patch.rows)) return { ok: false, error: 'manifest patch.rows must be an array' };
      for (const row of value.patch.rows) {
        if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length > 128) {
          return { ok: false, error: 'manifest patch row rejected' };
        }
      }
    } else {
      return { ok: false, error: 'manifest patch kind rejected' };
    }
  }
  return { ok: true, manifest: value };
}

/** Validate + size-check the serialized form received over the wire. */
export function validateManifestBytes(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `manifest exceeds ${MAX_MANIFEST_BYTES} bytes` };
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, error: 'manifest is not valid JSON' };
  }
  return validateManifest(parsed);
}

/** Serialize for upload (stable order → byte-identical uploads for identical state). */
export function serializeManifest(manifest) {
  return Buffer.from(stableStringify(manifest), 'utf8');
}
