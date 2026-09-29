import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, normalizeSettings, saveSettings, settingsPath } from '../lib/settings-store.js';

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log(`  ok - ${label}`); }
  else { failed += 1; console.error(`  FAIL - ${label}`); }
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-pls-settings-'));
console.log('settings store:');
check('absent settings return null', loadSettings(profile) === null);

const saved = saveSettings(profile, {
  s3: {
    endpoint: ' https://s3.example.test ', bucket: 'plugin-config', prefix: 'team/dev',
    forcePathStyle: false, allowInsecure: false, serverSideEncryption: false,
    // Must never survive the non-secret settings store.
    accessKeyId: 'not-persisted', secretAccessKey: 'not-persisted',
  },
  includePatchConfig: true,
  machineLabel: ' office-desktop ',
  automation: {
    autoUpload: true, uploadDebounceSeconds: 12,
    autoCheck: true, checkIntervalMinutes: 30,
  },
});
check('settings file uses plugin private state directory', settingsPath(profile).includes(join('.dsh-plugin-list-sync', 'settings.json')));
check('S3 endpoint and label are normalized', saved.s3.endpoint === 'https://s3.example.test' && saved.machineLabel === 'office-desktop');
check('automation policy persists', saved.automation.autoUpload && saved.automation.uploadDebounceSeconds === 12 && saved.automation.autoCheck && saved.automation.checkIntervalMinutes === 30);
check('credential-like fields are discarded', saved.s3.accessKeyId === undefined && saved.s3.secretAccessKey === undefined);

const loaded = loadSettings(profile);
check('saved settings round-trip', loaded !== null && loaded.s3.bucket === 'plugin-config' && loaded.automation.checkIntervalMinutes === 30);
const bad = normalizeSettings({
  s3: { endpoint: 'x', bucket: 'b' },
  automation: { uploadDebounceSeconds: 1, checkIntervalMinutes: 2000 },
});
check('automation bounds fall back safely', bad.automation.uploadDebounceSeconds === 8 && bad.automation.checkIntervalMinutes === 15);

rmSync(profile, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
