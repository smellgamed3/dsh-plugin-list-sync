/**
 * Diff: compare a remote manifest against the live profile and produce the
 * MERGE plan apply.js executes. Every entry is human-readable in both
 * directions because the settings page renders this list before the user
 * confirms.
 *
 * Merge semantics (the invariant this plugin promises):
 *   - nothing present locally is ever REMOVED because the remote lacks it;
 *   - package versions never move BACKWARDS (a lower remote version is
 *     reported as `keptLocal`, never as a downgrade);
 *   - bundles and patch rows merge by union;
 *   - local provider config blocks always survive.
 */
import { compareVersions } from './manifest.js';

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
 * @param {{mode?: 'merge'|'replace'}} [options] - merge (default) never removes
 *   or downgrades; replace (force) mirrors the remote state exactly:
 *   local-only packages become removals and older remote versions become
 *   downgrades. Replace is opt-in per request and never persisted.
 */
export function diffManifests(local, remote, options = {}) {
  const replace = options.mode === 'replace';
  const a = toComparable(local);
  const b = toComparable(remote);

  const installs = [];
  const upgrades = [];
  const keptLocal = [];
  const sameVersion = [];
  const downgrades = [];
  for (const [name, remoteVersion] of Object.entries(b.packages)) {
    const localVersion = a.packages[name];
    if (localVersion === undefined) {
      installs.push({ name, version: remoteVersion });
    } else if (localVersion === remoteVersion) {
      sameVersion.push(name);
    } else if (compareVersions(remoteVersion, localVersion) > 0) {
      upgrades.push({ name, from: localVersion, to: remoteVersion });
    } else if (replace) {
      downgrades.push({ name, from: localVersion, to: remoteVersion });
    } else {
      // Remote is OLDER (or unparseable): keep the local version. The merge
      // never downgrades, but the difference is reported so the operator
      // sees why the local state stays.
      keptLocal.push({ name, local: localVersion, remote: remoteVersion });
    }
  }
  // In merge mode, packages that exist only locally are part of the union and
  // are uploaded on the next sync; applying a remote manifest never removes
  // them. In replace mode they are the removals.
  const removals = [];
  const localOnly = [];
  for (const [name, localVersion] of Object.entries(a.packages)) {
    if (b.packages[name] === undefined) {
      if (replace) removals.push({ name, from: localVersion });
      else localOnly.push({ name, version: localVersion });
    }
  }

  const bundleAdds = [...b.bundles].filter((x) => !a.bundles.has(x));
  const localOnlyBundles = [...a.bundles].filter((x) => !b.bundles.has(x));
  const bundleRemovals = replace ? localOnlyBundles : [];
  const dedupedLocalOnlyBundles = replace ? [] : localOnlyBundles;

  let patchDiffers = false;
  const toggles = [];
  if (b.patchRows !== null) {
    const localRows = a.patchRows;
    if (localRows === null) {
      patchDiffers = b.patchRows.size > 0;
    } else {
      const ids = new Set([...localRows.keys(), ...b.patchRows.keys()]);
      for (const id of ids) {
        const l = localRows.get(id);
        const r = b.patchRows.get(id);
        const lDisabled = l?.disabled === true;
        const rDisabled = r?.disabled === true;
        if (l === undefined && r !== undefined) { patchDiffers = true; toggles.push({ id, from: 'absent', to: rDisabled ? 'disabled' : 'enabled' }); continue; }
        if (r === undefined && l !== undefined) {
          if (replace) { patchDiffers = true; toggles.push({ id, from: lDisabled ? 'disabled' : 'enabled', to: 'absent' }); }
          continue; // merge: local-only row is kept, not a remote difference
        }
        if (lDisabled !== rDisabled) { patchDiffers = true; toggles.push({ id, from: lDisabled ? 'disabled' : 'enabled', to: rDisabled ? 'disabled' : 'enabled' }); continue; }
        if (stableJson(l) !== stableJson(r)) patchDiffers = true;
      }
    }
  }

  const isEmpty = installs.length === 0 && upgrades.length === 0 && downgrades.length === 0
    && removals.length === 0 && bundleAdds.length === 0 && bundleRemovals.length === 0
    && dedupedLocalOnlyBundles.length === 0
    && !patchDiffers;

  return {
    mode: replace ? 'replace' : 'merge',
    empty: isEmpty,
    installs,
    upgrades,
    downgrades,
    removals,
    keptLocal,
    localOnly,
    bundleAdds,
    bundleRemovals,
    localOnlyBundles: dedupedLocalOnlyBundles,
    patchDiffers,
    toggles,
    sameCount: sameVersion.length,
  };
}
