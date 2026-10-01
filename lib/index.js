/**
 * dsh-plugin-list-sync host entry.
 *
 * Mounts:
 *   - /plugin-sync command (ctx.commands, optional service)
 *   - /dsh-plugin-list-sync/api/* routes (webServer, optional service)
 *   - settings namespace (ctx.get('settings'), optional) so the client page
 *     can persist its config through the standard DSH settings store.
 *
 * Everything is feature-detected via ctx.get(): the only hard peer is
 * @deepseek-ai/cordis, which ships with DSH itself. A host missing a service
 * keeps the matching surface silently disabled instead of failing to load —
 * the dshmarket peer-lock lesson applied at the architecture level.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, validateManifestBytes, serializeManifest, parsePatchRows, mergeManifests, compareVersions, SELF_PACKAGE } from './manifest.js';
import { diffManifests } from './diff.js';
import { createSnapshot, listSnapshots, restoreSnapshot, writeProfileFiles, orchestrateInstalls } from './apply.js';
import { s3Get, s3Put, s3Head, s3ErrorCode, manifestKey, S3Error } from './s3.js';
import { loadCredentials, saveCredentials, clearCredentials, credentialsSource } from './credentials-store.js';
import { loadSettings, saveSettings } from './settings-store.js';
import { createAutomationController } from './automation.js';

export const name = 'dsh-plugin-list-sync';

const ROUTE_BASE = '/dsh-plugin-list-sync/api';

function moduleDir() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function packageRoot() {
  // lib/index.js → package root two levels up.
  return join(moduleDir(), '..');
}

function selfVersion() {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Resolve the live profile directory: prefer profileContext, fall back to package root's parent chain. */
function resolveProfileDir(ctx) {
  const profileContext = ctx.get('profileContext');
  if (profileContext !== undefined) {
    // The service exposes startedBundles/overlays; the dir itself is derived
    // from the loader's baseDir when present.
  }
  const hmr = ctx.get('hmr');
  if (hmr !== undefined && typeof hmr.baseDir === 'string' && hmr.baseDir !== '') {
    return hmr.baseDir;
  }
  // packageRoot() = <profile>/node_modules/dsh-plugin-list-sync/lib → walk up 3.
  return join(packageRoot(), '..', '..', '..');
}

/** S3 connection config from the plugin Config schema (cordis entry config). */
function s3ConfigOf(config) {
  const s3 = config?.s3 ?? {};
  return {
    endpoint: s3.endpoint,
    region: s3.region,
    bucket: s3.bucket,
    prefix: s3.prefix,
    forcePathStyle: s3.forcePathStyle !== false,
    allowInsecure: s3.allowInsecure === true,
    serverSideEncryption: s3.serverSideEncryption === true,
  };
}

function requireS3Config(config) {
  const s3 = s3ConfigOf(config);
  if (typeof s3.endpoint !== 'string' || s3.endpoint.trim() === '') {
    throw new S3Error('S3 endpoint is not configured — open the plugin settings page', 'config');
  }
  if (typeof s3.bucket !== 'string' || s3.bucket.trim() === '') {
    throw new S3Error('S3 bucket is not configured — open the plugin settings page', 'config');
  }
  return s3;
}

/** Credentials priority: settings-page pair (private store) → env vars. Never read from a request body. */
async function credentialsOf(ctx, config) {
  const saved = loadCredentials(resolveProfileDir(ctx));
  if (saved !== null) return saved;
  const envKey = process.env.DSH_PLUGIN_SYNC_S3_KEY;
  const envSecret = process.env.DSH_PLUGIN_SYNC_S3_SECRET;
  if (envKey && envSecret) return { accessKeyId: envKey, secretAccessKey: envSecret };
  return undefined;
}

function profileNameOf(profileDir) {
  const parts = profileDir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'default';
}

function dshVersionOf(ctx) {
  const runtime = process.env.DSH_VERSION;
  if (typeof runtime === 'string' && runtime !== '') return runtime;
  return undefined;
}

