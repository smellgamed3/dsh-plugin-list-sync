# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的记录风格，并尽量以语义化版本表达兼容性影响。

## [Unreleased]

### Documentation

- 补充中文主文档、架构说明、部署与排错手册、贡献与发布维护指南。

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

[Unreleased]: https://github.com/smellgamed3/dsh-plugin-list-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/smellgamed3/dsh-plugin-list-sync/releases/tag/v0.1.0
