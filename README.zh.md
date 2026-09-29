# dsh-plugin-list-sync

[English](README.md) · [架构说明](docs/architecture.zh.md) · [部署与排错](docs/operations.zh.md) · [贡献指南](CONTRIBUTING.zh.md) · [变更记录](CHANGELOG.md)

> 面向 **DeepSeek Harness（DSH）** 多客户端的插件列表同步插件。
>
> 将当前 DSH Profile 的第三方插件清单、启用顺序和用户补丁层上传到兼容 S3 协议的对象存储；在另一台客户端上先预览差异、再按需应用，并在任何写入前创建可回滚快照。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| S3 兼容存储 | 支持 AWS S3、MinIO、RustFS、Cloudflare R2、阿里云 OSS S3 API 等实现。 |
| 多端同步 | 同步第三方依赖版本、bundle 顺序、插件启用/禁用和用户补丁层。 |
| 先预览后应用 | 拉取远端清单先计算安装、升级、降级、移除与 patch 差异，应用由用户主动触发。 |
| 快照与回滚 | 每次应用前备份 `package.json` 与 `cordis.patch.yml`；可一键回滚。 |
| 安全下载 | 对远端 manifest 做格式、大小、包名和字段白名单验证，拒绝不可信内容。 |
| LLM 配置保护 | 默认不同步 LLM provider 详细配置；可按需开启。 |
| 凭据隔离 | AccessKey / SecretKey 不会进入同步清单，也不写入 `cordis.patch.yml`。 |
| 兼容性优先 | 仅声明 `@deepseek-ai/cordis` peer dependency，避免重演旧版插件的 DSH peer 锁死问题。 |

## 同步什么，不同步什么

一个 DSH Profile 的插件配置主要由以下两个文件定义：

| 文件 | 同步内容 |
| --- | --- |
| `package.json` | 第三方 `dependencies`、`dsh.profile.bundles` 的加载顺序。 |
| `cordis.patch.yml` | 插件禁用状态、条目覆盖和用户补丁层。 |

### 明确不在同步范围内

- `@deepseek-ai/*` 官方 bundle：它们必须随本机 DSH runtime 版本演进，强行跨机同步会带来 peer dependency 兼容风险。
- 会话、工作区、附件、模型 API Key、DSH 账户和其他业务数据。
- `dsh-plugin-list-sync` 自身：每台机器首次需自行安装，避免“同步插件负责安装自己”的自举风险。
- 默认情况下的 LLM provider 详细配置，例如私有网关 `baseURL`、provider 列表和模型目录。

> **LLM provider 配置开关**：需要统一网关/模型目录时，可在设置页打开“同步 LLM provider 配置”。开启前应确认所有客户端均可访问相同网关，且远端对象存储访问权限受到控制。

## 安装

### 从 GitHub 安装

```powershell
dsh plugin add smellgamed3/dsh-plugin-list-sync
```

### 从本地开发目录安装

```powershell
dsh plugin add file:C:/path/to/dsh-plugin-list-sync
```

安装后在 **设置 → 插件同步** 打开设置页。若本机已运行 DSH，新增或更新 Host 侧插件后请重启 DSH，以确保 Node ESM 模块缓存重新加载。

## 快速开始

1. 进入 **设置 → 插件同步**。
2. 填写 S3 Endpoint、Region、Bucket、Prefix。
3. 填写 AccessKey ID 与 Secret Access Key，点击“保存凭据”。
4. 首台设备点击“上传当前插件列表”。
5. 其他设备填相同存储配置，点击“预览差异”。
6. 检查差异无误后，点击“下载并应用”。
7. 若结果不符合预期，点击“回滚”恢复到应用前快照。

首台上传后，远端对象默认位于：

```text
s3://<bucket>/<prefix>/<profile-name>.json
```

例如 desktop profile、Prefix 为 `dsh-plugin-list-sync`：

```text
s3://dsh-config/dsh-plugin-list-sync/desktop.json
```

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| S3 端点 | 必填 | 例如 `https://s3.amazonaws.com`、`https://r2.example.com` 或 `http://127.0.0.1:9000`。Endpoint 不应附带 bucket/path。 |
| Region | `auto` | AWS 使用真实 Region；MinIO / RustFS 等通常可保留 `auto`（签名时使用 `us-east-1`）。 |
| Bucket | 必填 | 存放同步 manifest 的桶。 |
| Prefix | `dsh-plugin-list-sync` | 对象 key 前缀，适合按团队、环境或用途隔离。 |
| Path-Style 寻址 | 开启 | MinIO / RustFS 常需要；AWS S3 和部分 R2 endpoint 可关闭以使用 virtual-host-style。 |
| 允许明文 HTTP | 关闭 | 仅允许本机或受控测试环境使用，生产环境应保持 HTTPS。 |
| 请求 SSE-S3 AES256 加密 | 关闭 | 只在服务端已配置 SSE-S3 / KMS 时开启。RustFS 未设置 `RUSTFS_SSE_S3_MASTER_KEY` 时必须关闭。 |
| 同步 LLM provider 配置 | 关闭 | 开启后同步完整 patch 层，可能包含私有网关、模型目录等环境信息。 |
| 本机标签 | 空 | 写入 manifest 的来源标签，如 `office-desktop`、`dev-laptop`，便于审计。 |

### 凭据存储

通过设置页保存的凭据保存在本机：

