# Changelog

本文件记录 dsh-cohub 的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.10.1] - 2026-10-27

### 新增

- **复盘报告写入项目内**：执行 `/cohub-review` 后，除原有位置外额外写一份 Markdown 到 `<项目根>/.cohub/reviews/report-<时间戳>.md`，并在该目录自动创建 `.gitignore`（内容 `*`）使其被 git 忽略，无需改动你自己的 `.gitignore`。对使用者的影响：报告就在项目里，不用再去 `~/.dsh` 下按哈希目录翻找，也便于在新会话里直接把这份文档交给 agent 分析。
- **复盘报告全局索引**：`~/.dsh/cohub/reviews/` 下新增 `index.json`（机器读）与 `INDEX.md`（人读），记录每个项目的 cwd、项目名、最近报告的状态/findings 数/会话数与三份报告路径，按最近时间倒序。对使用者的影响：目录名是 cwd 的 sha256 前 16 位、无法辨认项目的问题得到解决，一眼能看到所有项目的复盘情况；索引损坏时会隔离为 `.corrupt` 后重建，失败的报告（`error-*.json`）也会出现在索引里。
- **复盘 findings 增加严重程度分级**：`kind` 表类型、`severity` 表严重程度，仅 `issue` 类型必需（`low`/`medium`/`high`），其它类型不输出。issue 在发现区内按严重度降序排列，并在区块开头显示「问题分布：high X / medium Y / low Z」。对使用者的影响：面对十几条发现时能先看高严重度的问题；判据明确写入分析提示词（high 含任务失败/数据丢失/单轮 200 倍以上 token 比例等）。

### 变更

- **分析提示词输出预算提高**：生成复盘分析时 `maxTokens` 由 2000 提高到 5000。对使用者的影响：会话较多时不再因输出被截断导致结论整体丢失。

### 修复

- **0.10.0 发布内容不完整，请升级**：`0.10.0` 的 git tag 指向的提交早于本版本多项改动，导致 npm 上的 `0.10.0` 实际只含委派静默降级相关的 todo 改动，**缺少**本应一同发布的会话复盘能力增强、报告容错与 finding 分级。对使用者的影响：安装过 `0.10.0` 的请升级到 `0.10.1`，否则 `/cohub-review` 不会把报告写到项目内、没有全局索引、findings 也没有严重程度分级。
- **复盘分析输出被截断时结论全丢**：原解析用「最后一个 `]`」定位 JSON 数组，一旦模型输出被截断就找不到结尾、直接返回空，未报错也未保存。现改为括号配对扫描并支持剥除 Markdown 围栏、修复尾随逗号，截断时逐个抢救完整对象并标记 `interrupted`。
- **复盘分析失败原因不可见**：新增 `analysis.rawOutput`（前 2000 字）与 `rawOutputLength` 诊断字段，并在 Markdown 的「分析状态」与「限制说明」两处渲染。对使用者的影响：分析失败时能直接看到模型原始输出，不必再去翻日志。
- **根会话判定为单跳**：`resolveRootSessionId` 原先只上溯一层，出现多层委派时会把孙会话挂到中间层。现改为沿 `parentSession` 逐级上溯至根。

## [0.10.0] - 2026-10-27

### 新增

