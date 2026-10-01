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
import { renderPatch, compareVersions, SELF_PACKAGE } from './manifest.js';

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
 * Compose the next package.json from the live one + a remote manifest's
 * package view. Two modes share this entry point:
 *
 *   merge (default) — every local dependency stays (official, self, and
 *     third-party alike); remote packages the local profile lacks are ADDED;
 *     a shared package moves to the remote version only when that is HIGHER;
 *     dsh.profile.bundles becomes the union.
 *
 *   replace (force) — the third-party slice mirrors the remote manifest
 *     exactly: local-only third-party dependencies are dropped, shared
 *     packages take the remote version even when older (explicit downgrade),
 *     and bundles follow the remote order. Official bundles and this plugin
 *     itself are ALWAYS preserved either way.
 */
export function composePackageJson(currentPkgText, manifest, options = {}) {
  const replace = options.mode === 'replace';
  const pkg = JSON.parse(currentPkgText);
  pkg.dependencies = { ...(pkg.dependencies ?? {}) };
  const manifestPackages = manifest?.packages ?? {};
  if (replace) {
    // Mirror the remote third-party slice exactly (official + self stay).
    for (const name of Object.keys(pkg.dependencies)) {
      if (name.startsWith('@deepseek-ai/')) continue;
      if (name === SELF_PACKAGE) continue;
      if (manifestPackages[name] === undefined) delete pkg.dependencies[name];
    }
    for (const [name, version] of Object.entries(manifestPackages)) {
      pkg.dependencies[name] = version;
    }
    const previousBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const official = previousBundles.filter((b) => typeof b === 'string' && b.startsWith('@deepseek-ai/'));
    const self = previousBundles.includes(SELF_PACKAGE) ? [SELF_PACKAGE] : [];
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    pkg.dsh.profile.bundles = [...official, ...self, ...(manifest?.bundles ?? [])];
    return `${JSON.stringify(pkg, null, 2)}\n`;
  }
  const merged = { packages: { ...manifestPackages }, bundles: [...(manifest?.bundles ?? [])] };
  for (const [name, version] of Object.entries(merged.packages)) {
    const current = pkg.dependencies[name];
    if (current === undefined || compareVersions(version, current) > 0) {
      pkg.dependencies[name] = version;
    }
    // else: local version is equal or higher — merge never downgrades.
  }
  const previousBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const seen = new Set();
  const nextBundles = [];
  for (const entry of [...previousBundles, ...merged.bundles]) {
    if (typeof entry !== 'string' || seen.has(entry)) continue;
    seen.add(entry);
    nextBundles.push(entry);
  }
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = nextBundles;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Compose the next cordis.patch.yml. Two modes:
 *
 * merge (default) — block-level merge INTO the local layer. Rows are keyed by
 *   their `id:` (or `name:` when no id exists): local rows are ALWAYS kept,
 *   with their nested `config:` blocks VERBATIM (LLM provider definitions
 *   and model selections are machine-local topology that the manifest
 *   deliberately does not carry); a shared row keeps the local block except
 *   that the remote `disabled` flag travels; remote-only rows are appended.
 *
 * replace (force) — the non-official slice mirrors the remote manifest:
 *   local-only third-party rows are dropped, remote rows are rendered from
 *   the manifest. Official rows (and this plugin's row) keep their original
 *   local text verbatim in BOTH modes — their nested config is exactly what
 *   a sync must never destroy.
 */
export function composePatchText(currentPatchText, manifest, options = {}) {
  const replace = options.mode === 'replace';
  const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# synced by dsh-plugin-list-sync.\n';
  const localBlocks = splitPatchBlocks(currentPatchText);
  if (manifest?.patch?.kind !== 'rows' || !Array.isArray(manifest.patch.rows)) {
    if (replace) {
      const keptOfficial = localBlocks.filter((b) => b.official).map((b) => b.text);
      return header + keptOfficial.join('\n') + (keptOfficial.length > 0 ? '\n' : '');
    }
    return currentPatchText && currentPatchText.trim() !== ''
      ? `${currentPatchText.trimEnd()}\n`
      : header;
  }
  const remoteRows = manifest.patch.rows.filter((row) => row && typeof row.id === 'string');
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  if (replace) {
    const keptOfficial = localBlocks.filter((b) => b.official).map((b) => b.text);
    const body = [...keptOfficial, ...renderRows(remoteRows)].filter((text) => text.trim() !== '');
    return header + body.join('\n') + '\n';
  }
  const usedRemoteIds = new Set();
  const body = [];
  for (const block of localBlocks) {
    const remoteRow = block.id !== null ? remoteById.get(block.id) : undefined;
    if (remoteRow !== undefined) {
      usedRemoteIds.add(block.id);
      body.push(applyRemoteToggle(block, remoteRow));
      continue;
    }
    body.push(block.text);
  }
  for (const row of remoteRows) {
    if (usedRemoteIds.has(row.id)) continue;
    body.push(renderRowFromManifest(row));
  }
  return header + body.filter((text) => text.trim() !== '').join('\n') + '\n';
}

const OFFICIAL_ROW_IDS = new Set(['llm-pi-ai', 'agent-default-model']);

/**
 * Apply a remote manifest row's structural keys onto a preserved local block:
 * the local text (including nested config) survives verbatim; only the
 * `disabled:` line, when the remote explicitly sets it, is aligned.
 */
function applyRemoteToggle(block, remoteRow) {
  if (remoteRow.disabled === undefined) return block.text;
  const lines = block.text.split(/\r?\n/);
  const disabledLineIndex = lines.findIndex((line) => /^\s*disabled:\s/.test(line));
  if (remoteRow.disabled === false && disabledLineIndex === -1) return block.text; // already enabled
  if (disabledLineIndex === -1) {
    // append the flag after the row's first line (the `- id:` head)
    lines.splice(1, 0, `  disabled: ${remoteRow.disabled}`);
    return lines.join('\n');
  }
  lines[disabledLineIndex] = lines[disabledLineIndex].replace(/^(\s*disabled:\s*).*/, `$1${remoteRow.disabled}`);
  return lines.join('\n');
}

function renderRowFromManifest(row) {
  const lines = [`- id: ${JSON.stringify(String(row.id))}`];
  if (row.name !== undefined && row.name !== null) lines.push(`  name: ${JSON.stringify(String(row.name))}`);
  if (row.disabled !== undefined && row.disabled !== null) lines.push(`  disabled: ${row.disabled}`);
  return lines.join('\n');
}

/**
 * Split patch text into top-level `- ` blocks. Each block carries its full
 * original text (nested config included) plus the `id`/`name` keys that
 * identify it for merging. Rows whose `name:` targets an official package
 * (or this plugin) are tagged `official` so callers can treat them as
 * strictly local.
 */
export function splitPatchBlocks(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const blocks = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  const flush = () => {
    if (current !== null) {
      while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === '') current.lines.pop();
      current.text = current.lines.join('\n');
      if (current.text.trim() !== '') blocks.push(current);
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
      current = { lines: [line], id: key === 'id' ? value : null, name: key === 'name' ? value : null, official: false };
      if (key === 'name' && (value.startsWith('@deepseek-ai/') || value === SELF_PACKAGE)) current.official = true;
      if (key === 'id' && OFFICIAL_ROW_IDS.has(value)) current.official = true;
      continue;
    }
    if (current === null) continue; // header comments / blank lines above the first row
    current.lines.push(line);
    const trimmed = line.trim();
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(trimmed);
    if (kv !== null) {
      const [, key, rawValue] = kv;
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      if (key === 'id' && current.id === null) current.id = value;
      if (key === 'name' && current.name === null) current.name = value;
      if (key === 'name' && (value.startsWith('@deepseek-ai/') || value === SELF_PACKAGE)) current.official = true;
      if (key === 'id' && OFFICIAL_ROW_IDS.has(value)) current.official = true;
    }
  }
  flush();
  return blocks;
}

function rowToYaml(row) {
  return renderRowFromManifest(row);
}

function renderRows(rows) {
  return rows.map(rowToYaml).join('');
}

/**
 * Write back both files for the manifest's file-level state. Dependency
 * INSTALLS are still the pluginManager's job; this only makes the file
 * consistent with what the user confirmed. Mode 'replace' mirrors the remote
 * manifest (dropping local-only third-party entries); the default 'merge'
 * never removes anything local.
 */
export function writeProfileFiles(profileDir, manifest, options = {}) {
  const pkgPath = join(profileDir, 'package.json');
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const nextPkg = composePackageJson(readFileSync(pkgPath, 'utf8'), manifest, options);
  const currentPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const nextPatch = composePatchText(currentPatch, manifest, options);
  writeFileSync(pkgPath, nextPkg, 'utf8');
  writeFileSync(patchPath, nextPatch, 'utf8');
}

/**
 * Orchestrate installs through pluginManager when available.
 *
 * merge (default): purely additive — only installs and version UPGRADES, so
 * the merge promise (never remove, never downgrade) holds end to end.
 *
 * replace (force): mirrors the remote state — local-only packages are
 * uninstalled and older remote versions are installed as explicit
 * downgrades, because the user explicitly asked for that state.
 *
 * The pluginManager service is optional: when the host does not expose it,
 * files are already written and the caller reports that a restart/manual
 * install is needed for dependency changes.
 */
export async function orchestrateInstalls(pluginManager, plan, { signal } = {}) {
  const results = [];
  const replace = plan?.mode === 'replace';
  const targets = [
    ...plan.installs.map((entry) => ({ name: entry.name, version: entry.version, action: 'install' })),
    ...plan.upgrades.map((entry) => ({ name: entry.name, version: entry.to, action: 'upgrade' })),
    ...(replace ? plan.downgrades.map((entry) => ({ name: entry.name, version: entry.to, action: 'downgrade' })) : []),
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
  if (replace) {
    for (const entry of plan.removals) {
      if (signal?.aborted) break;
      try {
        const change = await pluginManager.removeBundle(entry.name);
        results.push({ name: entry.name, action: 'remove', ok: true, change });
      } catch (error) {
        results.push({ name: entry.name, action: 'remove', ok: false, error: String(error?.message ?? error) });
      }
    }
  }
  return results;
}
