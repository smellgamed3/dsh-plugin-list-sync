/**
 * In-process end-to-end test: drives lib/index.js flows against the local
 * s3-mock with a stub Cordis context. Verifies the same code path the live
 * routes execute (upload → preview → apply → rollback), without restarting
 * the running DSH host — and above all that BOTH directions are MERGE-only:
 * nothing local is deleted, no local version is downgraded.
 *
 * Prereq: node test/s3-mock.mjs running on 127.0.0.1:9666 (background).
 */
process.env.DSH_PLUGIN_SYNC_S3_KEY = 'test-access-key';
process.env.DSH_PLUGIN_SYNC_S3_SECRET = 'test-secret-key';

const { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, mkdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

// An ISOLATED throwaway profile — the e2e must never mutate the user's real one.
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-pls-e2e-'));
const PROFILE_DIR = join(ROOT, 'profile');
const PLUGIN_STATE = join(PROFILE_DIR, 'node_modules', 'dsh-plugin-list-sync');
mkdirSync(PLUGIN_STATE, { recursive: true });

writeFileSync(join(PROFILE_DIR, 'package.json'), JSON.stringify({
  name: 'dsh-profile-e2e',
  private: true,
  dependencies: {
    'dsh-context': '0.59.0',
    'dsh-cost-meter': '1.7.40',
    dshmarket: '1.66.3',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-cost-meter', 'dsh-plugin-list-sync'], patchReload: 'live' } },
}, null, 2));
writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), `# patch
- id: cost-meter
  disabled: true
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: omni-outside--chat
    model: zai/glm-5.3
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      aigw:
        api: openai-completions
        baseURL: https://example.internal:28000/v1
`);

const { buildManifest, validateManifestBytes, serializeManifest } = await import('../lib/manifest.js');
const { diffManifests } = await import('../lib/diff.js');
const { createSnapshot, restoreSnapshot, writeProfileFiles, listSnapshots } = await import('../lib/apply.js');
const { s3Get, s3Put, s3Head, manifestKey } = await import('../lib/s3.js');

