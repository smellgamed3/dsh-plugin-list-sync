# 架构说明

[中文主文档](../README.zh.md) · [部署与排错](operations.zh.md) · [贡献指南](../CONTRIBUTING.zh.md)

`dsh-plugin-list-sync` 的目标是同步 DSH Profile 的**插件组成**，而不是复制整个 DSH 数据目录。设计重点是：可审计、可回滚、最小依赖、跨 S3 实现兼容，以及不破坏本地 runtime 的官方组件与敏感配置。

## 设计边界

```text
┌──────── DSH Profile ────────┐          ┌────── S3-compatible storage ──────┐
│ package.json                │          │ <prefix>/<profile>.json           │
│ cordis.patch.yml            │ ───────► │ versioned manifest                 │
│ .dsh-plugin-list-sync/      │  SigV4   │ revision + ETag optimistic locking │
│   snapshots/                │ ◄─────── │                                     │
│   credentials.json          │          └───────────────────────────────────┘
└─────────────────────────────┘
```

| 数据 | 是否同步 | 原因 |
| --- | --- | --- |
| 第三方 `dependencies` | 是 | 决定安装哪些用户插件及版本。 |
| `dsh.profile.bundles` | 是 | 决定 bundle 启用和顺序。 |
| 用户 patch 层 | 是，默认结构化 | 表达插件禁用和配置覆盖。 |
| `@deepseek-ai/*` 官方 bundle | 否 | 必须跟随每台客户端实际 DSH runtime。 |
| LLM provider 详细 config | 默认否 | 可能暴露私有 Endpoint、模型目录或环境拓扑。 |
| Credentials | 否 | 本地私有存储，绝不进入 manifest。 |
| Sessions / workspaces / attachments | 否 | 不属于插件配置层。 |

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `lib/index.js` | Cordis Host 入口、HTTP 路由、命令接入、配置合并、上传/预览/应用编排。 |
| `lib/manifest.js` | 读取 Profile、过滤官方 bundle、投影 patch、序列化与严格验证 manifest、`mergeManifests` 合并原语与版本比较。 |
| `lib/s3.js` | 无 SDK 的 AWS SigV4、Endpoint 标准化、GET/HEAD/PUT、错误分类。 |
| `lib/diff.js` | 比较本地/远端 manifest，生成合并计划（默认：新增、升级、保留本地版本、本地独有；replace 模式：额外给出移除与降级）。 |
| `lib/apply.js` | 快照、合并式文件写回（默认不删本地依赖/不降级；replace 模式镜像远端但豁免官方组件）、回滚、pluginManager 编排（默认只装不卸；replace 才调用 removeBundle）。 |
| `lib/credentials-store.js` | 本地保存、读取和清除 AccessKey / SecretKey。 |
| `client/client.js` | 设置页、浏览器本地非敏感表单缓存、调用 Host API、差异和状态渲染。 |
| `test/selftest.mjs` | manifest、diff、快照、回滚、凭据存储等核心回归。 |
| `test/s3-mock.mjs` | 支持 SigV4 验证的最小 S3 mock。 |
| `test/e2e.mjs` | 针对 mock 的上传、拉取、应用、回滚端到端测试。 |

## Manifest 协议

远端对象是单个版本化 JSON 文档：

```jsonc
{
  "format": "dsh-plugin-list-sync/manifest",
  "version": 1,
  "revision": 42,
  "updatedAt": "2026-09-29T08:00:00.000Z",
  "source": { "label": "office-desktop" },
  "runtime": { "dshVersion": "0.2.0-rc.1" },
  "packages": {
    "dsh-context": "0.59.0"
  },
  "bundles": ["dsh-context"],
  "patch": {
    "kind": "rows",
    "rows": [{ "id": "cost-meter", "disabled": true }]
  }
}
```

### 协议不变量

- `format` 与 `version` 必须完全匹配当前支持版本。
- `revision` 为非负整数；上传基于远端 revision 自增。
- `packages` 仅接受 npm 风格名称和有限长度的版本字符串。
- manifest 字节数受 `MAX_MANIFEST_BYTES` 限制。
- `patch` 仅接受 `text` 或受限 `rows` 两种表示。
- 下载失败、格式不合法或未知字段时拒绝应用，不做“尽力部分恢复”。

对协议做破坏性修改时必须提高 `version`，在解析层显式实现迁移，并保留旧版本读取策略或给出明确拒绝信息。

## 上传流程（合并式）

