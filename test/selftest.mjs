/**
 * Self-test: exercises manifest build → validate → serialize → diff →
 * snapshot → write-back → restore against a COPY of the real profile's
 * files. Run: node test/selftest.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, validateManifestBytes, serializeManifest, parsePatchRows, mergeManifests, compareVersions } from '../lib/manifest.js';
import { diffManifests } from '../lib/diff.js';
import { createSnapshot, restoreSnapshot, writeProfileFiles, listSnapshots } from '../lib/apply.js';
import { manifestKey, normalizeEndpoint, validBucketName, validPrefix } from '../lib/s3.js';
import { saveCredentials, loadCredentials, clearCredentials, credentialsSource, credentialsPath } from '../lib/credentials-store.js';

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log(`  ok - ${label}`); }
  else { failed += 1; console.error(`  FAIL - ${label}`); }
}

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-pls-test-'));
// A representative profile: one official bundle, two third-party deps, a patch
// layer with a disabled row, a provider config row, and a structural row.
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-test',
  private: true,
  dependencies: {
    '@michengai/dsh-btw': '0.1.13',
    'dsh-context': '0.59.0',
    'dsh-cost-meter': '1.7.40',
    dshmarket: '1.66.3',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-cost-meter', '@michengai/dsh-btw'], patchReload: 'live' } },
}, null, 2));
writeFileSync(join(profileDir, 'cordis.patch.yml'), `# patch
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
console.log('manifest build:');
const manifest = buildManifest(profileDir, { revision: 7, label: 'test-box', includePatchConfig: false });check('official dep filtered', manifest.packages['@deepseek-ai/dsh-base'] === undefined);
check('third-party deps kept', manifest.packages['dsh-context'] === '0.59.0' && manifest.packages.dshmarket === '1.66.3');
check('official bundle filtered from bundles', manifest.bundles.every((b) => !b.startsWith('@deepseek-ai/')));
check('revision/label recorded', manifest.revision === 7 && manifest.source.label === 'test-box');
check('patch projected to rows (config excluded)', manifest.patch.kind === 'rows');
const costRow = manifest.patch.rows.find((r) => r.id === 'cost-meter');
check('disabled row preserved structurally', costRow !== undefined && costRow.disabled === true);
const providerRow = manifest.patch.rows.find((r) => r.id === 'llm-pi-ai');
check('provider config dropped by default', providerRow !== undefined && providerRow.config === undefined);

console.log('manifest validate/serialize round-trip:');
const bytes = serializeManifest(manifest);
const back = validateManifestBytes(bytes);
check('validates after serialize', back.ok === true && back.manifest.revision === 7);
const tampered = JSON.parse(bytes.toString('utf8'));
tampered.packages['evil<pkg>'] = '1.0.0';
check('tampered name rejected', validateManifestBytes(Buffer.from(JSON.stringify(tampered))).ok === false);
const oversize = validateManifestBytes(Buffer.concat([bytes, Buffer.alloc(600 * 1024)]));
check('oversize rejected', oversize.ok === false);

console.log('includePatchConfig=true:');
const withConfig = buildManifest(profileDir, { revision: 1, includePatchConfig: true });
check('patch carried as full text', withConfig.patch.kind === 'text' && withConfig.patch.text.includes('baseURL'));

console.log('diff:');
const remote = JSON.parse(bytes.toString('utf8'));
remote.revision = 8;
remote.packages['dsh-context'] = '0.60.0';
remote.packages['new-plugin'] = '1.0.0';
// NOTE: dshmarket deliberately STAYS in the remote manifest too — merge never
// drops it. The old "removal detected" scenario is structurally impossible now.
remote.packages.dshmarket = '1.66.3';
remote.bundles = ['dsh-context', 'dsh-cost-meter', '@michengai/dsh-btw', 'new-plugin'];
const plan = diffManifests(manifest, remote);
check('install detected', plan.installs.some((e) => e.name === 'new-plugin'));
check('upgrade detected', plan.upgrades.some((e) => e.name === 'dsh-context' && e.to === '0.60.0'));
check('merge plan has NO removals', plan.removals.length === 0);
check('merge plan has NO downgrades', plan.downgrades.length === 0);
check('plan not empty', plan.empty === false);
const planSame = diffManifests(manifest, JSON.parse(bytes.toString('utf8')));
check('identical manifests diff empty', planSame.empty === true);

console.log('merge semantics:');// Remote OLDER than local: local version must win, never a downgrade.
const remoteOlder = JSON.parse(bytes.toString('utf8'));
remoteOlder.packages['dsh-context'] = '0.55.0';
const planOlder = diffManifests(manifest, remoteOlder);
check('older remote version → keptLocal, no downgrade', planOlder.keptLocal.some((e) => e.name === 'dsh-context' && e.local === '0.59.0' && e.remote === '0.55.0'));
check('older remote version produces no upgrades for that package', !planOlder.upgrades.some((e) => e.name === 'dsh-context'));
// Local-only plugin: applying a remote manifest without it must not remove it.
const remoteWithoutMarket = JSON.parse(bytes.toString('utf8'));
delete remoteWithoutMarket.packages.dshmarket;
const planWithout = diffManifests(manifest, remoteWithoutMarket);
check('remote lacking a local package → still NO removals', planWithout.removals.length === 0);
check('local-only package reported for visibility', planWithout.localOnly.some((e) => e.name === 'dshmarket' && e.version === '1.66.3'));
// mergeManifests primitive: union + higher version wins.
const mergedPrim = mergeManifests(manifest, remoteOlder);
check('merge keeps union of packages', mergedPrim.packages['dsh-context'] !== undefined && mergedPrim.packages.dshmarket !== undefined && mergedPrim.packages['new-plugin'] === undefined);
check('merge picks the higher version', mergedPrim.packages['dsh-context'] === '0.59.0');
check('merge bundles union', mergedPrim.bundles.includes('dsh-context') && mergedPrim.bundles.includes('dsh-cost-meter'));
check('version compare sanity', compareVersions('1.2.3', '1.10.0') < 0 && compareVersions('1.0.0', '1.0.0-beta') > 0 && compareVersions('2.0.0', '2.0.0') === 0);

console.log('replace (force) mode:');
// Same manifests, replace mode: local-only becomes removal, older remote
// becomes downgrade — exactly what the force UI previews.
const planReplace = diffManifests(manifest, remoteWithoutMarket, { mode: 'replace' });
check('replace mode reports the local-only package as a removal', planReplace.removals.some((e) => e.name === 'dshmarket'));
check('replace mode reports an older remote version as a downgrade', diffManifests(manifest, remoteOlder, { mode: 'replace' }).downgrades.some((e) => e.name === 'dsh-context' && e.to === '0.55.0'));
check('replace mode does not report keptLocal for the same entry', diffManifests(manifest, remoteOlder, { mode: 'replace' }).keptLocal.length === 0);
check('replace mode plan carries mode field', planReplace.mode === 'replace');
check('merge mode plan carries mode field', planOlder.mode === 'merge');

console.log('snapshot + write-back + restore:');
const snapId = createSnapshot(profileDir);
check('snapshot created', typeof snapId === 'string' && listSnapshots(profileDir).length === 1);
const beforeApply = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
writeProfileFiles(profileDir, remote);
const nextPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('new dependency added', nextPkg.dependencies['new-plugin'] === '1.0.0');
check('local-only dependency NOT removed (merge keeps it)', nextPkg.dependencies.dshmarket === '1.66.3');
check('official deps untouched', nextPkg.dependencies['@michengai/dsh-btw'] === '0.1.13');
check('upgraded dependency version applied', nextPkg.dependencies['dsh-context'] === '0.60.0');
check('official bundles kept at front', nextPkg.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base');
check('bundles merged by union', nextPkg.dsh.profile.bundles.includes('new-plugin') && nextPkg.dsh.profile.bundles.includes('dsh-context') && nextPkg.dsh.profile.bundles.includes('dsh-cost-meter'));
const nextPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('patch rewritten: local official provider row kept verbatim (config preserved, not synced from manifest)', nextPatch.includes('baseURL'));
check('patch rewritten with disabled row', nextPatch.includes('disabled: true'));
check('local structural row kept as text', nextPatch.includes('- id: cost-meter'));
check('remote-only row appended', nextPatch.includes('- id: "cost-meter"') || nextPatch.includes('- id: cost-meter'));
restoreSnapshot(profileDir, snapId);
const restoredPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('rollback restores old dependency set', restoredPkg.dependencies.dshmarket === '1.66.3' && restoredPkg.dependencies['new-plugin'] === undefined);
const restoredPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('rollback restores provider config', restoredPatch.includes('baseURL'));

console.log('apply never downgrades (composePackageJson):');
const remoteOlderForApply = JSON.parse(JSON.stringify(remote));
remoteOlderForApply.packages['dsh-context'] = '0.50.0';
delete remoteOlderForApply.packages['dsh-cost-meter']; // remote lacks it entirely
const beforeDowngradeTest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
writeProfileFiles(profileDir, remoteOlderForApply);
const afterOlderApply = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('older remote version does NOT downgrade local', afterOlderApply.dependencies['dsh-context'] === beforeDowngradeTest.dependencies['dsh-context']);
check('remote-missing package stays installed', afterOlderApply.dependencies['dsh-cost-meter'] === '1.7.40');
// Same input in replace mode: mirrors the remote exactly.
writeProfileFiles(profileDir, remoteOlderForApply, { mode: 'replace' });
const afterReplaceApply = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('replace mode DOES downgrade to the remote version', afterReplaceApply.dependencies['dsh-context'] === '0.50.0');
check('replace mode DOES drop the remote-missing package', afterReplaceApply.dependencies['dsh-cost-meter'] === undefined);
check('replace mode still keeps official + self dependencies', afterReplaceApply.dependencies['@michengai/dsh-btw'] === '0.1.13');
check('replace mode keeps official bundles', afterReplaceApply.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base');
const replacePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('replace mode preserves official provider config verbatim', replacePatch.includes('baseURL'));
check('replace mode drops local-only third-party patch rows', !replacePatch.includes('id: cost-meter'));
restoreSnapshot(profileDir, snapId);

console.log('upload merge (local INTO remote):');
// Remote has a plugin this profile never installed: the merged manifest must
// keep it, because uploading from here must not delete it for other clients.
const remoteExtra = JSON.parse(bytes.toString('utf8'));
remoteExtra.packages['remote-only-plugin'] = '2.0.0';
remoteExtra.bundles = [...new Set([...remoteExtra.bundles, 'remote-only-plugin'])];
const localFresh = buildManifest(profileDir, { revision: 9, label: 'test-box' });
const uploadMerged = { ...localFresh, ...mergeManifests(localFresh, remoteExtra, { preferRemotePatch: false }), revision: 10 };
check('upload manifest preserves remote-only package', uploadMerged.packages['remote-only-plugin'] === '2.0.0');
check('upload manifest keeps all local packages', uploadMerged.packages.dshmarket === '1.66.3' && uploadMerged.packages['dsh-cost-meter'] === '1.7.40');
check('upload manifest merges bundles union', uploadMerged.bundles.includes('remote-only-plugin') && uploadMerged.bundles.includes('dsh-cost-meter'));
const olderRemoteForUpload = JSON.parse(bytes.toString('utf8'));
olderRemoteForUpload.packages['dsh-context'] = '0.10.0';
const uploadMergedOlder = { ...localFresh, ...mergeManifests(localFresh, olderRemoteForUpload, { preferRemotePatch: false }) };
check('upload keeps higher local version over older remote', uploadMergedOlder.packages['dsh-context'] === '0.59.0');

console.log('s3 helpers:');
check('endpoint normalize (minio)', JSON.stringify(pick(normalizeEndpoint('http://127.0.0.1:9000'))) === JSON.stringify({ protocol: 'http:', hostname: '127.0.0.1', port: 9000 }));
check('endpoint normalize (bare host → https)', normalizeEndpoint('s3.amazonaws.com').protocol === 'https:');
check('endpoint rejects embedded path', throws(() => normalizeEndpoint('https://s3.io/bucket')));
check('endpoint rejects credentials', throws(() => normalizeEndpoint('https://ak:sk@s3.io')));
check('bucket names validated', validBucketName('my-bucket') === true && validBucketName('Bad_Bucket') === false && validBucketName('a') === false);
check('prefix validated', validPrefix('dsh-plugin-list-sync') === true && validPrefix('../escape') === false);
check('manifest key', manifestKey({ prefix: 'pls' }, 'desktop') === 'pls/desktop.json');
check('manifest key default prefix', manifestKey({}, 'desktop') === 'desktop.json');
check('profile name escape rejected', throws(() => manifestKey({}, '../evil')));

console.log('credentials store:');
delete process.env.DSH_PLUGIN_SYNC_S3_KEY;
delete process.env.DSH_PLUGIN_SYNC_S3_SECRET;
check('no source initially', credentialsSource(profileDir) === null);
saveCredentials(profileDir, 'AKIA-TEST-1234', 'secret-value-5678');
const loaded = loadCredentials(profileDir);
check('save → load round-trip', loaded !== null && loaded.accessKeyId === 'AKIA-TEST-1234' && loaded.secretAccessKey === 'secret-value-5678');
check('source is saved after store', credentialsSource(profileDir) === 'saved');
check('file lives in plugin state dir', credentialsPath(profileDir).includes(join('.dsh-plugin-list-sync', 'credentials.json')));
check('empty values rejected', throws(() => saveCredentials(profileDir, '', 'x')));
check('newline injection rejected', throws(() => saveCredentials(profileDir, 'AK\n', 'x')));
clearCredentials(profileDir);
check('cleared → source null again', credentialsSource(profileDir) === null && loadCredentials(profileDir) === null);
process.env.DSH_PLUGIN_SYNC_S3_KEY = 'env-key';
process.env.DSH_PLUGIN_SYNC_S3_SECRET = 'env-secret';
check('env fallback after clear', credentialsSource(profileDir) === 'env');
delete process.env.DSH_PLUGIN_SYNC_S3_KEY;
delete process.env.DSH_PLUGIN_SYNC_S3_SECRET;

rmSync(profileDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

function pick(endpoint) { return { protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port }; }
function throws(fn) { try { fn(); return false; } catch { return true; } }
