# Changelog

本文件记录 dsh-cohub 的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.8.2] - 2026-10-27

### 性能

- **`delegate` / `delegate_batch` 的工具描述从 1162 字符压到 423 字符**（含参数级描述），每请求少发 739 字符。对使用者的影响：这两个工具常驻每次请求的工具表里，现在每个请求的固定开销更小、留给实际对话的上下文更宽；详细用法原本就在 orchestrator 技能中覆盖，调用方式与功能完全不变。

### 新增

- **子代理 preset 与工具裁剪的降级原因现在会出现在委派结果末尾**：此前这类问题只打一条 `logger.warn`，而进程并不落盘日志，于是「preset 未声明」「工具裁剪未生效」完全是静默的——委派照常返回结果，你没法知道子代理其实跑在错误的工具面上。对使用者的影响：以后收到委派结果时，末尾会直接标出降级原因，一眼可见「这个子代理没按预期裁剪工具」；注意降级逻辑本身未变（仍然是 fail-soft，不会因此中断委派），只是从不可见变为可见。

## [0.8.1] - 2026-10-26

### 修复

- **`delegate_batch` 的 `skill` 改为必填，漏传不再静默降级**：此前某个 task 漏写 `skill` 只会静默产出一个 `delegate_batch:xxx:undefined` 的子代理——既没有 preset 路由，也没有按角色裁剪工具表，等于派出去一个「谁都不是」的执行者，事后只能从 label 里的 `undefined` 看出问题。现在缺 `skill` 的调用会在参数校验阶段直接报 `invalid arguments: missing required property "tasks[i].skill"`；即使旧调用绕过校验，运行时也会打一条 warn 并兜底到 `co-fixer`，label 显示 `co-fixer (default:co-fixer)`。单个 `delegate` 的 `skill` 同样标为必填（此前技能文档声称必填，schema 实际未校验）。对使用者的影响：写错的委派当场报错，而不是悄悄退化成低效子代理；升级后漏传 `skill` 的旧脚本会被拒绝，需要补上代理名。

## [0.8.0] - 2026-10-26

### 新增

- **子代理改用独立精简 preset（硬隔离）**：子代理不再继承主代理的「主调度者」人设与完整工具表，而是按是否需要写入分别挂 `cohub-subagent-readonly` / `cohub-subagent-write` 两个精简 preset，经 `request.agentPreset` 由运行时独立组装。对使用者的影响：每个子代理少烧约 2.4k tokens 的系统提示词；工具面里不再出现 delegate / subagent / workflow，子代理不会再试图「再派一层」；只读代理（explorer / oracle / librarian 等）在物理上就没有写文件与跑命令的工具，人设与「你是执行者」的实际职责终于一致。
- **`co-explorer` / `co-fixer` 增加效率硬约束**：无依赖的工具调用必须打包成同一批发出，输出控制在 3000 字符以内。对使用者的影响：同一批探索与改动明显更快——反面案例里 16 次串行调用耗掉 107 秒，批量化后往返次数与回传数据量同时下降。

### 变更

- **`delegate` 结果裁剪阈值 6000 → 12000 字符，并为超长结果开了受控读取口**：子代理的长输出不再那么早被砍掉；中间产物落盘后，orchestrator 可以直接读取 locator 指向的行段（仅限本会话产出的中间产物，限行段、限 2 次）。对使用者的影响：检索结果、测试报告这类长输出能保留更多有效信息，同时父会话上下文预算仍然受控。

### 修复

- **`co-planner` / `co-librarian` / `co-designer` 等技能与只读 preset 能力对齐**：此前这些技能要求子代理「写文件 / 跑命令」，在只读工具面下只会失败或空转；现已改为在只读能力内完成职责（产出文本方案、结论与设计说明）。对使用者的影响：这些代理的任务不再因为「工具不存在」而失败。

## [0.7.0] - 2026-10-26

### 新增

- **`delegate_batch` 结果首行自报并发度**：批量委派的结果第一行会写明 `并发 N 个子代理 · M/N 完成 · 总耗时 Xs`，不用再自己数结果条数就能判断有没有任务被静默丢弃、这批到底省了多少时间。
- **子代理禁止再派子代理**：depth ≥ 1 的委派被硬拒绝，避免「孙代理」层层套娃——同一件事被拆散到多层上下文里，耗时和 token 翻倍却没人对结果负责。
- **单次委派目标 ≤8 steps 纪律**：一个子任务的目标被约束在能一次交付的粒度，派出去的活不再拖成巨型任务、超时后整批白跑。
- **`co-planner` 输出上限 1500 字符**：方案文本不再无限膨胀，交给下游执行时信噪比更高，也避免规划本身吃掉大量上下文。

