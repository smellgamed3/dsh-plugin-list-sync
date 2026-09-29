/**
 * Safe automation controller.
 *
 * It has exactly two capabilities:
 *   1. after local profile files settle, upload the current manifest;
 *   2. periodically check whether a meaningful remote diff exists.
 *
 * It deliberately does NOT receive an apply callback. A remote update can
 * only become `remoteUpdateAvailable: true`; a human must still preview and
 * press "Download && apply". Keeping that prohibition structural prevents a
 * later timer refactor from accidentally turning into auto-installation.
 */
import { watch as nodeWatch } from 'node:fs';
import { join } from 'node:path';
import { s3ErrorCode } from './s3.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function messageOf(error) {
  return String(error?.message ?? error ?? 'unknown automation error');
}

export function createAutomationController({
  profileDir,
  getConfig,
  upload,
  checkRemote,
  onChange = () => {},
  watchFactory = nodeWatch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
}) {
  const state = {
    autoUploadEnabled: false,
    autoCheckEnabled: false,
    uploadDebounceSeconds: 8,
    checkIntervalMinutes: 15,
    uploadPending: false,
    uploadRunning: false,
    checkRunning: false,
    lastAutoUploadAt: null,
    lastAutoUploadRevision: null,
    lastAutoCheckAt: null,
    remoteUpdateAvailable: false,
    remote: null,
    lastAutoError: null,
  };

  let uploadTimer = null;
  let checkTimer = null;
  let watchers = [];
  let disposed = false;
  let suppressUntil = 0;

  const emit = () => onChange(clone(state));

  const configReady = (config) => {
    const s3 = config?.s3;
    return typeof s3?.endpoint === 'string' && s3.endpoint.trim() !== ''
      && typeof s3?.bucket === 'string' && s3.bucket.trim() !== '';
  };

  const recordError = (kind, error) => {
    state.lastAutoError = {
      kind,
      code: s3ErrorCode(error),
      message: messageOf(error),
      at: new Date(now()).toISOString(),
    };
    emit();
  };

  const runUpload = async (reason) => {
    if (disposed || state.uploadRunning) return;
    const config = getConfig();
    if (!state.autoUploadEnabled || !configReady(config)) return;
    if (now() < suppressUntil) return;
    state.uploadPending = false;
    state.uploadRunning = true;
    state.lastAutoError = null;
    emit();
    try {
      const result = await upload(config);
      state.lastAutoUploadAt = new Date(now()).toISOString();
      state.lastAutoUploadRevision = result?.revision ?? null;
      state.remoteUpdateAvailable = false;
      state.remote = result?.revision === undefined ? state.remote : { revision: result.revision, source: config.machineLabel || null };
    } catch (error) {
      recordError(`upload:${reason}`, error);
    } finally {
      state.uploadRunning = false;
      emit();
    }
  };

  const scheduleUpload = (reason = 'filesystem') => {
    if (disposed || !state.autoUploadEnabled || now() < suppressUntil) return;
    if (uploadTimer !== null) clearTimeoutFn(uploadTimer);
    state.uploadPending = true;
    emit();
    uploadTimer = setTimeoutFn(() => {
      uploadTimer = null;
      void runUpload(reason);
    }, state.uploadDebounceSeconds * 1000);
  };

  const runCheck = async (reason) => {
    if (disposed || state.checkRunning) return;
    const config = getConfig();
    if (!state.autoCheckEnabled || !configReady(config)) return;
    state.checkRunning = true;
    state.lastAutoError = null;
    emit();
    try {
      const result = await checkRemote(config);
      state.lastAutoCheckAt = new Date(now()).toISOString();
      state.remoteUpdateAvailable = result?.plan?.empty === false;
      state.remote = result?.remote ?? null;
    } catch (error) {
      // A first-use empty object is informative, not an automation failure.
      if (s3ErrorCode(error) === 'not-found') {
        state.lastAutoCheckAt = new Date(now()).toISOString();
        state.remoteUpdateAvailable = false;
        state.remote = null;
      } else {
        recordError(`check:${reason}`, error);
      }
    } finally {
      state.checkRunning = false;
      emit();
    }
  };

  const closeWatchers = () => {
    for (const close of watchers) {
      try { close(); } catch { /* best effort */ }
    }
    watchers = [];
  };

  const reconfigure = () => {
    if (uploadTimer !== null) { clearTimeoutFn(uploadTimer); uploadTimer = null; }
    if (checkTimer !== null) { clearIntervalFn(checkTimer); checkTimer = null; }
    closeWatchers();
    if (disposed) return;

    const automation = getConfig()?.automation ?? {};
    state.autoUploadEnabled = automation.autoUpload === true;
    state.autoCheckEnabled = automation.autoCheck === true;
    state.uploadDebounceSeconds = Number.isInteger(automation.uploadDebounceSeconds) ? automation.uploadDebounceSeconds : 8;
    state.checkIntervalMinutes = Number.isInteger(automation.checkIntervalMinutes) ? automation.checkIntervalMinutes : 15;

    if (state.autoUploadEnabled) {
      for (const filename of ['package.json', 'cordis.patch.yml']) {
        try {
          const watcher = watchFactory(join(profileDir, filename), { persistent: false }, () => scheduleUpload('filesystem'));
          watchers.push(() => watcher.close());
        } catch (error) {
          recordError(`watch:${filename}`, error);
        }
      }
    }

    if (state.autoCheckEnabled) {
      checkTimer = setIntervalFn(() => void runCheck('interval'), state.checkIntervalMinutes * 60_000);
      // An early check communicates existing remote drift soon after Host boot.
      setTimeoutFn(() => void runCheck('startup'), 1_000);
    }
    emit();
  };

  const suppressUploads = (milliseconds = 30_000) => {
    suppressUntil = Math.max(suppressUntil, now() + milliseconds);
    if (uploadTimer !== null) {
      clearTimeoutFn(uploadTimer);
      uploadTimer = null;
      state.uploadPending = false;
    }
    emit();
  };

  const snapshot = () => clone(state);

  const dispose = () => {
    disposed = true;
    if (uploadTimer !== null) clearTimeoutFn(uploadTimer);
    if (checkTimer !== null) clearIntervalFn(checkTimer);
    closeWatchers();
  };

  reconfigure();
  return { reconfigure, scheduleUpload, runCheck, suppressUploads, snapshot, dispose };
}
