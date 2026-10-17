# oh-my-codex-cohub

[CoHub monorepo](https://github.com/Mr-cjf/cohub) 的 Codex 原生插件：主编排技能 `cohub`、12 个中文代理技能、3 个 Git 工作流技能和 Council MCP 服务。源码以本目录为准，安装缓存由 Codex 管理。

## 安装

需要 Node.js 20+ 和支持 `codex plugin` 的 Codex CLI。无需安装 npm 依赖，也无需编译 Markdown 技能。

在仓库根运行：

```bash
npm run build:codex
npm run test:codex
npm run install:codex
```

等价的原生命令：

```bash
codex plugin marketplace add .
codex plugin add oh-my-codex-cohub@cohub
```

marketplace 位于仓库根 `.agents/plugins/marketplace.json`，插件源指向 `./packages/oh-my-codex-cohub`。安装完成后新开会话；桌面端若未发现新 marketplace，重启应用。源码或技能补齐后不会自动更新已安装副本，需重新运行 `npm run install:codex` 并在新会话加载新版本。用户配置文件无需重新安装；每次派发子代理时都会读取最新配置。

## 默认编排入口

插件安装不会擅自修改全局指令。要让普通工程请求（例如部署状态、故障排查、测试和远程检查）默认先进入 Orchestrator，在仓库根运行：

```bash
npm --prefix packages/oh-my-codex-cohub run orchestrator:status
npm --prefix packages/oh-my-codex-cohub run orchestrator:enable
```

启用命令只维护 `~/.codex/AGENTS.md` 或当前生效的 `AGENTS.override.md` 中的 CoHub 受管区块，保留其他内容；重复启用幂等。禁用使用 `orchestrator:disable`。启用后新建 Codex 会话验证入口，旧会话不能据此判定已经加载。指导模式要求主代理准备任务包并委派至少一个相关 worker；它不提供主代理的权限隔离。严格模式需要宿主额外提供可靠的主/子代理身份和独立工具权限，当前版本不宣称已具备。

旧个人版可在新版本验证成功后卸载：

```bash
codex plugin remove oh-my-codex-cohub@personal
```

同时移除 `~/.agents/plugins/marketplace.json` 中旧的 CoHub 条目和旧独立插件目录，保留其他个人插件。不要把安装缓存当成维护源码。

## 使用与能力

```text
用 CoHub 六步工作流帮我完成：<任务>
让 co-oracle 审查这段代码。
用 co-council 对这个方案做多模型共识分析。
```

主编排采用「理解 → 收集 → 规范分析 → 制定方案 → 调度执行 → 验证」，包含 ContextGuard 上下文包、任务看板和文件冲突纪律。

上下文默认策略：所有角色 ContextGuard 默认 `none`——委派只携带完整任务指令（目标只表达一次、必要输入、真实约束、验收），不按角色默认附加历史文件、决策、错误或依赖摘要；任务明确选择 `relevant`/`summary` 时才附加相应材料（数量与字符软预算见[效率规范](skills/cohub/references/efficiency.md)）。`none` 不表示零任务信息，也不等于 `fork_turns=none`：宿主 fork 分支、模型/推理覆盖限制和主会话 `ultra` 设置保持不变。

## 批量操作

普通任务只执行必要的理解、收集、规则分析、规划、执行和验证步骤；复杂任务可采用完整流程。Codex 版的规划、调度和执行技能共享[效率规范](skills/cohub/references/efficiency.md)与[批量操作规范](skills/cohub/references/batch-execution.md)：

- **文件**：集中搜索和读取，关联文件合并为一次补丁，同文件写入串行，保留用户及其他代理改动。
- **代理**：就绪队列准备、原生调用连续发送、容量补位及实际派发验收遵循[效率规范](skills/cohub/references/efficiency.md)的 `dispatch_prepare` / `dispatch_send` 契约。插件不设任务数上限；实际启动间隔由宿主决定。
- **命令**：独立命令一轮并行调用，有依赖或共享生成目录、锁文件、测试状态时串行；逐项记录结果及运行会话。
- **验证**：执行批次可标记 `implementation-only`，整批写入结束后由指定负责人统一构建及测试，验证前保持 `implemented` 状态。
- **失败**：仅阻断失败项的下游，独立任务可继续；确认旧执行已结束并修复原因后，重跑受影响的任务和检查。

这些是调度与执行指令，使用当前会话实际提供的 Codex 工具，不额外注册批量执行 MCP 工具。

### 日志摘要与检查证据

两个零依赖 helper 只处理调用方提供的日志、退出码和检查证据，不会启动或等待项目命令。摘要限长和密钥遮蔽是尽力处理，完整日志仍保留在原路径供检查。

命令结束后立即保存真实退出码，再生成摘要：

```sh
npm test > test.log 2>&1
test_exit=$?
node scripts/summarize-log.mjs --log test.log --exit-code "$test_exit"
```

PowerShell 中在运行摘要 helper 前保存 `$LASTEXITCODE`。API 与 CLI 接受 `-2147483648` 到 `4294967295` 的有符号或无符号 32 位退出码，JSON 保留传入的原值；Windows 子进程退出状态采用相同的无符号位图，POSIX 进程状态只能暴露低 8 位。CLI 输出 `passed`/`failed` 摘要，但摘要不能替代原命令结果。

检查证据 CLI 的 spec 必须声明完整输入范围、`environment.complete: true`、`environment.unknown: false`、`readOnly: true` 和 `externalState: false`。spec、before 快照及 evidence 文件都必须位于 scope 根目录之外。调用方执行 spec 中的命令并保存实际退出码后，按此顺序操作：

```sh
node scripts/check-evidence.mjs snapshot --spec ../.task/check.json --evidence ../.task/test.json --out ../.task/before.json
# 此处执行 spec.command；示例命令为 npm test
npm test
test_exit=$?
test_status=passed
if [ "$test_exit" -ne 0 ]; then test_status=failed; fi
node scripts/check-evidence.mjs record --spec ../.task/check.json --before ../.task/before.json --evidence ../.task/test.json --completed --exit-code "$test_exit" --status "$test_status"
node scripts/check-evidence.mjs check --spec ../.task/check.json --evidence ../.task/test.json
```

退出码非零时，应把真实码和 `--status failed` 传给 `record`。范围或环境无法完整声明、命令有副作用或依赖外部可变状态时，不应依赖复用；`check --force` 可强制返回 miss。证据只表示声明的文件输入稳定且检查通过，不是执行器或外部状态证明。

## 角色

| 技能 | 职责 |
|------|------|
| cohub | 主编排入口 |
| co-orchestrator | 规划、委派、验证 |
| co-planner | 任务分解与验收方案 |
| co-oracle | 架构与代码审查 |
| co-librarian | 外部文档研究 |
| co-explorer | 代码定位 |
| co-designer | UI/UX 设计与实现 |
| co-fixer | 代码修改 |
| co-observer | 图片与文档分析 |
| co-council | 多模型共识 |
| co-rule-user | `~/.codex/AGENTS.md` 等用户规范 |
| co-rule-project | 项目 `AGENTS.md` 及 `.rules/*.md` |
| co-rule-app | `.codex/rules/*.md` |

这些角色是技能指令，由主代理使用当前环境提供的子代理工具委派。

## 工作流技能

除代理角色外，插件另含 3 个 Git 工作流技能，作为主代理的直接执行指令，**不属于代理角色，不进入 `subagents.roles` 角色映射**：

| 技能 | 用途 |
|------|------|
| co-git-commit | 普通提交工作流：确认暂存范围与授权后按分步逻辑提交，不触碰远程与分支管理 |
| co-git-commit-release | 明确发版触发的工作流：核实目标包、版本、渠道与发布机制，分别确认提交、标签、推送和发布的授权后执行 |
| co-branch-summary | 分支总结：只读汇总当前分支状态与未提交改动，不修改工作区、不执行写操作 |

三个工作流与代理角色遵循相同行为纪律：总结只读、无固定分支或硬编码 remote、不 `git add .`、不 amend/force push、不绕过 hooks、授权分别确认。仓库根 `.opencode/skills/` 提供同套工作流的 OpenCode 技能入口（`git-commit` / `git-commit-release` / `branch-summary`）。

旧版 `agents` 配置不生效；`subagents` 可按字段为子代理提供模型和推理强度参数，再交给 Codex 原生工具派发。批量解析 CLI 只输出结果，不自行启动子代理；实际派发仍由原生工具依据其参数支持情况执行。显式模型或强度需要从当前会话工具能力中校验，模型不可用时会报错，不会静默降级。

### 子代理模型配置

配置按字段合并，优先级从高到低为：本次委派覆盖 > 项目 `.codex/cohub.json` > `COHUB_CONFIG` 或 CLI `--config` 指定文件 > 用户 `~/.codex/oh-my-codex-cohub/config.json` > 旧版 `~/.config/oh-my-codex-cohub/config.json` > Codex 原生继承。`COHUB_CONFIG` 和 `--config` 是同一优先级；如果显式指定的文件不存在或无效，会报错，不会回退。旧路径仅在较高层没有覆盖对应字段时参与合并。

每层先合并 `subagents.defaults`，再由 `subagents.roles.<co-role>` 的同名字段覆盖。字段缺失会继续采用较低层的值；字段设为 `null` 会清除该字段的 CoHub 覆盖并回到原生继承。只配置一两个角色即可，`defaults` 和 `roles` 也都可省略。示例：

```json
{
  "subagents": {
    "roles": {
      "co-explorer": { "model": "gpt-6-luna", "reasoning_effort": "medium" },
      "co-oracle": { "model": "gpt-6.1-sol", "reasoning_effort": "high" }
    }
  }
}
```

`model` 与 `reasoning_effort` 可分别省略或设为 `null` 以继承。支持的推理强度以当前工具为准；resolver 根据当前工具提供的模型和能力校验，发现无效或不支持的显式设置时会报错。CLI 用法：

```bash
npm run resolve:agents -- --roles co-explorer,co-oracle --cwd . --capabilities runtime-caps.json
```

解析结果中的 `spawnArgs` 供原生子代理工具使用。CLI 不执行任务或启动子代理。配置示例见 [`config/cohub.example.json`](config/cohub.example.json) 和 [`config/subagents.example.json`](config/subagents.example.json)。

## Council 配置

配置读取顺序：

1. `COHUB_CONFIG` 指向的 JSON 文件。
2. `~/.codex/oh-my-codex-cohub/config.json`。
3. 旧版 `~/.config/oh-my-codex-cohub/config.json`，兼容已有配置。

在本包目录初始化配置：

```bash
npm run init:config
```

已有目标配置不会被覆盖；若旧路径存在配置，初始化命令会将它复制到新路径。`COHUB_CONFIG` 可覆盖初始化位置。

参考 `config/cohub.example.json` 设置自己的 provider 与模型。示例模型名称是占位建议，需按实际供应商可用性调整。

| 字段 | 说明 |
|------|------|
| `council.default_preset` | 默认预设，默认 `default` |
| `council.execution_mode` | `parallel`（默认）或 `serial` |
| `council.timeout_ms` | 单次请求超时，默认 180000 ms |
| `council.retries` | 失败或空响应重试次数，默认 3 |
| `council.providers` | `base_url` 和 `api_key_env` |
| `council.presets` | 各预设的 councillor 配置 |
| `council.chair` | 可选的共识主席 |

API Key 通过环境变量提供。MCP 注册默认转发 `COHUB_CONFIG`、`COHUB_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`MINIMAX_API_KEY`；自定义 `api_key_env` 时也要把该名称加入 `.mcp.json` 的 `env_vars` 后重新安装。不要把密钥放进仓库。

`variant` 是历史温度预设（max=0.2、high=0.4、medium=0.6、low=0.8），并非 Codex 的 reasoning effort。可以用 `temperature` 覆盖。Council 请求调用配置供应商的 `/chat/completions` 接口；真实模型调用会使用对应供应商账户。

```text
列出 council_presets。
用 council_session 分析这个方案，preset 用 default：<问题>
```

## 开发与验证

```bash
npm run build
npm test
npm run install:local
```

`build` 校验清单版本、16 个技能（1 入口 + 12 角色 + 3 工作流）、资源路径、repo marketplace 和 MCP 环境变量。测试通过本地 HTTP 模拟服务验证 MCP 握手、工具发现、Council 汇总及配置迁移，不调用外部模型、不需要真实密钥。

```text
.codex-plugin/plugin.json   Codex 兼容清单
.mcp.json                  Council MCP 注册
package.json               独立版本及开发命令
skills/                    主编排 + 12 个代理技能 + 3 个工作流技能
mcp/council_server.mjs      零依赖 Node.js MCP 实现
config/                    配置示例与 JSON Schema
scripts/                   校验、安装、初始化
test/                      隔离的 MCP 集成测试
assets/logo.png            插件图标
```

卸载项目版：`codex plugin remove oh-my-codex-cohub@cohub`。插件不会删除用户 Council 配置。

## 数据与许可

技能使用 Codex 当前工作区和权限。Council 将问题及显式附加上下文发送到用户配置的模型供应商；本插件不另设遥测服务。MIT，见 `LICENSE`。

打包方式参考 [OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)，保留受支持的 `.codex-plugin/plugin.json` 兼容格式。
