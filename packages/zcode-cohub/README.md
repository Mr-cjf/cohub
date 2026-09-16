# zcode-cohub

ZCode 平台的中文智能体编排插件——12 个专职代理技能 + MCP Server 委派/共识工具 + 中文语言注入。

## 技能清单（12 个）

| 技能 | 角色 |
|------|------|
| `co-orchestrator` | 纯调度者——分析需求→委派信息收集→委派 co-planner 制定方案→审核→调度执行→委派验证。绝不亲自操作，全部委派。 |
| `co-planner` | 方案制定——综合需求+信息+规范，输出按 Wave 分组的结构化任务分解方案。 |
| `co-oracle` | 战略技术顾问——架构审查 / 代码审查 / YAGNI 简化 / 复杂调试。只读，不修改文件。 |
| `co-explorer` | 快速代码库导航——回答"X 在哪里？""找到 Y""哪个文件有 Z"。只读。 |
| `co-librarian` | 代码库和文档研究——官方文档查询、GitHub 示例、库研究。只读+Web。 |
| `co-designer` | 前端 UI/UX 专家——创造和审查有意图的、精致的体验。读写。 |
| `co-fixer` | 快速实现专家——高效执行代码变更。读写+Bash。不研究、不委派，直接实施。 |
| `co-observer` | 视觉分析专家——解释图片、截图、PDF 和图表。只读。 |
| `co-council` | 多模型并行共识——跨多个 LLM 模型运行共识并综合结果。只读，使用 `co_council` 工具。 |
| `co-rule-user` | 用户级规则分析——读取 `~/.zcode/AGENTS.md` 结合方案给出调整建议。只读。 |
| `co-rule-project` | 项目级规则分析——读取项目 `AGENTS.md` 结合方案给出调整建议。只读。 |
| `co-rule-app` | 应用规则分析——分析 `.zcode/rules/*.md` 规则文件，逐文件给出映射建议。只读。 |

## Hooks

| Hook | 触发点 | 功能 |
|------|--------|------|
| `chinese-inject` | SessionStart（startup / resume） | 注入中文语言要求到系统提示词 |
| `job-board` | UserPromptSubmit | 在用户消息末尾注入后台任务看板信息 |
| `orchestrate-remind` | UserPromptSubmit | 注入调度纪律提醒（orchestrator 流程步骤） |
| `agent-tracker` | PreToolUse / PostToolUse / PostToolUseFailure（Agent / Task） | 追踪子代理任务生命周期（spawn → completed / failed），驱动 job-board 面板 |
| `grep-counter` | PostToolUse（Grep） | 监听 Grep 调用频率，达阈值时通过 additionalContext 注入 `co_scan` 提醒 |

## 安装

本包为 ZCode 插件，通过 ZCode 插件机制加载。插件清单位于 `.zcode-plugin/plugin.json`，以 MCP Server 形式运行（命令 `node ${ZCODE_PLUGIN_ROOT}/dist/src/index.js`）。

安装方式（开发模式）：

```bash
cd packages/zcode-cohub
npm install
npm run build
bun scripts/install.ts          # 开发模式加 --dev
```

> 安装脚本负责：向 ZCode 注册插件（marketplace / known_marketplaces / installed_plugins / enabledPlugins）、铺设 11 个角色 agent 模板到 `~/.zcode/agents/`（保留用户在设置界面改过的模型等用户键）、构建产物置于插件数据目录。安装后需**新开会话**，ZCode 才会重新加载插件缓存中的 skills 与 hooks。

角色模型分配：除 `orchestrator` 外的 11 个角色同时是用户级 subagent，可在 ZCode **Settings → Subagents** 里逐个角色指定模型（如 `co-explorer` 用便宜的快速模型、`co-oracle` 用强推理模型）。

## 开发与构建

**依赖 Bun**：脚本内部实际执行 `bun run` / `bun build` / `bun test`，必须先安装 Bun（npm 仅作入口）。

```bash
npm install           # 安装依赖
npm run build         # 构建：generate-skills → generate-agents → 打包 src/index.ts → tsc 生成 .d.ts
npm run build:hooks   # 单独构建 5 个 hook 脚本 → dist/hooks/
npm test              # 运行测试（bun test ./src）
```

构建产物在 `dist/`，`skills/`、`hooks/` 和 `.zcode-plugin/` 目录随包发布。

## 架构

```
zcode-cohub/
├── .zcode-plugin/plugin.json    # ZCode 插件清单（MCP Server 入口）
├── skills/                       # 12 个 ZCode skills（SKILL.md YAML frontmatter）
├── agents-template/             # 11 个角色 agent 模板（生成物）
├── hooks/hooks.json             # Hook 注册（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure）
├── src/                         # MCP Server 源码
│   ├── index.ts                 # MCP Server 入口（4 工具分发）
│   ├── tools/                   # co_delegate / co_council / co_close_job / co_scan
│   ├── context/                 # 上下文共享引擎
│   ├── hooks/                   # Hook 脚本
│   └── utils/                   # 工具函数
└── scripts/                     # generate-skills / generate-agents / install
```

## MCP 工具

| 工具 | 功能 |
|------|------|
| `co_delegate` | 提示词装配器——匹配 skill → 登记任务/上下文 → 返回装配结果。可选路径：orchestrator 默认直接 spawn 子代理。 |
| `co_council` | 多模型并行共识 |
| `co_close_job` | 取消作业 |
| `co_scan` | 批量符号引用统计——一次调用替代 N 次搜索 |

## 许可证

MIT — 详见 [LICENSE](./LICENSE)。