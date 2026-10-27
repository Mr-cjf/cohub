# dsh-cohub

> 本文对应 **v0.9.2**；完整变更历史见 [CHANGELOG.md](./CHANGELOG.md)。

DeepSeek Harness 版（对照 [OpenCode 版](../oh-my-opencode-cohub/)）：中文智能体编排插件。
把「纯调度模式 + 13 个技能（12 个代理编排体系 + co-cordis 组合创作）+ 多模型共识 + 运行期调度韧性」移植到 DSH 原生能力之上。

## 快速开始

### 1. 前置条件

宿主 DSH ≥ `0.2.0-rc.2`（peer 依赖锁定）；其中子代理读写硬隔离（per-child `agentPreset`）需 ≥ `0.2.1`。不支持 DSH 0.1。

### 2. 安装

```bash
dsh plugin --profile web add dsh-cohub
```

> 请通过 `dsh plugin add dsh-cohub` 安装（由宿主提供 `@deepseek-ai/schemastery` 等 peer 依赖）；直接 `npm install dsh-cohub` 虽可安装，但缺少宿主运行时服务，插件无法独立加载。

本地开发安装：

```bash
dsh plugin --profile web add <monorepo>/packages/dsh-cohub
```

或手动：profile 的 package.json

以下为**本地开发/离线**安装方式，日常使用请用上面的 npm 安装：

```json
{
  "dependencies": { "dsh-cohub": "file:../dsh-cohub" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-cohub"] } }
}
```

### 3. 选择工作模式

- **`co-orchestrator`**：纯调度，自己不动手，只委派子代理——适合长链调度、多模型共识。
- **`cohub-cordis`**：标准模式全工具面 + 中文身份 + 组合创作技能——适合直接动手、插件开发。
- preset 在会话首个 turn 后即锁定，切换需新建会话。

完整说明见下文「工作模式与 preset」。

### 4. 验证安装

重启 DSH 后确认三点：

1. 技能列表中能看到 13 个 `co-*` / cohub 相关技能；
2. 设置页出现「CoHub 代理模型」区块；
3. preset 选择器里能看到 `co-orchestrator` 与 `cohub-cordis`；若看不到，说明 preset 未安装，见下文「工作模式与 preset」的手动兜底步骤。

### 5. 首次调用

先新建一个会话并在 preset 选择器里选中 `co-orchestrator`（preset 在会话首个 turn 后即锁定，中途无法切换）：

```
用 co-orchestrator 帮我审查 packages/dsh-cohub 的 README 结构
```

预期产出：主调度先派探索子代理（co-explorer）定位结构与引用，再把结果汇总成审查结论，全程不直接读写文件。

## 工作模式与 preset

### co-orchestrator（纯调度）

`presets/co-orchestrator/` 提供调度者主代理身份（persona + 调度工具面：subagent/fork/workflow/skill/todo/jobs/ask-user/goal + compaction）。

**自动安装**：本包在 `apply` 时会把内置 preset 复制到 `~/.dsh/.agent-presets/co-orchestrator/`（幂等，不覆盖你已修改的同名 preset）。`dsh plugin --profile web add dsh-cohub` 装完重启后，即可在 GUI 的 agent preset 选择器中切换，无需手动操作。

若 preset 未出现（例如本地源码开发、或想手动摆放），可兜底执行：

```bash
mkdir -p ~/.dsh/.agent-presets/co-orchestrator
cp presets/co-orchestrator/* ~/.dsh/.agent-presets/co-orchestrator/
```

> ⚠️ 上面的 `cp presets/<name>/*` **不会带上子目录**。带 `skills/` 的 preset（如 `cohub-cordis`）必须整目录复制，否则技能丢失；Windows 上推荐直接用随仓库提供的脚本（递归复制 + 防 `Copy-Item` 同名嵌套陷阱）：
>
> ```powershell
> pwsh -File scripts/deploy-preset.ps1                       # 默认 cohub-cordis
> pwsh -File scripts/deploy-preset.ps1 -PresetName co-orchestrator
> ```

