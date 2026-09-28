/**
 * Diff: compare a remote manifest against the live profile and produce the
 * plan apply.js executes. Every entry is human-readable in both directions
 * because the settings page renders this list before the user confirms.
 */
import { SELF_PACKAGE } from './manifest.js';

/** Order-insensitive JSON comparison (key order never decides a diff). */
function stableJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Read the live state in manifest shape (no revision) for comparison. */
function toComparable(manifest) {
  return {
    packages: { ...manifest.packages },
    bundles: new Set(manifest.bundles),
    patchRows: patchRowsOf(manifest),
  };
}

function patchRowsOf(manifest) {
  if (manifest?.patch?.kind !== 'rows' || !Array.isArray(manifest.patch.rows)) return null;
  const map = new Map();
  for (const row of manifest.patch.rows) {
    if (typeof row?.id === 'string') map.set(row.id, row);
  }
  return map;
}

/**
 * @param {import('./manifest.js').Manifest} local - built from the live profile.
 * @param {import('./manifest.js').Manifest} remote - downloaded and validated.
 * @returns The plan: lists of installs, upgrades, removals, toggles, and
 *   whether the patch layer differs (config-level detail shown by the page).
 */
export function diffManifests(local, remote) {
  const a = toComparable(local);
  const b = toComparable(remote);

  const installs = [];
  const upgrades = [];
  const downgrades = [];
  const sameVersion = [];
  for (const [name, remoteVersion] of Object.entries(b.packages)) {
    const localVersion = a.packages[name];
    if (localVersion === undefined) installs.push({ name, version: remoteVersion });
    else if (localVersion === remoteVersion) sameVersion.push(name);
    else upgrades.push({ name, from: localVersion, to: remoteVersion });
  }
  const removals = [];
  for (const name of Object.keys(a.packages)) {
    if (b.packages[name] === undefined) removals.push({ name, from: a.packages[name] });
  }
  // Split version changes into upgrades vs downgrades by semver-ish comparison.
  const realUpgrades = [];
  const realDowngrades = [];
  for (const entry of upgrades) {
    if (compareVersions(entry.from, entry.to) >= 0) realDowngrades.push(entry);
    else realUpgrades.push(entry);
  }

  const bundleAdds = [...b.bundles].filter((x) => !a.bundles.has(x));
  const bundleRemovals = [...a.bundles].filter((x) => !b.bundles.has(x));

  let patchDiffers = false;
  const toggles = [];
  if (b.patchRows !== null) {
    const localRows = a.patchRows;
    if (localRows === null) {
      patchDiffers = true;
    } else {
      const ids = new Set([...localRows.keys(), ...b.patchRows.keys()]);
      for (const id of ids) {
        const l = localRows.get(id);
        const r = b.patchRows.get(id);
        const lDisabled = l?.disabled === true;
        const rDisabled = r?.disabled === true;
        if (l === undefined && r !== undefined) { patchDiffers = true; toggles.push({ id, from: 'absent', to: rDisabled ? 'disabled' : 'enabled' }); continue; }
        if (r === undefined && l !== undefined) { patchDiffers = true; toggles.push({ id, from: lDisabled ? 'disabled' : 'enabled', to: 'absent' }); continue; }
        if (lDisabled !== rDisabled) { patchDiffers = true; toggles.push({ id, from: lDisabled ? 'disabled' : 'enabled', to: rDisabled ? 'disabled' : 'enabled' }); continue; }
        if (stableJson(l) !== stableJson(r)) patchDiffers = true;
      }
    }
  }

  const isEmpty = installs.length === 0 && realUpgrades.length === 0 && realDowngrades.length === 0
    && removals.length === 0 && bundleAdds.length === 0 && bundleRemovals.length === 0
    && !patchDiffers;

  return {
    empty: isEmpty,
    installs,
    upgrades: realUpgrades,
    downgrades: realDowngrades,
    removals,
    bundleAdds,
    bundleRemovals,
    patchDiffers,
    toggles,
    sameCount: sameVersion.length,
  };
}

/** Semver-ish compare over dotted numeric segments; prerelease strings sort before their release. */
export function compareVersions(x, y) {
  const px = parseVersion(x);
  const py = parseVersion(y);
  for (let i = 0; i < Math.max(px.release.length, py.release.length); i += 1) {
    const dx = px.release[i] ?? 0;
    const dy = py.release[i] ?? 0;
    if (dx !== dy) return dx - dy;
  }
  if (px.pre === null && py.pre === null) return 0;
  if (px.pre === null) return 1;
  if (py.pre === null) return -1;
  return px.pre < py.pre ? -1 : px.pre > py.pre ? 1 : 0;
}

function parseVersion(v) {
  const text = String(v);
  const [core, pre] = text.split(/[-+]/, 2);
  const release = core.split('.').map((s) => Number.parseInt(s, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  return { release, pre: pre ?? null };
}