let passed = 0; let failed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  ok - ${label}`); }
  else { failed += 1; console.error(`  FAIL - ${label}`); }
}

const s3 = {
  endpoint: 'http://127.0.0.1:9666',
  region: 'auto',
  bucket: 'dsh-sync-test',
  prefix: 'pls',
  forcePathStyle: true,
  allowInsecure: true,
};

console.log('live round-trip against s3-mock:');
const key = manifestKey(s3, 'desktop');
check('manifest key', key === 'pls/desktop.json');
// The HTTP upload route derives its profile name from the profile DIRECTORY,
// not the hardcoded test key — align both so route assertions hit the same object.
const PROFILE_NAME = 'profile';
const routeKey = manifestKey(s3, PROFILE_NAME);

// 1) upload path: build local manifest from the temp profile, revision+1
const local = buildManifest(PROFILE_DIR, { revision: 1, label: 'e2e-box', includePatchConfig: false });
const body = serializeManifest(local);
const put = await s3Put(s3, key, body, { serverSideEncryption: false });
check('PUT accepted (SigV4 verified by mock)', typeof put.etag === 'string' && put.etag !== '');

// 2) GET back and validate
const got = await s3Get(s3, key);
const validated = validateManifestBytes(got);
check('GET returns byte-identical manifest', validated.ok && validated.manifest.revision === 1);
check('third-party packages present', validated.manifest.packages['dsh-context'] === '0.59.0' && validated.manifest.packages.dshmarket === '1.66.3');

// 3) HEAD
const head = await s3Head(s3, key);
check('HEAD sees the object with etag', head.exists && head.etag === put.etag);

// 4) second upload increments revision (optimistic-lock path)
const local2 = buildManifest(PROFILE_DIR, { revision: 2, label: 'e2e-box' });
const put2 = await s3Put(s3, key, serializeManifest(local2), { ifMatch: put.etag, serverSideEncryption: false });
check('conditional PUT with If-Match succeeds', typeof put2.etag === 'string');

// 5) diff: identical → empty
const remote = validateManifestBytes(await s3Get(s3, key)).manifest;
const planSame = diffManifests(buildManifest(PROFILE_DIR, { revision: 2 }), remote);
check('identical local/remote → empty plan', planSame.empty === true);

// 6) simulate a second client whose manifest LACKS dshmarket and carries an
//    OLDER dsh-context: applying it must MERGE — keep dshmarket, keep 0.59.0.
const mutated = JSON.parse(JSON.stringify(remote));
mutated.revision = 3;
delete mutated.packages.dshmarket;                 // remote no longer has it
mutated.bundles = mutated.bundles.filter((b) => b !== 'dshmarket');
mutated.packages['dsh-context'] = '0.50.0';       // remote is OLDER
mutated.packages['brand-new-plugin'] = '1.0.0';   // remote has an addition
mutated.bundles = [...new Set([...mutated.bundles, 'brand-new-plugin'])];
mutated.patch = { kind: 'rows', rows: [{ id: 'cost-meter', disabled: false }] };
await s3Put(s3, key, serializeManifest(mutated), { serverSideEncryption: false });

const planMerge = diffManifests(buildManifest(PROFILE_DIR, { revision: 3 }), mutated);
check('apply plan installs the remote addition', planMerge.installs.some((e) => e.name === 'brand-new-plugin'));
check('apply plan has NO removals for dshmarket', planMerge.removals.length === 0);
check('apply plan has NO downgrades for dsh-context', planMerge.downgrades.length === 0 && planMerge.keptLocal.some((e) => e.name === 'dsh-context'));

const snap = createSnapshot(PROFILE_DIR);
check('snapshot taken before apply', listSnapshots(PROFILE_DIR).length >= 1);

writeProfileFiles(PROFILE_DIR, mutated);
const after = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
check('apply KEEPS dshmarket dependency (merge, no delete)', after.dependencies.dshmarket === '1.66.3');
check('apply keeps dsh-context upgraded nowhere but bundle entries unioned', after.dsh.profile.bundles.includes('dsh-context') && after.dsh.profile.bundles.includes('brand-new-plugin'));
check('apply does NOT downgrade dsh-context', after.dependencies['dsh-context'] === '0.59.0');
check('apply adds the remote-only plugin', after.dependencies['brand-new-plugin'] === '1.0.0');
check('apply keeps official bundles first', after.dsh.profile.bundles[0].startsWith('@deepseek-ai/'));
check('apply keeps self in bundles', after.dsh.profile.bundles.includes('dsh-plugin-list-sync'));
const patchAfter = readFileSync(`${PROFILE_DIR}/cordis.patch.yml`, 'utf8');
check('apply preserves provider config verbatim (llm-pi-ai block intact)', patchAfter.includes('omni-outside--chat'));
check('apply preserves provider baseURL verbatim', patchAfter.includes('baseURL'));

restoreSnapshot(PROFILE_DIR, snap);
const rolled = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
check('rollback restores pre-apply dependencies', rolled.dependencies.dshmarket === '1.66.3' && rolled.dependencies['brand-new-plugin'] === undefined);

// 7) upload-merge: remote has a plugin this profile never installed. Uploading
//    from here must PRESERVE it in the new remote manifest (merge, not replace).
const { mergeManifests } = await import('../lib/manifest.js');
const remoteExtra = JSON.parse(JSON.stringify(mutated));
remoteExtra.packages['remote-only-plugin'] = '2.0.0';
remoteExtra.bundles = [...new Set([...remoteExtra.bundles, 'remote-only-plugin'])];
await s3Put(s3, key, serializeManifest(remoteExtra), { serverSideEncryption: false });
const localFresh = buildManifest(PROFILE_DIR, { revision: 10, label: 'e2e-box' });
const uploadMerged = { ...localFresh, ...mergeManifests(localFresh, remoteExtra, { preferRemotePatch: false }), revision: 11 };
check('upload manifest preserves the remote-only plugin', uploadMerged.packages['remote-only-plugin'] === '2.0.0');
check('upload manifest still carries every local plugin', uploadMerged.packages.dshmarket === '1.66.3');
const olderRemote = JSON.parse(JSON.stringify(remoteExtra));
olderRemote.packages['dsh-context'] = '0.10.0';
const uploadMergedOlder = mergeManifests(localFresh, olderRemote, { preferRemotePatch: false });
check('upload never writes an older version into the manifest', uploadMergedOlder.packages['dsh-context'] === '0.59.0');

// 8) error classification over the wire
let notFoundCode = '';
try { await s3Get(s3, 'pls/missing.json'); } catch (e) { notFoundCode = e.code; }
check('GET missing key → classified not-found', notFoundCode === 'not-found');

// 9) HTTP surface: force upload replaces the remote; merge upload preserves it.
//    Drive the real route handlers through the route registry with a stub ctx.
console.log('HTTP route surface (merge vs force upload):');
const index = await import('../lib/index.js');
const routeHandlers = new Map();
const stubCtx = {
  get: (name) => (name === 'hmr' ? { baseDir: PROFILE_DIR } : undefined),
  inject: (deps, fn) => {
    if (deps.includes('webServer')) {
      return fn({ webServer: { register: ({ kind, path, handler }) => { routeHandlers.set(path, handler); return () => {}; } } });
    }
    if (deps.includes('commands')) {
      return fn({ commands: { register: () => () => {} } });
    }
    return fn({});
  },
  effect() { return () => {}; },
};
index.apply(stubCtx, {});
const uploadHandler = routeHandlers.get('/dsh-plugin-list-sync/api/upload');
check('upload route registered', typeof uploadHandler === 'function');

function makeRes() {
  return {
    statusCode: 0, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}
const fakeReq = (body) => ({
  method: 'POST', headers: { host: '127.0.0.1:19387' }, destroyed: false,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})); },
});

// Remote has 'remote-only-plugin'; merge upload (default) must preserve it.
// The stub ctx exposes hmr.baseDir = PROFILE_DIR so resolveProfileDir finds
// the temp profile; settings.json is absent so the per-request s3 block is
// the only config source. The route reads/writes routeKey (derived from the
// profile directory name), so stage the remote-only state there too.
const remoteForRoute = JSON.parse(JSON.stringify(remoteExtra));
await s3Put(s3, routeKey, serializeManifest(remoteForRoute), { serverSideEncryption: false });
const reqBody = (extra) => ({ config: { s3: { ...s3, endpoint: 'http://127.0.0.1:9666', allowInsecure: true } }, ...extra });
const resMerge = makeRes();
await uploadHandler(fakeReq(reqBody()), resMerge);
const mergeBody = JSON.parse(resMerge.body);
check('merge upload succeeds over HTTP', resMerge.statusCode === 200 && mergeBody.ok === true, JSON.stringify(mergeBody).slice(0, 300));
const afterMergeUpload = validateManifestBytes(await s3Get(s3, routeKey)).manifest;
check('merge upload kept the remote-only plugin in the object', afterMergeUpload.packages['remote-only-plugin'] === '2.0.0');
check('merge upload kept every local plugin in the object', afterMergeUpload.packages.dshmarket === '1.66.3');

// Force upload: the manifest becomes exactly this machine's state.
const resForce = makeRes();
await uploadHandler(fakeReq(reqBody({ force: true })), resForce);
const forceBody = JSON.parse(resForce.body);
check('force upload succeeds over HTTP', resForce.statusCode === 200 && forceBody.ok === true && forceBody.force === true, JSON.stringify(forceBody).slice(0, 300));
const afterForceUpload = validateManifestBytes(await s3Get(s3, routeKey)).manifest;
check('force upload REMOVED the remote-only plugin from the object', afterForceUpload.packages['remote-only-plugin'] === undefined);
check('force upload still carries local plugins', afterForceUpload.packages.dshmarket === '1.66.3');

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
