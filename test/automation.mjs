/**
 * Automation controller tests.
 *
 * These tests intentionally provide upload/check callbacks only. There is no
 * apply callback in createAutomationController's public contract: this is the
 * regression guard for the promise that automation never changes local plugin
 * configuration from a remote manifest.
 */
import { createAutomationController } from '../lib/automation.js';

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log(`  ok - ${label}`); }
  else { failed += 1; console.error(`  FAIL - ${label}`); }
}

let clock = 1_000_000;
let nextTimerId = 0;
const timeouts = new Map();
const intervals = new Map();
const watchers = [];
let uploads = 0;
let checks = 0;
const changes = [];
const config = {
  s3: { endpoint: 'https://s3.example.test', bucket: 'plugin-config' },
  automation: { autoUpload: true, uploadDebounceSeconds: 3, autoCheck: false, checkIntervalMinutes: 5 },
};

const controller = createAutomationController({
  profileDir: 'C:/test-profile',
  getConfig: () => config,
  upload: async () => { uploads += 1; return { revision: uploads }; },
  checkRemote: async () => { checks += 1; return { remote: { revision: 9 }, plan: { empty: false } }; },
  onChange: (state) => changes.push(state),
  now: () => clock,
  watchFactory: (_path, _opts, callback) => {
    const watcher = { closed: false, close() { this.closed = true; } };
    watchers.push({ callback, watcher });
    return watcher;
  },
  setTimeoutFn: (callback, delay) => {
    const id = ++nextTimerId;
    timeouts.set(id, { callback, delay });
    return id;
  },
  clearTimeoutFn: (id) => timeouts.delete(id),
  setIntervalFn: (callback, delay) => {
    const id = ++nextTimerId;
    intervals.set(id, { callback, delay });
    return id;
  },
  clearIntervalFn: (id) => intervals.delete(id),
});

console.log('automation controller:');
check('auto-upload creates exactly two profile watchers', watchers.length === 2);
check('auto-check disabled creates no interval', intervals.size === 0);

// Two rapid filesystem events collapse into exactly one debounce timer.
watchers[0].callback();
watchers[1].callback();
check('rapid file events leave one pending debounce', timeouts.size === 1);
const [debounceId, debounce] = [...timeouts.entries()][0];
check('debounce uses configured 3-second delay', debounce.delay === 3_000);
timeouts.delete(debounceId);
await debounce.callback();
check('debounced local changes upload once', uploads === 1);
check('automatic upload clears remote-update flag', controller.snapshot().remoteUpdateAvailable === false);

// Enabling checks must create an interval and only surface remote drift.
config.automation = { ...config.automation, autoCheck: true, checkIntervalMinutes: 7 };
controller.reconfigure();
check('reconfigure closes old watchers then recreates two', watchers.length === 4 && watchers[0].watcher.closed && watchers[1].watcher.closed);
check('auto-check creates one interval', intervals.size === 1);
const interval = [...intervals.values()][0];
check('check interval respects configured minutes', interval.delay === 7 * 60_000);
// Startup check uses an independent one-second timer. This test drives the
// interval directly, so clear that fixture timer before asserting debounce.
timeouts.clear();
await interval.callback();
check('periodic check runs once', checks === 1);
check('periodic check marks remote update without applying it', controller.snapshot().remoteUpdateAvailable === true && uploads === 1);

// Suppression is used by manual remote apply/rollback to stop watcher echo.
controller.suppressUploads(30_000);
watchers[2].callback();
check('suppressed watcher event does not queue an upload', timeouts.size === 0 && uploads === 1);
clock += 30_001;
watchers[2].callback();
check('upload resumes after suppression window', timeouts.size === 1);
const afterSuppression = [...timeouts.values()][0];
timeouts.clear();
await afterSuppression.callback();
check('resumed watcher action uploads once more', uploads === 2);

controller.dispose();
check('dispose closes all active watchers and intervals', watchers.slice(2).every(({ watcher }) => watcher.closed) && intervals.size === 0);
check('state changes were published for UI status', changes.length > 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
