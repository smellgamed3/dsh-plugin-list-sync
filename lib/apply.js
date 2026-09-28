/**
 * Apply: execute a diff plan against the live profile, snapshot-first.
 *
 * Strategy (the discipline dshmarket's snapshot/backup modules validated):
 *   1. capture package.json + cordis.patch.yml into .dsh-plugin-list-sync/
 *      snapshots/<timestamp>.json before touching anything;
 *   2. write back the composed files;
 *   3. dependency changes go through the host's pluginManager service
 *      (installBundle / removeBundle / waitForInstall) rather than raw pnpm,
 *      so the same compatibility gates and reload lifecycle that the UI's
 *      plugin page uses protect us here too;
 *   4. any failure leaves a precise report; rollback is one command.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPatch } from './manifest.js';

const SNAPSHOT_DIR = '.dsh-plugin-list-sync';
const SNAPSHOT_PREFIX = 'snapshot-';
const SNAPSHOT_FORMAT = 'dsh-plugin-list-sync/profile-snapshot';
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOTS = 20;

/** Capture the two composition-critical files. Returns the snapshot id. */
export function createSnapshot(profileDir) {
  const dir = join(profileDir, SNAPSHOT_DIR, 'snapshots');
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}`;
  const id = `${SNAPSHOT_PREFIX}${stamp}`;
  const files = {};
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const path = join(profileDir, name);
    files[name] = existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
  const document = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    id,
    createdAt: now.getTime(),
    files,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(document, null, 2), 'utf8');
  pruneSnapshots(dir);
  return id;
}

function pruneSnapshots(dir) {
  const entries = readdirSync(dir).filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json')).sort();
  while (entries.length > MAX_SNAPSHOTS) {
    rmSync(join(dir, entries.shift()), { force: true });
  }
}

/** List snapshots (newest first by filename sort). */
export function listSnapshots(profileDir) {
  const dir = join(profileDir, SNAPSHOT_DIR, 'snapshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => {
      try {
        const document = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (document?.format === SNAPSHOT_FORMAT) return { id: document.id, createdAt: document.createdAt };
      } catch { /* corrupt entries are skipped, not fatal */ }
      return null;
    })
    .filter(Boolean);
}

const SNAP_ID_RE = /^snapshot-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;
function validSnapshotId(id) {
  return typeof id === 'string' && SNAP_ID_RE.test(id);
}

/** Restore one snapshot: rewrite both files exactly as captured. */
export function restoreSnapshot(profileDir, id) {
  if (!validSnapshotId(id)) throw new Error('invalid snapshot id');
  const path = join(profileDir, SNAPSHOT_DIR, 'snapshots', `${id}.json`);
  if (!existsSync(path)) throw new Error(`snapshot not found: ${id}`);
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (document?.format !== SNAPSHOT_FORMAT) throw new Error('unsupported snapshot format');
  // Snapshot before restoring, so even a rollback has a rollback.
  createSnapshot(profileDir);
  for (const [name, content] of Object.entries(document.files)) {
    const target = join(profileDir, name);
    if (content === null) {
      if (existsSync(target)) rmSync(target, { force: true });
    } else {
      writeFileSync(target, content, 'utf8');
    }
  }
  return { restored: id };
}

/**
 * Compose the next package.json from the live one + a diff plan's package
 * view. Official bundles and dependencies are preserved untouched; only the
 * third-party slice is replaced.
 */
export function composePackageJson(currentPkgText, manifest) {
  const pkg = JSON.parse(currentPkgText);
  pkg.dependencies = { ...(pkg.dependencies ?? {}) };
  // Drop third-party entries not in the manifest.
  for (const name of Object.keys(pkg.dependencies)) {
    if (name.startsWith('@deepseek-ai/')) continue;
    if (name === 'dsh-plugin-list-sync') continue;
    if (manifest.packages[name] === undefined) delete pkg.dependencies[name];
  }
  // Add/update from the manifest.
  for (const [name, version] of Object.entries(manifest.packages)) {
    pkg.dependencies[name] = version;
  }
  const previousBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const official = previousBundles.filter((b) => typeof b === 'string' && b.startsWith('@deepseek-ai/'));
  const self = previousBundles.includes('dsh-plugin-list-sync') ? ['dsh-plugin-list-sync'] : [];
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = [...official, ...self, ...manifest.bundles];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Compose the next cordis.patch.yml: remote rows + preserved local official-only rows. */
export function composePatchText(currentPatchText, manifest) {
  const rendered = renderPatch(manifest.patch);
  if (manifest.patch?.kind !== 'rows') return rendered;
  // Keep local rows the manifest filtered out (official/self references).
  const keptLocal = extractOfficialRows(currentPatchText);
  const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# synced by dsh-plugin-list-sync.\n';
  const body = [...keptLocal.map(rowToYaml), ...renderRows(manifest.patch.rows)].join('');
  return header + body;
}

function extractOfficialRows(text) {
  if (typeof text !== 'string') return [];
  const rows = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0 && raw.startsWith('- ')) {
      if (current?.official) rows.push(current.row);
      current = startRow(raw.slice(2).trim());
    } else if (current !== null && indent >= 2) {
      appendField(current, raw.trim());
    }
  }
  if (current?.official) rows.push(current.row);
  return rows;
}

function startRow(body) {
  const eq = body.indexOf(':');
  const key = eq === -1 ? '' : body.slice(0, eq).trim();
  const value = eq === -1 ? '' : body.slice(eq + 1).trim();
  const row = {};
  if (key !== '') row[key] = value === '' ? null : value;
  const official = typeof row.name === 'string' && (row.name.startsWith('@deepseek-ai/') || row.name === 'dsh-plugin-list-sync');
  return { row, official };
}

function appendField(state, line) {
  const eq = line.indexOf(':');
  if (eq === -1) return;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  state.row[key] = value === '' ? null : value;
}

function rowToYaml(row) {
  const lines = [`- id: ${JSON.stringify(String(row.id))}`];
  if (row.name !== undefined && row.name !== null) lines.push(`  name: ${JSON.stringify(String(row.name))}`);
  if (row.disabled !== undefined && row.disabled !== null) lines.push(`  disabled: ${row.disabled}`);
  return lines.join('\n') + '\n';
}

function renderRows(rows) {
  return rows.map(rowToYaml).join('');
}

/**
 * Write back both files for the manifest's file-level state. Dependency
 * INSTALLS are still the pluginManager's job; this only makes the file
 * consistent with what the user confirmed.
 */
export function writeProfileFiles(profileDir, manifest) {
  const pkgPath = join(profileDir, 'package.json');
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const nextPkg = composePackageJson(readFileSync(pkgPath, 'utf8'), manifest);
  const currentPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const nextPatch = composePatchText(currentPatch, manifest);
  writeFileSync(pkgPath, nextPkg, 'utf8');
  writeFileSync(patchPath, nextPatch, 'utf8');
}

/**
 * Orchestrate installs/removals through pluginManager when available.
 * Returns per-package results. The pluginManager service is optional: when
 * the host does not expose it, files are already written and the caller
 * reports that a restart/manual install is needed for dependency changes.
 */
export async function orchestrateInstalls(pluginManager, plan, { signal } = {}) {
  const results = [];
  const targets = [
    ...plan.installs.map((entry) => ({ name: entry.name, version: entry.version, action: 'install' })),
    ...plan.upgrades.map((entry) => ({ name: entry.name, version: entry.to, action: 'upgrade' })),
    ...plan.downgrades.map((entry) => ({ name: entry.name, version: entry.to, action: 'downgrade' })),
  ];
  for (const target of targets) {
    if (signal?.aborted) break;
    try {
      const spec = `${target.name}@${target.version}`;
      const change = await pluginManager.installBundle(spec);
      results.push({ name: target.name, action: target.action, ok: true, change });
    } catch (error) {
      results.push({ name: target.name, action: target.action, ok: false, error: String(error?.message ?? error) });
    }
  }
  for (const entry of plan.removals) {
    if (signal?.aborted) break;
    try {
      const change = await pluginManager.removeBundle(entry.name);
      results.push({ name: entry.name, action: 'remove', ok: true, change });
    } catch (error) {
      results.push({ name: entry.name, action: 'remove', ok: false, error: String(error?.message ?? error) });
    }
  }
  return results;
}
