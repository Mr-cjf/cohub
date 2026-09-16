# CoHub

中文智能体编排体系 monorepo，一套 12 个 co-* 专职代理的编排体系在三个平台的移植版。

## 子包

| 包路径 | 描述 | 版本 | 状态 |
|--------|------|------|------|
| `packages/zcode-cohub` | ZCode 插件，MCP Server + Skills | v0.1.0 | 待迁入 |
| `packages/oh-my-opencode-cohub` | OpenCode 插件 | v1.17.0 | 待迁入 |
| `packages/dsh-cohub` | DeepSeek Harness 插件 | v0.4.10 | 待迁入 |

## 开发约定

1. **独立构建**：各子包拥有独立的 `package.json`，各自 `npm install`、各自构建，依赖各自平台 SDK。不使用 npm workspaces。
2. **发版标签**：发布时 Git tag 带平台前缀，例如 `dsh-v0.4.11`、`opencode-v1.18.0`。
3. **CI/CD 注意事项**：GitHub Actions 只识别仓库根 `.github/workflows/` 目录下的 workflow 文件，各子包内的 workflow 不会被自动加载。如需启用发布流水线，须在仓库根重建 workflow 文件并通过 `working-directory` 配置子包路径。
4. **TypeScript 配置自治**：各子包独立维护 `tsconfig.json`，不共享 `tsconfig.base.json`，避免因配置差异破坏构建。

## 迁移来源

本项目于 2026 年 9 月由三个独立仓库的快照合并而来：

- [Mr-cjf/zcode-cohub](https://github.com/Mr-cjf/zcode-cohub)（已归档）
- [Mr-cjf/oh-my-opencode-cohub](https://github.com/Mr-cjf/oh-my-opencode-cohub)（已归档）
- [Mr-cjf/dsh-cohub](https://github.com/Mr-cjf/dsh-cohub)（已归档）