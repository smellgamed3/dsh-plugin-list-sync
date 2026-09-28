/**
 * Self-test: exercises manifest build → validate → serialize → diff →
 * snapshot → write-back → restore against a COPY of the real profile's
 * files. Run: node test/selftest.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, validateManifestBytes, serializeManifest, parsePatchRows } from '../lib/manifest.js';
import { diffManifests } from '../lib/diff.js';
import { createSnapshot, restoreSnapshot, writeProfileFiles, listSnapshots } from '../lib/apply.js';
import { manifestKey, normalizeEndpoint, validBucketName, validPrefix } from '../lib/s3.js';

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
const manifest = buildManifest(profileDir, { revision: 7, label: 'test-box', includePatchConfig: false });
check('official dep filtered', manifest.packages['@deepseek-ai/dsh-base'] === undefined);
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
delete remote.packages.dshmarket;
remote.bundles = ['dsh-context', 'dsh-cost-meter', '@michengai/dsh-btw', 'new-plugin'];
const plan = diffManifests(manifest, remote);
check('install detected', plan.installs.some((e) => e.name === 'new-plugin'));
check('upgrade detected', plan.upgrades.some((e) => e.name === 'dsh-context' && e.to === '0.60.0'));
check('removal detected', plan.removals.some((e) => e.name === 'dshmarket'));
check('plan not empty', plan.empty === false);
const planSame = diffManifests(manifest, JSON.parse(bytes.toString('utf8')));
check('identical manifests diff empty', planSame.empty === true);

console.log('snapshot + write-back + restore:');
const snapId = createSnapshot(profileDir);
check('snapshot created', typeof snapId === 'string' && listSnapshots(profileDir).length === 1);
writeProfileFiles(profileDir, remote);
const nextPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('dependencies rewritten', nextPkg.dependencies['new-plugin'] === '1.0.0' && nextPkg.dependencies.dshmarket === undefined);
check('official bundles kept at front', nextPkg.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base');
check('bundle order follows manifest', JSON.stringify(nextPkg.dsh.profile.bundles.slice(1)) === JSON.stringify(remote.bundles));
const nextPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('patch rewritten without provider config', !nextPatch.includes('baseURL'));
check('patch rewritten with disabled row', nextPatch.includes('disabled: true'));
restoreSnapshot(profileDir, snapId);
const restoredPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('rollback restores dependencies', restoredPkg.dependencies.dshmarket === '1.66.3' && restoredPkg.dependencies['new-plugin'] === undefined);
const restoredPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('rollback restores provider config', restoredPatch.includes('baseURL'));

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

rmSync(profileDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

function pick(endpoint) { return { protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port }; }
function throws(fn) { try { fn(); return false; } catch { return true; } }
