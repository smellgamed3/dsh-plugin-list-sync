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
import { buildManifest, validateManifestBytes, serializeManifest, parsePatchRows, SELF_PACKAGE } from './manifest.js';
import { diffManifests } from './diff.js';
import { createSnapshot, listSnapshots, restoreSnapshot, writeProfileFiles, orchestrateInstalls } from './apply.js';
import { s3Get, s3Put, s3Head, s3ErrorCode, manifestKey, S3Error } from './s3.js';
import { loadCredentials, saveCredentials, clearCredentials, credentialsSource } from './credentials-store.js';

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

/** Upload flow: GET current revision → build revision+1 → PUT. */
async function uploadManifest(ctx, config, signal) {
  const s3 = requireS3Config(config);
  const creds = await credentialsOf(ctx, config);
  if (creds !== undefined) Object.assign(s3, { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey });
  const profileDir = resolveProfileDir(ctx);
  const profile = profileNameOf(profileDir);
  const key = manifestKey(s3, profile);

  let revision = 0;
  let ifMatch;
  try {
    const remote = await s3Get(s3, key, signal);
    const validated = validateManifestBytes(remote);
    if (validated.ok) revision = validated.manifest.revision;
    const head = await s3Head(s3, key, signal);
    ifMatch = head.exists ? head.etag : undefined;
  } catch (error) {
    if (s3ErrorCode(error) !== 'not-found') throw error;
  }

  const manifest = localManifest(ctx, config, revision + 1);
  const body = serializeManifest(manifest);
  const { etag } = await s3Put(s3, key, body, { signal, ifMatch });
  return { revision: manifest.revision, bytes: body.length, packages: Object.keys(manifest.packages).length, etag, profile };
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

/** Preview: remote manifest + diff against local. No writes. */
async function previewDiff(ctx, config, signal) {
  const { manifest } = await fetchRemote(ctx, config, signal);
  const local = localManifest(ctx, config, manifest.revision);
  const plan = diffManifests(local, manifest);
  return { remote: summarize(manifest), plan };
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

/** Apply flow: snapshot → write files → orchestrate installs. */
async function applyRemote(ctx, config, signal) {
  const { manifest } = await fetchRemote(ctx, config, signal);
  const local = localManifest(ctx, config, manifest.revision);
  const plan = diffManifests(local, manifest);
  if (plan.empty) return { applied: false, reason: 'already-in-sync', plan };
  const profileDir = resolveProfileDir(ctx);
  const snapshotId = createSnapshot(profileDir);
  writeProfileFiles(profileDir, manifest);

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
 * Merge same-origin POSTed form values over the loader config. Only known
 * keys survive; secret values are never merged from the request (credentials
 * enter through env vars or the credentials service ref only).
 */
function mergedConfig(base, overrides) {
  if (overrides === null || typeof overrides !== 'object') return base ?? {};
  const s3 = { ...(base?.s3 ?? {}) };
  const form = overrides.config ?? overrides;
  const S3_KEYS = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'allowInsecure'];
  for (const key of S3_KEYS) {
    const value = form?.s3?.[key] ?? form?.[`s3.${key}`];
    if (value === undefined) continue;
    s3[key] = value;
  }
  delete s3.accessKeyId;
  delete s3.secretAccessKey;
  const merged = { ...(base ?? {}), s3 };
  if (form?.includePatchConfig !== undefined) merged.includePatchConfig = form.includePatchConfig === true;
  if (form?.machineLabel !== undefined) merged.machineLabel = typeof form.machineLabel === 'string' ? form.machineLabel : undefined;
  return merged;
}

function mountRoutes(ctx, configRef) {
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
        // Credential presence only — never the values.
        credentials: {
          source: credentialsSource(profileDir),
          accessKeyIdMasked: saved !== null ? maskKey(saved.accessKeyId) : undefined,
        },
      });
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
      const result = await uploadManifest(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request));
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/preview`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const overrides = await readJsonBody(request).catch(() => ({}));
      const result = await previewDiff(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request));
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/apply`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const overrides = await readJsonBody(request).catch(() => ({}));
      const result = await applyRemote(ctx, mergedConfig(configRef(), overrides), requestAbortSignal(request));
      sendJson(response, 200, { ok: true, ...result });
    }));

    route(`${ROUTE_BASE}/rollback`, wrap(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'untrusted-origin', message: 'untrusted origin' } }); return; }
      const body = await readJsonBody(request);
      if (typeof body?.snapshotId !== 'string') { sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: 'snapshotId required' } }); return; }
      const profileDir = resolveProfileDir(ctx);
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
        const arg = line.trim().split(/\s+/)[0] ?? '';
        const config = configRef();
        try {
          if (arg === 'status') {
            const s3 = s3ConfigOf(config);
            const local = localManifest(ctx, config, 0);
            return { text: `profile=${profileNameOf(resolveProfileDir(ctx))} packages=${Object.keys(local.packages).length} endpoint=${s3.endpoint ?? '(unset)'}` };
          }
          if (arg === 'upload') {
            const result = await uploadManifest(ctx, config, signal);
            return { text: `uploaded revision ${result.revision} (${result.packages} packages, ${result.bytes} bytes)` };
          }
          if (arg === 'diff' || arg === 'preview') {
            const { remote, plan } = await previewDiff(ctx, config, signal);
            if (plan.empty) return { text: 'in sync — no differences' };
            return { text: [
              `remote revision ${remote.revision} (${remote.updatedAt}${remote.source ? ` by ${remote.source}` : ''}):`,
              plan.installs.map((e) => `  + ${e.name}@${e.version}`).join('\n'),
              plan.upgrades.map((e) => `  ↑ ${e.name} ${e.from} → ${e.to}`).join('\n'),
              plan.downgrades.map((e) => `  ↓ ${e.name} ${e.from} → ${e.to}`).join('\n'),
              plan.removals.map((e) => `  - ${e.name}`).join('\n'),
              plan.patchDiffers ? '  ~ cordis.patch.yml differs' : '',
            ].filter(Boolean).join('\n') };
          }
          if (arg === 'pull' || arg === 'apply') {
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
          return { text: 'usage: /plugin-sync status | upload | diff | pull | rollback [snapshot-id]' };
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
  // configRef: the live config object; cordis re-mounts on config edits, but
  // route/command closures read through this ref so a remount always sees
  // current values even if a stale fiber lingers one tick.
  let current = config ?? {};
  const configRef = () => current;

  const disposers = [
    mountRoutes(ctx, configRef),
    mountCommand(ctx, configRef),
  ];

  return () => {
    for (const d of disposers) {
      try { d?.(); } catch { /* disposal is best-effort */ }
    }
  };
}


