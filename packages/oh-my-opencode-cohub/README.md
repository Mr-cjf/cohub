# oh-my-opencode-cohub

OpenCode 中文智能体编排插件 CoHub——纯调度模式、全中文提示词、编排引擎、上下文共享、规范分析代理、方案制定代理。

[![GitHub](https://img.shields.io/badge/GitHub-Mr--cjf%2Fcohub-blue?logo=github)](https://github.com/Mr-cjf/cohub)

## 特性

- 🚀 **独立运行**：纯 OpenCode Plugin，依赖 `@opencode-ai/plugin` SDK，零外部插件依赖
- 🤖 **12 个专职代理 + 1 个 GPT 专用变体（co-orchestrator-gpt）**：8 个通用代理（orchestrator/oracle/librarian/explorer/designer/fixer/observer/council）+ 4 个规范/方案代理（rule-user/rule-project/rule-app/planner）+ 1 个 GPT 专用 orchestrator 纯调度变体
- 🪝 **自动注入**：通过 `experimental.chat.system.transform` 钩子在每次 LLM 调用时统一注入中文语言要求与并行工具调用总则（覆盖全部 13 个 agent）
- 🧠 **纯调度 Orchestrator**：不碰任何文件工具，只负责规划、委派、验证
- 🇨🇳 **全中文提示词**：13 个 agent 全部使用中文提示词
- 📋 **规范分析代理**：rule-user（用户级 AGENTS.md）、rule-project（从项目根逐级发现 AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md 及 `.rules/*.md`）、rule-app（定向分析 `.opencode/rules/*.md`）
- 🎯 **方案制定代理**：planner 综合所有输入输出结构化任务分解
- 🔗 **编排引擎（Orchestration Engine）**：六状态 DAG 状态机（pending→ready→running→completed/failed→cancelled），诚实镜像原生 task 生命周期（观测/内部状态同步，不激活自动调度/自动重试）；级联取消仅同步引擎内部状态，不会自动 abort 其他运行会话
- ⚡ **Wave 波次并行工作流**：理解→收集→规范分析→制定方案（按依赖分 Wave）→按波次并行调度（区分修改/验证 Wave）→验证，并行与失败处理由主代理显式推进。Wave 仅展示依赖层次，不构成整体等待屏障：任务实际前置依赖完成且无共享可变状态冲突即可派发，同次所有已就绪任务同一消息同时启动，不等无关任务
- 📜 **AGENTS.md 专用分析代理**：co-rule-user / co-rule-project / co-rule-app 三个专用代理分别分析用户级/项目级 AGENTS.md 与 .opencode/rules，orchestrator 在方案制定前自动委派，分析结果注入执行上下文
- 📖 **架构借鉴**：插件架构和代理编排理念借鉴了 oh-my-opencode-slim，但完全独立实现、无运行时依赖
- 🔒 **同工作树构建互斥**：同一 projectDir 下多个 OpenCode 会话并行时，构建类命令（npm/bun/pnpm/yarn build、bun build、tsc、generate-prompts）自动串行加锁；不同 worktree 并行不受影响；建议独立特性使用 `git worktree` 隔离

## 安装

### 前置条件

- [OpenCode](https://opencode.ai) 已安装
- [Bun](https://bun.sh) 已安装（隔离 HOME 检验与源码构建需要；官方插件安装不需要）

### 方式一：官方插件安装（推荐，真实 HOME）

```bash
opencode plugin oh-my-opencode-cohub@<精确版本号> --global --force
```

> 安装前先对 `~/.config/opencode/opencode.json` 与 `~/.config/opencode/tui.json` 做**时间戳备份**；命令只写入插件相关条目，**保留其他配置**。

1. 将 `oh-my-opencode-cohub@<精确版本号>` 注册到全局 `plugin` 配置（`--global --force` 覆盖为指定精确版本）
2. 插件运行时写入默认配置文件 `~/.config/opencode/oh-my-opencode-cohub.json`
3. **重启 OpenCode 后生效**——已运行的会话不会热切加载新版本，需用户重启

> **bunx 包 CLI 仅用于隔离 HOME 检验**：`bunx oh-my-opencode-cohub install/uninstall` 等包自带 CLI 只在隔离 HOME 环境中验证安装/卸载流程，**不要在真实 HOME 上整文件重写配置**。

### 方式二：npm 安装 + 手动配置

```bash
npm install oh-my-opencode-cohub
```

然后在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["oh-my-opencode-cohub"]
}
```

重启 OpenCode 即可。

### 方式三：复制文案交给 AI 配置

如果你不想用命令行，也可以复制以下文案粘贴给 AI，让 AI 帮你生成 `oh-my-opencode-cohub.json` 配置文件。

> **注意：这只生成 `oh-my-opencode-cohub.json`（代理模型配置）。插件本身仍需通过方式一或方式二安装。**

````

## 你的任务

帮我生成 oh-my-opencode-cohub 的配置文件。

**要求：收到后先分析我的环境、输出配置方案表格、等我确认后再写入文件，不要直接动手改。**

## 执行步骤

### 第一步：分析环境

读取 `~/.config/opencode/opencode.json`，找到所有已配置的 provider 和 model，整理成表格给我看。

### 第二步：输出配置方案

根据下面规则，输出每个代理的 model 和 variant 分配表格，等我确认。

### 第三步：写入文件

确认后将配置写入 `~/.config/opencode/oh-my-opencode-cohub.json`。

## 配置文件结构

```json
{
  "$schema": "https://unpkg.com/oh-my-opencode-cohub@latest/oh-my-opencode-cohub.schema.json",
  "agents": {
    "co-orchestrator": { "model": "provider/model", "variant": "max" },
    "co-orchestrator-gpt": { "model": "provider/model", "variant": "max" },
    ...
  },
  "council": {
    "default_preset": "default",
    "timeout": 180000,
    "councillor_execution_mode": "parallel",
    "councillor_retries": 3,
    "presets": {
      "default": {
        "alpha": { "model": "provider/model", "variant": "max" },
        "beta":  { "model": "provider/model", "variant": "high" },
        "gamma": { "model": "provider/model", "variant": "medium" }
      }
    }
  }
}
```

## 13 个 agent 配置规则（12 专职 + 1 GPT 变体）

| 代理 | 角色 | 推理强度 | variant 建议 | 模型偏好 |
|------|------|---------|-------------|---------|
| co-orchestrator | 纯调度者，编排任务、委派执行 | **重型** | max / xhigh | pro、max、sonnet、opus 等强推理模型 |
| co-orchestrator-gpt | GPT 专用纯调度变体（DS 用户仍用 co-orchestrator） | **重型** | max / xhigh | gpt-5 等 GPT 系强推理模型 |
| co-oracle | 战略顾问，架构审查、复杂调试 | **轻型** | low / medium | flash、mini、haiku 等轻量快速模型 |
| co-planner | 方案制定，综合信息输出任务分解 | **轻型** | low / medium | 同上 |
| co-council | 多模型共识，跨多个 LLM 综合 | **轻型** | low / medium | 同上 |
| co-librarian | 研究员，查文档、搜 GitHub、Web 搜索 | **轻型** | low / medium | flash、mini、haiku 等轻量快速模型 |
| co-explorer | 代码探索者，grep/glob 搜索定位 | **轻型** | low / medium | 同上 |
| co-fixer | 执行者，代码修改、编译、测试 | **轻型** | low / medium | 同上 |
| co-rule-user | 分析用户级 AGENTS.md 规范 | **轻型** | low / medium | 同上 |
| co-rule-project | 分析项目 AGENTS.md 规范 | **轻型** | low / medium | 同上 |
| co-rule-app | 分析 .opencode/rules/* 应用规则 | **轻型** | low / medium | 同上 |
| co-designer | 设计师，UI/UX 设计、视觉润色 | **中等** | high / medium | sonnet、claude、minimax 等前端/视觉强的模型 |
| co-observer | 观察者，图片/PDF/截图视觉分析 | **中等** | medium / high | vision、flash 等支持视觉的模型 |

## council 详细说明

council 是内置的多模型共识机制，会将同一个问题发给 3 个 councillor 并行回答，然后综合出最优方案。

| councillor | 角色定位 | 推理强度 | variant 建议 |
|-----------|---------|---------|-------------|
| alpha | 主力深度推理 | **重型** | max / xhigh |
| beta | 第二视角互补 | **重型/中等** | high / xhigh |
| gamma | 第三方校验 | **中等** | medium / high |

**关键配置项说明：**

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `default_preset` | `"default"` | 默认使用的 preset 名称，可以定义多个 preset（如 `"quick"` 快速共识、`"deep"` 深度共识） |
| `timeout` | `180000`（3 分钟） | 单个 councillor 的超时时间（毫秒），所有 councillor 并行执行 |
| `councillor_execution_mode` | `"parallel"` | 执行模式：`"parallel"` 并行（快）或 `"serial"` 串行（省 tokens） |
| `councillor_retries` | `3` | 单个 councillor 调用失败后的重试次数 |

**presets 示例（多套配置）：**

```json
"presets": {
  "default": {
    "alpha": { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
    "beta":  { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" },
    "gamma": { "model": "openai/gpt-5.2", "variant": "high" }
  },
  "quick": {
    "alpha": { "model": "deepseek/deepseek-v4-pro", "variant": "high" },
    "beta":  { "model": "openai/gpt-5.2", "variant": "medium" },
    "gamma": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "medium" }
  }
}
```

## 分配规则

- 从 opencode.json 读取已配置的 provider，按上表规则为每个代理分配 model 和 variant
- 只有 1 个 provider：所有代理都用它，variant 按表格建议选不同档位
- 有多个 provider：co-orchestrator / co-orchestrator-gpt 优先选最强推理 provider，其余代理选最快 provider
- 主控代理选择：GPT 系用户选 `co-orchestrator-gpt`，DS 系用户选 `co-orchestrator`；两者权限一致（均可调用 `close_job`）
- council 的 alpha/beta/gamma 优先选 3 个不同 provider；不够 3 个时用同一 provider 的不同 model
- opencode.json 无任何 provider 时，生成占位配置并在 `_comment` 字段提示用户先配置

## 注意

- 只写入 `oh-my-opencode-cohub.json`，不要修改 `opencode.json`
- agent 名必须用 `co-` 前缀（共 13 个），不要遗漏
````

### 卸载

```bash
bunx oh-my-opencode-cohub uninstall
```

CLI 会精确清理所有 `co-*` 代理和相关配置，不影响其他插件的配置数据。

如果使用 npm 手动安装，则需手动从 `opencode.json` 的 `plugin` 数组中移除 `"oh-my-opencode-cohub"`，然后 `npm uninstall oh-my-opencode-cohub`。

### 验证安装

安装并重启 OpenCode 后，确认以下效果：

- 对话中自动出现 **中文语言要求**（如 "你必须始终使用中文进行思考、推理和回复"）
- 可用代理列表中出现 13 个 `co-*` 前缀 agent（12 专职 + 1 GPT 变体：`co-orchestrator`、`co-orchestrator-gpt`、`co-oracle`、`co-librarian`、`co-explorer`、`co-designer`、`co-fixer`、`co-observer`、`co-council`、`co-rule-user`、`co-rule-project`、`co-rule-app`、`co-planner`）
- Orchestrator 自动进入纯调度模式（只做规划、委派、验证，不直接操作文件）

### 故障排查：代理模型未生效？

如果重启后代理可见但 model/variant 未应用，或子代理仍然不可见，复制以下文案交给 AI 自动诊断修复：

> **适用场景**：`@` 列表中缺少某些 co-* 代理，或代理使用的 model 与预期不符。

````
## 你的任务

帮我在当前环境中诊断并修复 oh-my-opencode-cohub 的代理配置问题。

**诊断步骤（按顺序执行，执行完向我报告结果）：**

### 第一步：检查 opencode.json 的 agent 条目

读取 `~/.config/opencode/opencode.json`，检查 `agent` 字段中是否存在以下 13 个条目：
- co-orchestrator、co-orchestrator-gpt (mode: primary) + 其余 11 个 (mode: subagent)

如果缺少某些条目，说明插件未正确安装，运行以下命令重新安装：
```bash
bun pm cache rm && bunx oh-my-opencode-cohub@latest install
```

### 第二步：检查 model/variant 配置

读取 `~/.config/opencode/oh-my-opencode-cohub.json`，确认 `agents` 字段下每个代理都有 `model` 和 `variant`。

如果 agent 条目有 model 但 opencode.json 中缺少 model，手动将 model/variant 补入 opencode.json 对应条目：
```json
"co-explorer": {
  "mode": "subagent",
  "description": "...",
  "model": "deepseek-anthropic/deepseek-v4-flash",
  "variant": "low"
}
```

### 第三步：验证 config hook（仅诊断）

检查 `~/.local/share/opencode/storage/oh-my-opencode-cohub/config-hook-ran.json` 是否存在且 `count` 为 13。如果不存在或 count < 13，说明插件未正常加载，检查：
- opencode.json 的 `plugin` 数组是否包含 `"oh-my-opencode-cohub"`
- OpenCode 版本是否 >= 1.17

### 第四步：最终修复

如果以上检查都通过但代理仍无 model/variant，执行完整重装：
```bash
bunx oh-my-opencode-cohub uninstall && bun pm cache rm && bunx oh-my-opencode-cohub@latest install
```
重启 OpenCode 后验证。

### 第五步：验证修复

请确认以下内容后告诉我结果：
- TAB 切换列表中有 co-orchestrator
- `@` 输入时能看到至少 11 个子代理名称
- 随便 @ 某个子代理（如 `@co-explorer 搜索src目录`），确认它能正常工作
````

### 构建互斥与锁目录

同一 projectDir 下多个 OpenCode 会话并行构建时，插件自动加互斥锁。锁文件位于 `~/.local/share/opencode/storage/oh-my-opencode-cohub/build-locks/`，由插件自动管理（30 分钟 TTL + 进程陈旧检测），**不要手动删除锁文件**；不同 worktree 的构建互不影响。

### 从源码安装（本地开发）

如果需要修改源码或使用开发版本：

```bash
# 1. 克隆项目
git clone https://github.com/Mr-cjf/cohub.git && cd cohub/packages/oh-my-opencode-cohub

# 2. 安装依赖
npm install

# 3. 构建（需要系统已安装 Bun）
npm run build

# 4. 方式 A：npm link 全局链接（推荐）
npm link
bunx oh-my-opencode-cohub install
# 重启 OpenCode 即可。之后修改源码只需重新 npm run build

# 4. 方式 B：手动配置绝对路径
# 编辑 ~/.config/opencode/opencode.json，在 plugin 数组中写入项目绝对路径：
# { "plugin": ["/absolute/path/to/oh-my-opencode-cohub"] }
# 然后手动运行 CLI 注册代理：
# node dist/cli/index.js install
```

> **构建步骤**：`npm run build` 依次执行：1) `scripts/generate-prompts.ts` 将提示词文件生成 `src/prompts/*.ts` 导出模块；2) `bun build` 编译 `src/index.ts` + `src/tui.ts` → `dist/` 以及 `src/cli/index.ts` → `dist/cli/`；3) `tsc --emitDeclarationOnly` 生成 `.d.ts`。系统需安装 [Bun](https://bun.sh) 和 Node.js。所有 `@opencode-ai/*`、`@opentui/*`、`zod` 均为 external，不打包进 `dist/`。

## 代理一览

### 代理（13 个，全中文提示词）

| 代理 | 默认模型 | 职责 | 读取源 |
|------|----------|------|--------|
| co-orchestrator | `deepseek/deepseek-v4-pro` | 纯调度：规划→委派→验证 | — |
| co-orchestrator-gpt | `deepseek/deepseek-v4-pro` | GPT 专用纯调度变体：规划→委派→验证（DS 用户仍用 co-orchestrator） | — |
| co-oracle | `deepseek/deepseek-v4-flash` | 架构审查/代码审查 | — |
| co-librarian | `deepseek/deepseek-v4-flash` | 外部文档/API 研究 | — |
| co-explorer | `deepseek/deepseek-v4-flash` | 代码库搜索定位 | — |
| co-designer | `minimax/MiniMax-M3` | UI/UX 设计与实现 | — |
| co-fixer | `deepseek/deepseek-v4-flash` | 代码修改执行（含 TDD skill） | — |
| co-observer | `deepseek/deepseek-v4-flash` | 图片/PDF 分析 | — |
| co-council | `deepseek/deepseek-v4-flash` | 多模型共识 | — |
| co-rule-user | `deepseek/deepseek-v4-flash` | 用户级规范分析 | `~/.config/opencode/AGENTS.md` |
| co-rule-project | `deepseek/deepseek-v4-flash` | 项目级规范分析（从项目根到当前目录逐级发现 `AGENTS.md`/`CLAUDE.md`/`AGENTS.local.md`/`CLAUDE.local.md` 及该级 `.rules/*.md`，就近覆盖） | 项目根起的各级 `AGENTS.md` 等 + `.rules/*.md` |
| co-rule-app | `deepseek/deepseek-v4-flash` | 应用规则分析（**定向分析**：仅在方案确需对照时分析明确指定的 `.opencode/rules/*.md` 文件，不猜测、不扫描目录） | 明确指定的 `.opencode/rules/*.md` |
| co-planner | `deepseek/deepseek-v4-flash` | 方案制定 | 综合需求+信息+规则 |

> **注意**：上表模型为内置兜底值。安装时 CLI 会根据 `opencode.json` 中已配置的 provider 智能匹配并写入 `oh-my-opencode-cohub.json`；若 `opencode.json` 无 provider 则生成占位配置。最终生效模型以 `oh-my-opencode-cohub.json` 为准，也可通过下文「配置文件」或「自定义模型」章节手动覆盖。
>
> **工具权限**：`close_job` 仅 co-orchestrator 与 co-orchestrator-gpt 可调用；`council_session` 仅 co-council 可调用；其余代理配置层 deny，纵深防御。

## 编排引擎

CoHub 内置轻量编排引擎（`src/orchestration/`，6 模块），**诚实镜像 OpenCode 原生 task 生命周期**，为主代理的编排决策提供可观测的内部状态，而非接管任务执行：

| 组件 | 文件 | 职责 |
|------|------|------|
| 状态机引擎 | `engine.ts` | 六状态 DAG：`pending→ready→running→completed/failed/cancelled`；`tool.execute.before/after` 与 `event` hook 按 `(parentSessionID, callID)` 精确关联原生 task，镜像其生命周期；级联取消仅同步引擎内部状态（标记未完成后继为 cancelled），**不会自动 abort 其他运行中的会话** |
| 重试管理器 | `retry.ts` | 保留实现（指数退避 / fixed / immediate 策略判定），**当前入口未激活**：不自动重试/重派失败任务；宿主原生重试由 OpenCode 自行处理，插件仅观测记录 |
| 上下文契约 | `contract.ts` | `<!-- CONTRACT_BEGIN/END -->` 结构化块：关键结果 / 决策 / 修改文件 / 验证状态 / 待完成 / 警告，子代理间传递并自动去重 |
| 并发调度器 | `scheduler.ts` | 保留实现（默认 `maxConcurrency=20`），**当前入口未激活**：不强制全局并发上限；并行度由 orchestrator 显式 Wave 推进决定（同一 Wave 一次消息同时启动多个 task） |

> **职责边界（重要）**：任务的实际执行与生命周期通知来自 OpenCode 原生机制（`task` 工具 + `session.idle/deleted/error/status`、`message.part.updated` 事件）。插件侧 TaskTracker + 编排引擎做**观测与内部状态镜像**（供 Board / TUI / 诊断展示），不做自动调度、不做自动重试；唯一的干预例外是**后台任务超时清理**（见下）。主代理（co-orchestrator）显式推进并行：任务实际前置依赖完成且无共享可变状态冲突即可派发，同次所有已就绪任务同一消息同时启动，不等无关任务；失败重派、取消后继任务由主代理显式执行。`close_job` 是插件唯一主动中止会话的工具：对**已绑定子会话**的目标执行 `session.abort()`，未绑定子会话的任务仅本地取消（不中止任何会话，详见下节）。`council_session`（多模型共识）自身保留真实的空响应重试与退避降级，不在此限。
>
> **后台超时清理（例外，非级联取消）**：插件每 30 秒检查一次，创建超过 30 分钟且仍为 running 的后台任务会被标记为 errored；其中已绑定子会话的任务会尝试真实 `session.abort()`。此机制是超时兜底清理，不属于依赖级联取消。

### 关键工具

| 工具 | 可用代理 | 功能 |
|------|---------|------|
| `close_job` | 仅 co-orchestrator / co-orchestrator-gpt | 按 Session ID 或任务别名定位后台任务：**已绑定子会话**时执行真实 `session.abort()`（是否真实中止以返回的 `session_aborted` 为准），仅作用于指定目标会话；**未绑定子会话**仅本地取消（状态落 cancelled、`session_aborted=false`，不中止任何会话）；未知/歧义目标幂等拒绝，不假成功 |
| `council_session` | 仅 co-council | 多模型并行/串行共识：共识检测、空响应重试、质量门禁、退避降级 |

### 上下文共享

ContextEngine（`src/context/`）默认**不注入**历史上下文——所有代理默认策略为 `none`，每次委派不会自动读取父会话历史（避免无谓的上下文膨胀与 token 消耗）。需要历史上下文时由调度者显式 opt-in：

- **任务级 opt-in**：`task` 调用传 `context_override` 参数（如 `context_override="relevant"`）；
- **配置级 opt-in**：在 `oh-my-opencode-cohub.json` 的 `context.strategy` 中为指定代理显式配置非 `none` 策略。

| 策略 | 注入内容 |
|------|---------|
| `none` | 不注入上下文（默认） |
| `relevant` | 相关文件路径 + 前置决策 + 近期错误 |
| `summary` | 同上，且文件正文按 token 预算（2000）截断后注入 |
| `full` | 完整正文（预留） |

**依赖传播（`context.dependencyPropagation`，默认 `false`）**：子代理结果默认不自动传播到后续子代理；需要依赖历史摘要时显式配置 `"context": { "dependencyPropagation": true }`。关闭时 `captureResult` 仍照常返回结果与质量/复用预算采样（任务追踪、质量回送不受影响），仅不做依赖缓存写入与注入。

**summary 文件读取模式（`context.summaryReadMode`，默认 `bounded`）**：控制 `summary` 策略下**文件正文的读取方式**，与上面的上下文策略 `full` 是**两个不同维度**，不要混淆：

- `bounded`（默认）：按 token 预算推导字节上限**有界读取**（每文件正文窗口硬上限 1 MiB，另读 4 字节 lookahead，超限保守截断），读取成本远低于全量读。注意：读取上限或 UTF-8 字符边界可能使正文内容/截断标记与全量读+截断存在差异（如纯 emoji 恰停预算边界、文件超 1 MiB 上限时附加读取截断标记）；需严格兼容旧全量行为时可选 `full`
- `full`：保留旧行为——全量 `readFileSync` 后再按预算截断（保守选项，可关闭激进裁剪；注入后仍受 12,000 token 注入预算兜底约束）

配置示例（用户级 `~/.config/opencode/oh-my-opencode-cohub.json` 或项目级 `.opencode/oh-my-opencode-cohub.json` 均支持）：

```json
{
  "context": {
    "strategy": { "co-fixer": "relevant", "co-oracle": "summary" },
    "dependencyPropagation": true,
    "summaryReadMode": "bounded"
  }
}
```

### 上下文诊断日志（默认关闭）

上下文注入诊断日志是 **opt-in** 的，默认不产生任何 I/O（避免每次委派阻塞事件循环）。开启方式（环境变量优先）：

| 方式 | 说明 |
|------|------|
| 环境变量 `COHUB_CTX_DIAG=1` | 开启（`=0` 强制关闭，优先级最高） |
| 配置 `"diag": { "enabled": true }` | 用户级或项目级 `oh-my-opencode-cohub.json` 均可；可选 `"path"` 自定义日志路径 |

```json
{
  "diag": { "enabled": true }
}
```

开启后日志**路径与字段保持不变**（默认 `os.tmpdir()/opencode/ctx-diag.log`），异步串行写入 + 尾部窗口压缩，不再阻塞事件循环、文件有硬上界。**任务生命周期诊断**仅记录白名单元数据（callID/session/alias/event/status/耗时等），不携带原始错误正文或 headers；**上下文注入诊断**则包含截断后的上下文预览（详情前 120 字符）与注入 prompt 尾部（80 字符），供确认注入内容是否到达。排查「注入的上下文是否真正到达子代理」问题时才需要开启。

### 注入膨胀防护

- **prompt 预算兜底**：拼接超 12,000 token 时降级为裸用户 prompt，防止 JSON 超长截断
- **CONTRACT 去重**：`stripExistingContracts` 仅清理插件自生成的 goal-only 空壳契约块，含约束/前置/其他内容的契约块（含用户手写）保守保留；新契约非空才追加且不重复追加
- **错误截断**：单条 ≤200 字符 + 渲染总量 ≤600
- **Job Board 折叠**：展示上限 15 条 + `pruneTerminalJobs` 每 30 分钟清理终态任务

### 质量回送

`quality.ts` 轻量启发式判定：输出非空 + exit 正常 + 无错误关键词（含否定短语感知）+ decisions ≥ 1，四项各 0.25 分。低分仅标记不改变成败判定，供后续调度参考。

### 任务统计

CLI 提供 `stats` 子命令，展示任务成功率 / 平均延迟 / 平均 token：

```bash
bunx oh-my-opencode-cohub stats [N]    # 查看最近 N 个任务统计（默认 50）
```

## 配置文件
CLI 安装后自动创建 `~/.config/opencode/oh-my-opencode-cohub.json`，这是 CoHub 的专用配置文件，结构如下：

```json
{
  "$schema": "https://unpkg.com/oh-my-opencode-cohub@latest/oh-my-opencode-cohub.schema.json",
  "agents": {
    "co-orchestrator": { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
    "co-orchestrator-gpt": { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
    "co-oracle":      { "model": "deepseek/deepseek-v4-flash", "variant": "low" },
    "co-librarian":   { "model": "deepseek/deepseek-v4-flash", "variant": "low" },
    "co-explorer":    { "model": "deepseek/deepseek-v4-flash", "variant": "low" },
    "co-designer":    { "model": "minimax/MiniMax-M3", "variant": "medium" },
    "co-fixer":       { "model": "deepseek/deepseek-v4-flash", "variant": "high" },
    "co-observer":    { "model": "deepseek/deepseek-v4-flash", "variant": "low" },
    "co-council":     { "model": "deepseek/deepseek-v4-flash", "variant": "low" },
    "co-rule-user":   { "model": "deepseek/deepseek-v4-flash", "variant": "medium" },
    "co-rule-project":{ "model": "deepseek/deepseek-v4-flash", "variant": "medium" },
    "co-rule-app":    { "model": "deepseek/deepseek-v4-flash", "variant": "medium" },
    "co-planner":     { "model": "deepseek/deepseek-v4-flash", "variant": "low" }
  }
}
```

直接编辑此文件即可修改任意代理的模型和变体。`$schema` 提供 IDE 自动补全支持。

> **注意**：同一目录 `~/.config/opencode/oh-my-opencode-cohub/` 下也可放置 `{agent}.md` 提示词覆盖文件（见「自定义提示词」章节），与 JSON 配置文件共存。

### Council 多模型共识配置

`co-council` 代理通过 `council_session` 工具并行调用多个模型（councillors），综合各方观点形成共识。councillors 的数量、模型、推理强度完全可配置：

```json
{
  "council": {
    "default_preset": "default",
    "timeout": 180000,
    "councillor_execution_mode": "parallel",
    "councillor_retries": 3,
    "presets": {
      "default": {
        "alpha": { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
        "beta":  { "model": "deepseek/deepseek-v4-flash", "variant": "high" },
        "gamma": { "model": "minimax/MiniMax-M3", "variant": "medium" }
      },
      "quick": {
        "alpha": { "model": "deepseek/deepseek-v4-flash", "variant": "high" },
        "beta":  { "model": "deepseek/deepseek-v4-flash", "variant": "low" }
      },
      "deep": {
        "alpha": { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
        "beta":  { "model": "deepseek/deepseek-v4-pro", "variant": "max" },
        "gamma": { "model": "minimax/MiniMax-M3", "variant": "medium" },
        "delta": { "model": "deepseek/deepseek-v4-flash", "variant": "high" }
      }
    }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `presets` | object | (必填) | 预设字典，每个预设是一组 councillor |
| `default_preset` | string | `"default"` | 调用时不指定 preset 时使用的预设 |
| `timeout` | number | `180000` | 单个 councillor 超时（毫秒），默认 3 分钟 |
| `councillor_execution_mode` | `"parallel"` \| `"serial"` | `"parallel"` | 并行/串行执行 |
| `councillor_retries` | number | `3` | 空响应重试次数 |

- 每个 councillor 的 key（如 `alpha`、`beta`）可任意命名，会出现在输出中
- `model` 格式为 `"provider/model"`，`variant` 可选 `"max"` / `"high"` / `"medium"` / `"low"`
- councillor 数量无上限，但建议 2-5 个以平衡成本和质量
- 调用时可通过 `council_session` 工具的 `preset` 参数切换预设，如 `"quick"` 或 `"deep"`

## 工作流

CoHub 采用 Wave 波次分组并行模式。并行与推进由**主代理显式执行**，编排引擎负责观测与内部状态镜像（另有后台超时清理兜底，见「编排引擎」章节）：

```
1. 理解需求（co-orchestrator 分析用户意图）
2. 信息收集（Wave 1 — 全并行：@co-explorer + @co-librarian + @co-observer）
3. 规范分析（Wave 1 — 全并行：@co-rule-user + @co-rule-project + @co-rule-app）
4. 制定方案 → @co-planner（按依赖分 Wave 1/2/3... 输出结构化任务分解）
5. 调度执行（Wave 2+ — 同一 Wave 内一次消息同时启动）
   - 修改 Wave：fixer/designer 仅修改文件，不编译/测试
   - 验证 Wave：所有修改完成后统一编译 + 测试
6. 验证（@co-oracle 代码审查 + @co-designer 视觉审查）
```

主代理在此流程中负责（均为显式操作，无自动魔法）：

- **Wave 推进**：Wave 仅表示依赖层次，不构成整体等待屏障——任务的实际前置依赖完成且无共享可变状态冲突即可派发，同次所有已就绪任务同一消息同时启动，不等本 Wave / 其他 Wave 的无关任务
- **失败重派**：task 返回失败时，由 orchestrator 根据结果显式决定重派/换策略，不自动重试
- **取消后继**：需要取消时显式调用 `close_job`——插件唯一注册的取消工具，对**已绑定子会话**的目标执行真实 `session.abort()`（未绑定子会话仅本地取消，以返回的 `session_aborted` 为准）；OpenCode 原生 `cancel_task` 路径仅同步插件内部状态（引擎标记 cancelled），不承诺真实中止目标会话。无自动级联取消——编排引擎的「级联取消」仅是内部状态同步（把未完成后继标记为 cancelled），不会自动中止其他运行中的会话
- **验证区分**：修改 Wave 只改不编译（注明「验证待统一执行」），多文件修改完成后统一编译一次

## 依赖

- [OpenCode](https://opencode.ai) ≥ 1.17
- 运行时依赖：
  - `@opencode-ai/plugin@^1.17.0`
  - `@opencode-ai/sdk@^1.3.17`
- TUI 面板（可选）：
  - `@opentui/solid@^0.4.3`
  - `@opentui/core@^0.4.3`
- 开发依赖（仅源码开发时需要）：
  - `typescript@^5.4.0`
  - `@types/node@^26.1.1`
- 无其他外部插件依赖

## 自定义模型

**推荐**：直接编辑 `~/.config/opencode/oh-my-opencode-cohub.json`（见「配置文件」章节），修改对应代理的 `model` 和 `variant` 即可。

**备选**：通过 `opencode.json` 的 plugin config 覆盖：

```json
{
  "plugin": [
    {
      "name": "oh-my-opencode-cohub",
      "config": {
        "models": {
          "orchestrator": "openai/gpt-5.5",
          "fixer": "openai/gpt-5.4-mini"
        }
      }
    }
  ]
}
```

> 注意：plugin config 中的 key 使用无 `co-` 前缀的短名（如 `orchestrator`）；JSON 配置文件使用完整的 `co-` 前缀名（如 `co-orchestrator`）。

## 自定义提示词

### 方式一：通过 plugin config 覆盖（推荐）

在 `opencode.json` 的 plugin config 中传入自定义 prompt：

```json
{
  "plugin": [
    {
      "name": "oh-my-opencode-cohub",
      "config": {
        "overrides": {
          "oracle": "你是我的自定义 Oracle 代理——负责代码审查和安全审计……",
          "fixer": "你是我的自定义 Fixer 代理——只做 Python 代码修改……"
        }
      }
    }
  ]
}
```

支持覆盖的代理名称：`orchestrator`、`orchestrator-gpt`、`oracle`、`librarian`、`explorer`、`designer`、`fixer`、`observer`、`council`、`rule-user`、`rule-project`、`rule-app`、`planner`

### 方式二：文件覆盖（类 oh-my-opencode-slim 机制）

在项目 `.opencode/oh-my-opencode-cohub/` 或 `~/.config/opencode/oh-my-opencode-cohub/` 目录下创建 `{agent}.md` 文件：

```
oh-my-opencode-cohub/
├── oracle.md          ← 完全替换 oracle 提示词
├── fixer_append.md    ← 追加到 fixer 提示词末尾
├── co-orchestrator-gpt_append.md  ← 追加到 co-orchestrator-gpt 提示词末尾
└── planner.md         ← 完全替换 planner 提示词
```

文件名规则：
- `{agent}.md` —— 完全替换该代理的内置提示词
- `{agent}_append.md` —— 追加内容到内置提示词末尾

查找优先级：项目 `.opencode/` > `~/.config/opencode/`

### 方式三：Fork 并修改源码

```bash
# 修改 src/prompts/oracle.ts 并重新编译
npm run build
```

适合深度定制，但需维护自己的分支。

## 版本历史

完整变更记录见 [CHANGELOG.md](./CHANGELOG.md)，或 [GitHub 上的 CHANGELOG](https://github.com/Mr-cjf/cohub/blob/main/packages/oh-my-opencode-cohub/CHANGELOG.md)。

> **版本说明**：v1.15.0 及更早版本的 release 链接指向**已归档的旧仓库**（`Mr-cjf/oh-my-opencode-cohub`），仅作历史存档；历史条目不代表当前运行机制——现行机制以 CHANGELOG 与源码为准。v1.15.1 之后版本为纯文本记录，未附 release 链接。

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| 1.19.0 | 2026-10-19 | 新增 `co-orchestrator-gpt`（GPT 专用 orchestrator 纯调度变体，独立 agent，mode: primary）；DS 的 `co-orchestrator` 提示词与行为保持不变。GPT 变体采用「先最小修复 → 先定向验证 → 再查漏补缺」节奏；`close_job` 权限扩展至 co-orchestrator-gpt（运行时权限分支 + job-control 纵深防御）；CLI 安装模板同步 13 个代理，TUI 兜底列表加入 GPT 变体；文档同步（包 README / 包 AGENTS / .rules/05 / 根 README / 根 AGENTS） |
| 1.18.4 | 2026-10-16 | README 文档跟进：版本历史补齐 1.18.3 与当前编排语义（诚实镜像原生 task 生命周期，**不激活自动调度/自动重试**）；上下文 `summaryReadMode`（`bounded`/`full`）与 opt-in 诊断日志说明；`close_job` 取消边界（已绑定子会话真实 abort / 未绑定仅本地取消）与后台超时清理例外（30 秒检查、30 分钟超时标记 errored）。无运行时代码变更 |
| 1.18.3 | 2026-10-16 | 编排提示词并发语义修正：移除默认 2-3 / 固定数量 / 强制分批限制，无依赖、无共享可变状态冲突的任务同一条消息同时派发，不以任务/文件数量或猜测容量预限；Wave 仅展示依赖层次不构成等待屏障，已就绪任务同时启动不等无关慢任务；同文件独立只读可并行，仅真实写冲突或要求特定文件版本/读取结果的读写任务按实际冲突与依赖串行；保留 429/TPM 限流反馈（尊重 retry.next / Retry-After）、有限重试、后台已启动任务不重复派发、定向规则分析与已核实事实复用。仅提示词文案调整，无运行时 API / TUI / MCP 变更 |
| 1.18.2 | 2026-10-16 | 任务生命周期按 `(parentSessionID, callID)` 精确关联与真实收尾；后台任务终态不再仅凭 `session.idle` 判定（有界读取验证明确终态，读失败/无终态信号保持 running 不假成功）；`close_job` 真实取消与质量回写；内部状态机诚实镜像原生 task 生命周期（**不激活自动调度/自动重试**）；`context.summaryReadMode` 支持 `bounded`（默认）/`full`；限流分类器 + opt-in 任务生命周期诊断 |
| 1.18.1 | 2026-10-16 | 修复 Background Job Board 跨会话泄漏：Board 仅向**当前直接父会话**注入任务（显式传 `sessionID`，移除全局回退）；未知/非法会话 ID 一律返回空不注入 |
| 1.18.0 | 2026-10-16 | 上下文注入诊断日志改 **opt-in 默认关闭**（`COHUB_CTX_DIAG=1/0` 环境变量优先，或配置 `diag.enabled`，用户级/项目级配置均支持）；`co-rule-project` 逐级发现 `AGENTS.md`/`CLAUDE.md`/`AGENTS.local.md`/`CLAUDE.local.md` 及该级 `.rules/*.md`（就近覆盖）；`co-rule-app` 定向分析明确指定的 `.opencode/rules/*.md`；oracle/council 提示词改为按需取证读取（软预算） |
| 1.17.0 | 2026-09-16 | 新增 `co_ocr_review` 工具（仅 `co-oracle` 可调用；OCR CLI 为**软依赖**，未安装时返回引导提示并自动回退原生审查）。注：该工具仅见于本版 CHANGELOG 历史摘要，当前源码与分发产物未包含此工具 |
| 1.16.0 | 2026-09-15 | 并行工具调用总则统一经 `experimental.chat.system.transform` hook 注入，覆盖全部 12 个代理；修正 observer 唯一串行指令与 orchestrator 禁 bash 冲突措辞 |
| 1.15.3 | 2026-09-15 | 上下文引擎 `fillContextAsync` 改为 in-flight promise 去重（并发同 key 共享请求、无脏读）；explorer 新增搜索策略段落（首轮宽泛并行、最多 4 轮、glob→grep→read 优先级）；observer 兜底模型残留修正 |
| 1.15.1 | 2026-09-03 | README 对齐 v1.15.0：新增「编排引擎」章节（状态机/重试/契约/调度器 + 工具权限 + 上下文 4 策略 + 注入膨胀防护 + 质量回送 + stats）、工作流章节重写为 Wave 波次分组并行、版本历史补齐 v1.13.0~v1.15.0 |
| [v1.15.0](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.15.0) | 2026-09-03 | 子代理并行工具调用：fixer/designer 同消息并行读文件、librarian 并行外部搜索、explorer 并行读取 |
| [v1.14.1](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.14.1) | 2026-09-03 | Dependabot 安全修复（3 high + 1 moderate 传递依赖升级） |
| [v1.14.0](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.14.0) | 2026-09-03 | 修改 Wave vs 验证 Wave 区分：并行改文件不再各自编译，统一编译一次 |
| [v1.13.2](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.13.2) | 2026-09-03 | 注入膨胀根治：prompt 预算兜底、CONTRACT 去重、错误截断、Job Board 折叠 |
| [v1.13.1](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.13.1) | 2026-09-03 | Wave 波次分组并行：planner/orchestrator/oracle 提示词重构 |
| [v1.13.0](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.13.0) | 2026-09-03 | 编排引擎（状态机/重试/契约/调度器）、close_job 工具、并发上限 20 |
| [v1.12.13](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.12.13) | 2026-08-07 | 修复 messages.transform 仅对最后一条 user 消息做占位修复，恢复含 file-only 历史消息的旧会话时触发 API 空 content 错误 |
| [v1.12.12](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.12.12) | 2026-08-04 | 子代理模型降级 Flash（适配 DeepSeek-V4-Flash 2026-07-31 增强），仅 orchestrator 保留 Pro；Board 会话复用修复 |
| [1.12.10-beta.1](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.12.10-beta.1) | 2026-07-30 | 调度策略优化、四阶段并行决策框架 |
| [1.12.9](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.12.9) | 2026-07-29 | 安装架构修复、配置双保险回退、prerelease 发布 |
| [1.12.0](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.12.0) | 2026-07-28 | AI 配置文案、智能模型匹配、配置外化管理 |
| [1.11.1](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.11.1) | 2026-07-28 | 配置分离（model/variant 由 hub config 唯一管理） |
| [1.10.2](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.10.2) | 2026-07-25 | 诊断日志工具 `src/utils/log.ts`、异常信息前缀统一 |
| [1.9.3](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.9.3) | 2026-07-25 | 移除 co-guardian 代理、回归精简架构 |
| [1.8.0](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.8.0) | 2026-07-24 | ContextGuard 上下文卫士、PlanGate 拆除 |
| [1.0.18](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.0.18) | 2026-07-15 | `council_session` 多模型并行共识工具 |
| [1.0.13](https://github.com/Mr-cjf/oh-my-opencode-cohub/releases/tag/v1.0.13) | 初始发布 | 12 个 co-* 代理 + 纯调度模式 |

## 许可证

MIT
