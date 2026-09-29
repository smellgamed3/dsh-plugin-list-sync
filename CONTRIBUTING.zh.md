# 贡献与维护指南

[中文主文档](README.zh.md) · [架构说明](docs/architecture.zh.md) · [部署与排错](docs/operations.zh.md)

感谢参与 `dsh-plugin-list-sync`。本项目处理 Profile 文件、插件安装和云端对象，因此每一项改动都应优先保证可验证性、可回滚性和敏感数据隔离。

## 开发原则

1. **预览先于写入**：新功能不得绕过 diff/确认路径直接批量改写 Profile。
2. **快照先于应用**：任何会变更 `package.json` 或 `cordis.patch.yml` 的操作必须先创建快照。
3. **凭据永不上传**：不得把 SecretKey、token、Cookie 或 credential 文件放进 manifest、调试输出、测试夹具或 issue。
4. **官方 bundle 不跨机覆盖**：不得同步 `@deepseek-ai/*` runtime bundle。
5. **兼容性失败必须显式**：不要通过自动宽松 peer dependency、静默忽略 pluginManager 错误或版本豁免掩盖风险。
6. **零或最小运行时依赖**：优先 Node 内置能力；引入依赖必须说明维护成本、供应链影响和 DSH compatibility 范围。

## 本地环境

```text
Node.js >= 20
pnpm >= 10（推荐与 DSH profile 使用的版本兼容）
DeepSeek Harness desktop 或 web profile（用于真机验证）
```

仓库目录：

```text
lib/       Host 逻辑
client/    Web 设置页 bundle
test/      自测、S3 mock 与 E2E
docs/      架构和运维文档
```

## 常用命令

```powershell
# 快速静态检查 + 核心回归
pnpm run check

# 仅核心自测
pnpm test

# 终端 A：启动带 SigV4 校验的 S3 mock
pnpm run test:s3-mock

# 终端 B：mock 运行时执行端到端流程
pnpm run test:e2e
```

`test:e2e` 会演练上传、HEAD、ETag 条件写入、预览、应用和回滚。运行前先阅读脚本中的 Profile 路径与备份策略，避免在未理解的真实 Profile 上执行。

## 真机调试

### 本地安装

```powershell
dsh plugin add file:C:/absolute/path/to/dsh-plugin-list-sync
```

或在目标 Profile 添加本地 `file:` dependency 后运行 `pnpm install`。

### 代码刷新规则

| 改动 | 生效方式 |
| --- | --- |
| `client/client.js` | 刷新 DSH 页面；若 HMR/模块表未重新扫描，硬刷新。 |
| `lib/*.js` | 重启 DSH；Node ESM 会缓存 Host 模块。 |
| `cordis.patch.yml` | 通常由 profile `patchReload: live` 处理，但仍须验证。 |
| `package.json` bundle/依赖 | 执行安装后重启 DSH。 |

不要因页面显示旧状态就重复提交同一上传操作；先检查远端 revision、对象时间和 Host 重启状态。

## 代码规范

### Host

- 所有外部输入（HTTP body、S3 manifest、路径、环境变量）先验证再使用。
- 所有 S3 错误转换为稳定、可显示的 `S3Error.code`。
- 不在异常、日志或返回 JSON 中带出 SecretKey。
- HTTP 写路由必须继续使用 same-origin 检查。
- 修改 S3 header、canonical request 或签名时，必须更新 mock/E2E 验证。

### 客户端

- 输入框为受控组件时，修改状态必须触发渲染；否则会出现无法输入、粘贴后回弹等问题。
- `localStorage` 仅保存非敏感连接信息，禁止保存 AccessKey/SecretKey。
- 请求成功后清理临时 loading 文案；结果区域与 loading 状态不得互相矛盾。
- 新增文案时同时补充 `DICT_ZH` 和 `DICT_EN`。

### Manifest 与 Apply

- 修改 manifest 必须考虑向后兼容与版本号演进。
- 默认 patch 投影不得破坏本地官方 LLM/provider 配置块。
- 对对象字段进行稳定排序/比较，避免 JSON key 顺序产生伪差异。

## Pull Request 要求

PR 描述至少包含：

- 问题与设计目标
- 受影响模块
- 安全影响（凭据、Profile 写入、S3 权限、跨域）
- 兼容性影响（DSH runtime、S3 实现、已有 manifest）
- 测试命令与结果
- 若有 UI 变更：中文/英文截图或操作说明

请将相互独立的重构、功能和格式化拆分提交。不要把真实生产凭据、对象内容、`.dsh` Profile 私有文件加入 Git。

## 发布清单

发布或生成新安装版本前：

- [ ] 更新 `CHANGELOG.md`
- [ ] 更新 README / 运维文档中的用户可见行为
- [ ] 执行 `pnpm run check`
- [ ] 运行 mock S3 E2E
- [ ] 用至少一个真实兼容后端验证 GET/PUT（建议 RustFS 或 MinIO）
- [ ] 验证 SSE-S3 默认关闭，及开启时的后端行为
- [ ] 验证首次上传、预览、应用、回滚
- [ ] 验证凭据从 UI 保存、掩码显示、清除和 env fallback
- [ ] 在干净 Profile 上重新安装并重启 DSH 验证 Host 加载

## 报告安全问题

不要在公开 issue 中披露凭据、私有 Endpoint、bucket 内容或内部网络信息。请通过仓库维护者指定的私密渠道报告，或先创建脱敏 issue 说明影响范围。