/** Build the current local manifest. */
function localManifest(ctx, config, revision = 0) {
  const profileDir = resolveProfileDir(ctx);
  return buildManifest(profileDir, {
    revision,
    label: config?.machineLabel,
    includePatchConfig: config?.includePatchConfig === true,
    dshVersion: dshVersionOf(ctx),
  });
}

/** Upload flow (MERGE by default, FORCE-replace opt-in): GET remote → merge
 * local INTO it (or replace entirely when force) → PUT.
 *
 * Default: the uploaded manifest is the UNION of the remote state and this
 * client's state — plugins that exist only on the remote are PRESERVED
 * (uploading from a machine that never installed them must not delete them
 * for everyone), per-package versions take the HIGHER side, and patch rows
 * merge by id.
 *
 * force (explicit per-request opt-in, never persisted): the uploaded
 * manifest mirrors this client's state EXACTLY — remote-only plugins are
 * dropped from the manifest and older remote versions are overwritten. This
 * is the "make remote match local" escape hatch for a genuinely corrupted
 * or unwanted remote state, so it must be consciously chosen each time.
 *
 * A missing remote object is the first upload; a CORRUPT/invalid remote
 * object refuses to overwrite in merge mode (in force mode replacing it is
 * exactly the point, so it is allowed).
 */
async function uploadManifest(ctx, config, signal, { force = false } = {}) {
  const s3 = requireS3Config(config);
  const creds = await credentialsOf(ctx, config);
  if (creds !== undefined) Object.assign(s3, { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey });
  const profileDir = resolveProfileDir(ctx);
  const profile = profileNameOf(profileDir);
  const key = manifestKey(s3, profile);

  let revision = 0;
  let ifMatch;
  let remoteManifest = null;
  try {
    const remote = await s3Get(s3, key, signal);
    const validated = validateManifestBytes(remote);
    if (validated.ok) {
      revision = validated.manifest.revision;
      remoteManifest = validated.manifest;
    } else if (remote.length > 0 && !force) {
      // Non-empty but invalid: never destroy unknown content by overwriting.
      throw new S3Error(`remote manifest is not mergeable (${validated.error}); refusing to overwrite it — use force upload to replace it deliberately`, 'manifest');
    }
    const head = await s3Head(s3, key, signal);
    ifMatch = head.exists ? head.etag : undefined;
  } catch (error) {
    if (s3ErrorCode(error) !== 'not-found') throw error;
  }

  const local = localManifest(ctx, config, revision + 1);
  const merged = force || remoteManifest === null
    ? local
    : { ...local, ...mergeManifests(local, remoteManifest, { preferRemotePatch: false }), revision: revision + 1 };
  const body = serializeManifest(merged);
  const { etag } = await s3Put(s3, key, body, {
    signal,
    ifMatch,
    serverSideEncryption: s3.serverSideEncryption === true,
  });
  const result = { revision: merged.revision, bytes: body.length, packages: Object.keys(merged.packages).length, etag, profile, force };
  if (!force && remoteManifest !== null) {
    const preserved = Object.keys(remoteManifest.packages).filter((name) => local.packages[name] === undefined);
    if (preserved.length > 0) result.preservedRemotePackages = preserved;
    const keptLocal = Object.entries(local.packages)
      .filter(([name, version]) => remoteManifest.packages[name] !== undefined && remoteManifest.packages[name] !== version && compareVersions(version, remoteManifest.packages[name]) > 0)
      .map(([name]) => name);
    if (keptLocal.length > 0) result.keptLocalVersions = keptLocal;
  }
  if (force && remoteManifest !== null) {
    const dropped = Object.keys(remoteManifest.packages).filter((name) => local.packages[name] === undefined);
    if (dropped.length > 0) result.droppedRemotePackages = dropped;
  }
  return result;
}

