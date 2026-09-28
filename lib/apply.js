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

/** Compose the next cordis.patch.yml: remote rows + preserved local official rows.
 *
 * Block-level: a row starts at a top-level `- ` line and runs until the next
 * one. Rows whose `name:` targets an official package (or this plugin) keep
 * their ORIGINAL TEXT verbatim — their nested `config:` blocks (LLM provider
 * definitions, model selections) are exactly what the manifest deliberately
 * does not carry, so re-rendering them from flattened fields would destroy
 * them. Everything else is replaced by the manifest's rows.
 */
export function composePatchText(currentPatchText, manifest) {
  const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# synced by dsh-plugin-list-sync.\n';
  const keptOfficial = splitPatchRows(currentPatchText).filter((b) => b.official).map((b) => b.text);
  if (manifest.patch?.kind !== 'rows') {
    const text = manifest.patch?.kind === 'text' ? manifest.patch.text.trimEnd() : '';
    return header + [...keptOfficial, text].filter(Boolean).join('\n') + '\n';
  }
  const body = [...keptOfficial, ...renderRows(manifest.patch.rows)].join('');
  return header + body;
}

const SELF_NAME = 'dsh-plugin-list-sync';
const OFFICIAL_ROW_IDS = new Set(['llm-pi-ai', 'agent-default-model']);

/** Split patch text into top-level row blocks with official detection. */
function splitPatchRows(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const blocks = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  const flush = () => {
    if (current !== null) {
      while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === '') current.lines.pop();
      current.text = current.lines.join('\n');
      blocks.push(current);
      current = null;
    }
  };
  for (const line of lines) {
    if (/^-\s/.test(line)) {
      flush();
      const head = line.slice(2).trim();
      const eq = head.indexOf(':');
      const key = eq === -1 ? '' : head.slice(0, eq).trim();
      const value = eq === -1 ? '' : head.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      current = { lines: [line], official: false };
      if (key === 'name' && (value.startsWith('@deepseek-ai/') || value === SELF_NAME)) current.official = true;
      if (key === 'id' && OFFICIAL_ROW_IDS.has(value)) current.official = true;
      continue;
    }
    if (current === null) continue; // header comments / blank lines above the first row
    current.lines.push(line);
    const trimmed = line.trim();
    if (/^name:\s/.test(trimmed)) {
      const value = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
      if (value.startsWith('@deepseek-ai/') || value === SELF_NAME) current.official = true;
    }
  }
  flush();
  return blocks;
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
