/**
 * Live-HTTP harness: mounts the plugin's host half in a standalone process
 * with a stub Cordis context + real http.Server, so the new credentials and
 * sync routes can be exercised over actual HTTP without restarting the DSH
 * host (whose ESM cache still holds the pre-credentials build).
 *
 * The webServer stub implements just register({kind:'exact',path,handler}).
 * The profile directory points at the REAL desktop profile so path
 * resolution matches production.
 */
process.env.DSH_PLUGIN_SYNC_S3_KEY = '';
process.env.DSH_PLUGIN_SYNC_S3_SECRET = '';
delete process.env.DSH_PLUGIN_SYNC_S3_KEY;
delete process.env.DSH_PLUGIN_SYNC_S3_SECRET;

import { createServer } from 'node:http';
import { apply } from '../lib/index.js';
import { loadCredentials, clearCredentials } from '../lib/credentials-store.js';

const PORT = 9667;
const PROFILE_DIR = 'C:/Users/gis/.dsh/profiles/desktop';

// Stub context: only what lib/index.js touches.
const routes = new Map();
const ctx = {
  inject(deps, fn) {
    // Emulate cordis inject: invoke the callback with a context exposing the
    // requested services we can stub; webServer is the only one mounted here.
    const stub = {
      webServer: { register({ kind, path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
      commands: { register() { return () => {}; } },
      get(name) {
        if (name === 'hmr') return { baseDir: PROFILE_DIR };
        return undefined;
      },
    };
    const disposer = fn(stub);
    return typeof disposer === 'function' ? disposer : () => {};
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  get(name) {
    if (name === 'hmr') return { baseDir: PROFILE_DIR };
    return undefined;
  },
  on() { return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};

clearCredentials(PROFILE_DIR); // start clean

const dispose = apply(ctx, {});

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const handler = routes.get(url.pathname);
  if (handler === undefined) { res.writeHead(404); res.end('no route'); return; }
  handler(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`harness listening on http://127.0.0.1:${PORT} with ${routes.size} routes: ${[...routes.keys()].join(', ')}`);
});