```text
GET object
  ├─ 不存在：revision = 0，首次上传
  ├─ 存在且合法：严格验证 manifest，读取 revision + HEAD 的 ETag
  └─ 存在但损坏：拒绝覆盖（不静默丢弃未知内容）

buildManifest(profile, revision + 1)
  ├─ 过滤官方 bundle / 本插件自身
  ├─ 默认剥离 LLM provider 详细 config
  └─ 生成稳定 JSON

mergeManifests(local, remote)
  ├─ packages：并集；共同包取更高版本（绝不降级、绝不丢弃任一侧）
  ├─ bundles：并集（远端顺序在前，本地独有追加）
  └─ patch：按 id 并集；共享行同步 disabled，config 保留本地

PUT object
  ├─ AWS SigV4
  ├─ If-Match: ETag（服务器支持时）
  └─ 可选 x-amz-server-side-encryption: AES256
```

上传是"本地合并进远端"：仅存在于远端的插件被保留（本机未安装不会从远端删除它们），共同插件取两端更高版本。上传结果报告 `preservedRemotePackages` 与 `keptLocalVersions`。

## 下载与应用流程（合并式）

```text
GET object
  ↓
validateManifestBytes
  ↓
build local manifest + diffManifests（合并计划：只有新增与升级）
  ↓
用户预览并确认
  ↓
createSnapshot
  ↓
writeProfileFiles（合并写入）
  ├─ package.json：本地依赖全保留；远端新增追加；共同包仅升级
  ├─ bundles：并集（本地顺序在前）
  └─ cordis.patch.yml：本地行含 config 原样保留；disabled 随远端；远端独有行追加
  ↓
pluginManager.installBundle（只安装与升级，绝不 removeBundle）
  ↓
成功：报告结果
失败：保留快照，允许 rollback
```

**合并不变量**（违反任何一条都是缺陷）：

1. 下载应用绝不移除本地已安装的第三方插件（默认 merge 模式）。
2. 下载应用绝不把共同插件降到更低的版本（默认 merge 模式）。
3. 上传绝不从远端清单中删除仅远端存在的插件（默认 merge 模式）。
4. 本地 `cordis.patch.yml` 行的嵌套 `config:` 块永远不会被同步改写（**任何模式**，包括 replace）。

### 强制覆盖（replace 模式，显式一次性选择）

`diffManifests(local, remote, { mode: 'replace' })` 与 `writeProfileFiles(..., { mode: 'replace' })` 提供镜像语义：本地独有第三方包成为 `removals`、更旧的远端版本成为 `downgrades`、`removeBundle` 会被调用。它的安全边界：

- **传输层防护**：`/api/apply` 收到 `mode: 'replace'` 时必须同时携带 `confirmReplace: true`，否则以 `confirm-required` 拒绝——客户端必须先展示 replace 计划再确认。
- **不持久化**：force 开关只存在于客户端 `state.forceUpload` / `state.forceApply`（不在 `state.form`，不进 localStorage/settings.json），每次操作后复位。
- **客户端双重确认**：强制覆盖本地要求 (a) 以勾选状态重新预览得到 `plan.mode === 'replace'`，(b) 通过列明具体 removals/downgrades 的 `window.confirm`。
- **命令面拒绝**：`pull --force` 直接拒绝；强制覆盖本地只能走设置页。
- **官方组件豁免**：即使 replace，`@deepseek-ai/*` 与本插件自身的依赖、bundle、patch 行（含 provider config）原样保留。
- **快照仍然先行**：replace 应用前同样 `createSnapshot`。

### Patch 合成原则

补丁行按 `id` 做块级合并：本地行总是以其原始文本保留——包括 `llm-pi-ai`、`agent-default-model` 等官方条目的嵌套 `config:`（LLM provider 定义、模型目录），绝不被扁平化或重序列化。共享行只有 `disabled` 开关随远端同步；远端独有行从 manifest 追加渲染。

用户启用“同步 LLM provider 配置”后，manifest 可携带完整 patch 文本；此模式要求远端配置受信且所有目标机器使用相同的环境拓扑。

## S3 兼容性实现

### 传输层

- 使用 `node:https` / `node:http`，不依赖 AWS SDK。
- 使用 AWS Signature Version 4，service 固定为 `s3`。
- 支持 path-style 和 virtual-host-style。
- GET、HEAD、PUT 均使用真实 payload SHA-256。
- 每个请求有超时与 AbortSignal。

### SSE-S3

`x-amz-server-side-encryption: AES256` 默认**不发送**：