### 变更

- **build/test 分离纪律限定为「仅多批并行修改」适用**：只有一次改动跨多批并行下发时才需要单独跑构建与测试门禁；单批改动仍由 `co-fixer` 自行验证，小改动不必再多付一轮验证往返。

### 文档

- **新增「并发写与 FS_STALE_VERSION」三段式处理纪律**：写文件撞上版本号冲突时有了固定的处理顺序，不用再临场猜该重试还是重读。
- **委派配置类文件须标注并发风险**：改这类文件时会收到明确提醒，减少多代理同时改同一处导致的丢失更新。
- **发版流程修正 12 处不一致并补齐两处缺口**：按文档操作即可走通发版，不必自己判断哪句指导已经过时。

## [0.6.0] - 2026-10-24

### 新增

- **`delegate` 支持后台 job 模式**：开启 `delegateBackground` 后，子代理注册为 DSH 后台 job 并立即返回 jobId，主代理用 `job_output` 取结果或等待自动唤醒，等待期间可并行推进其他工作；默认关闭，jobs 服务不可用时自动降级为前台同步。
- **后台委派的显式开关与纪律**：`background: true` 可绕过总开关单独指定；技能文档补充了「何时该后台化、如何取结果、等待期如何并行、取消需用 `job_kill`、每个 agent 10 个并发上限」的完整规则。
- **子代理结果预算**：父会话工具结果按契约段保留 + 头尾裁剪 + 全文落盘 locator，防止长输出把上下文撑爆；复用平台 spillStore，不再自建存储。
- **子代理按角色裁剪工具表**：`toolFilter` 以 deny 方式收敛每个代理可见的工具，fail-soft 降级，越权调用在设计上就不成立。
- **子代理模型分层默认值**：只读类代理（explorer / oracle / librarian / observer）默认走 low reasoning effort，重型代理保留高投入，无需逐个手工配置。
- **CoHub 代理模型设置页（恢复）**：在设置页注册独立的 `settings.section`，13 个代理逐行配置 provider / model 双下拉，走 `configForms` 直接读写 volatile `skills`；未配置的代理保持继承父模型。
- **按代理配置推理强度**：设置页每行新增推理强度下拉，档位从 `modelCatalog()` 的 `models[].reasoning.efforts[]` 动态读取；模型不支持时禁用并提示，换模型时自动清空不兼容档位，空值不写入配置（继承父会话）。

### 修复

- **`delegate` 适配 DSH 0.2.1 `startActivation` API**：委派链路在新版运行时上恢复可用。
- **委派错误信息透传 `SubagentResult.diagnostic`**：子代理失败时父会话能看到原始诊断，而不是一句「未知错误」。
- **阻止子代理重复加载 orchestrator 技能**：修复子代理把 orchestrator 技能当成自身职责、错误地再套一层调度的浪费。
- **persona 身份判据收紧到首条用户消息**：此前判据过宽会误触发身份切换，现在只认任务书中的 `--- 你的具体任务 ---` 分隔符。
- **`toolFilter` 下发前求交集**：避免与运行时已有白名单冲突导致的无谓降级。
- **显式请求后台失败时回传降级原因**：不再静默变成前台同步，调用方能看到为什么没进后台。
- **后台 delegate 修正 job owner 与 jobs 服务获取**：owner 改为传 session id 字符串，并从 owner 的 ctx 取 jobs 服务，避免取到错误的挂载点。
- **后台 delegate 把结果写入 `job.result`**：此前结果落在别处，`job_output` 读不到。
- **preset 对齐运行时 0.2.1-rc.2**：preset 组合与当前运行时版本匹配，避免 peer 校验告警。

### 变更

- **任务分档 T0-T3**：单文件改动不再强制走完整五阶段流程，显著降低子代理数量与往返次数，小改动不再被大流程拖住。
- **验证收敛**：T1/T2 档位不再强制召唤 `co-oracle`，按档位选择验证强度。
- **单任务 5 分钟预算 + 先落盘证据纪律**：委派 prompt 附带统一模板，要求先写证据再汇报，超预算即收口。
- **preset compaction 阈值 0.8 → 0.5**：上下文压缩更早触发，长会话更稳。
- **设置页表述与依赖注入同步**：`dsh.client.inject` 补齐 `dsh-client-ui-settings` 与 `dsh-api-remotes`，README 更新到当前形态。

