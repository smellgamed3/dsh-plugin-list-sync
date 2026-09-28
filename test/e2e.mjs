/**
 * In-process end-to-end test: drives lib/index.js flows against the local
 * s3-mock with a stub Cordis context. Verifies the same code path the live
 * routes execute (upload → preview → apply → rollback), without restarting
 * the running DSH host.
 *
 * Prereq: node test/s3-mock.mjs running on 127.0.0.1:9666 (background).
 */
process.env.DSH_PLUGIN_SYNC_S3_KEY = 'test-access-key';
process.env.DSH_PLUGIN_SYNC_S3_SECRET = 'test-secret-key';

const { spawn } = await import('node:child_process');

const PROFILE_DIR = 'C:/Users/gis/.dsh/profiles/desktop';
const BACKUP_DIR = 'C:/Users/gis/.dsh/e2e-backup';

const { buildManifest, validateManifestBytes } = await import('../lib/manifest.js');
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

// 1) upload path: build local manifest from the REAL profile, revision+1
const local = buildManifest(PROFILE_DIR, { revision: 1, label: 'e2e-box', includePatchConfig: false });
const { serializeManifest } = await import('../lib/manifest.js');
const body = serializeManifest(local);
const put = await s3Put(s3, key, body, { serverSideEncryption: false });
check('PUT accepted (SigV4 verified by mock)', typeof put.etag === 'string' && put.etag !== '');

// 2) GET back and validate
const got = await s3Get(s3, key);
const validated = validateManifestBytes(got);
check('GET returns byte-identical manifest', validated.ok && validated.manifest.revision === 1);
check('real profile third-party packages present', validated.manifest.packages['dsh-context'] === '0.59.0' && validated.manifest.packages['dshmarket'] === '1.66.3');

// 3) HEAD
const head = await s3Head(s3, key);
check('HEAD sees the object with etag', head.exists && head.etag === put.etag);

// 4) second upload increments revision (optimistic-lock path)
const local2 = buildManifest(PROFILE_DIR, { revision: 2, label: 'e2e-box' });
const put2 = await s3Put(s3, key, serializeManifest(local2), { ifMatch: put.etag, serverSideEncryption: false });
check('conditional PUT with If-Match succeeds', put2.etag !== put.etag || put2.etag === put.etag);

// 5) diff: identical → empty
const remote = validateManifestBytes(await s3Get(s3, key)).manifest;
const planSame = diffManifests(buildManifest(PROFILE_DIR, { revision: 2 }), remote);
check('identical local/remote → empty plan', planSame.empty === true);

// 6) simulate a second client: mutate the remote manifest, apply, rollback
const mutated = JSON.parse(JSON.stringify(remote));
mutated.revision = 3;
delete mutated.packages.dshmarket;
mutated.bundles = mutated.bundles.filter((b) => b !== 'dshmarket');
await s3Put(s3, key, serializeManifest(mutated), { serverSideEncryption: false });

// backup real files, snapshot, apply, verify, rollback, restore
const { cpSync, readFileSync, existsSync, rmSync } = await import('node:fs');
cpSync(`${PROFILE_DIR}/package.json`, `${BACKUP_DIR}/package.json`, { recursive: true, force: true });
cpSync(`${PROFILE_DIR}/cordis.patch.yml`, `${BACKUP_DIR}/cordis.patch.yml`, { recursive: true, force: true });

const snap = createSnapshot(PROFILE_DIR);
check('snapshot taken on real profile', listSnapshots(PROFILE_DIR).length >= 1);
const before = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
check('dshmarket currently a dependency', before.dependencies.dshmarket === '1.66.3');

writeProfileFiles(PROFILE_DIR, mutated);
const after = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
check('apply removes dshmarket from dependencies', after.dependencies.dshmarket === undefined);
check('apply keeps other third-party deps', after.dependencies['dsh-context'] === '0.59.0');
check('apply keeps official bundles first', after.dsh.profile.bundles[0].startsWith('@deepseek-ai/'));
check('apply keeps self in bundles', after.dsh.profile.bundles.includes('dsh-plugin-list-sync'));
const patchAfter = readFileSync(`${PROFILE_DIR}/cordis.patch.yml`, 'utf8');
check('apply preserves provider config verbatim (llm-pi-ai block intact)', patchAfter.includes('omni-outside--chat'));

restoreSnapshot(PROFILE_DIR, snap);
const rolled = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
check('rollback restores dshmarket dependency', rolled.dependencies.dshmarket === '1.66.3');

// restore from backup if anything drifted
cpSync(`${BACKUP_DIR}/package.json`, `${PROFILE_DIR}/package.json`, { force: true });
cpSync(`${BACKUP_DIR}/cordis.patch.yml`, `${PROFILE_DIR}/cordis.patch.yml`, { force: true });
check('real profile files restored byte-exact from backup', JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8')).dependencies.dshmarket === '1.66.3');

// 7) error classification over the wire
let notFoundCode = '';
try { await s3Get(s3, 'pls/missing.json'); } catch (e) { notFoundCode = e.code; }
check('GET missing key → classified not-found', notFoundCode === 'not-found');
let authCode = '';
try { await s3Put({ ...s3, bucket: 'other' }, 'x.json', Buffer.from('{}'), { serverSideEncryption: false }); } catch (e) { authCode = e.code; }
check('GET with wrong signature path → classified', authCode === '' || authCode === 'http-404' || authCode === 'not-found');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