- **turn-stopping 收尾闸门（`src/todo-gate.ts`）**：监听官方 `agent/turn-stopping` 事件（`@mode serial` 且被 await），在「本可以关闭」的轮次边界前读 `sessionProjections` 的 `todo` 投影，若仍有 `in_progress` 项，就用 `agent.steer()` 投递一条动作指令，让状态机重读 inbox 再走一步，逼模型把状态回写，而不是留下面板与实际不符的 `in_progress`。文案给出三个明确出口（已完成→`completed`／确需继续→保持并立刻做完／等外部条件→降级 `pending` 并写明在等什么）。对使用者的影响：委派链跑完后，编排者的 `todo` 面板不再可能停在「进行中」——turn 关不掉，除非每项都有交代。
- **闸门的三道防噪硬约束**：① 子会话隔离（`session.header.parentSession` 非空直接 return），否则 `delegate` / `delegate_batch` 场景下每个子代理 turn 关闭都被催，会成倍放大成噪音风暴；② 每 session 硬上限 2 次（`WeakMap` 计数，对齐 `todo-nudge.ts` 的口径）；③ `in_progress` 内容指纹去重（`pickInProgress` + `fingerprintOf` 排序快照），指纹不变就不催，同一 turn 内重复 emit 与同状态反复关闭都被吸收。
- **闸门全程 fail-soft + 可撤销**：`steer` 前先扣额度（抛错也已记账，不会无限重试）、同步函数不 await 网络/LLM、不看返回值、整体 `try/catch` 吞错；注册包在 `ctx.effect(() => registerTodoGate(ctx))` 内，返回的 `off` 自身也吞错，插件卸载时自动摘监听。另有 kill switch `COHUB_TODO_GATE=0` 可整体禁用。
- **单测 `test/todo-gate.ts`（270 行）与 `test/todo-nudge.ts`（173 行）**：独立运行不连真宿主，覆盖纯函数契约、指纹去重、无 `in_progress` 时不催、内容变化后的第二次触发与上限截断、子会话隔离、`steer` 抛错时额度已扣、kill switch 生效与恢复。

### 说明

- 承接 0.9.2 的 `todo` 闭环：0.9.2 已提供「编排流程写入 `todo` 状态维护纪律」（`skills/orchestrator.md`，派发前置 `in_progress`、验收通过立即 `completed`、收尾对账）与「委派返回后自动注入 `todo` 回写提醒」（`src/todo-nudge.ts`），本版补上最后一环——turn 关闭前若仍漏写，由闸门强制回写。
- 本版为纯增量：不新增配置项，不改既有默认行为；`COHUB_TODO_GATE=0` 即可退回 0.9.2 的观感。

### 修复

- **`/cohub-review` 异常时静默零产物**：生成报告链路的首步会话读取是唯一没有异常保护的调用，一旦宿主 `readSession` 抛错（如分析期间会话仍在写入导致 replay 校验失败），异常会被 fire-and-forget 的 catch 吞成一条不落盘的 warn，用户只看到「正在生成报告」却什么都拿不到。现在改为三层兜底：会话读取失败降级为空事件并让报告照常落盘（自带「采集不完整」标记）、任何未捕获异常写 `error-<时间戳>.json`、错误同时追加到 `_errors.log`。对使用者的影响：即使遇到异常也能拿到可诊断的产物，不再出现「提示成功但磁盘空白」。
- **复盘分析全链路无超时**：此前 `readSession` 与 LLM 调用均无时限，而子会话查找会列举该工作目录下的全部历史会话（实测某项目 690 个），可能长时间挂起。现加 60 秒总超时，并改用手父会话过滤的 BFS 查找，避免全量列举。
- **复盘报告与采集统计目录不同源**：报告曾按根会话写盘、`stats.json` 按发起会话写盘，同一会话会出现两种目录，导致「以为没产出」的误判。现统一按发起会话归档，报告内容中的 `rootSessionId` 语义不变。

## [0.9.2] - 2026-10-27

### 修复

- **裸装时 `schemastery` 旧版缺 `volatile` 导致整个插件导入失败**：`peerDependencies` 里 `@deepseek-ai/schemastery` 的下限原本是 `^3.18.1`，而 `Schema.prototype.volatile` 自 **3.18.4** 才提供；更关键的是它同时被登记在 `peerDependenciesMeta.optional`，npm 既不会自动安装也不做版本校验，于是解析到 3.18.1～3.18.3 时，`src/index.ts` 里 6 处 `.volatile()` 在**模块顶层求值**就抛 `TypeError`，插件连加载都进不去。现把下限提到 `^3.18.4`。对使用者的影响：`npm install dsh-cohub` 的裸装场景不再因为一个次版本差就整包导入失败。
- **`schemastery` 从 `peerDependenciesMeta` 移除，改为必需 peer**：此前标 `optional: true` 意味着「宿主没装也不报错」，实际后果是缺失/过旧都被静默放过，问题延迟到运行期才以 `TypeError` 形式爆出来。对使用者的影响：依赖不对时在安装阶段就能被发现，而不是等插件加载时才崩。
- **新增 `volatileSchema()` 包装 6 处 `.volatile()` 调用**：`skills` / `delegateRetry` / `schedule` / `resultBudget` / `delegateBackground` / `delegateSubagentPreset` 统一经该 helper 标记——旧版 `schemastery` 环境下降级为**普通配置字段**（失去热更新投影，但功能可用），而不是在模块顶层直接抛错。对使用者的影响：即便宿主锁死在旧版 `schemastery`，插件也能正常加载并工作，只是这几个字段不再享受设置页热更新。

