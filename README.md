# CoHub

中文智能体编排体系 monorepo：一套 12 个 `co-*` 专职代理的编排体系在两个平台的移植版。`dsh-cohub` 额外多一个 `co-cordis`（Cordis 插件 / preset 修复），共 13 个 skill。

两个平台包均**已在本仓库内**并可独立构建，不再有外部仓库。

## 子包

版本号以各包 `package.json` 为准；变更历史见对应 CHANGELOG。

| 包路径 | 描述 | 变更历史 | 状态 |
|--------|------|----------|------|
| `packages/oh-my-opencode-cohub` | OpenCode 插件 | [CHANGELOG](packages/oh-my-opencode-cohub/CHANGELOG.md) | 已迁入，可构建 |
| `packages/dsh-cohub` | DeepSeek Harness 插件 | [CHANGELOG](packages/dsh-cohub/CHANGELOG.md) | 已迁入，可构建 |

## 目录结构

| 路径 | 内容 |
|------|------|
| `packages/dsh-cohub` | DSH 插件（13 个 skill、council 工具、orchestrator preset） |
| `packages/oh-my-opencode-cohub` | OpenCode 插件（12 专职代理 + 1 个 GPT 变体、中文注入、TUI 面板） |
| `cohub-shared` | 跨包共享的零平台依赖纯逻辑单一真源，经 `sync.ts` 复制到各包 `src/shared/` |
| `normify-cohub` | 本仓库自身的架构结构图（Normify 模块树 + 交互式 HTML） |
| `docs` | 仓库级文档，如 `npm-release-setup.md` |
| `.github` | 仓库根 CI/CD，如 `workflows/publish.yml` |

根 `package.json` 提供两个便捷脚本：`npm run build:opencode` / `build:dsh`。

## 开发约定

1. **先构建再测试**：`packages/dsh-cohub` 的 `lib/` 与生成的 `src/skills.ts` 都在 `.gitignore` 中，干净 clone 后**必须先 `npm run build`** 才能运行测试。同理，opencode 包的 `src/prompts/*.ts` 为生成物。
2. **独立构建**：各子包拥有独立的 `package.json`，各自 `npm install`、各自构建，依赖各自平台 SDK。不使用 npm workspaces。
3. **独立版本**：两个包的版本号彼此无关，各自按语义化版本推进（当前值见各包 `package.json`）。
4. **发版标签**：发布时 Git tag 带平台前缀，例如 `dsh-v<版本>`、`opencode-v<版本>`。
5. **CI/CD 注意事项**：GitHub Actions 只识别仓库根 `.github/workflows/` 目录下的 workflow 文件，各子包内的 workflow 不会被自动加载。如需启用发布流水线，须在仓库根重建 workflow 文件并通过 `working-directory` 配置子包路径。
6. **TypeScript 配置自治**：各子包独立维护 `tsconfig.json`，不共享 `tsconfig.base.json`，避免因配置差异破坏构建。

## 迁移来源

本项目于 2026 年 9 月由两个独立仓库的快照合并而来：

- [Mr-cjf/oh-my-opencode-cohub](https://github.com/Mr-cjf/oh-my-opencode-cohub)（已归档）
- [Mr-cjf/dsh-cohub](https://github.com/Mr-cjf/dsh-cohub)（已归档）