在 GUI 的 agent preset 选择器中切换。注意：**DSH 0.2.1 起支持 per-child `agentPreset`**（`SubagentStartRequest.agentPreset` 为一等字段，子代理经 `presets.mount()` 独立组装），子代理不再继承父代理的 preset 组合与工具表——cohub 已用两个独立精简 preset（`cohub-subagent-readonly` / `cohub-subagent-write`）对子代理做**硬隔离**，故「绝不亲自操作文件」「只读代理不写文件」由工具面物理保证，不再只靠提示词。`toolFilter` 仍保留作为补充收窄手段（但它对子代理 own 层挂载的工具无效）。主代理侧「绝不亲自操作文件」继续由 co-orchestrator 技能在提示词层约束（与 OpenCode 原版一致）。

完整变更历史（含 v0.3.0–v0.8.2 全部条目）见 [CHANGELOG.md](./CHANGELOG.md)。

> 迁移提示：若你曾手动改造过 ~/.dsh/.agent-presets/cohub-standard/，需自行删除该目录。

### cohub-cordis（创造模式）

`presets/cohub-cordis/` 是 **DSH 官方「创造模式」（`cordis` preset）的骨架 + cohub 中文身份与委派指引**：标准模式的全部工具面、`present` 产物交付、组合创作技能，加上直接可用的 cohub `delegate` / `delegate_batch`。

**⚠️ 本 preset 不含运行时自改能力（`cordis_*` 工具由官方「创造模式」提供）；需要读写 harness 组合请直接用官方创造模式。**

**两者定位**：

| preset | 工具模式 | 委派 | 运行时自改 | 适用场景 |
|---|---|---|---|---|
| co-orchestrator | 纯调度（不挂 fs/shell/web + persona 软约束） | ✅ delegate | ✗ | 长链调度 / 多模型共识 / 严格自律 |
| **cohub-cordis** | **标准模式 + 中文身份 + 组合创作技能** | ✅ delegate | ✗（用官方创造模式） | 直接动手 + 委派混合、插件开发日常 |
| 官方 **创造模式**（`cordis`） | 标准 + **Cordis 自指工具面** | ✅ delegate（host plane，同样可用） | ✅ | 自改 harness / preset 创作 / 插件实验 |

**cohub 能力从哪来**：13 个 co-* 技能与 `delegate` / `delegate_batch` 工具由 dsh-cohub bundle 在 **host plane 全局注册**，与 preset 解耦——所以本 preset 不需要（也没有）额外的委派工具行。已实测确认：`delegate` 与 `delegate_batch` 都出现在会话工具表中，任何 preset 的会话（含创造模式）都能直接用，只要 dsh-cohub 挂在该 profile 上。

**使用方式**：agent preset 在会话**首次 turn 之后即锁定**（`agent-preset/locked: session has already started; its agent preset is fixed`），所以创造模式只能**新建会话**时选择，不能中途切换。

**自包含技能**：本 preset 自带 `skills/`（`cordis-plugin-development`、`editing-cordis-compositions` 两份组合创作指导），通过 `customSkillDirs` 指向 preset 自身目录，因此无论安装到哪里都能解析。

> **TRUST**：`cordis_mount` 会对模型写出的 JavaScript 求值并在活动运行时里执行，且本 agent 写出的组合会成为其他会话可挂载的 preset。请把使用本 preset 的会话**等同于 shell 访问权限**对待。

### 子代理 preset（读写硬隔离）

`cohub-subagent-readonly` 与 `cohub-subagent-write` 是 0.8.0 起新增的支撑性 preset，服务于委派机制本身，用户不需要也无需手动选择。
DSH 0.2.1 起 `SubagentStartRequest.agentPreset` 是一等字段，`delegate` / `delegate_batch` 会按目标技能的读写需求自动挂载对应 preset。
只读类代理（co-explorer / co-oracle / co-librarian / co-observer / co-rule-* 等）的工具面**不含 write / shell**；只有写类代理（co-fixer / co-designer / co-cordis）才具备文件写入与 build / test 能力。
因此「只读代理不写文件」由工具面物理保证，不再只靠提示词层软约束；`toolFilter` 仅作为补充收窄手段保留。
手动 `subagent` 委派时也可显式指定这两个 preset 之一，但常规链路无需关心。

