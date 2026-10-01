# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的记录风格，并尽量以语义化版本表达兼容性影响。

## [Unreleased]

### Added

- **强制覆盖开关（显式、一次性、不持久化）**：
  - 设置页新增"强制覆盖"区块：`强制覆盖远端`（上传时用本机状态替换远端清单，远端独有插件会被移除）与 `强制覆盖本地`（应用时镜像远端清单，本地独有插件会被卸载、版本可被降低）。
  - 两个开关均**不写入** localStorage、settings.json 或任何持久化存储；仅对下一次操作生效，操作完成（无论成败）自动复位。
  - 强制覆盖本地需两道确认：必须先以勾选状态重新"预览差异"看到 replace 计划（否则服务端以 `confirm-required` 拒绝），再通过列明具体卸载/降级清单的确认弹窗。
  - `/plugin-sync upload --force` 强制替换远端；`/plugin-sync diff --force` 预览 replace 计划；命令面**不支持**强制覆盖本地（`pull --force` 被拒绝），必须走设置页的双重确认。
  - 强制上传结果报告 `droppedRemotePackages`；强制上传也允许覆盖远端损坏对象（merge 模式则拒绝）。

### Added (prior)

- 可选文件变化 debounce 自动上传与可选定时远端更新检查。
- Profile 私有非敏感 `settings.json` 自动化策略存储。
- 自动化状态、最近上传/检查和错误状态 API。

### Changed

- 自动化控制器不持有 apply、安装、移除或远端 Profile 写入能力；远端变更始终需人工确认。
- 手动 apply/rollback 会抑制 watcher 上传，避免远端状态回显覆盖。

### Documentation

- 补充中文主文档、架构说明、部署与排错手册、贡献与发布维护指南。

## [0.2.0] - 2026-09-29

### Changed

- **上传与下载全面改为合并（merge）语义**：
  - 下载应用远端清单时，本地已有的第三方插件**绝不会被移除**——即使远端清单中没有它们。
  - 远端版本低于本地时**绝不降级**：共同插件取两端中更高的版本，远端更旧时保留本地版本并在预览中标注（`keptLocal`）。
  - 上传时本地清单先与远端清单合并（`mergeManifests`）：仅存在于远端的插件会被保留，不会因本机未安装而被"删除"；上传结果会报告 `preservedRemotePackages` 与 `keptLocalVersions`。
  - 远端对象存在但校验失败（损坏/不合法）时，上传拒绝覆盖，避免静默丢弃未知内容。
- `dsh.profile.bundles` 与 `cordis.patch.yml` 补丁行均按并集合并：
  - bundles 取"本地顺序在前 + 远端独有条目追加"，任何本地 bundle 不会被禁用或移除。
  - patch 行按 `id` 合并：本地行的嵌套 `config:` 块（LLM provider、模型目录）原样保留，只有 `disabled` 开关随远端同步；远端独有行追加。
- 差异计划（`diffManifests`）不再产生 `removals` / `downgrades`（字段保留为空数组以兼容旧 UI），新增 `keptLocal` / `localOnly` / `localOnlyBundles` 供预览展示。
- `orchestrateInstalls` 只执行安装与升级，不再调用 `removeBundle`。
- 预览界面与 `/plugin-sync` 命令输出标注合并语义与"保留本地版本/本地独有"信息。

### Fixed

- 修复下载应用会删除本地独有插件、会用远端旧版本覆盖本地新版本的问题（本版本的核心目标）。
- 修复上传会用本机状态整体替换远端清单、导致其他客户端独有插件从远端消失的问题。

## [0.1.0] - 2026-09-28

### Added

- S3 兼容的插件列表 manifest 上传、下载、预览和应用。
- AWS Signature Version 4 的 GET / HEAD / PUT 实现，支持 AWS S3、MinIO、RustFS、R2、OSS S3 API 等。
- Path-Style 与 Virtual-Host-Style 寻址支持。
- Profile 快照与回滚机制。
- 远端 manifest 严格验证与差异计划。
- 设置页：连接配置、凭据保存、手动上传/预览/应用/回滚。
- 本地凭据隔离存储与环境变量 fallback。
- LLM provider 配置默认不参与同步的保护机制。
- 核心自测、SigV4 S3 mock 和端到端测试。

### Fixed

- 避免同步官方 DSH bundle 导致的跨 runtime 兼容风险。
- 保留本地官方 LLM/provider 的嵌套 patch 配置，避免 apply 时丢失模型设置。
- 修复客户端凭据受控输入无法输入/粘贴的问题。
- 修复表单配置 payload 从客户端到 Host 的嵌套结构不匹配。
- 成功预览后清理遗留的“处理中…”提示。
- SSE-S3 默认关闭，避免 RustFS 未配置 master key/KMS 时拒绝上传。

[Unreleased]: https://github.com/smellgamed3/dsh-plugin-list-sync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/smellgamed3/dsh-plugin-list-sync/releases/tag/v0.2.0
[0.1.0]: https://github.com/smellgamed3/dsh-plugin-list-sync/releases/tag/v0.1.0