/** Download + validate, without applying. */
async function fetchRemote(ctx, config, signal) {
  const s3 = requireS3Config(config);
  const creds = await credentialsOf(ctx, config);
  if (creds !== undefined) Object.assign(s3, { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey });
  const profileDir = resolveProfileDir(ctx);
  const profile = profileNameOf(profileDir);
  const key = manifestKey(s3, profile);
  const bytes = await s3Get(s3, key, signal);
  const validated = validateManifestBytes(bytes);
  if (!validated.ok) throw new S3Error(validated.error, 'manifest');
  return { manifest: validated.manifest, profile, bytes: bytes.length };
}

/** Preview: remote manifest + diff against local. No writes. mode='replace'
 * previews what a force apply would do (with removals/downgrades listed). */
async function previewDiff(ctx, config, signal, { mode = 'merge' } = {}) {
  const { manifest } = await fetchRemote(ctx, config, signal);
  const local = localManifest(ctx, config, manifest.revision);
  const plan = diffManifests(local, manifest, { mode });
  return { remote: summarize(manifest), plan, mode: plan.mode };
}

function summarize(manifest) {
  return {
    revision: manifest.revision,
    updatedAt: manifest.updatedAt,
    source: manifest.source?.label ?? null,
    dshVersion: manifest.runtime?.dshVersion ?? null,
    packages: Object.keys(manifest.packages).length,
    includesPatchConfig: manifest.patch?.kind === 'text',
  };
}

/** Apply flow (MERGE default / REPLACE opt-in): snapshot → merge or mirror → orchestrate.
 *
 * Default merge: the remote manifest is applied additively — local-only
 * plugins, higher local versions, and local provider config blocks all
 * survive; only additions and version upgrades are written and orchestrated.
 *
 * mode='replace' (force, explicit per-request opt-in): the local profile
 * mirrors the remote manifest exactly — local-only third-party plugins are
 * removed, older remote versions are installed (explicit downgrade). This
 * is the "make local match remote" escape hatch; a snapshot is still taken
 * first so rollback remains possible.
 */
async function applyRemote(ctx, config, signal, { mode = 'merge' } = {}) {
  const { manifest } = await fetchRemote(ctx, config, signal);
  const local = localManifest(ctx, config, manifest.revision);
  const plan = diffManifests(local, manifest, { mode });
  if (plan.empty) return { applied: false, reason: 'already-in-sync', plan };
  const profileDir = resolveProfileDir(ctx);
  const snapshotId = createSnapshot(profileDir);
  writeProfileFiles(profileDir, manifest, { mode: plan.mode });

  const pluginManager = ctx.get('pluginManager');
  let installs = [];
  let orchestrated = false;
  if (pluginManager !== undefined && typeof pluginManager.installBundle === 'function') {
    orchestrated = true;
    installs = await orchestrateInstalls(pluginManager, plan, { signal });
  }
  return {
    applied: true,
    snapshotId,
    plan,
    orchestrated,
    installs,
    note: orchestrated ? undefined : 'dependency changes written to package.json; run your plugin manager or restart to materialize them',
  };
}

