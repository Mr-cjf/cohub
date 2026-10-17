# CoHub 可靠编排方案

日期：2026-10-15。状态：指导模式已实施，严格模式不可用；版本 1.6.1。默认入口仍需由用户显式启用，本文件记录实施边界和验收要求。

目标是让普通工程请求，例如“GPU 服务部署了吗”，在用户启用后自动进入委派流程：顶层 root 负责理解、拆分、委派、对账和汇报，worker 执行业务搜索、SSH、测试和部署。轻任务一个 worker；独立就绪任务全部进入队列，不添加插件侧数字并发上限，实际发送遵循宿主容量与文件归属。日常聊天不启动代理，用户明确要求不委派或更高优先级限制时标记 `disabled/exempt`。

## 已知事实与约束

本轮调查确认安装版本为 1.5.1，用户全局 `~/.codex/AGENTS.md` 为 0 字节且无 override。GPU 会话的技能目录包含 CoHub，但未观察到技能加载或 resolver 执行；记录中有 128 次 exec，后段仅一次 `fork_turns=all` 的 spawn。因此目录可见不足以证明入口生效，也不能证明角色模型配置被使用。CLI 为 0.162.1；Desktop 的具体运行时未确认，二者的能力不能相互代证。

源码共有 16 个技能，包括其他聊天新增的三个 Git 工作流技能，全部保留。现有 hooks 配置含 10 类事件、每类一个 handler，必须保留。仅在 Codex 包边界内设计实现，遵守[仓库规范](../../../AGENTS.md)、[文件操作规则](../../../.rules/04-file-operation.md)、[Codex 包规则](../../../.rules/07-codex-plugin-dev.md)和[调度契约](../skills/cohub/references/efficiency.md)。

## 分层保证

**指导模式是可先落地的默认方案。** 用户显式启用后，以受管理的全局 AGENTS 区块提供常驻入口，技能写清工程任务范围、指令优先级、root/worker 分工及禁止递归编排。安装默认不修改全局入口；启用、状态、禁用分别是明确操作。不能依赖每条提示提到 CoHub，也不能把技能 description 或 `agents/openai.yaml` 的 `default_prompt` 当作原生代理注册。[1][2]

首次启用后必须新建原生会话验收，旧聊天不能声称自动激活。启动与后续回合区分磁盘配置和会话观测：`configured` 只表示配置存在；加载过程可观察时为 `loading`，否则为 `unknown`；有真实委派证据才为 `observed-active`。保护级别另记 `guidance-only`、`strict-unavailable` 或 `verified-strict`，并记录宿主、会话、原因和证据引用。模型口头承诺、root 可写的任务状态或“已加载”字符串均不能作为独立证据。

**hooks 是可选辅助层。** 官方覆盖包括 Bash/exec、apply_patch、MCP、本地函数、spawn 的 Agent 别名及 code mode 嵌套调用；Hosted Web Search 等特殊路径并不完整覆盖，`write_stdin` 续写不重新触发 PreToolUse。异常或超时可继续执行；Stop 的 block 触发继续工作，不能充当最终完成门禁，其他 Stop 的 `continue:false` 仍可优先终止。[3] 因此只用于诊断、提醒和已覆盖路径的拒绝，不发布完整隔离保证。非托管 hooks 必须经用户审阅并信任，不能自动信任或绕过。新增 handler 应独立合并、去重，保留现有处理器及顺序。

**严格模式取决于宿主实际能力。** 必须同时具备以下条件，缺一项便报告 `strict-unavailable`：

- 宿主或受信 broker 提供稳定、不能由提示伪造的 actor 身份。PreToolUse 的公共 `session_id` 可属于父会话，缺少稳定 agent 身份；transcript 也不是稳定契约。[3] 不能用角色提示、最近一次 SubagentStart 或活动子代理数量推断调用者。
- root 使用独立工具白名单，实际移除业务 shell、文件读写、MCP、HTTP、web，以及间接调用和会话续写通道；编排配置解析只能走受限接口。worker 权限不超过父级授权及任务范围。
- 宿主控制完成账本，root 只读；真实 spawn、结果、产物哈希与来源证明相互绑定。身份、权限或证据失效时关闭执行，拒绝伪造或重放结果。

root 能改 AGENTS 或 task-state 不构成权限隔离。能力探针通过前，不把新 CLI host 或 broker 当作当前插件已有能力，也不暗中实现新的执行宿主。无法委派或入口未生效时，可靠行为是明确报告“编排未生效／工具不可用”，不能用 root 直接执行业务来掩盖失败；显式豁免则记录适用范围，不用 hook 强拦用户授权。

## 实施阶段与接口

阶段 0 仅做只读探针和隔离 fixture，分别核查 Desktop、CLI 的原生委派、加载证据、actor 身份、工具限制及 hook 信任状态。输出能力表与失败原因。严格模式能力不足就停在阻断结论；指导模式可继续独立实施。

阶段 1 实现显式启停和指导规则。管理脚本先按原生 AGENTS/override 发现顺序定位有效文件，展示目标与差异，保留其他内容、编码和 CRLF；重复启用幂等，marker 缺失配对、重复或损坏时整次拒绝写入。写前备份并校验并发变更，原子替换；禁用只移除本插件区块，回滚不得覆盖用户后续修改。[1]

同批角色按当前会话能力和用户有效配置一次解析，复用既有 resolver 优先级及 `null` 继承语义。未配置时原生继承；`fork_turns=all` 不附模型覆盖，显式覆盖只在支持的 `none` 路径提交。错误配置或工具缺失明确失败，不能静默降级；请求值与宿主实际返回值分开记录，未知保持未知。

