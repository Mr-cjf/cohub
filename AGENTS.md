# cohub 仓库

中文智能体编排插件的**多平台移植版 monorepo**——将同一套 12 代理编排体系（orchestrator / planner / oracle / librarian / explorer / designer / fixer / observer / council / rule-user / rule-project / rule-app）分别适配到两个 AI 编程平台，共享核心设计但各自遵循平台原生机制。

## 仓库结构

| 包 | 平台 | 注册形式 | 状态 |
|---|------|---------|------|
| `packages/dsh-cohub` | DeepSeek Harness | Cordis Plugin（runtime skills + preset） | **当前主力** |
| `packages/oh-my-opencode-cohub` | OpenCode | `@opencode-ai/plugin` SDK（agent + hook + TUI） | 原版（已归档到本 monorepo） |

> OpenCode 侧 orchestrator 提供 GPT 专用变体 `co-orchestrator-gpt`（纯调度，专为 GPT 系用户）；DS 侧默认路径不变，继续用 `co-orchestrator`。

## 包边界纪律

两个包各自绑定自己的平台路径体系，**改一个包时不要串改其他包**：

| 包 | 用户配置根 | 应用级规范目录 |
|---|-----------|-------------|
| `dsh-cohub` | `~/.dsh/` | `~/.dsh/rules/` |
| `oh-my-opencode-cohub` | `~/.config/opencode/` | `.opencode/rules/` |

## 规范文件约定

- **项目级入口**：本文件 `AGENTS.md`——DSH 平台原生机制 + `co-rule-project` 技能均从此读取。
- **按主题拆分的细则**：`.rules/*.md`——集中维护一处，切换任何代理都能读到。文件以两位数字前缀排序（如 `01-coding-style.md`），一主题一文件，避免单文件过长。

## 产物与源的区别

以下文件是**生成物**，已被 `.gitignore` 排除，手动修改会被下次构建覆盖：

| 生成物 | 对应的源文件 |
|--------|------------|
| `lib/` | `src/*.ts`（`bun build` 编译产出） |
| `src/skills.ts`（dsh-cohub） | `skills/*.md`（技能 Markdown 源文件） + `scripts/generate-skills.ts`（元数据脚本） |

修改技能内容时请编辑 `skills/*.md`，然后运行构建：

```bash
bun run build
```

<!-- COHUB_AGENTS_E2E_MARKER -->