### 文档

- **preset 中 spill-policy 的版本与字段注释修正**：模型分层与 spill 策略的注释不再与实际运行时版本脱节。

## [0.5.1] - 2026-10-19

> 注：README 历史段落记为 2026-10-17，实际发布日待核实。

### 新增

- **恢复「CoHub 代理模型」设置页**：撤销 v0.5.0 收尾中「删除自定义设置卡片」的决定——该决定的理由是「官方设置页会自动按 volatile 字段生成表单」，但官方 README 明说「目前没有已发布的客户端会那样渲染 volatile 字段」，官方 settings 导航 / 页面全部由客户端插件注册（general / models / plugins / agent-presets / account 皆然），故该理由不成立。
- **设置页回到向 `settings.section` 注册独立页面**：`src/client/index.js` 恢复独立设置页（`order: 12`），13 个代理的 provider / model 双下拉经 `configForms` 读写 volatile `skills`（`mutate` + revision 冲突栅栏）。
- **`test/client-runtime-0.2.ts` 扩为 84 条断言**：覆盖渲染契约（`value=""` 继承占位项、目录加载中 / 失败降级手填、已存值不可用 disabled 回显、只读、冲突、保存失败）与写回契约（只写显式配置的代理、空 model 不写键、保留未知 skill 名）。
- **新增 `test/skills-contract.ts` 契约测试**：直接读取 `skills/*.md` 磁盘正文（不依赖生成物 `src/skills.ts`，build 前后均可运行、与调用时 cwd 无关，`node test/skills-contract.ts` 即可），断言四角色验证纪律——orchestrator 验证节（范围 / 负责人 / 扩大条件 / 修改 Wave 不自测、批量改完统一验证）、planner 验证步骤、fixer 委派范围纪律、oracle 成功证据复用安全条件。
- **`test/preset-schema.ts` 增加移除性断言**：persona 必须 `prefix` 非空、不得残留 `text:`、preset 不得挂 `tool-cordis`、关键工具行齐全、无制表符缩进、`cohub-standard` 不得复活。

### 变更

- **`dsh.client.inject` 补回 `@deepseek-ai/dsh-client-ui-settings` / `@deepseek-ai/dsh-api-remotes`**：由宿主 web 组合提供，本包不直接依赖。
- **收紧验证纪律（第二轮）**：多代理并行修改的 Wave 本轮只改不验证，批量修改全部完成后统一验证；失败先集中归因（真实退出码 / 错误消息 / 日志位置）→ 定向修复最小范围 → 验证通过后再按影响面扩大，诊断 / 交互类问题说明理由可作例外。
- **证据复用契约化**：仅限成功完成的只读检查，且仍覆盖当前输入 / 源码与测试 / 配置 / 范围 / 环境状态；证据不足就必要重验，失败不是通过证据，无新变更 / 目标时不机械重跑已知失败。
- **本版本不含新的 API 适配**：仅收敛验证范围 / 证据复用规则并新增对应契约测试，v0.5.0 的 DSH 0.2 适配与 0.1 不兼容说明保持有效。

## [0.5.0] - 2026-10-17

### 新增

- **正式面向 DSH 0.2.0-rc.2**：本包锁定 DSH 0.2 契约，peer / dev 依赖升至 `0.2.0-rc.2`；`@deepseek-ai/cordis` peer `^4.0.1` / `@deepseek-ai/schemastery` peer `^3.18.1` 保持合法 range。
- **新增 peer `@deepseek-ai/dsh-session-projection ^0.2.0-rc.2`（required）**：tokenMeter 真实调用 `ctx.sessionProjections.snapshot`。
- **新增 `npm run test:client`**（`test/client-runtime-0.2.ts`）：执行真实构建产物 `lib/client.js` 的 ModuleLoader 注册，断言 module id / inject 仅 locale、apply 只访问声明服务、不触碰旧 settingsScope / slot / 未声明 remote（locale 与 window 为内存 stub，非 React 真实浏览器 UI，浏览器实测留给宿主）。
- **`test/host-integration.ts` 新增运行中取消门禁**：真实 SubagentRuntime + in-memory provider 验证 start 已发布后 mid-flight abort 的 result 停止 / 失败传播（signal 驱动受控 result settle 为 `stopReason=aborted`，非仅断言 `signal.aborted`）与 dispose 资源清理，并验证 delegate 工具 execution 的取消链（父 `exec.signal` → run.result 停止 → 结构化 cause）。

### 变更