## 技能清单（13 个）

co-orchestrator（调度）/ co-planner（方案）/ co-oracle（审查）/
co-explorer（搜索）/ co-librarian（研究）/ co-observer（视觉）/
co-fixer（执行）/ co-designer（UI）/ co-council（共识）/
co-rule-user / co-rule-project / co-rule-app（规范分析）/
co-cordis（Cordis 插件与 preset 组合创造 —— 第 13 个，需读写+Bash 权限）

> 前 12 个即代理编排体系，`co-cordis` 是组合创作角色（修插件 / 改 harness 组合 / 写 preset）。
> `test/unit.ts` 断言的正是这 13 个名字，改动技能清单需同步 `scripts/generate-skills.ts` 与测试。

## 使用

1. 主会话中让模型加载 co-orchestrator 技能（skill 工具）
2. 按提示词流程：信息收集（并行 subagent）→ co-planner 方案 → 审核 → 执行 → 验证
3. 子代理统一通过 DSH 原生 subagent 工具委派，后台任务走 job board

### settings 卡片

**DSH 0.2 起**：本插件**注册独立的设置页**「CoHub 代理模型」——客户端模块
（`src/client/index.js`）向 `settings.section` slot 注册一个 section（`order: 12`，插在
「模型」10 与「插件」15 之间），13 个代理每个一行：供应商下拉 + 模型下拉（可降级手填）。
页面通过 `configForms` 读写 Config 的 volatile `skills` 字段（走 `mutate` 提交，携带读取时的
revision 做冲突栅栏），因此改完保存即生效，无需重启。

