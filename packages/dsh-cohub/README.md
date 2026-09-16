# dsh-cohub

DeepSeek Harness 版 [oh-my-opencode-cohub](https://github.com/Mr-cjf/oh-my-opencode-cohub)：中文智能体编排插件。
把「纯调度模式 + 12 专职代理 + 多模型共识 + 运行期调度韧性」移植到 DSH 原生能力之上。

## 与 OpenCode 版的机制映射

| OpenCode 版（oh-my-opencode-cohub） | DSH 版（本包） |
|---|---|
| 12 个 agent 注册（双重注册 + config hook） | 12 个 runtime skills（本插件 apply 时注册） |
| 中文注入 experimental.chat.system.transform | ctx.systemPrompt.section |
| task 工具 + 并行派发 | DSH 原生 subagent 工具（后台/续聊） |
| todowrite | DSH 原生 todo_write |
| Background Job Board（消息注入） | DSH 原生 job board（删除） |
| ContextEngine 上下文提取 | subagent_fork 继承会话（删除） |
| council_session 工具 | M4：workflow 并行 + provider/model 覆盖 |
| TUI 面板 | DSH Web GUI 原生面板（删除） |
| CLI 安装器 | dsh plugin add（转发 pnpm） |
| **M2/M3/M4 调度韧性**（N2 停滞检测 / N3 调度参数） | **P3-1/P3-3 切片**（stall 检测器 + schedule 配置 + systemPrompt 段） |
| **环境契约一次学习持续使用**（N1） | **P3-2 切片**（envSignatures 模块 + 缓存到 `~/.dsh/cohub/env-signatures.json`） |

> 注：`dsh plugin add` 不是 CLI 独立子命令，而是把参数转发给 profile 目录内的 `pnpm`（`dsh plugin --profile <name> add <pkg>` ≡ 在该 profile 执行 `pnpm add <pkg>`），安装后自动把声明 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`。

## 技能清单（12 个）

co-orchestrator（调度）/ co-planner（方案）/ co-oracle（审查）/
co-explorer（搜索）/ co-librarian（研究）/ co-observer（视觉）/
co-fixer（执行）/ co-designer（UI）/ co-council（共识）/
co-rule-user / co-rule-project / co-rule-app（规范分析）

## 构建

前置：系统 bun（与主仓库一致）。

```bash
cd dsh-cohub
npm run build
# 等价于：
#   bun run scripts/generate-skills.ts   # 生成 src/skills.ts
#   bun build src/index.ts --outdir lib --target node --format esm \
#     --external @deepseek-ai/cordis --external @deepseek-ai/schemastery \
#     --external @deepseek-ai/dsh-tools --external @deepseek-ai/dsh-system-prompt \
#     --external @deepseek-ai/dsh-skill --external @deepseek-ai/dsh-home-paths \
#     --external @deepseek-ai/dsh-settings
#   bun run scripts/build-client.js       # src/client/index.js → lib/client.js
```

## 安装到 profile

```bash
dsh plugin --profile web add dsh-cohub
```

本地开发安装：

```bash
dsh plugin --profile web add C:\Users\14023\Desktop\dsh-cohub
```

或手动：profile 的 package.json

```json
{
  "dependencies": { "dsh-cohub": "file:../dsh-cohub" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-cohub"] } }
}
```

## 配置（profile 的 cordis.patch.yml，按行 id "cohub" 覆盖）

最小配置（不开 council）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors: []          # 为空则不注册 council_session 工具
    councilTimeoutMs: 180000
    skills: []               # delegate 委派路由（可用 settings.yaml 的 cohub.skills 覆盖）
```

**M4 启用 council**（councillors 非空时自动注册 council_session 工具）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors:
      - { name: expert1, provider: deepseek-official, model: deepseek-v4-flash }
      - { name: expert2, provider: pi-ai, model: pi-ai-large }
      - { name: expert3, provider: deepseek-official, model: deepseek-v4-pro, prompt: 你是首席架构师，先列风险再给结论 }
```

**P3 完整配置**（cordis.patch.yml 第 18 行起所有注释块都是可选 profile 覆盖）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    # delegateEnvContract：环境契约注入（默认开）。部署已知环境可覆盖 text 跳过探测：
    delegateEnvContract: { enabled: true }
    # delegateRetry：中止/失败自动重试。默认不重试（保持现状）。
    # P3-1 N2 停滞检测：默认关闭（enabled=false），启用后在 spawn 子代理时挂 StallWatchdog，
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
    # P3-2 N1 环境契约持久化：默认 auto（无缓存时行为不变）。
    # 累计同一归一化签名达 confirmCount 次后写入 dshHomePath("cohub","env-signatures.json")。
    envSignatures:
      use: auto                  # auto / off / manual
      ttlMs: 604800000           # 7 天
      confirmCount: 2
    # P3-3 N3 调度参数：通过 systemPrompt.section 注入实际生效值（cohub:schedule），子代理可见。
    schedule:
      maxParallelBatch: 3
      wallClockBudgetMs: 600000
      useJobTracking: auto       # auto / on / off
      adaptiveBatch: auto        # auto / off
```

完整字段含义与缺省见 [`cordis.patch.yml`](cordis.patch.yml) 顶部注释块。

## 使用

1. 主会话中让模型加载 co-orchestrator 技能（skill 工具）
2. 按提示词流程：信息收集（并行 subagent）→ co-planner 方案 → 审核 → 执行 → 验证
3. 子代理统一通过 DSH 原生 subagent 工具委派，后台任务走 job board

### settings 卡片

`npm run build` 后重启 DSH，打开设置 → **插件** 标签，可看到「CoHub 代理模型」卡片：

- **12 个 skill 行**（每个独立配置 provider / model）
- **调度参数（可选）**：批大小 / 墙钟预算 / Job 跟踪 / 批间自适应
- **委派重试 / 重试间隔**：maxRetries / retryDelayMs / 可重试原因（逗号分隔）
- **停滞检测（可选）**：启用复选框 + 5 个阈值 + 可重试复选框（未启用时数字输入框 disabled）
- **环境契约持久化（可选）**：契约模式（auto/off/manual）/ 缓存 TTL / 确认次数

改卡片后无需重启即生效（`text` 是函数，每次 prompt 装配时动态读取当前 settings）。

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

## co-orchestrator agent preset（Phase 2）

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

在 GUI 的 agent preset 选择器中切换。注意（rc.6 限制）：子代理继承父代理的 preset 组合且 toolFilter 只能收窄，因此 preset 不硬性移除文件工具——「绝不亲自操作文件」由 co-orchestrator 技能在提示词层约束（与 OpenCode 原版一致）。

**v0.3.0 修正（修复派发）**：原 preset 只挂 `tool-workflow`，缺 spawn/fork 委派工具行，主代理无法实际 spawn co-* 子代理。v0.3.0 补齐 `delegation-subagents` group（subagent / subagent_fork / control / list-agents / ralph）+ compaction group（防长会话爆 context）；persona「全部委派给专职子代理」才能落地。**前序版本中尝试用运行时 `tools.restrict({deny})` 物理收口文件 / Shell / 外网工具的做法已回退**——实测发现该 API 在 DSH 0.1.0-rc.6 上行为不符合预期，会连带影响委派工具，导致主代理无法派发；现回到「preset 不挂 fs/shell/web 工具行 + persona 软约束」方案。

**v0.4.6 修正（修复「留空 model」的秒失败）**：`cohub.skills` 中只配 `provider`、不配 `model` 时，旧版 `buildAgentOptions()` 只把 `provider` 交给子代理，模型则回落到**父会话的模型名**。当该模型名不属于这个 provider（例：`provider: tokenproto` 而父会话是 `deepseek-official/deepseek-flash`），DSH 的 pi-ai 适配器在网络 I/O 前就以 `UNKNOWN_MODEL` 拒绝，`delegate` 只返回 `subagent stopped with reason "error" after 0 retry(ies); partial:`，子代理会话里没有任何模型消息。v0.4.6 起：model 缺失时用 `ctx.llm.listModels(provider)` 取该 provider 目录的首个模型作为回退（适配器偏好顺序的第一项），查询失败或空目录则降级为旧行为。同时 settings 卡片的模型下拉框新增 `value=""` 占位项——旧版在 `value=""` 时会被浏览器渲染成列表**第一项**，让「留空」看起来像已经选好了模型。

**v0.4.7 修正（工具批处理 + 委派细分 + 创造模式）**：
- **A｜执行器环境契约新增「工具批处理」通用原则**（`src/env-contract.ts`）：一条消息里可发多个无依赖调用、无依赖只读调用应打包同批、`pwsh`/`bash` 按批执行是逐条串行所以能用一条命令表达的不要拆成多次 shell 调用；同时明确**批处理只省往返、不等于并行加速**（实测同批调用多被串行执行），并列出必须串行留白的场景（后续参数取决于前序结果 / 同文件写 / 破坏性 shell）。契约由 `delegate` 注入所有子代理，一处生效覆盖 12 个技能。
- **C｜orchestrator 增加「信息收集的细分原则」**（`skills/orchestrator.md`）：先列独立事实清单 → 每个事实维度一个子任务 → ≥2 时用**一次 `delegate_batch`** 并行发出（实测 agent loop 对同批 tool_use 极少真并发，而 `delegate_batch` 内部 `Promise.allSettled` 是真并行）。
- **D｜新增 cohub-cordis preset（创造模式）**：见上节。

**v0.4.8 变更（preset 安装台账 + 移除 cohub-standard）**：
- **A｜preset 安装/升级台账**（`src/preset-install.ts`）：在 preset root 的**上一级**写 `<root>/../.cohub-preset-install.json`，记录每个 preset 的安装版本与逐文件 sha256。包版本升级时逐文件比对——**未被用户改动的文件跟随更新，用户改过的文件跳过并告警**，解决旧实现"目录已存在就跳过、老用户永远收不到 preset 修复"的问题。首次遇到"已存在但台账未记录"的目录时会尝试**纳入台账**（与包内有内容一致即视为插件早前安装），完全无一致文件的目录视为用户自建，永不触碰。台账损坏/读写失败一律降级为"仅新增"，绝不覆盖既有内容。
- **B｜安装开关**：`cohub.installPresets`（默认 `true`）设为 `false` 后本插件完全不再触碰 `~/.dsh/.agent-presets/`，给不需要这些 preset 的部署一个干净出口。
- **孤儿清理**：包内已不再发布的 preset（曾记录在台账中的）会在加载时从用户目录移除，避免选择器残留幽灵条目；只清理台账确认由本插件安装过的 id，**不碰用户自建目录**。
- **移除 `cohub-standard`**：其工具面是 `cohub-cordis` 的真子集，详见下方说明。

**v0.4.9 修复（preset 无法挂载 → 新会话无法创建）**：这一次修的是**两个独立的挂载期故障**，症状相同（preset 不可用 → 以它为默认 preset 时新会话建不出来），日志都在 `%APPDATA%\DSH Desktop\logs\host\dsh-*.log`。

**其一：persona 字段名过时。** `@deepseek-ai/dsh-persona` 的 schema 是 `prefix`（required）/ `suffix`，而两个内置 preset 一直沿用旧字段 `text:`：

```
[preset-tree] Error: failed to apply loader entry persona (@deepseek-ai/dsh-persona):
  invalid config: - $.prefix missing required value (at prefix)
```

已把两个 preset 的字段统一为 `prefix`。

**其二：`tool-cordis` 与官方创造模式撞名。** `@deepseek-ai/dsh-tool-cordis` 挂载时会把一组 **Host 级 inspect provider**（`Service` / `Event` / `Builtin` / `Tool`）注册进**进程单例**注册表（`dsh-cordis-host-runner` 的 `CordisInspectRegistryService.register()`：`if (this.providers.has(manifest.id)) throw ...`）。官方 `cordis`（创造模式）preset 同样挂这一行，而 DSH 对同一 preset 共享 standing mount —— 于是两个 preset 在同一进程里各自挂载时必然撞名：

```
[tool-cordis] Error: Host Cordis inspect provider "Service" is already registered
[preset-tree] Error: failed to apply loader entry tool-cordis (@deepseek-ai/dsh-tool-cordis):
  Host Cordis inspect provider "Service" is already registered
```

**v0.4.9 曾把它改由 host 层单次挂载，v0.4.10 已撤销 —— 那是个更糟的修复。** v0.4.9 在 `dsh-cohub` 自带的 `cordis.patch.yml`（bundle 层）里用顶层 `insert`（无 id → 追加到 host 组合）挂了一次：

```yaml
- insert:
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

它的假设是"host 层挂一次，创造模式就不必自己挂了"。但官方 `cordis` preset 是**部署自带、不可修改**的（升级会覆盖），它**仍然会自己挂那一行**，于是 host 层那份变成了抢占者：

- 创造模式的 standing mount 失败 → agent 创建在 preset 的 compose 阶段被**回滚** → **每次对话都报 `client api: session/prompt failed: Failed to fetch (gateway/internal)`**；
- host 同时以 ~10 次/秒重试失败的挂载，日志写到 **10MB/分钟**（一天 200MB+）。

所以 v0.4.10 起：**`tool-cordis` 全进程只由官方「创造模式」挂**。`dsh-cohub` 的 bundle patch 不再插入该行，`cohub-cordis` 也不挂它，而 cohub 插件行照常挂载。

> **`cohub-cordis` 因此不含 `cordis_*` 工具**（`cordis_define` / `cordis_run` / `cordis_mount` / `cordis_inspect_*`）。需要 Cordis 自指能力时，请用官方**创造模式**会话；本 preset 用于"标准能力 + cohub 委派纪律"的日常开发。
>
> 也**不要**在 profile 的 `cordis.patch.yml` 里 insert 同 id —— 那会重新制造同一个故障。
>
> 需要回退时：把 `dsh-cohub` 从 profile `package.json` 的 `dsh.profile.bundles` 移除即可。

`test/preset-schema.ts` 现在同时断言：persona 必须 `prefix` 非空、**不得残留 `text:`**、**preset 不得挂 `tool-cordis`**、关键工具行齐全、无制表符缩进、`cohub-standard` 不得复活。

> 升级注意：安装台账按「用户是否改过」逐文件保护。若某个 preset 文件**既被用户改过、又需要跟随上游改名**，台账会判为用户改动而跳过自动更新 —— 此时需手动同步（或删除该 preset 目录让插件重新安装）。本次就是这种情况，已在该机器上手动修正。

### 关于 `cohub-standard`（v0.4.7 移除）

原先的 `cohub-standard`（标准模式 + cohub 身份）其 29 行工具面是 `cohub-cordis` 的**真子集**——只少了 `tool-cordis`、`present`、`command-goal`，而两者的 delegate 能力完全相同。因此 v0.4.7 删除该 preset，统一指向 **cohub-cordis**（标准模式全部能力 + 自改运行时）。

对已安装的老用户：插件加载时会读取安装台账，自动移除"曾由本插件安装、但已不再随包发布"的目录，所以重启后选择器里不会再出现它。若你**手动改造过** `~/.dsh/.agent-presets/cohub-standard/`，或该目录早于台账机制存在，它不会被自动清理——按需手动删除即可。

## cohub-cordis agent preset（Phase 5，v0.4.7 新增；v0.4.10 起不含 tool-cordis）

`presets/cohub-cordis/` 是 **DSH 官方「创造模式」（`cordis` preset）的骨架 + cohub 中文身份与委派指引**：标准模式的全部工具面、`present` 产物交付、组合创作技能，加上直接可用的 cohub `delegate` / `delegate_batch`。

**⚠️ 它不含运行时自改能力（`cordis_*` 工具）**：`tool-cordis` 在 Host 进程级 inspect 注册表里按 id 占位，全进程只能挂一次，而官方创造模式自带这一行（v0.4.10 撤销了 v0.4.9 的 host 层方案，原因见上）。要读写 harness 组合、做 `cordis_mount` 插件实验、动态定义/运行插件，请用官方**创造模式**；本 preset 用于"标准能力 + cohub 委派纪律"的日常开发。

**两者定位**：

| preset | 工具模式 | 委派 | 运行时自改 | 适用场景 |
|---|---|---|---|---|
| co-orchestrator | 纯调度（不挂 fs/shell/web + persona 软约束） | ✅ delegate | ✗ | 长链调度 / 多模型共识 / 严格自律 |
| **cohub-cordis** | **标准模式 + 中文身份 + 组合创作技能** | ✅ delegate | ✗（用官方创造模式） | 直接动手 + 委派混合、插件开发日常 |
| 官方 **创造模式**（`cordis`） | 标准 + **Cordis 自指工具面** | ✅ delegate（host plane，同样可用） | ✅ | 自改 harness / preset 创作 / 插件实验 |

**cohub 能力从哪来**：12 个 co-* 技能与 `delegate` / `delegate_batch` 工具由 dsh-cohub bundle 在 **host plane 全局注册**，与 preset 解耦——所以本 preset 不需要（也没有）额外的委派工具行。已实测确认：`delegate` 与 `delegate_batch` 都出现在会话工具表中，任何 preset 的会话（含创造模式）都能直接用，只要 dsh-cohub 挂在该 profile 上。

**使用方式**：agent preset 在会话**首次 turn 之后即锁定**（`agent-preset/locked: session has already started; its agent preset is fixed`），所以创造模式只能**新建会话**时选择，不能中途切换。

**自包含技能**：本 preset 自带 `skills/`（`cordis-plugin-development`、`editing-cordis-compositions` 两份组合创作指导），通过 `customSkillDirs` 指向 preset 自身目录，因此无论安装到哪里都能解析。

> **TRUST**：`cordis_mount` 会对模型写出的 JavaScript 求值并在活动运行时里执行，且本 agent 写出的组合会成为其他会话可挂载的 preset。请把使用本 preset 的会话**等同于 shell 访问权限**对待。

## 测试

```bash
node test/unit.ts          # 基础集成（12 技能 + 内容 + brief + delegate 注入 + M4 council）
node test/delegate-p1.ts   # P1：环境契约注入 + 重试
node test/stall-p3.ts      # P3-1 N2 停滞检测（35 用例）
node test/schedule-p3.ts   # P3-3 N3 调度参数（24 用例）
node test/env-sig-p3.ts    # P3-2 N1 环境契约持久化（50 用例）
```

基线说明：`unit` 20 + `delegate-p1` 41 + `stall-p3` 35 + `schedule-p3` 24 + `env-sig-p3` 50 + `preset-copy` 13 + `preset-install` 35 + `preset-schema` 26。除 `schedule-p3` 的 5 个既有失败（`cohub:schedule` 注入段断言，与委派链路无关）外全部 PASS（node >= 24）。无需 LLM，单测纯本地模拟。

## 目录

```
skills/            提示词源文件（.md，人工编辑；scripts/generate-skills.ts 据此生成 src/skills.ts）
scripts/
  generate-skills.ts    .md → src/skills.ts（必须先跑）
  build-client.js       src/client/index.js → lib/client.js
  audit-session.mjs     会话导出目录审计 / 回归
  deploy-preset.ps1     手动部署内置 preset 到用户 preset root（幂等，防嵌套）
src/
  index.ts              插件行入口（apply、Config schema、P3 三切片 schema、preset 安装接线）
  preset-install.ts     内置 preset 安装/升级台账（未改动则更新、用户改动则跳过、孤儿清理）
  delegate.ts           delegate 工具 + P3-1 StallWatchdog
  env-contract.ts       注入子代理的执行器环境契约文本（含「工具批处理」通用原则）
  env-signatures.ts     P3-2 环境契约持久化（EnvSignatureLearner + 缓存）
  skills.ts             generate-skills.ts 生成物（禁止手编）
  client/index.js       settings 卡片（i18n + 12 个 P3 控件）
presets/co-orchestrator/  内置 agent preset（Phase 2，纯调度模式 + 委派工具面补全 + compaction）
presets/cohub-cordis/     内置 agent preset（Phase 5，创造模式 + 中文身份 + 自包含组合创作技能，v0.4.7 新增）
test/
  unit.ts               基础集成
  delegate-p1.ts        P1 环境契约注入 + 重试 + 模型回退
  stall-p3.ts           P3-1 N2 停滞检测
  schedule-p3.ts        P3-3 N3 调度参数
  env-sig-p3.ts         P3-2 N1 环境契约持久化
  preset-copy.ts        preset 递归复制（含真实 preset 结构断言）
  preset-install.ts     preset 安装/升级台账（用户改动保护 + 孤儿清理 + 降级）
cordis.patch.yml        bundle patch（含 P1/P3 全部 profile 字段示例）
```

> DSH 处于 0.1.0-rc 阶段，本包 peerDependencies 锁定 rc.6。