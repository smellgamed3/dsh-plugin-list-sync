# 部署、配置与排错手册

[中文主文档](../README.zh.md) · [架构说明](architecture.zh.md)

本文档面向负责部署 S3/RustFS/MinIO 和维护多台 DSH 客户端的管理员。

## 部署前检查

| 项目 | 要求 |
| --- | --- |
| DSH | 使用包含 Cordis 4 的兼容 runtime；插件会保留官方 bundle 在本地。 |
| Node.js | `>= 20`。 |
| 网络 | 每台 DSH 客户端能访问所配置的 S3 endpoint。 |
| 对象存储 | 支持 S3 GET、HEAD、PUT 和 AWS SigV4。 |
| 凭据 | 仅授予指定 bucket/prefix 的对象读取与写入权限。 |
| 时钟 | 客户端与服务端时钟应同步；SigV4 对时间偏差敏感。 |

## 推荐对象布局

按团队和环境设置不同 Prefix，避免互相覆盖：

```text
s3://dsh-config/
  production/plugin-list-sync/desktop.json
  production/plugin-list-sync/laptop.json
  development/plugin-list-sync/desktop.json
```

Profile 名默认来自 DSH 的 profile 目录名，例如 `desktop`。多台设备若需共用同一配置，应使用同名 profile 或建立统一的 profile 命名约定。

## 各类后端配置

### AWS S3

| 设置 | 示例 |
| --- | --- |
| Endpoint | `https://s3.amazonaws.com` 或区域 endpoint |
| Region | 真实 AWS region，例如 `ap-southeast-1` |
| Path-Style | 通常关闭 |
| HTTP | 关闭 |
| SSE-S3 请求 | 可按组织加密策略决定；推荐桶默认加密 |

请优先使用 IAM Role、短期凭据或最小权限 IAM 用户。插件目前读取静态 AccessKey / SecretKey，不负责自动刷新 STS token。

### MinIO

| 设置 | 示例 |
| --- | --- |
| Endpoint | `https://minio.example.internal:9000` |
| Region | `auto` |
| Path-Style | 开启 |
| HTTP | 仅本机测试环境开启 |
| SSE-S3 请求 | 仅 MinIO 已配置 server-side encryption 时开启 |

### RustFS

| 设置 | 示例 |
| --- | --- |
| Endpoint | `https://files.example.internal:32123` |
| Region | `auto` |
| Path-Style | 开启 |
| SSE-S3 请求 | **关闭（默认）** |

如果出现：

```text
SSE-S3 requires RUSTFS_SSE_S3_MASTER_KEY to be set ...
```

说明服务端未配置 SSE-S3 master key 或 KMS。保持插件 SSE 开关关闭，或由 RustFS 管理员配置对应服务端能力后再开启。

### Cloudflare R2 / OSS S3 API

- 确认 endpoint、Region 和 path-style 需求，优先以服务商 S3 API 文档为准。
- 用“预览差异”验证 GET；首次“上传”验证 PUT。
- 若服务商默认不支持 `If-Match`，插件仍可工作，但并发覆盖保护会退化。

## 半自动同步配置

调整自动化开关后必须点击“保存同步设置”。配置保存在 `<profile>/.dsh-plugin-list-sync/settings.json`，因此浏览器页面关闭后 Host 仍可继续运行。

| 设置 | 默认 | 建议 |
| --- | --- | --- |
| 本地配置变化后自动上传 | 关闭 | 只在该设备明确是本地配置源时开启；建议 debounce 为 8–30 秒。 |
| 定时检查远端更新（仅提示） | 关闭 | 推荐开启；10–30 分钟适合日常多设备检查。 |
| 自动下载或自动应用 | 不存在 | 设计上不支持；任何远端变更必须先人工预览、再人工应用。 |

手动 apply/rollback 会暂时抑制 watcher 上传，避免接收的远端状态或恢复的快照被立刻自动回写。

## 首次上线流程

1. 选定一个“基准客户端”，确认其第三方插件列表可用。
2. 在该设备设置 endpoint、bucket、prefix、凭据。
3. 点击“上传当前插件列表”。
4. 在另一台测试客户端设置相同连接信息。
5. 先点击“预览差异”，检查计划中没有意外的版本回退（合并语义保证不会移除本地插件或降级）。
6. 点击“下载并应用”。
7. 重启 DSH，确认所有 Host/Client bundle 正常加载。
8. 验证后再向其他设备推广。

