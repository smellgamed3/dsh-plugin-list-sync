# dsh-plugin-list-sync

[中文文档](README.zh.md) · [Architecture（架构）](docs/architecture.zh.md) · [Operations（部署与排错）](docs/operations.zh.md) · [Contributing（贡献指南）](CONTRIBUTING.zh.md) · [Changelog](CHANGELOG.md)

Synchronize the plugin-list configuration of [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) clients through any **S3-compatible** object store — AWS S3, MinIO, RustFS, Cloudflare R2, Aliyun OSS (S3 gateway), etc.

DSH 插件列表多端同步：把当前客户端的插件清单上传到任意 S3 兼容存储，在其他客户端下载并应用，实现多端插件配置一致。

## What gets synced

The plugin-list configuration is exactly two files in a DSH profile:

| File | Carries |
|---|---|
| `package.json` | third-party dependency versions + `dsh.profile.bundles` enable order |
| `cordis.patch.yml` | the user patch layer — disabled rows, plugin config overrides |

- Official `@deepseek-ai/*` bundles are **never synced**: they track each client's own DSH runtime, and syncing them would re-create the peer-dependency breakages the DSH plugin gate exists to prevent.
- **LLM provider config is excluded by default** (the `config:` blocks of rows like `llm-pi-ai` / `agent-default-model` carry baseURLs and model catalogs). Enable `includePatchConfig` if you want it synced; when disabled, those rows keep only their structural keys (`id` / `name` / `disabled`).
- `dsh-plugin-list-sync` itself is skipped (self-bootstrap): it must be installed on each client manually — once.

## Install

```bash
dsh plugin add smellgamed3/dsh-plugin-list-sync
```

or from a checkout:

```bash
dsh plugin add file:C:/path/to/dsh-plugin-list-sync
```

## Configure

Open **Settings → Plugin Sync** in the DSH web UI and fill in:

- **S3 endpoint** — e.g. `https://s3.amazonaws.com`, `http://127.0.0.1:9000` (MinIO/RustFS)
- **Region** — real region on AWS; `auto` (maps to `us-east-1`) works for MinIO/RustFS
- **Bucket** + optional **key prefix**
- **Path-style addressing** — on by default (MinIO/RustFS need it); turn off for virtual-host-style endpoints
- **Allow plain HTTP** — opt-in only for local/test endpoints
- **Request SSE-S3 AES256 encryption** — off by default; enable only when the S3 backend has SSE-S3/KMS configured (keep it off for RustFS without `RUSTFS_SSE_S3_MASTER_KEY`)
- **Request SSE-S3 AES256 encryption** — off by default; enable only when the S3 backend has SSE-S3/KMS configured (keep it off for RustFS without `RUSTFS_SSE_S3_MASTER_KEY`)

Credentials are **never written to config files and never included in the sync manifest**. Provide them either via:

- the settings page — **AccessKey / SecretKey fields** with Save/Clear buttons; stored locally in `<profile>/.dsh-plugin-list-sync/credentials.json` (priority over env vars), or
- environment variables `DSH_PLUGIN_SYNC_S3_KEY` / `DSH_PLUGIN_SYNC_S3_SECRET` (used when no saved pair exists).

## Use

Settings page buttons: **Preview diff** (dry-run against the remote manifest), **Upload current list**, **Download && apply**, **Rollback** (restores the latest snapshot; every apply snapshots both files first).

Command surface (any DSH chat):

```
/plugin-sync status
/plugin-sync upload
/plugin-sync diff
/plugin-sync pull
/plugin-sync rollback [snapshot-id]
```

## Safety model

1. **Download-side strict validation** — a remote manifest is applied only after schema whitelisting (format/version/revision, npm-style package names, bounded sizes). Anything outside the schema refuses to apply.
2. **Snapshot-first apply** — `package.json` + `cordis.patch.yml` are captured to `.dsh-plugin-list-sync/snapshots/` before any write; rollback is one command and itself snapshots first.
3. **Revision monotonicity** — uploads increment the remote revision; a pull never applies an older revision silently.
4. **Same-origin fence** — every mutating route rejects cross-site requests (Origin/Host discipline).
5. **Optimistic locking** — uploads carry `If-Match` with the observed ETag where the server supports it.
6. **Minimal peer surface** — the only peer dependency is `@deepseek-ai/cordis` (ships with DSH). Everything else (`commands`, `webServer`, `pluginManager`, `credentials`, `settings`) is feature-detected at runtime; a host missing a service keeps that surface disabled instead of failing to load.

## Manifest format

```jsonc
{
  "format": "dsh-plugin-list-sync/manifest",
  "version": 1,
  "revision": 42,
  "updatedAt": "2026-09-29T08:00:00.000Z",
  "source": { "label": "office-desktop" },
  "runtime": { "dshVersion": "0.2.0-rc.1" },
  "packages": { "dsh-context": "0.59.0" },
  "bundles": ["dsh-context"],
  "patch": { "kind": "rows", "rows": [{ "id": "cost-meter", "disabled": true }] }
}
```

One JSON object per profile: `s3://<bucket>/<prefix>/<profile-name>.json`.

## Development

```bash
pnpm run check          # syntax checks + core regression suite
pnpm test               # core regression suite
pnpm run test:s3-mock   # terminal A: local SigV4-validating S3 mock
pnpm run test:e2e       # terminal B: full S3 upload/download/apply/rollback flow
```

Pure Node built-ins (`node:https`, `node:crypto`, `node:fs`, `node:path`); zero runtime dependencies; SigV4 implemented in ~200 lines (`lib/s3.js`).

## License

MIT