- **设置改为 Config 的 `.volatile()` 动态字段**：由官方设置页按活动 profile entry id 原生投影，取代并删除 0.1 的 `installSettingsSection` / `settingsNamespace` 自定义卡片机制。
- **客户端收敛**：`src/client/index.js` 删除 0.1 `settingsScope` / `settings.plugin.item` 兼容死分支与不可达的自定义设置卡片（约 800 行，0.2 下该分支永不执行），仅保留 locale 设置字典注册。
- **`dsh.client.inject` 收敛为仅 `@deepseek-ai/dsh-client-locale`**：peer 移除不再使用的 `react` / `dsh-client-connection` / `dsh-client-ui-settings` / `dsh-client-ui-slots` / `dsh-api-remotes`。
- **不再支持 DSH 0.1（不兼容）**：0.1 宿主因 peer 冲突被 npm 拒绝安装，属预期。
- **不自动迁移旧 `cohub` settings namespace 与用户 preset（不兼容）**：旧配置请经设置页或 `cordis.patch.yml` 重配；preset 由安装台账按「用户是否改过」逐文件保护。

## [0.4.11] - 2026-10-17

### 变更

- **`skills/orchestrator.md` 瘦身 20587 → 15532 bytes（约 -24.6%）**：主代理保持纯调度不变，压缩的是冗余叙述而非纪律。
- **规格不变项**：两层并行 / 聚合、brief 300、planner 237、批次上限 3 均不变；不伪造 runtime 200K，不自动压缩 / 硬裁 delegate。

## [0.4.10] - 日期待核实

### 修复

- **撤销 v0.4.9 的 host 层单次挂载方案**：v0.4.9 在 `dsh-cohub` 自带的 `cordis.patch.yml`（bundle 层）里用顶层 `insert`（无 id → 追加到 host 组合）挂了一次 `tool-cordis`，假设「host 层挂一次，创造模式就不必自己挂」——那是个更糟的修复。
- **撤回原因**：官方 `cordis` preset 是部署自带、不可修改的（升级会覆盖），它仍会自己挂那一行，于是 host 层那份变成抢占者——创造模式的 standing mount 失败 → agent 创建在 preset 的 compose 阶段被回滚 → 每次对话都报 `client api: session/prompt failed: Failed to fetch (gateway/internal)`；host 同时以 ~10 次/秒重试失败的挂载，日志写到 10MB/分钟（一天 200MB+）。
- **`tool-cordis` 全进程只由官方「创造模式」挂载**：`dsh-cohub` 的 bundle patch 不再插入该行，`cohub-cordis` 也不挂它，而 cohub 插件行照常挂载。

## [0.4.9] - 日期待核实

### 修复

- **persona 字段名过时**：`@deepseek-ai/dsh-persona` 的 schema 是 `prefix`（required）/ `suffix`，两个内置 preset 一直沿用旧字段 `text:`，挂载期报 `invalid config: - $.prefix missing required value (at prefix)`；已把两个 preset 的字段统一为 `prefix`。
- **`tool-cordis` 与官方创造模式撞名**：`@deepseek-ai/dsh-tool-cordis` 挂载时会把一组 Host 级 inspect provider（`Service` / `Event` / `Builtin` / `Tool`）注册进进程单例注册表（`dsh-cordis-host-runner` 的 `CordisInspectRegistryService.register()`：`if (this.providers.has(manifest.id)) throw ...`），而官方 `cordis`（创造模式）preset 同样挂这一行，同一进程里各自挂载必然撞名，报 `Host Cordis inspect provider "Service" is already registered`。
- **症状同源**：以上是两个独立的挂载期故障，症状相同——preset 不可用，以它为默认 preset 时新会话建不出来，日志在 `%APPDATA%\DSH Desktop\logs\host\dsh-*.log`。
- **本版本的 host 层单次挂载方案后来被 v0.4.10 撤销**。

## [0.4.8] - 日期待核实

### 新增

- **preset 安装 / 升级台账**（`src/preset-install.ts`）：在 preset root 的上一级写 `<root>/../.cohub-preset-install.json`，记录每个 preset 的安装版本与逐文件 sha256；包版本升级时逐文件比对——未被用户改动的文件跟随更新，用户改过的文件跳过并告警，解决旧实现「目录已存在就跳过、老用户永远收不到 preset 修复」的问题。
- **台账纳入与降级策略**：首次遇到「已存在但台账未记录」的目录时会尝试纳入台账（与包内有内容一致即视为插件早前安装），完全无一致文件的目录视为用户自建、永不触碰；台账损坏 / 读写失败一律降级为「仅新增」，绝不覆盖既有内容。
- **安装开关 `cohub.installPresets`（默认 `true`）**：设为 `false` 后本插件完全不再触碰 `~/.dsh/.agent-presets/`，给不需要这些 preset 的部署一个干净出口。
- **孤儿清理**：包内已不再发布、但曾记录在台账中的 preset 会在加载时从用户目录移除，避免选择器残留幽灵条目；只清理台账确认由本插件安装过的 id，不碰用户自建目录。