```text
<profile>/.dsh-plugin-list-sync/credentials.json
```

它与同步文件隔离：

- 不会写入 `package.json` 或 `cordis.patch.yml`。
- 不会写入或上传至 S3 manifest。
- 设置页只展示掩码后的 AccessKey ID。
- 删除已保存凭据后，插件可回退使用环境变量：

```text
DSH_PLUGIN_SYNC_S3_KEY
DSH_PLUGIN_SYNC_S3_SECRET
```

> 保护该 Profile 目录的系统账户权限；不要把 `.dsh-plugin-list-sync/credentials.json` 提交到 Git、共享盘或备份到不可信位置。

## 操作语义

### 上传当前插件列表

1. 拉取远端现有 manifest，读取 revision 与 ETag。
2. 从当前 Profile 生成本地 manifest。
3. revision 自增后通过 `PUT` 上传。
4. 可用时携带 `If-Match`，避免覆盖另一个客户端刚提交的版本。

### 预览差异

仅读取远端对象，不修改本机。差异可能包括：

- 待安装插件
- 待升级 / 降级的插件版本
- 待移除插件
- bundle 顺序变化
- `cordis.patch.yml` 结构差异与插件启用状态变化

显示“**已同步，无差异**”表示请求已经完成，不代表页面仍在加载。

### 下载并应用

1. 下载并严格验证远端 manifest。
2. 生成差异计划。
3. 创建本地快照。
4. 写入新的 Profile 文件，并通过 DSH pluginManager 编排插件安装或移除。
5. 若任一步失败，可使用回滚恢复快照。

### 回滚

回滚恢复指定快照中的 `package.json` 和 `cordis.patch.yml`。回滚前也会再次创建快照，避免二次操作不可逆。

## S3 权限最小集

同步只读写一个对象，不需要列桶、删除对象或管理桶。建议向专用 IAM 用户/服务账号授予最低权限：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::<bucket>/<prefix>/*"
    }
  ]
}
```

不同 S3 兼容服务的权限语法可能不同，但建议保持同等最小权限边界。

## 安全模型

1. **HTTPS 默认**：HTTP 必须用户显式开启。
2. **签名请求**：使用 AWS Signature Version 4，不依赖大体积 AWS SDK。
3. **远端内容校验**：manifest 有格式版本、大小限制、npm 风格包名校验和字段白名单。
4. **凭据隔离**：凭据不参与 manifest 序列化。
5. **同源保护**：所有写操作 API 检查 same-origin，避免其他网页驱动本机 Host。
6. **快照优先**：应用前先备份，降低批量变更风险。
7. **官方组件本地化**：不跨客户端同步官方 DSH bundle，防止 runtime 不兼容。

## 命令接口

在支持 DSH 人类命令的环境中可使用：

```text
/plugin-sync status
/plugin-sync upload
/plugin-sync diff
/plugin-sync pull
/plugin-sync rollback <snapshot-id>
```

日常推荐使用设置页：它会展示状态、差异预览与可回滚快照。

## 常见问题

### `The specified key does not exist.`

远端还没有 manifest。请在任意一台配置正确的客户端点击“上传当前插件列表”完成首次初始化。

### `SSE-S3 requires RUSTFS_SSE_S3_MASTER_KEY ...`

RustFS 服务端未配置 SSE-S3 主密钥。请在设置页关闭“请求 SSE-S3 AES256 加密”；默认即为关闭。也可以由 RustFS 管理员配置 `RUSTFS_SSE_S3_MASTER_KEY` 或 KMS 后再开启。

### 显示“已同步，无差异”后仍有“处理中…”

旧版客户端曾在成功响应后遗留 loading 文案。更新到包含该修复的版本后刷新页面即可；请求实际已完成，差异结果以“远端差异”区域为准。

### 插件安装/移除失败，提示 minimumReleaseAge 或 peer dependency

这是 DSH/pnpm 的供应链或兼容性策略在阻止变更，不应强行绕过。请先检查远端插件版本是否兼容本机 DSH runtime，必要时等待包越过发布时间策略窗口或改用兼容版本。

### 新版本代码未生效

客户端设置页代码通常刷新页面即可更新；Host 侧（Node ESM）更新后请重启 DSH。

## 开发与维护

```powershell
# 静态检查 + 核心回归
pnpm run check

# 仅核心自测
pnpm test

# 本地 S3 mock（另一终端）
pnpm run test:s3-mock

# mock 启动后，执行完整 S3 上传/下载/应用/回滚 E2E
pnpm run test:e2e
```

项目只依赖 Node 内置模块，未引入 AWS SDK。请先阅读：

- [架构说明](docs/architecture.zh.md)
- [部署与排错](docs/operations.zh.md)
- [贡献指南](CONTRIBUTING.zh.md)
- [变更记录](CHANGELOG.md)

## 支持与反馈

- 问题与缺陷：<https://github.com/smellgamed3/dsh-plugin-list-sync/issues>
- 源码：<https://github.com/smellgamed3/dsh-plugin-list-sync>

提交问题时请隐藏 AccessKey、SecretKey、对象内容和私有 Endpoint；建议提供 DSH 版本、插件版本、S3 服务类型、Region、Path-Style 选项、完整错误码与脱敏日志。

## 许可证

[MIT](LICENSE)

---

本插件不是 DSH 官方组件，也不会规避 DSH 的兼容性和供应链安全策略。请始终先预览差异，再应用远端配置。