- AWS 可以通过桶默认加密完成服务端加密。
- RustFS / MinIO 的 SSE-S3 能力可能需要管理员额外配置密钥或 KMS。
- 用户主动勾选设置页“请求 SSE-S3 AES256 加密”后才会发送该头。

## 凭据模型

优先级：

```text
<profile>/.dsh-plugin-list-sync/credentials.json
    > DSH_PLUGIN_SYNC_S3_KEY / DSH_PLUGIN_SYNC_S3_SECRET
    > 无凭据（请求拒绝）
```

关键约束：

- HTTP API 不接受把 AccessKey / SecretKey 混入普通同步配置。
- 凭据 API 只在 same-origin 条件下允许写入或删除。
- Status API 只返回凭据来源与掩码后的 AccessKey。
- 任何 manifest、diff、日志和 UI 结果不得回显 SecretKey。

未来若接入 DSH 原生 credentials service，必须维持相同的“永不进入 manifest”和脱敏输出约束。

## 客户端状态模型

客户端将**非敏感** S3 连接表单缓存到浏览器 `localStorage`：

```text
key: dsh-plugin-list-sync.form
```

这避免刷新后丢失 Endpoint、Bucket、Prefix、Path-Style 和 SSE 开关。AccessKey / SecretKey 不进入 `localStorage`，只由专用凭据 API 保存到 Profile 私有目录。

设置页提交的 payload 使用嵌套结构：

```jsonc
{
  "config": {
    "s3": {
      "endpoint": "https://...",
      "bucket": "..."
    },
    "includePatchConfig": false,
    "machineLabel": "office-desktop"
  }
}
```

Host 同时兼容历史扁平字段，避免旧缓存页面与新 Host 短暂不兼容。

## 半自动化控制器

`lib/automation.js` 只接收 `upload(config)` 和 `checkRemote(config)` 两个能力，不接收 `applyRemote`、插件安装、插件移除或 Profile 写入回调。因此它的能力在结构上被限制为：监听本地文件后上传，以及周期检查后标记 `remoteUpdateAvailable`。

远端更新仍只能经显式的人工 `/api/apply` 流程落地。手动 apply/rollback 会调用 `suppressUploads()`，避免 watcher 把远端状态回显上传。自动化策略写入 `<profile>/.dsh-plugin-list-sync/settings.json`，不含凭据，因此页面关闭后 Host 仍可继续安全运行。

## 兼容性原则

- 运行时仅硬依赖 `@deepseek-ai/cordis`。
- 其他 Host service 通过 `ctx.get()` 或 `ctx.inject()` 进行能力检测。
- `pluginManager` 缺失时不伪造安装成功，明确告知需要手动 materialize/restart。
- 不绕过 DSH/pnpm 的 peer dependency 与 supply-chain 策略。

## 维护检查清单

修改以下任何区域时，应同步增加测试：

| 变更区域 | 至少需要验证 |
| --- | --- |
| `manifest.js` | 默认/完整 patch、非法 manifest、大小上限、包名过滤、`mergeManifests` 并集与高版本胜出。 |
| `diff.js` | 安装、升级、保留本地版本（不降级）、本地独有（不移除）、键顺序不影响 diff；replace 模式的 removals/downgrades。 |
| `apply.js` | 快照、回滚、合并写回不删本地依赖、官方 provider 块保留。 |
| `s3.js` | Path-Style、虚拟主机、SigV4、错误分类、SSE 默认行为。 |
| `credentials-store.js` | 保存、掩码、清除、env fallback、换行/空值拒绝。 |
| `client/client.js` | 表单 payload、loading 状态清除、敏感字段不进入 localStorage。 |

运行：

```powershell
pnpm run check
pnpm run test:s3-mock   # 另一终端
pnpm run test:e2e       # mock 启动后
```

## 未来演进

优先级建议：

1. 接入 DSH 原生 credentials service（保持平滑迁移）。
2. 增加 manifest 历史版本和远端 revision 浏览。
3. 支持冲突提示和显式合并策略，而非仅 last-write-wins。
4. 为 S3 兼容端点维护认证/寻址互操作测试矩阵。
5. 发布 npm 包及签名发行物，降低 GitHub 安装路径的供应链风险。

任何新增功能都应保持：**预览先于写入、快照先于应用、凭据永不上传、官方 bundle 不跨机覆盖、默认合并永不删除本地插件或降低本地版本、破坏性替换必须显式一次性选择并确认**。