`reasoningEffort` 仍通过官方表单（`SettingsForms.describe()` 从真实 Loader entry 的
`fiber.runtime.Config` 投影）配置，在官方表单里是文本字段（档位随模型变化，静态枚举无法表达），
留空 = 不覆盖；可填档位见上文
[按代理配置推理强度](#按代理配置推理强度reasoningeffort)。

`npm run test:client`（`test/client-runtime-0.2.ts`，84 条断言）覆盖该页的渲染契约与写回契约：
`value=""` 继承占位项、目录加载中/失败降级手填、已存值不可用时 disabled 回显、只读连接、
revision 冲突拒绝保存、只写显式配置的代理等。

官方表单提交后无需重启即生效：Config 的 `skills` / `schedule` / `delegateRetry` 是 `.volatile()` 字段，
官方设置页按**活动 profile entry id** 投影这些字段，改动经 `entry.update({config})` 写入 profile patch 后，
由 Loader 以 `loader/volatile-update` 提交到运行中的同一 Volatile 引用（无需重挂载）；
插件每次 delegate 工具 execute 时 `get()` 当前快照，因此下一次工具调用即见更新，正在执行的一次使用起始快照。
`test/host-integration.ts` 用真实 Loader + `SettingsForms.describe()` 验证了这条链路（含提交后 describe 的 value 与 `config.get()` 一致）。

## 配置（profile 的 cordis.patch.yml，按行 id "cohub" 覆盖）

最小配置（不开 council）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors: []          # 为空则不注册 council_session 工具
    councilTimeoutMs: 180000
    skills: []               # delegate 委派路由（DSH 0.2 起由设置页按 profile entry id 投影此 volatile 字段，实时生效）
                             # 每条路由可配 provider/model/maxTokens/reasoningEffort，见下节「skills 字段」
```

**启用 council**（councillors 非空时自动注册 council_session 工具）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors:
      - { name: expert1, provider: deepseek-official, model: deepseek-v4-flash }
      - { name: expert2, provider: pi-ai, model: pi-ai-large }
      - { name: expert3, provider: deepseek-official, model: deepseek-v4-pro, prompt: 你是首席架构师，先列风险再给结论 }
```

**完整配置**（cordis.patch.yml 第 18 行起所有注释块都是可选 profile 覆盖）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    # delegateEnvContract：环境契约注入（默认开）。部署已知环境可覆盖 text 跳过探测：
    delegateEnvContract: { enabled: true }
    # delegateRetry：中止/失败自动重试。默认不重试（保持现状）。
    # 停滞检测：默认关闭（enabled=false），启用后在 spawn 子代理时挂 StallWatchdog，
    # 按 session/event 在线估计 S1-S4 信号并提前中止（复用 delegateRetry 重试预算）。
    delegateRetry:
      maxRetries: 2
      retryDelayMs: 1500
      retryableReasons: ["aborted"]
      stall:
        enabled: true
        consecutiveErrors: 3      # S1 连续同类错误阈值
        idleMs: 180000            # S2 无结果空转毫秒
        reasoningWithoutAction: 50 # S3 纯推理无动作阈值
        loopCount: 3              # S4 同工具名 + 同参数重复次数
        graceMs: 30000            # 宽限窗口
        recoverable: true         # 触发后按 retryableReasons 判定
    # 环境契约持久化：默认 auto（无缓存时行为不变）。
    # 累计同一归一化签名达 confirmCount 次后写入 dshHomePath("cohub","env-signatures.json")。
    envSignatures:
      use: auto                  # auto / off / manual
      ttlMs: 604800000           # 7 天
      confirmCount: 2
    # 调度参数：通过 systemPrompt.section 注入实际生效值（cohub:schedule），子代理可见。
    # ⚠️ useJobTracking 与 adaptiveBatch 已于 2026-09-03 移除（声明了但代码不读的死参数），不要再配。
    schedule:
      maxParallelBatch: 3
      wallClockBudgetMs: 600000
```

完整字段含义与缺省见 [`cordis.patch.yml`](cordis.patch.yml) 顶部注释块。

### 按代理配置推理强度（reasoningEffort）

每条 skill 路由可写的字段：`name`（必填）、`provider`、`model`、`maxTokens`、`reasoningEffort`。

`reasoningEffort` 直接转发为 DSH 的 `AgentOptions.reasoningEffort`（`ReasoningEffortId`，
adapter 拥有的**不透明字符串**——`dsh-llm` 的 `brand.ts` 明确 "no validation is performed"，
所以本插件用 `z.string()` 而不是写死 `low/medium/high` 枚举，避免把别的 provider 的档位拒之门外）：

```yaml
skills:
  - { name: co-oracle,   provider: deepseek-official, model: deepseek-v4-pro, reasoningEffort: high }
  - { name: co-explorer, reasoningEffort: low }   # 只降档：provider/model 仍继承父会话
```

语义（依据官方 `@deepseek-ai/dsh-subagent` 的 `resolveChildAgentOptions`）：

| 配置 | 子代理实际模型/强度 |
| --- | --- |
| 都不配 | 完全继承父会话（provider/model/强度） |
| 只配 `provider`+`model` | 用该模型；**继承的强度会被清掉**，改用该模型的 `defaultEffort` |
| `provider`+`model`+`reasoningEffort` | 用该模型 + 指定强度（显式值覆盖继承值） |
| **只配 `reasoningEffort`** | provider/model 仍继承父会话，只覆盖推理强度 |
| `provider` 当前不可用 | 完全继承（强度一并忽略，并打印告警） |

- 合法档位 = 该 provider+model 在模型目录里暴露的 `models[].reasoning.efforts[].id`
  （`ctx.remote.session.modelCatalog()` / `ctx.llm.resolveModelInfo()` 同源）。
- 配了模型不支持的档位：DSH 会在发出请求前直接抛 `UNSUPPORTED_REASONING_EFFORT`（不做
  clamp/alias）。本插件因此在**provider+model 都确定**时先用 `resolveModelInfo` 预校验：
  不支持则丢弃该强度并告警（委派照常进行，按模型默认档跑）；查询不可用/抛错时放行不拦截。
- 空串与纯空白视为「未配置」（官方设置页清空文本字段会写回 `""`）。
- 本字段可选、无默认值：不配置时解析结果不含该键，官方表单也不会把默认档写回每条路由。

## 升级与卸载

### 升级

- 通过插件市场/安装命令升级：`dsh plugin add dsh-cohub@latest`；离线环境按 profile 的 `package.json` 改版本号后重装。
- 升级后重启 DSH。preset 内容有变化时，**老会话不会自动生效**——preset 在会话首个 turn 后锁定，需新建会话。

### 卸载

1. 从 profile 的 `cordis.patch.yml` 移除 `cohub` 那一行（或其 `plugins:` 项），或执行 `dsh plugin remove dsh-cohub`。
2. 删除 `~/.dsh/.agent-presets/` 下的 `co-orchestrator`、`cohub-cordis`、`cohub-subagent-readonly`、`cohub-subagent-write` 目录（若存在）。
3. 重启 DSH。技能与设置页区块应随之消失。

### 排查入口

- 设置页「CoHub 代理模型」区块可确认模型路由是否生效。
- 行为异常时先确认宿主 DSH 版本（见「快速开始 → 前置条件」），再查看会话日志定位委派链路。

## 兼容性

宿主版本要求见「快速开始 → 前置条件」。`@deepseek-ai/cordis` peer `^4.0.1` / `schemastery` peer `^3.18.1`
保持合法 range，测试 devDependencies **精确固定**宿主实测 `4.0.4` / `3.18.4`——lock 解析到最新不代表宿主实测，以宿主为准：

- **0.1 的 settings namespace 机制已移除**：`installSettingsSection` / `settingsNamespace` 在
  dsh-settings 0.2 已删除。本插件不再注册 `cohub` namespace，改为 Config 的三个动态字段标
  `.volatile()`（见上节）。`settings.yaml` 的 `cohub.*` 段**不会被自动迁移**（旧 importer 是否
  支持自定义 namespace 未证实，明确不触发），请通过设置页或 `cordis.patch.yml` 重新配置。
- **不兼容 DSH 0.1**：宿主版本要求见「快速开始 → 前置条件」（0.1 宿主上 npm 会拒绝 peer 冲突，属预期行为）。
- **验证入口**：`npm run test:runtime`（`test/runtime-0.2.ts`，真实 schemastery/Volatile/defineTool
  契约 + 真实 cordis 挂载，离线 stub 子代理）、`npm run test:host`（`test/host-integration.ts`，
  真实 Loader + entry.update volatile 提交 + SettingsForms.describe 投影 + 真实 subagents 服务
  （正常/失败/capability/pre-aborted/运行中取消 + delegate 取消链） +
  app-boot preflight 官方 helper）、`npm run typecheck:0.2`
  （`test/types/runtime-0.2.ts`，strict 编译检查公共边界与真实 DSH 0.2 导出）。完整宿主链路
  （真实 spawn/fork transport 的进程内实现、真实 LLM provider、preset 树真实挂载）由宿主集成验证覆盖，
  单测不冒称完全覆盖。

### 环境契约持久化

`envSignatures.use="auto"` 时：

- 累计同一归一化错误签名（`err:<msg>#`）出现 ≥ `confirmCount`（缺省 2）次
- 写入 `~/.dsh/cohub/env-signatures.json`（插件自管，不依赖 settings）
- 下次 spawn 命中缓存（指纹一致 + TTL 内）→ 用确定性契约文本前馈注入，跳过探针

`use="off"` 不读不写，每次都走 DEFAULT_ENV_CONTRACT 探针式。
`use="manual"` 只读 manual 配置（schema 中 `contract` 字段，部署可静态指定），不学习。

### 停滞检测

`delegateRetry.stall.enabled=true` 时启用：

- 通过 `ctx.on("session/event")` 监听 session/event 全局事件总线，按 `run.id` 归属子代理事件
- 四类噪声信号：S1 连续同类错误 / S2 无结果空转 / S3 纯推理无动作 / S4 重复调用循环
- 触发条件：`S1 ∪ (S2 ∪ S3 ∪ S4)` **且**距最近一次成功工具结果超过 `graceMs`（最近成功过不触发）
- 触发后 `ac.abort()` 提前中止，复用 `delegateRetry` 重试预算（`recoverable=true`）
- T3：父 `exec.signal` 中止通过内部 `AbortController` 转发到子代理
- 降级：若 `ctx.on` 缺失（无事件源），自动降级关闭，看门狗完全不介入（维持现状）
- `error.cause.stall` 写入结构化信息 `{ signals: [...], diagnostics: "..." }`

无事件源的部署会自动降级，不会因缺失 session/event 而崩。

### 会话审计

会话导出目录（含根 `session.jsonl` + `subagents/.../session.jsonl`）可跑：

```bash
npm run audit -- <sessionDir> [--rules <json>] [--rules-file <path>] [--json <out>]
```

输出工具调用/结果/错误、错误类别、通用"重复盲试"、委派树、墙钟超时与环境签名。完整规则与退出码见 `scripts/audit-session.mjs` 顶部注释。

### 会话复盘（`/cohub-review`）

在当前会话直接执行 `/cohub-review` 即可生成可追溯的复盘报告：命令零 turn、不经模型，输入框立即返回产物路径，分析在后台完成。

- **两段式**：每个 `turn/end` 只做纯统计落盘（零 LLM 调用，不阻塞主响应）；只有你主动执行命令时才发起一次 LLM 分析。
- **产物**：`<dshHome>/cohub/reviews/<cwdHash>/<sessionHash>/` 下有 JSON 与 Markdown 两份报告。
- **可追溯**：每条结论都带 `(sessionId, turn, seq)` 锚点可回溯原始事件，无证据的结论会被隔离到「未验证」区，不会混进正式结论。

## 开发与维护

### 与 OpenCode 版的机制映射

| OpenCode 版（oh-my-opencode-cohub） | DSH 版（本包） |
|---|---|
| 12 个 agent 注册（双重注册 + config hook） | 13 个 runtime skills（本插件 apply 时注册） |
| 中文注入 experimental.chat.system.transform | ctx.systemPrompt.section |
| task 工具 + 并行派发 | DSH 原生 subagent 工具（后台/续聊） |
| todowrite | DSH 原生 todo_write |
| Background Job Board（消息注入） | DSH 原生 job board（删除） |
| ContextEngine 上下文提取 | subagent_fork 继承会话（删除） |
| council_session 工具 | workflow 并行 + provider/model 覆盖 |
| TUI 面板 | DSH Web GUI 原生面板（删除） |
| CLI 安装器 | dsh plugin add（转发 pnpm） |
| **调度韧性**（停滞检测 / 调度参数） | **切片**（stall 检测器 + schedule 配置 + systemPrompt 段） |
| **环境契约一次学习持续使用** | **切片**（envSignatures 模块 + 缓存到 `~/.dsh/cohub/env-signatures.json`） |

> 注：`dsh plugin add` 不是 CLI 独立子命令，而是把参数转发给 profile 目录内的 `pnpm`（`dsh plugin --profile <name> add <pkg>` ≡ 在该 profile 执行 `pnpm add <pkg>`），安装后自动把声明 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`。

### 构建

前置：系统 bun（与主仓库一致）。

```bash
cd packages/dsh-cohub
npm run build
# 等价于：
#   bun run scripts/generate-skills.ts   # ① 生成 src/skills.ts（.md → 技能定义，必须先跑）
#   bun run scripts/guard-schema.ts      # ② 校验 Config / ScheduleConfig schema 与 cordis.patch.yml 一致
#   bun build src/index.ts --outdir lib --target node --format esm \
#     --external @deepseek-ai/cordis --external @deepseek-ai/schemastery \
#     --external @deepseek-ai/dsh-tools --external @deepseek-ai/dsh-system-prompt \
#     --external @deepseek-ai/dsh-skill --external @deepseek-ai/dsh-home-paths
#   bun build src/co-cordis-plugin.ts --outdir lib --target node --format esm \
#     --external @deepseek-ai/dsh-tools   # co-cordis 专用插件（第 13 个技能）
#   bun run scripts/build-client.js       # src/client/index.js → lib/client.js
```

### 测试

```bash
node test/unit.ts          # 基础集成（13 技能 + 内容 + brief + delegate 注入 + council）
node test/delegate-p1.ts   # P1：环境契约注入 + 重试
node test/stall-p3.ts      # 停滞检测（35 用例）
node test/schedule-p3.ts   # 调度参数（24 用例）
node test/env-sig-p3.ts    # 环境契约持久化（50 用例）
node test/skills-contract.ts # 技能契约：四角色验证纪律 + 证据复用 + 扩大条件（直接读 skills/*.md）
npm run test:runtime      # DSH 0.2 运行期契约（真实 schemastery/Volatile/defineTool + cordis 挂载）
npm run test:host         # DSH 0.2 宿主集成门禁（真实 Loader/SettingsForms/subagents/app-boot preflight）
```

### 目录结构

```
skills/            提示词源文件（.md，人工编辑；scripts/generate-skills.ts 据此生成 src/skills.ts）
docs/              设计文档
scripts/
  generate-skills.ts    .md → src/skills.ts（必须先跑）
  guard-schema.ts       Config / ScheduleConfig schema 与 cordis.patch.yml 一致性校验
  build-client.js       src/client/index.js → lib/client.js
  audit-session.mjs     会话导出目录审计 / 回归
  deploy-preset.ps1     手动部署内置 preset 到用户 preset root（幂等，防嵌套）
src/
  index.ts              插件行入口（apply、Config schema、三切片 schema、preset 安装接线）
  co-cordis-plugin.ts   co-cordis 专用插件（第 13 个技能）
  preset-install.ts     内置 preset 安装/升级台账（未改动则更新、用户改动则跳过、孤儿清理）
  delegate.ts           delegate 工具 + StallWatchdog
  delegate_batch.ts     delegate_batch 批量并行派发工具
  council.ts            多模型共识（council_session 工具）
  env-contract.ts       注入子代理的执行器环境契约文本（含「工具批处理」通用原则）
  env-signatures.ts     环境契约持久化（EnvSignatureLearner + 缓存）
  chinese.ts            中文身份与提示词文本
  result-budget.ts      子代理输出预算裁剪
  text-utils.ts         文本处理小工具
  skills.ts             generate-skills.ts 生成物（禁止手编）
  shared/               主/客户端共享常量
  client/index.js       客户端模块（设置页「CoHub 代理模型」section 注册）
presets/
  co-orchestrator/          内置 agent preset（纯调度编排，委派工具面补全 + compaction）
  cohub-cordis/             内置 agent preset（创造模式 + 中文身份 + 自包含组合创作技能）
  cohub-subagent-readonly/  子代理只读 preset（工具面硬隔离）
  cohub-subagent-write/     子代理可写 preset（工具面硬隔离）
test/
  unit.ts               基础集成
  client-runtime-0.2.ts 设置页渲染 / 写回契约（84 条断言）
  delegate-p1.ts        P1 环境契约注入 + 重试 + 模型回退
  stall-p3.ts           停滞检测
  schedule-p3.ts        调度参数
  env-sig-p3.ts         环境契约持久化
  runtime-0.2.ts        DSH 0.2 运行期契约
  host-integration.ts   宿主集成门禁（真实 Loader / SettingsForms / subagents）
  skills-contract.ts    技能契约（四角色验证纪律 + 证据复用）
  preset-copy.ts        preset 递归复制（含真实 preset 结构断言）
  preset-install.ts     preset 安装/升级台账（用户改动保护 + 孤儿清理 + 降级）
  preset-schema.ts      preset YAML schema 断言（persona.prefix / 无 text: / 不挂 tool-cordis / 无 tab 缩进）
  types/                strict 类型检查入口（runtime-0.2.ts）
cordis.patch.yml     bundle patch（含 P1/P3 全部 profile 字段示例）
CHANGELOG.md         变更历史
package.json         包定义与脚本
tsconfig.typecheck.json  src 类型检查配置（typecheck:src；0.2 用 test/tsconfig.runtime-0.2.json，见 typecheck:0.2）
```

> 宿主版本要求见「快速开始 → 前置条件」。