/** ---------- HTTP layer (the settings page talks to these) ---------- */

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function loopbackAuthority(host) {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function sameOrigin(request) {
  const host = request.headers.host;
  if (host !== undefined && !loopbackAuthority(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Mask an access key for display: first 2 + … + last 2, or fully masked when very short. */
function maskKey(key) {
  if (key.length <= 4) return '****';
  return `${key.slice(0, 2)}…${key.slice(-2)}`;
}

function requestAbortSignal(request) {
  // Abort route work when the client disconnects, when the runtime exposes it.
  const signals = [request.destroyed ? AbortSignal.abort() : undefined, typeof AbortSignal !== 'undefined' ? AbortSignal.none : undefined];
  return signals.find((s) => s !== undefined);
}

/**
 * Merge same-origin POSTed form values over the loader config. Accepts both
 * shapes the client has historically sent — nested (config.s3.endpoint) and
 * flat (config.endpoint). Only known keys survive; secret values are never
 * merged from the request (credentials live in the private store/env only).
 */
function mergedConfig(base, overrides) {
  if (overrides === null || typeof overrides !== 'object') return base ?? {};
  const s3 = { ...(base?.s3 ?? {}) };
  const automation = { ...(base?.automation ?? {}) };
  const form = overrides.config ?? overrides;
  const S3_KEYS = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'allowInsecure', 'serverSideEncryption'];
  const AUTOMATION_KEYS = ['autoUpload', 'uploadDebounceSeconds', 'autoCheck', 'checkIntervalMinutes'];
  for (const key of S3_KEYS) {
    const value = form?.s3?.[key] ?? form?.[`s3.${key}`] ?? form?.[key];
    if (value !== undefined) s3[key] = value;
  }
  for (const key of AUTOMATION_KEYS) {
    const value = form?.automation?.[key] ?? form?.[`automation.${key}`] ?? form?.[key];
    if (value !== undefined) automation[key] = value;
  }
  // Credentials have a separate same-origin endpoint and are never accepted
  // from ordinary config payloads or written to settings.json.
  delete s3.accessKeyId;
  delete s3.secretAccessKey;
  const merged = { ...(base ?? {}), s3, automation };
  if (form?.includePatchConfig !== undefined) merged.includePatchConfig = form.includePatchConfig === true;
  if (form?.machineLabel !== undefined) merged.machineLabel = typeof form.machineLabel === 'string' ? form.machineLabel : undefined;
  return merged;
}

/** Persisted settings override loader defaults when a user has saved them. */
function effectiveConfig(ctx, loaderConfig) {
  const persisted = loadSettings(resolveProfileDir(ctx));
  return persisted === null ? (loaderConfig ?? {}) : mergedConfig(loaderConfig, { config: persisted });
}

function mountRoutes(ctx, configRef, automation) {
  ctx.inject(['webServer'], (hostCtx) => {
    const disposers = [];
    const route = (path, handler) => {
      const disposer = hostCtx.webServer.register({ kind: 'exact', path, handler });
      disposers.push(() => disposer?.());
    };

    const wrap = (fn) => async (request, response) => {
      try {
        await fn(request, response);
      } catch (error) {
        const code = error instanceof S3Error ? error.code : s3ErrorCode(error);
        sendJson(response, 500, { ok: false, error: { code, message: String(error?.message ?? error) } });
      }
    };

    route(`${ROUTE_BASE}/status`, wrap(async (request, response) => {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
      const config = configRef();
      const profileDir = resolveProfileDir(ctx);
      const local = localManifest(ctx, config, 0);
      const saved = loadCredentials(profileDir);
      sendJson(response, 200, {
        ok: true,
        version: selfVersion(),
        profile: profileNameOf(profileDir),
        configured: typeof config?.s3?.endpoint === 'string' && config.s3.endpoint !== '' && typeof config?.s3?.bucket === 'string' && config.s3.bucket !== '',
        local: { packages: Object.keys(local.packages).length, bundles: local.bundles.length, includesPatchConfig: config?.includePatchConfig === true },
        snapshots: listSnapshots(profileDir).slice(0, 5),
        settings: loadSettings(profileDir),
        automation: automation.snapshot(),
        // Credential presence only — never the values.
        credentials: {
          source: credentialsSource(profileDir),
          accessKeyIdMasked: saved !== null ? maskKey(saved.accessKeyId) : undefined,
        },
      });
    }));

    route(`${ROUTE_BASE}/config`, wrap(async (request, response) => {
      if (!['GET', 'PUT'].includes(request.method)) { response.writeHead(405, { allow: 'GET, PUT' }); response.end(); return; }
      if (request.method === 'PUT' && !sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const profileDir = resolveProfileDir(ctx);
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, settings: loadSettings(profileDir), automation: automation.snapshot() });
        return;
      }
      const body = await readJsonBody(request);
      const requested = body?.settings ?? body?.config ?? body;
      const settings = saveSettings(profileDir, mergedConfig(configRef(), { config: requested }));
      automation.reconfigure();
      sendJson(response, 200, { ok: true, settings, automation: automation.snapshot() });
    }));

    route(`${ROUTE_BASE}/credentials`, wrap(async (request, response) => {
      if (!['GET', 'PUT', 'DELETE'].includes(request.method)) { response.writeHead(405, { allow: 'GET, PUT, DELETE' }); response.end(); return; }
      if (request.method !== 'GET' && !sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const profileDir = resolveProfileDir(ctx);
      if (request.method === 'GET') {
        const saved = loadCredentials(profileDir);
        sendJson(response, 200, { ok: true, source: credentialsSource(profileDir), accessKeyIdMasked: saved !== null ? maskKey(saved.accessKeyId) : undefined });
        return;
      }
      if (request.method === 'DELETE') {
        clearCredentials(profileDir);
        sendJson(response, 200, { ok: true, source: credentialsSource(profileDir) });
        return;
      }
      const body = await readJsonBody(request);
      if (typeof body?.accessKeyId !== 'string' || typeof body?.secretAccessKey !== 'string') {
        sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: 'accessKeyId and secretAccessKey required' } });
        return;
      }
      try {
        saveCredentials(profileDir, body.accessKeyId, body.secretAccessKey);
        const saved = loadCredentials(profileDir);
        sendJson(response, 200, { ok: true, source: 'saved', accessKeyIdMasked: maskKey(saved.accessKeyId) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { code: 'bad-credentials', message: String(error?.message ?? error) } });
      }
    }));

    route(`${ROUTE_BASE}/upload`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const overrides = await readJsonBody(request).catch(() => ({}));
      const force = overrides?.force === true || overrides?.config?.force === true;
      const result = await uploadManifest(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request), { force });
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/preview`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const overrides = await readJsonBody(request).catch(() => ({}));
      const mode = overrides?.mode === 'replace' ? 'replace' : 'merge';
      const result = await previewDiff(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request), { mode });
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/apply`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const overrides = await readJsonBody(request).catch(() => ({}));
      const mode = overrides?.mode === 'replace' ? 'replace' : 'merge';
      if (mode === 'replace' && overrides?.confirmReplace !== true) {
        sendJson(response, 400, { ok: false, error: { code: 'confirm-required', message: 'replace mode requires confirmReplace: true — re-preview the removals/downgrades and confirm deliberately' } });
        return;
      }
      // Applying a remote state writes the watched profile files. Suppress the
      // watcher briefly so that receiving a remote revision never echoes it
      // back as an automatic local upload.
      automation.suppressUploads();
      const result = await applyRemote(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request), { mode });
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/rollback`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const body = await readJsonBody(request);
      if (typeof body?.snapshotId !== 'string') { sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: 'snapshotId required' } }); return; }
      const profileDir = resolveProfileDir(ctx);
      // A rollback is an intentional local recovery action, not a change that
      // should immediately overwrite the shared manifest in the background.
      automation.suppressUploads();
      const result = restoreSnapshot(profileDir, body.snapshotId);
      sendJson(response, 200, { ok: true, ...result });
    }));

    return () => { for (const d of disposers) d(); };
  });
}

/** ---------- command surface ---------- */

function mountCommand(ctx, configRef) {
  ctx.inject(['commands'], (cmdCtx) => {
    const off = cmdCtx.commands.register({
      name: 'plugin-sync',
      description: 'Sync the plugin list of this DSH client to/from S3 (dsh-plugin-list-sync)',
      async execute(agent, line, signal) {
        const words = line.trim().split(/\s+/).filter(Boolean);
        const arg = words[0] ?? '';
        const force = words.includes('--force');
        const config = configRef();
        try {
          if (arg === 'status') {
            const s3 = s3ConfigOf(config);
            const local = localManifest(ctx, config, 0);
            return { text: `profile=${profileNameOf(resolveProfileDir(ctx))} packages=${Object.keys(local.packages).length} endpoint=${s3.endpoint ?? '(unset)'}` };
          }
          if (arg === 'upload') {
            const result = await uploadManifest(ctx, config, signal, { force });
            const lines = [`uploaded revision ${result.revision} (${result.packages} packages, ${result.bytes} bytes)${force ? ' [FORCE replace]' : ''}`];
            if (result.preservedRemotePackages?.length) lines.push(`  preserved remote-only: ${result.preservedRemotePackages.join(', ')}`);
            if (result.keptLocalVersions?.length) lines.push(`  kept higher local versions: ${result.keptLocalVersions.join(', ')}`);
            if (result.droppedRemotePackages?.length) lines.push(`  DROPPED remote-only (force): ${result.droppedRemotePackages.join(', ')}`);
            return { text: lines.join('\n') };
          }
          if (arg === 'diff' || arg === 'preview') {
            const { remote, plan } = await previewDiff(ctx, config, signal, { mode: force ? 'replace' : 'merge' });
            if (plan.empty) return { text: 'in sync — no differences' };
            return { text: [
              `remote revision ${remote.revision} (${remote.updatedAt}${remote.source ? ` by ${remote.source}` : ''}) [${plan.mode}]${force ? ' [FORCE replace]' : ''}:`,
              plan.installs.map((e) => `  + ${e.name}@${e.version}`).join('\n'),
              plan.upgrades.map((e) => `  ↑ ${e.name} ${e.from} → ${e.to}`).join('\n'),
              plan.downgrades.map((e) => `  ↓ ${e.name} ${e.from} → ${e.to}`).join('\n'),
              plan.removals.map((e) => `  - ${e.name} (uninstall)`).join('\n'),
              plan.keptLocal.map((e) => `  = ${e.name} ${e.local} (remote ${e.remote} is older; local kept)`).join('\n'),
              plan.localOnly.map((e) => `  • ${e.name}@${e.version} stays local-only (merge never removes)`).join('\n'),
              plan.patchDiffers ? '  ~ cordis.patch.yml differs' : '',
            ].filter(Boolean).join('\n') };
          }
          if (arg === 'pull' || arg === 'apply') {
            if (force) return { text: 'refusing --force pull from the command surface: open the settings page, tick "force overwrite local" and confirm the removals there, or run without --force for a merge' };
            const result = await applyRemote(ctx, config, signal);
            if (!result.applied) return { text: `nothing to apply (${result.reason})` };
            const lines = [`applied remote manifest (snapshot ${result.snapshotId})`];
            for (const r of result.installs) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.action} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
            if (result.note !== undefined) lines.push(result.note);
            return { text: lines.join('\n') };
          }
          if (arg === 'rollback') {
            const id = line.trim().split(/\s+/)[1];
            const profileDir = resolveProfileDir(ctx);
            const result = restoreSnapshot(profileDir, id);
            return { text: `restored ${result.restored}` };
          }
          return { text: 'usage: /plugin-sync status | upload [--force] | diff [--force] | pull | rollback [snapshot-id]  (--force on upload replaces the remote; default is merge)' };
        } catch (error) {
          return { text: `plugin-sync failed: ${String(error?.message ?? error)}` };
        }
      },
    });
    return () => off?.();
  });
}

/** ---------- entry ---------- */

export function apply(ctx, config) {
  // The loader config is a fallback. Once a user saves the settings page,
  // effectiveConfig reads the profile-local non-secret settings file so Host
  // automation continues even with no browser page attached.
  let current = config ?? {};
  const configRef = () => effectiveConfig(ctx, current);
  const profileDir = resolveProfileDir(ctx);

  // The controller intentionally receives no apply/rollback function. It can
  // only upload a local settled state or mark a remote diff for human review.
  const automation = createAutomationController({
    profileDir,
    getConfig: configRef,
    upload: async (next) => uploadManifest(ctx, next, AbortSignal.none),
    checkRemote: async (next) => previewDiff(ctx, next, AbortSignal.none),
  });

  const disposers = [
    mountRoutes(ctx, configRef, automation),
    mountCommand(ctx, configRef),
  ];

  return () => {
    automation.dispose();
    for (const d of disposers) {
      try { d?.(); } catch { /* disposal is best-effort */ }
    }
  };
}