> 不建议首次上线即对所有生产客户端自动应用。先以一个孤立测试 profile 演练上传、预览、应用与回滚。

## Bucket 权限示例

AWS IAM 概念示例：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DshPluginListSync",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::dsh-config/production/plugin-list-sync/*"
    }
  ]
}
```

该插件不需要：

- `ListBucket`
- `DeleteObject`
- 桶策略管理
- 用户/角色管理

## 问题诊断流程

### 1. 设置页提示“请先完成 S3 配置”

检查 Endpoint 和 Bucket 是否已填写。新版设置页会将非敏感连接表单缓存到浏览器本地；刷新页面后应仍可见。

如果刚更新插件：

- 只涉及客户端界面时，执行浏览器硬刷新。
- 涉及 Host 路由或 S3 传输逻辑时，重启 DSH。

### 2. `The specified key does not exist.`

这是首次同步的正常状态：远端对象尚未创建。

处理：在基准客户端点击“上传当前插件列表”。上传成功后，其他客户端预览会显示差异或“已同步，无差异”。

### 3. `SignatureDoesNotMatch` / `403`

按此顺序检查：

1. AccessKey / SecretKey 是否对应当前 endpoint。
2. Region 是否符合后端要求；MinIO / RustFS 通常使用 `auto`。
3. Path-Style 是否符合后端要求。
4. 终端时间是否同步。
5. 反向代理是否篡改了 `Host`、路径编码或签名相关请求头。
6. AccessKey 是否只允许另一种签名版本或租户。

### 4. `SSE-S3 requires ...`

关闭“请求 SSE-S3 AES256 加密”。该开关默认关闭，除非确实已部署 KMS 或服务端 master key。

### 5. 上传成功、预览却显示不一致

确认两端使用：

- 同一个 bucket
- 同一个 prefix
- 同一个 profile 名
- 相同的 `includePatchConfig` 选择

同时确认不是另一个客户端刚覆盖了对象。注意本插件的上传是**合并式**的：远端独有插件会被保留，共同插件取更高版本。manifest 中 `source.label`、`updatedAt` 和 `revision` 可帮助定位来源。

### 6. 应用后插件加载失败

1. 先不要继续修改配置。
2. 使用“回滚”恢复最近快照。
3. 检查远端插件版本与当前 DSH 的 peer compatibility。
4. 查阅 DSH pluginManager 的错误输出；不要通过 version exemption 强行运行不兼容插件，除非明确接受崩溃和数据丢失风险。

### 7. 页面显示“处理中…”但已展示结果

旧版客户端可能保留成功请求的 loading 文案。升级后刷新页面即可。若“远端差异”区域已经显示“已同步，无差异”或具体计划，说明请求本身已经完成。

## 日志与问题反馈

反馈 issue 时请包含：

```text
DSH runtime 版本：
插件版本 / commit：
操作系统：
S3 实现（AWS / MinIO / RustFS / R2 / OSS）：
Endpoint 的协议与端口（请脱敏域名）：
Region：
Path-Style：开 / 关
SSE-S3 请求：开 / 关
操作：上传 / 预览 / 应用 / 回滚
完整错误码与已脱敏错误信息：
```

绝不能提交：

- Secret Access Key
- 完整 AccessKey
- Bucket 内真实私有对象内容
- 内部服务域名、IP、token 或 TLS 私钥

## 备份与灾难恢复

插件快照保存在：

```text
<profile>/.dsh-plugin-list-sync/snapshots/
```

它们仅保护插件配置文件，不替代整个 DSH Profile、用户凭据或会话数据的备份。

建议：

- 定期备份 `.dsh` 根目录中需要保留的业务数据。
- 对 S3 bucket 启用对象版本控制（如果后端支持）。
- 对生产 prefix 设置保留策略，保留历史对象版本。
- 在批量推广前导出或复制当前对象作为人工恢复点。

## 升级策略

1. 先在测试 profile / 测试机器更新插件。
2. 执行 `pnpm run check` 与模拟 S3 E2E 测试（开发场景）。
3. 刷新页面并重启 DSH。
4. 验证预览、上传和回滚。
5. 再推广到生产客户端。

对于 Host 模块变动，必须重启 DSH；Node ESM 会缓存已加载模块，单纯切换 bundle 的启用状态不保证加载新代码。