### 新增

- **委派返回后自动注入 `todo` 回写提醒（`src/todo-nudge.ts`）**：`delegate` 与 `delegate_batch` 拿到结果后，经官方 `ToolRunContext.deferContext()` 把一条 plugin-sourced user 上下文挂到本次工具结果之后（`tool/result` 落盘才追加，不抢正文位置），正文是一条可立即执行的动作指令「立刻 `todo_write` 回写对应项状态」。同会话最多注入 2 次（`WeakMap` 按 `exec.agent` 计数），后台 job 分支不注入（那里任务只是排队，提醒语义不成立）。全程 fail-soft：宿主没有 `deferContext` 或构造被拒即静默跳过，绝不影响委派结果。对使用者的影响：子代理做完后，编排者的 `todo` 面板不再长期停在「进行中」——提醒会跟着委派结果一起到达，最多两次，不刷屏。
- **编排流程写入 `todo` 状态维护纪律（`skills/orchestrator.md`）**：明确「状态维护归父代理」（派发前置 `in_progress`、未开始项保持 `pending`，子代理不碰面板）、「单项完成立即回写」（每项验收通过即标 `completed`，同批可合并但必须在下一批派发前写回）、「收尾对账硬性要求」（最终回复前再调一次 `todo_write`，不得遗留任何 `in_progress`）。对使用者的影响：编排过程的状态面板与实际进度一致，不再出现「活干完了面板还亮着」的错觉。

## [0.9.1] - 2026-10-27

### 修复