### 变更

- **移除 `cohub-standard`**：其工具面是 `cohub-cordis` 的真子集，移除原因与老用户迁移指引见 v0.4.7 条目。

## [0.4.7] - 日期待核实

### 新增

- **执行器环境契约新增「工具批处理」通用原则**（`src/env-contract.ts`）：一条消息里可发多个无依赖调用、无依赖只读调用应打包同批、`pwsh` / `bash` 按批执行是逐条串行所以能用一条命令表达的不要拆成多次 shell 调用；同时明确批处理只省往返、不等于并行加速（实测同批调用多被串行执行），并列出必须串行留白的场景（后续参数取决于前序结果 / 同文件写 / 破坏性 shell）。契约由 `delegate` 注入所有子代理，一处生效覆盖 13 个技能。
- **orchestrator 增加「信息收集的细分原则」**（`skills/orchestrator.md`）：先列独立事实清单 → 每个事实维度一个子任务 → ≥2 时用一次 `delegate_batch` 并行发出（实测 agent loop 对同批 tool_use 极少真并发，而 `delegate_batch` 内部 `Promise.allSettled` 是真并行）。
- **新增 `cohub-cordis` preset（创造模式）**：DSH 官方「创造模式」（`cordis` preset）的骨架 + cohub 中文身份与委派指引，含标准模式全部工具面、`present` 产物交付、组合创作技能，以及直接可用的 cohub `delegate` / `delegate_batch`。

### 变更

- **移除 `cohub-standard`（标准模式 + cohub 身份）**：其 29 行工具面是 `cohub-cordis` 的真子集——只少了 `tool-cordis`、`present`、`command-goal`，而两者的 delegate 能力完全相同；因此删除该 preset，统一指向 `cohub-cordis`（标准模式全部能力 + 自改运行时）。
- **老用户迁移**：插件加载时会读取安装台账，自动移除「曾由本插件安装、但已不再随包发布」的目录，重启后选择器里不会再出现它；若你手动改造过 `~/.dsh/.agent-presets/cohub-standard/`，或该目录早于台账机制存在，它不会被自动清理——按需手动删除即可。

## [0.4.6] - 日期待核实

### 修复

- **修复「留空 model」的秒失败**：`cohub.skills` 中只配 `provider`、不配 `model` 时，旧版 `buildAgentOptions()` 只把 `provider` 交给子代理，模型则回落到父会话的模型名；当该模型名不属于这个 provider（例：`provider: tokenproto` 而父会话是 `deepseek-official/deepseek-flash`），DSH 的 pi-ai 适配器在网络 I/O 前就以 `UNKNOWN_MODEL` 拒绝，`delegate` 只返回 `subagent stopped with reason "error" after 0 retry(ies); partial:`，子代理会话里没有任何模型消息。
- **model 缺失时回退到该 provider 目录首个模型**：用 `ctx.llm.listModels(provider)` 取适配器偏好顺序的第一项；查询失败或空目录则降级为旧行为。
- **设置卡片的模型下拉框新增 `value=""` 占位项**：旧版在 `value=""` 时会被浏览器渲染成列表第一项，让「留空」看起来像已经选好了模型。

## [0.3.0] - 日期待核实

### 修复

- **修复派发：补齐委派工具行**：原 preset 只挂 `tool-workflow`，缺 spawn / fork 委派工具行，主代理无法实际 spawn co-* 子代理。
- **补齐 `delegation-subagents` group**（subagent / subagent_fork / control / list-agents / ralph）：persona「全部委派给专职子代理」由此才能落地。
- **补齐 compaction group**：防长会话爆 context。

### 变更

- **回退运行时 `tools.restrict({deny})` 物理收口方案**：前序版本尝试用它限制文件 / Shell / 外网工具，实测该 API 在 DSH 0.1.0-rc.6 上行为不符合预期，会连带影响委派工具导致主代理无法派发；现回到「preset 不挂 fs / shell / web 工具行 + persona 软约束」方案。

---

历史版本详见 git tag `dsh-v0.5.1` 及之前的提交。