阶段 2 在用户完成信任后，可增加 hooks 辅助验证。阶段 3 仅在严格能力 gate 全部通过且用户确认范围后另行实施权限隔离，不以指导模式的成功推断严格模式可用。

冻结三个契约：状态输出 `{configured, mode, sessionState, protection, reason, evidence}`；能力输出 `{host, runtimeVersion, identity, toolIsolation, hookCoverage, nativeDelegation}`，未知字段显式为空；证据记录 `{taskId, nativeAgentId, actorAuthority, submittedAt, startedAt, endedAt, writeScope, resultRef, artifactHash}`。测试只使用隔离样本，不保存密钥、环境变量全集或原始远程日志。

## 任务图与文件归属

下表路径均相对本包，列出的新文件是拟新增范围。统一输入为本方案、已确认调查和上述规范；各项共享状态与证据契约。所有命令明确 cwd；测试临时目录隔离，构建输出、锁文件和端口由单一负责人管理。

| taskId / 负责人 | dependsOn / 输入 | 独占 writeScope | 产出、验收 / effort / 验证者 |
|---|---|---|---|
| P0 / 能力调查者 | 无；两个宿主的实际接口 | 新增 `docs/orchestrator-capabilities.md`；隔离临时 fixture | 分宿主能力表与严格模式 gate；无法观测项标未知 / medium / oracle |
| P1 / 单一 planner | P0；本方案与接口现状 | 本方案的确认修订 | 冻结接口、真实安装入口路径、归属与完整验收；不实施 / medium / root |
| A / 入口实现者 | P1；AGENTS 发现规则 | 新增 `scripts/orchestrator-policy.mjs`、`test/orchestrator-policy.test.mjs` | 启停、状态与失败原子性；仅产出 implemented / medium / V |
| B / 技能实现者 | P1；现有调度契约与 resolver | `skills/cohub/**`、`skills/co-orchestrator/**`，含各自 UI YAML | 普通工程自动委派、轻任务与豁免、继承解析、防递归；保留其余技能 / medium / V |
| C / 验收实现者 | P1、P0；冻结契约 | 新增 `test/orchestrator-fixtures/**`、`docs/orchestrator-evaluation.md` | 准备行为与反例 fixture、证据判据；不写 A/B 文件 / medium / V |
| I / 单一集成者 | A、B、C 写入结束 | README、包清单、插件清单、安装与结构校验入口的明确行段 | 对账 16 技能；安装不隐式启用；版本仅确认发布时更新 / medium / V |
| V / 统一验证者 | I；完整最终 diff | 只写隔离测试输出 | 一轮适用检查，记录真实退出码；失败返还原所有者 / medium / root |
| O / 只读 oracle | I；最终 diff、短结果与证据 | 无 | 与 V 并行审查边界、绕过与兼容性，不改实现 / high / root |
| E / 原生验收者 | V、O 通过；用户显式启用 | 仅用户授权的管理区块、隔离证据输出 | 新会话普通提示验收，按观测标状态；不沿用旧会话结论 / medium / root |

P0 是实施授权后的首个就绪项；本轮只交付方案。P1 完成后 A/B/C 同时就绪，不按预计槽位截断队列。I 独占集成文件，先检查其他聊天现有改动；归属冲突就拆出精确行段或等待，不能覆盖。V/O 前结束所有相关写入；修复后只重跑受影响检查。hooks 和严格宿主的后续工作须经过对应阶段 gate，再一次冻结完整新增任务范围。

## 验收矩阵与失败行为

| 场景 | 通过证据 / 失败判据 |
|---|---|
| 新会话“GPU 服务部署了吗” | 隔离部署状态由 worker 读取，有真实 nativeAgentId、结果与工具归属；root 无业务命令。未 spawn 即失败，不尝试真实部署 |
| 轻任务、多个独立任务 | 轻任务一个 worker；独立任务记录提交与起止时刻、文件所有者和实际重叠，无插件人工 cap；不承诺固定提速 |
| 明确不委派、普通聊天 | 前者标 `exempt` 并遵循更高优先级约束；后者零 spawn；不误触发 hook 阻断 |
| 工具缺失、模型无效、spawn 失败 | 明确失败或阻断；无虚构 ID、无静默降级、无 root 代做 |
| compact、resume、多轮、配置更新 | 重新对账有效规则与会话证据；未证实加载保持 unknown；配置变化重解析，旧聊天不自动标 active |
| 启停与兼容 | override、空文件、CRLF、损坏 marker、并发修改、重复启停及回滚样本通过；16 技能和现有 hooks 保留 |
| hook 未信任、超时或异常 | 不标“已保护”；缺失路径、续写、Stop 组合行为如实呈现 |
| 严格模式绕过探针 | 按 actor 测 shell/read/write/web/MCP/间接调用/续写，违规请求副作用为零；伪造角色、账本和结果不得过关；失败关闭 |

验收使用宿主原生事件或可信权限证明，不能用模型自述代替。统一检查在仓库根运行 `npm run build:codex`、`npm run test:codex`；通过后，再进行显式启用和全新原生会话验收。指导模式最多声明“本会话观察到编排生效”，只有严格隔离探针全部通过才声明 `verified-strict`。

## 官方依据

以下文档于 2026-10-15 核查；规范描述与本机能力探针分别留证，文档支持不等于当前宿主支持。

1. [OpenAI：AGENTS.md 发现与指令加载](https://developers.openai.com/codex/guides/agents-md)
2. [OpenAI：技能发现、调用与元数据](https://developers.openai.com/codex/skills)
3. [OpenAI：hooks 事件、覆盖、信任和失败语义](https://developers.openai.com/codex/hooks)