- **复盘分析输出被截断时 findings 全丢**：`/cohub-review` 的分析阶段 `maxTokens` 只有 2000，而 13 个会话的统计摘要本身就占掉大半预算，模型刚开头就被硬截断；更糟的是解析器用 `lastIndexOf("]")` 定位数组结尾，截断的输出里根本不存在 `]`，于是直接返回 `null`。对使用者的影响：此前跑十几轮会话的复盘，报告恒定 `status=failed` + 0 条结论，看起来像「本次会话没有值得复盘之处」，实际是分析结果被整段丢弃；现在同一份真实数据（13 会话）能稳定产出 12 条全带锚点的 findings。
- **`extractJsonArray` 改为括号配对扫描**：不再依赖「输出完整」这个前提，改为剥掉 Markdown 围栏（` ```json `）后逐字符做括号配对扫描，并在遇到截断时抢救已闭合的完整对象；`maxTokens` 同步从 2000 提到 5000，给统计摘要留出足够输出预算。对使用者的影响：模型带围栏或长尾截断都不再导致解析直接失败。
- **截断但救出完整对象时标记 `interrupted` 而非 `completed`**：此前只要没抛错就记 `completed`，用户无法区分「模型确实只找到这些结论」与「输出被截断、后面的结论没写出来」。对使用者的影响：报告状态如实反映分析是否完整，遇到 `interrupted` 就知道结论可能不全、值得重跑。
- **`analysis` 新增 `rawOutput` / `rawOutputLength` 诊断字段**：仅在状态非 `completed` 时写入，Markdown 侧同步渲染「模型原始输出：全长 N 字、留档前 M 字」。此前分析失败只留一句 `error`，无从判断是「被 maxTokens 截断」还是「模型格式跑偏」。对使用者的影响：出问题时不用翻日志，报告里直接能看出原始输出长什么样。
- **`resolveRootSessionId` 改为沿 `parentSession` 逐级上溯**：原实现只跳一跳，遇到「子代理的子代理」（孙会话）就把祖会话当成根，导致复盘归属错位、统计落不到真正的主会话上。对使用者的影响：多层委派的会话复盘现在能正确归到根会话。

## [0.9.0] - 2026-10-27

### 新增

- **`/cohub-review` 会话复盘命令**：在任意会话执行即可生成可追溯的复盘报告，命令经宿主 commands 通道执行、零 turn 不经模型，输入框立即返回产物路径、分析在后台完成。采用「A2 静默采集 + A1 手动分析」两段式：每个 `turn/end` 只做纯统计落盘（零 LLM 调用，不阻塞主响应），用户主动执行命令时才发起一次 LLM 分析。对使用者的影响：报告落 `<dshHome>/cohub/reviews/<cwdHash>/<sessionHash>/` 下的 JSON 与 Markdown 双份，每条结论都带 `(sessionId, turn, seq)` 锚点可回溯原始事件，无证据的结论会被隔离到「未验证」区而不是混进正式结论。
- **复盘模块 `review-command` / `review-collector` / `review-report` / `review-render` / `review-store` / `review-types`**：分别负责命令入口与 LLM 调用、事件采集、统计重放、Markdown 渲染、原子落盘、报告 DTO。
- **`src/error-signature.mjs`（含 `.d.mts`）**：错误签名归一化的单一实现，`env-signatures` 与 `audit-session` 共用，消除两套不兼容算法（原 `<audit>` 侧文本优先 + 数字归一 + 240 截断，`env-signatures` 侧结构优先 + 无数字归一 + 120 截断）。对使用者的影响：`audit` 报告与运行期环境签名可用同一把尺子比对。
- **`delegate` / `delegate_batch` 新增 `DelegateObserver` 埋点**：`onAttempt` 回调覆盖成功、失败、超时、中止四条出口，成功路径也保留实际重试次数（此前只在失败时记进 `err.cause.retries`，成功即丢）。对使用者的影响：不传 observer 时行为逐字节不变，属纯增量能力。

### 变更

- **`CACHE_VERSION` 1 → 2**：因错误签名算法统一，旧缓存签名与新算法不匹配，整体判废后按现有门槛重新学习。对使用者的影响：升级后首次委派会回落到环境契约探针文本（行为不劣化，仅多一次探测），`confirmCount` 达标后自动以 v2 写回。

### 修复

- **`/cohub-review` 命令返回值补齐 `kind` 字段**：此前 handler 返回 `{ text }` 而契约要求 `{ kind, text }`，导致执行时始终报 `gateway/internal: command "cohub-review" handler must return a CommandResult`，用户看不到任何提示。
- **复盘 LLM 路由解析**：改为优先读 `agent.options` / `session.requestHeader()`，解决命令经局部注入（`ctx.inject(['commands','sessionQuery'])`）挂载后 `ctx.llm` 不可用、`provider`/`model` 落空的问题。
- **LLM prepared call 配置比对失败**：`prepareCall` 会回填模型默认 `reasoningEffort`，而 `stream()` 按逐字段严格相等校验，导致 `prepared LLM call config changed before adapter dispatch`。改为 `stream()` 时展开 `prepared.config` 再叠加调用参数。对使用者的影响：分析阶段不再必然失败。
- **分析失败原因写入报告**：`analysis` 新增 `error` 字段并在 Markdown「分析状态」与「限制说明」两处渲染，此前失败只 `logger.warn`（实测日志中检索不到），用户无法得知为何没有结论。
- **`findings` 为空时的措辞矛盾**：此前一边写「没有带证据的结论」一边写「所有结论均已带锚点」，现按分析状态分支区分。
- **删除 `scripts/audit-session.mjs` 的 `blindPatterns` 死代码**：`matchesBlindPatterns` 全文件零调用点，规则字段解析却仍在，属「配置了却不生效」。删除 5 处共 9 行，向后兼容天然成立（`parseRules` 是白名单式合并，残留字段被静默忽略）。
- **补回 `orchestrator` / `planner` brief 丢失的专责与并行判据**：`orchestrator` brief 缺 `co-designer` 专责提示、`planner` brief 缺「不按文件数拆」并行判据，属 brief 精简时的内容退化。

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
