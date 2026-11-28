# Changelog

本文件记录 dsh-cohub 的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.13.24] - 2026-11-27

### 新增

- **角色库对齐原型**：删除顶部固定的主代理专属卡（`co-orchestrator` 回归内置角色列表）；每张内置角色卡统一提供「查看详情 / 编辑 / 以此模板新建」三个动作；新增角色搜索框（按名称与职责实时过滤）。

### 变更

- **团队限制只能有一位队长类型角色**：勾选 `kind=lead` 的角色时，若团队已有队长类型角色则拒绝并提示；若尚未有，则自动将其设为队长。保存校验增加「必须有一位队长类型角色」与「一个团队只能有一位队长」两条。

### 说明

- 队长类型角色在成员列表里标注「队长类型 · 只能一位」，担任队长的再加「队长」徽标。
- 本版改动均在隔离实例与本机会话中验证（tab 切换、模板面板、搜索、单队长拦截）。

## [0.13.23] - 2026-11-27

### 新增

- **内置角色可编辑**：18 个内置角色的**描述 / 提示词 / 档位 / 绑定工具**现在都能改，通过新增的 `Config.roleOverrides` 覆盖，不修改内置定义本身。
- 已覆盖的内置角色卡片显示「已覆盖」徽标，编辑面板提供「恢复默认」（删除对应覆盖条目）。
- 落库只写差异：只把与内置默认不同的字段写入 override，全部还原即删除该条目，避免把默认值全量复制进用户配置。
- 模型与思考强度仍由 `Config.skills` 配置（内置与自定义角色都支持），与 roleOverrides 互不干扰。

### 说明

- 合并优先级：`customRoles`（用户新建的角色）> `roleOverrides`（内置覆盖）> 内置默认。角色类型（队长/队员）不可覆盖。
- override 的 `name` 不在 18 个内置角色内时会被忽略并记录日志，不会导致插件挂载失败。

## [0.13.22] - 2026-11-27

### 变更

- **内部预设的描述说明误选后果**：`cohub-subagent-readonly` / `-readonly-net` / `-write` / `-write-shell` / `cohub-cordis` 五个内部预设的描述统一改为「内部工具集，供 cohub 编排在派发子代理时自动挂载。<能力>。请勿手动选择——手动选中后，该会话会以“子代理”身份直接运行（没有编排与派发能力，也不会按团队配置限员）。」
- README 新增「内部预设」小节，说明这些 preset 为什么会出现在 Agent 预设列表里（DSH 未提供隐藏机制），以及误选的代价。
- 说明：preset 定义在运行时从包内 `presets/` 目录读取，不内联进 `lib/index.js`，因此产物 grep 看不到这些文案属正常。

## [0.13.21] - 2026-11-27

### 变更

- **撤销「按 agent 类型分流注入」方案**：该方案用 `systemPrompt.section` 判断 `agent.session.header.origin === 'subagent'` 来给主代理注入纯调度约束、对子代理返回空串。实测子代理 assemble 时 `context.agent` 为 undefined，兜底按主代理注入，导致子代理仍被「不要亲自调用 read/edit/write/bash」拦住。section 的注入时机无法可靠区分主代理与子代理，此路作废。
- **恢复档位 preset 挂载**：子代理重新挂载 `cohub-subagent-*` / `cohub-cordis` 预设，获得「专职子代理」persona 与正确工具面。这 4 个内部预设因此重新出现在 Agent 预设列表中（`order: 900` + 「内部 ·」前缀沉底）。
- **保留 `co-orchestrator` 的 persona 中性化**：删除其中「绝不亲自调用任何文件/代码读写与执行工具」的硬禁令，改为「优先委派」的中性表述，减少对子代理的间接影响。

### 说明

- 实测确认：内置与自定义角色的 prompt 仍按任务书层注入子代理（例如 `co-designer` 会同时看到 system 层的「专职子代理」与任务书里的「Designer，前端 UI/UX 专家」），角色定义有效，只是不再位于 system 层。
- DSH 未提供 preset 隐藏机制（`PresetDefinition` 仅 id/name/description/order/plugins），内部预设无法隐藏，属公开 API 的硬边界。

## [0.13.20] - 2026-11-27

### 修复

- **子代理继承了父代理的「纯调度」persona**：0.13.13 让档位子代理不再挂载独立 preset、改为继承父组合（`co-orchestrator`），而后者 persona 写着「绝不亲自调用任何文件/代码读写与执行工具」；该 persona 进入子代理的 system prompt，优先级高于任务书，导致 `co-designer` 等子代理拒绝对文件做任何修改（`tools.restrict` 只能裁工具、裁不掉 persona）。

### 变更

- 恢复档位子代理挂载各自的预设（`cohub-subagent-readonly` / `-readonly-net` / `-write` / `-write-shell`），子代理重新获得「专职子代理」人格与正确工具面；主代理 `co-orchestrator` 仍不挂子代理预设。
- 这 4 个内部预设重新出现在「Agent 预设」列表中，但保持 `order: 900` 与「内部 ·」名称前缀沉底——这是为换取子代理人格正确所做的取舍。
- 保留 0.13.13 引入的 `restrict` fail-closed 行为，作为工具裁剪的第二层保险。

## [0.13.19] - 2026-11-27

### 变更

- **队长并发派发口径**：有 2 个以上可独立验收的任务时，必须用 `delegate_batch` 一次批量派出，不再并列推荐"多个并行 delegate"（同消息多个 delegate 常被串行执行，batch 才是真并行）。
- 派发顺序规则：先按职责切分（不按数量）→ 同职责且无依赖的任务放入同一批次、可给同一职责派多个实例 → 任务书必须自包含且单批不超过 `maxParallelBatch` → 有依赖必须串行并把上一步产出写进后一任务书 → 拿不准默认串行 → 只有一个任务时用单发 `delegate`，不为凑批次拆碎任务。
- 该口径已同步到 `co-team-lead`（通用队长）、`co-orchestrator`（开发团队队长）与 `orchestrator` 技能正文三处。

## [0.13.18] - 2026-11-27

### 新增

- **角色类型（队长 / 队员）**：`CustomRole.kind` 区分两类角色；内置角色中 `co-orchestrator` 与 `co-team-lead` 为队长类型，其余为队员。新建角色时必须选择类型，角色卡片显示类型徽标。
- **团队队长提示词动态生成**：团队注册为 Agent 预设时，队长 persona 由「队长角色说明 + 团队成员清单」动态拼装，逐条列出每个成员的名称与职责；成员增减或职责修改会自动重建预设。设置页团队编辑面板提供实时预览，与实际注册的 persona 逐字同构。
- **队长校验**：团队队长必须是队长类型角色；指向队员类型会被拒绝并提示。

### 变更

- 团队预设与运行时派发共用同一套队长判定（删除了重复实现），避免 persona 与限员规则不一致。

## [0.13.17] - 2026-11-27

### 新增

- **两个通用内置角色**：`co-team-lead`（通用队长，纯调度：拆解目标 → 选队员 → 派发 → 验收汇总）与 `co-team-member`（通用队员，示例角色：按任务书完成并交付）。二者作为参考范例，可直接选进团队，也可作为新建角色的模板；提示词不写死成员名单，成员以当前团队配置为准。

### 修复

- **`agentPresets` 未 inject 导致插件同步失败**：设置页「内置插件」报 `cannot get property "remote.agentPresets" without inject`。已在 client inject 声明 `remote.agentPresets`，并给属性访问加 try/catch 兜底。
- **团队卡片预设 id 显示错误**：内置开发团队显示 `cohub-team-dev`，实际注册为 `co-orchestrator`。已改为优先读 `team.presetId`（数据生成器与客户端两处补齐）。
- **内置开发团队队长显示成 `co-fixer`**：`co-orchestrator` 不在该团队 members 内，被 lead 校验回退到第一个成员。已改为「主代理例外」（`lead === co-orchestrator` 直接采纳），用户自建团队仍要求 lead 在成员内。

### 说明

- 本版改动均在隔离实例（独立 DSH_HOME + mobile profile）中真实验证：CoHub 代理菜单正常、双 tab 可切、18 个内置角色可见、默认预设显示为「开发团队（co-orchestrator）」、运行时日志 `registered id=co-orchestrator` / `registered id=cohub-team-writing` 正常。

## [0.13.16] - 2026-11-27

### 修复

- **设置页「CoHub 代理」菜单消失**（0.13.15 回归）：tab 切换原用 `React.useState` 在组件函数体内调用，宿主以直接函数调用方式渲染时抛 `Invalid hook call`，导致整个设置节未注册。改为 controller 闭包状态（与编辑/保存同一重渲染通道），不再依赖任何 React hook。

## [0.13.15] - 2026-11-27

### 新增

- **设置页拆分为「团队 / 角色」双 tab**：团队 tab 管团队（内置团队、自定义团队、队长与成员），角色 tab 管角色库（模板新建、工具绑定、模型配置）；两个 tab 各自保留未保存草稿。
- **通用队长 / 通用队员模板**：新建角色时可选用不绑定具体成员名单的「通用队长（纯调度）」与「通用队员（示例）」，不再把 `co-orchestrator` 当模板（它的提示词写死 12 个成员，新建会带出过期名单）。
- **团队区块显示默认预设**：顶部由「当前会话预设：未知」改为显示实际默认预设（如「默认预设：开发团队（co-orchestrator）」）。

### 修复

- **Release 正文偶发退化为 compare 链接**（0.13.14 仅 87 字符）：`git show … | awk … exit` 管道在 CHANGELOG 超过 64KB 管道缓冲时触发 SIGPIPE（退出码 141），配合 `set -euo pipefail` 使抽取被判失败并静默回退 `--generate-notes`。改为先落盘再 awk、`index()` 精确匹配版本号、抽取失败只回退不误判。

## [0.13.14] - 2026-11-27

### 修复

- **`cohub-cordis` 预设挂载失败**（Agent 预设页显示「加载失败」）：`skill-filesystem` 的 `customSkillDirs` 被解析成对象而非字符串。
- 根因两处：① mini-YAML 解析器把 `- !!js "process.getBuiltinModule('node:url')..."` 中 `node:url` 的冒号误判为 `key: value` 映射，序列项变成对象；② `!!js` 求值只支持平台布尔表达式，URL 目录表达式被原样透传。
- 修法：`- !!js <expr>` 走标量快速路径跳过映射解析；新增 URL 目录表达式求值（基于 preset 目录算绝对路径，拒绝绝对路径与 `..` 逃逸，不做代码求值）；无法识别的 `!!js` 键/项一律丢弃并告警，绝不把非字符串值交给宿主；注册前对 `customSkillDirs` 再做一次类型兜底校验。

## [0.13.13] - 2026-11-27

### 变更

- **子代理不再注册档位预设**：`cohub-subagent-readonly` / `-readonly-net` / `-write` / `-write-shell` 四个预设不再注册，Agent 预设列表里不再出现这些内部项。子代理改为继承父组合，由 spawn 后的 `tools.restrict` 按档位裁剪工具。
- **工具裁剪改为 fail-closed**：`restrict` 失败时该次派发直接失败并释放子代理，不再降级为全量工具（此前 fail-soft 会放行子代理拥有父的全部权限）。
- 保留 `cohub-cordis` 预设：它提供父组合没有的 `tool-cordis` 类工具，`restrict` 无法凭空添加，只能靠 preset 继承。

### 说明

- 升级后 Agent 预设自定义组只剩：`co-orchestrator`（开发团队）、`cohub-team-writing`（写作团队）、`cohub-cordis`。
- 若 profile patch 里仍有历史 preset 声明，请升级到 0.13.12+ 后手动清理并重启，否则会与运行时注册冲突。

## [0.13.12] - 2026-11-27

### 变更

- **预设注册统一走运行时**：停止把 preset 声明写入 profile 的 `cordis.patch.yml`，唯一来源改为插件启动时的 `ctx.agentPresets.register()`。
- 背景：patch 声明在插件之前加载，同名 id 会抢先注册，导致运行时注册无法覆盖——改名、改工具集都不会生效。本版起不再产生这份副本。
- `presets/profile-patch-presets.yml` 已废弃（保留文件仅作迁移说明）；`installPresets` 仍控制 preset 资源目录的复制。
- 升级后若 profile patch 里仍有历史 preset 声明，建议手动移除并重启（声明与运行时注册同 id 会冲突）。

## [0.13.11] - 2026-11-27

### 变更

- **`co-orchestrator` 升级为「开发团队」**：预设 id 保持不变（旧会话与默认设置继续可用），显示名改为「开发团队」，承载 12 个子代理与团队限员；不再单独注册 `cohub-team-dev`，消除两者功能重复。
- **内部预设弱化沉底**：4 个档位预设（`cohub-subagent-*`）与 `cohub-cordis` 的名称统一加「内部 ·」前缀、描述标注「内部工具集，供 cohub 编排自动选择，请勿手动选择。」、`order` 统一 900，避免与真正的团队预设混淆。

### 说明

- 本版包含 0.13.10 的全部内容（stall 告警分级、错误文本脱敏、死代码清理）。0.13.10 未对外发布（tag 仅存在于本地且已作废）。

## [0.13.10] - 2026-11-27

### 新增

- **停滞检测分档可配置**：新增 `stall.advisorySignals`（默认 `["S2","S3"]`，置空数组即退回旧行为，所有信号都直接中止）与 `stall.advisoryMaxMs`（省略时默认 `idleMs × 2`）。
- **S2/S3 降级为告警**：S2（无事件空转）与 S3（推理多不行动）不再直接中止，改为经 `logger.warn` 输出告警，含档位、静默时长与升级上限；S1（连续同类错误）与 S4（循环）保留直接中止。

### 变更

- **清理 `delegate.ts` 死代码**：移除不可达的 `"run error:"` 兜底分支与死变量 `lastRunError`。
- **错误文本脱敏**：新增 `maskSecrets`，对 `sk-*`、`Bearer *`、`api_key`/`token`/`secret`/`password` 键值与 URL 查询串值做掩码，执行顺序为「单行化 → 脱敏 → 200 字截断」。
- **收紧测试断言**：`client-runtime` 测试中的恒真断言改为真校验。

## [0.13.9] - 2026-11-26

### 变更

- **设置页移除「CoHub 代理模型」全局区块**：它按角色列出的供应商/模型/推理强度与角色详情里的「运行模型」重复，现在模型配置统一在角色详情里做。
- **子代理失败时透传真实错误详情**：新增 `describeFailureDetail` 剥掉框架错误外壳（error → errorMessage → failure → message → cause，防环、空白折行、超长截断），单发与批量两条失败出口接入。
- **批量路径记录 per-task 真实完成时刻**：避免队头阻塞把后续 task 的 `endedAt` 拉高。

## [0.13.8] - 2026-11-25

### 新增

- **内置团队**：随插件提供两套团队并注册为 Agent 预设——`cohub-team-dev`（开发团队，队长 co-orchestrator，含 12 个子代理）与 `cohub-team-writing`（写作团队，含 co-writer / co-editor / co-outliner）。
- 设置页团队区块**先列内置团队**（带「内置」徽标、成员数、队长、档位分布、预设 id），不可编辑或删除，支持「复制为我的团队」后改成员与队长。
- 内置团队同样受团队限员约束：在其预设下只能派该团队成员。

## [0.13.7] - 2026-11-25

### 新增

- **团队 = Agent 预设**：每个团队在运行时注册为一个 DSH Agent 预设（`cohub-team-<id>`），在原生「Agent 预设」选择器里选它即可开局；增删改名实时同步，无需重启。
- **团队限员**：`delegate` / `delegate_batch` 按当前会话预设判定团队，越界角色会被拒绝并列出可用成员。
- **团队队长（lead）**：团队可指定任一成员担当主代理，运行时按队长角色说明注入主代理提示词，调度纪律保留。
- **角色模板新建**：新建角色可先选 16 个内置角色（含通用编排主代理 `co-orchestrator`）作为模板，自动填充名称/描述/提示词/工具。
- **角色自由绑定工具**：按分组勾选具体工具，档位降化为快捷组合；每角色独立工具集。
- **角色模型路由 UI**：可单独为角色指定供应商/模型/推理强度/最大输出（写入 `Config.skills`），内置角色也可配。
- **团队预设 id 可手填**，避免中文团队名折叠为 `cohub-team-team`。

### 修复

- 团队预设原先只增不减、改名不同步（释放路径在真实宿主返回对象形态句柄时失效）；现在删除/改名都会正确注销与重建，并增加 `[cohub/team-preset]` 日志。

## [0.13.6] - 2026-11-25

### 变更

- **预置（agent preset）改为运行时注册**：插件在 `apply()` 内直接 `ctx.agentPresets.register()`，注册后立即挂载、当场可用；新增或调整档位 preset 不再依赖「写进 profile patch 等下次启动加载」。
- 保留 profile patch 写入逻辑作为兼容备用（由 `installPresets` 控制），运行时注册失败时自动回退。

### 修复

- 修复 `cohub-subagent-write-shell` / `cohub-subagent-readonly-net` 报 `Unknown agent preset` 的问题——根因是声明由插件启动时写入 patch，而 patch 的加载早于插件启动。
- `!!js` 平台门控表达式按当前进程安全求值（不使用 eval），避免把 `disabled: 'process.platform === "win32"'` 这种非空字符串当 truthy 而误禁工具。

## [0.13.5] - 2026-11-25

### 新增

- **团队组装**：`Config.teams`（团队容器，含 id/name/description/members）+ `Config.activeTeam`（当前团队）。设置当前团队后，`delegate` / `delegate_batch` 只允许派该团队成员，越界会明确报错并列出可用角色。
- **角色详情**：设置页可展开查看每个角色的工具档位、brief 提示词、**完整技能正文**、以及绑定工具清单（中文名 + 平台门控 + 插件名）。
- **团队视图**：设置页重构为「团队 + 角色库」双区块；团队卡片显示成员档位分布（如 `rw-shell ×1、ro ×2`）。

### 修复

- 角色卡片标题不显示角色名、一律显示「未命名角色」（原实现只判空串，`undefined` / 纯空格被误判为有名字）。
- 角色目录数据改为构建期生成 + 构建时拼接，避免 87KB 数据污染客户端源码。

## [0.13.4] - 2026-11-25

### 新增

- **用户自定义团队（自定义子代理角色）**：`Config.customRoles` 支持在设置页自行增删改角色（名称/职责/提示词/工具档位），保存后约 1 秒热生效，无需重启。
- **工具档位**：`ro` / `ro-net` / `rw` / `rw-shell` / `cordis` 五档，映射到独立 preset；新增 `cohub-subagent-readonly-net` 与 `cohub-subagent-write-shell` 两个档位 preset。
- **预置写作组**：新增 `co-writer` / `co-editor` / `co-outliner` 三个内置角色（内置角色达 16 个）。
- **设置页「自定义团队」编辑器**：列表 / 新增 / 编辑 / 删除 / 前端校验（kebab-case、内置重名、非空）。

### 变更

- **派发层按档位决定工具与 preset**：内置角色行为逐字不变（有 13 角色向后兼容对比断言）。
- **preset 声明自动写入**：安装/升级时幂等写入 profile patch，冲突时保留用户版本并告警。
- **可观测**：自定义角色注册/注销/跳过增加 console 日志。

## [0.13.3] - 2026-11-24

### 变更

- **结果预算：取消 co-planner 的 1500 字符硬上限**——方案正文不再被中段截断（co-planner 跑在只读 preset，无法自行落盘，硬压只会丢信息）。
- **取消子代理字数自我压缩契约**：explorer / fixer / orchestrator 不再要求输出 ≤3000 字符；超长由宿主自动落盘并返回 locator，主代理直接回读。
- **调整 spill 使用指引**：全文完整保存在 locator 文件，主代理需要明细时直接 read。

## [0.13.2] - 2026-11-24

### 变更

- **orchestrator 技能：delegate_batch 增加「skill 首键」构造约束**：每个 task 按 `skill` → `id` → `prompt` 顺序写，闭合前默数三键，防止长 prompt 挤掉必填键导致整批校验失败。

## [0.13.1] - 2026-11-17

### 修复

- **模型路由的三处静默降级现在会在返回文本里明确提示**：`provider` 未注册、未配 `model`（回退到目录首个）、推理强度不被模型支持——这三种情况此前只落 `logger`，调用方只看到「跑出来的模型和配的不一样」，无从判断是配置没写到还是被静默改写。现新增可选 `onDegrade` 回调，`delegate` 与 `delegate_batch` 两处调用点均已接入（batch **按 task 隔离**，一条降级只归到出问题的那一项，不牵连同批其它 task），每条降级说明写明**配置值、实际生效值、可用清单**：provider 未注册 → 说明该 skill 的 provider/model 全部未生效、子代理继承父会话模型，并列出当前可用的 provider；未配 model → 说明已回退到哪个模型；推理强度不被模型支持 → 说明该强度已丢弃、按模型默认档执行，并列出模型支持的档位。新增 `test/route-degrade.ts`（35 条断言）覆盖三处降级与「默认零噪音」路径，`test:all` 由 26 项增至 27 项。对使用者的影响：模型没按配置生效时，返回文本直接给出原因与可选项，不必再翻日志反推。**未触发降级时无任何提示，默认行为不变**——`onDegrade` 缺省时返回值、日志与返回文本与 0.13.0 逐字节一致。**已知未覆盖**：provider 目录本身不可读、模型完全不暴露强度档位这两种情况仍只有日志。

## [0.13.0] - 2026-11-17

### 新增

- **派发前双写契约自检与 `TypeError` 归因**：新增 `src/contract-probe.ts`。子代理 spawn 之前先在本地校验「双写契约」是否成立——`parent` / `prompt` 须同时写在 `spec` 顶层与 `spec.request`（两代宿主各自只读其中一层），缺字段当场给出可读错误，而不是等宿主在启动阶段抛裸 `TypeError`；若宿主仍先行抛错，则把症状翻译成四段式归因（契约缺失 / 宿主版本漂移 / 插件侧读取位置 / 未知），并完整保留原始 message 不吞栈。该模块**不发起任何探测式调用、不真 spawn**，纯本地静态校验。对使用者的影响：宿主契约再迁移时，失败信息直接指出是哪一段契约没对上，不必再从 `Cannot read properties of undefined (reading 'id')` 反推。**默认常开**：属派发前本地自检、无独立开关，也不产生额外宿主动作与调用。
- **任务粒度自检运行时化**：新增 `src/granularity.ts`，把技能里「单包粒度上限」的提示词自律落成可执行校验：`delegate_batch` 的每个 task 可选传 `scope: { demands?, domains? }`，当可独立判定诉求 >3 或模块域 >2 时，**该 task 单独**落 error 并回传拆分建议（点名超了哪一项、按上限算需拆成几包），同批其它 task 照常执行、不受牵连；非法值（`NaN` / 负数 / 非整数 / 空串域名）按「未声明」处理，不误伤。对使用者的影响：把多件事塞进一个包会在派发前被拦下并给出拆分方案，而不是让子代理在一轮里做多个决策、失败后无法归因。**默认不校验**：不传 `scope` 时行为与旧版完全一致，需在 `cordis.patch.yml` 的 `cohub.skills` 项里显式传 `scope` 才生效。
- **task 级进度事件与时间线**：`delegate_batch` 的每个结果条目新增 `startedAt` / `endedAt` / `durationMs` / `runId`，并新增顶层可选 `events` 数组承载同一批 task 级事件；返回文本新增「## task 时间线」段，**排在预算裁剪之后**（先裁剪后渲染，时间线不会被预算裁掉）。`startedAt` 缺失时整组时间字段一并省略，旧调用与测试桩行为零变化。对使用者的影响：批量委派的时间分布可读，长尾 task 与「名为并行实为串行」一眼可见；程序化调用方从 `events` 取结构化事件，无需解析文本。**默认常开**：纯增量字段与新增段落，不改任何既有字段语义。
- **角色级输出契约**：新增 `src/output-contract.ts`，为 12 个角色各定义一份输出 JSON Schema 子集，分 `off` / `lite` / `strict` 三档：`lite` 注入契约段 + 校验，违约只标记不改写；`strict` 在此基础上对违约重写一次，且**仅当结果 <8000 字符才重试**（避免把长输出整段再喂一遍）。对使用者的影响：需要结构化回收结论时可按路由逐条打开，收到的子代理结果可校验、格式稳定；默认档位不动，无契约的旧用法不受影响。**默认 `off`**（不注入、不校验、不重写）：需在 `cordis.patch.yml` 的 `cohub.skills` 项里为该路由配 `outputContract: lite|strict` 才生效；非法值一律归一到 `off`。

> 上述四项中，粒度自检与输出契约为**默认关闭、需显式配置**：在 `cordis.patch.yml` 的 `cohub.skills` 项里配 `outputContract: lite|strict`，或在调用 `delegate_batch` 时给 task 传 `scope`，对应能力才开始介入；不配置则运行时行为与 0.12.1 保持一致。派发前契约自检与 task 时间线为常开的增量能力，无开关。

### 变更

- **测试门禁扩容**：新增 4 个测试文件（`test/contract-probe.ts` / `test/granularity.ts` / `test/output-contract.ts` / `test/batch-events.ts`）共 262 条断言，`test:all` 由 22 项增至 26 项并全绿；新增 `makeSubagentReceipt` 工厂统一子代理回执桩，替换各测试文件里散落的裸对象构造。对使用者的影响：四项新能力的行为都有回归覆盖，其中「默认 off 时 prompt 与旧版逐字节一致」这一条被单独断言守护，后续改动破坏默认档静默性会被门禁直接挡下，不会悄悄改变既有编排结果。

## [0.12.1] - 2026-11-17

### 修复

- **委派工具在 DSH `0.2.2-rc.3` 上直接抛 `TypeError: Cannot read properties of undefined (reading 'id')`**：宿主 `startActivation` 契约在 0.2.2-rc 系列发生迁移，`parent` 由 `request.parent` 迁到 `spec` 顶层。`delegate` / `delegate_batch` 仍按旧位置读取，拿到的 `parent` 为 `undefined`，子代理启动阶段即崩，整次委派失败。现改为**顶层 + `request` 双写**：在 `spec.parent` 总写，且当宿主仍携带旧字段时保持 `request.parent` 同步，同一份代码在 `0.2.2-rc.1` 与 `0.2.2-rc.3` 上都能正常启动子代理。对使用者的影响：在 `0.2.2-rc.3` 宿主上委派不再一调用就崩，升级宿主无需降级插件。
- **`delegate_batch` 把派发前异常静默吞成「0/N 完成 0.0s」**：整批在派发前就失败时（上述 `startActivation` 抛错、参数或预设装配异常等），返回摘要只报零完成与 `0.0s`，错误本身被丢弃，调用方无从判断是「全部失败」还是「压根没派出去」。现改为把该异常落成一条带原始错误信息的 error 结果条目回显，摘要与实际失败一一对应。对使用者的影响：批量委派失败时能直接看到原因，不需要再去翻日志反推。

### 变更

- **测试类型债清零并纳入门禁主链**：`test/` 的 TypeScript 类型错误由 141 个清零到 0——新增 `test/types/test-stubs.ts` 统一桩工厂（`ToolRunContext` / `SessionId` / `SessionHeader` / `SubagentRun` / `StubFileSystem`），7 个既有测试文件改用工厂，并删掉宿主已不再提供的 `persona` / `toolFilter` 字段；新增 `test:all` 聚合入口。`typecheck:test` 的 `include` 由「只枚举迁移涉及的 7 个文件」扩到 `test/` 全量，以 `allowJs` + `checkJs: false` 处理按设计从构建产物加载的 `../lib/index.js`；`bun run typecheck` 主链由 `src && 0.2` 扩为 `src && 0.2 && test`。对使用者的影响：测试代码与 `src` 同受类型门禁覆盖，契约迁移类回归在类型检查阶段即暴露，不必等到运行期；合并前跑 `typecheck` 即覆盖全链。

## [0.12.0] - 2026-11-06

### 新增

- **委派粒度对称约束（单包粒度上限）**：`skills/orchestrator.md` 与 `skills/planner.md` 同步补入「单包粒度上限」——可独立判定的诉求 ≤3 个、涉及模块或子系统域 ≤2 个、跨模块交叉比对与多条件合成判定一律禁止入包；派发前的任务书须填写「粒度自检」行，写明诉求数、域数与是否含交叉比对，缺填即视为派发前检查未完成。对使用者的影响：子代理拿到的包不再需要跨多个域做合成判断，超限时在派发前被拆开，而不是在子代理里半途折戟。
- **拆分维度优先级与跨包汇总归属**：明确以「按证据集聚类」为默认拆分维度（同一组证据、同一文件集合的诉求归入同一包），**禁止按文件数拆分**；跨包得到的结论统一由编排者汇总，不要求任何单个子代理掌握其他包的结果。对使用者的影响：切分方式从「凑够数量」变为「跟着证据走」，重复读取与结论拼接的歧义同时减少。
- **对称违规声明**：拆分不足（包内超出粒度上限）与拆分过度（同批文件被多个包重复读取）明确并列为同类违规，两者都须在派发前自检中发现并修正。

### 变更

- **`maxParallelBatch` 默认值由 3 提升到 5**：`src/index.ts` 的 schema 默认值、`delegate_batch` / `delegate` 的兜底值与工具描述、内置 presets、README 示例已同步。对使用者的影响：同一批可并行的子代理更多，长链编排墙钟时间下降；并发压力相应上升，需要收紧时可在 `schedule.maxParallelBatch` 显式配置。
- **信息收集口径改为「包数 = 证据集数」**：原「总子任务 ≤3」的一刀切上限取消，改按证据集聚类后的包数决定；T2 分档允许在证据集 >2 时突破「≤2 个 explorer」的限制。对使用者的影响：证据天然分散的大任务不再被迫压成 3 个子任务，探索覆盖面完整。
- **并行度建议区间由「每批 2-3」调整为「每批 3-5」**：与新的默认值及包数口径对齐。

## [0.11.1] - 2026-11-06

### 修复

- **移除 preset 中已废弃的 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 挂载行**：该子路径导出在 0.2.2-rc 已删除，preset 继续挂载会导致宿主加载报错；`list_agents` 工具由主插件 `tool-subagent-control` 自动注册，无需单独挂载。受影响的 preset：`co-orchestrator`、`cohub-cordis`。

### 变更

- **最低支持宿主版本抬升至 DSH `0.2.2-rc.1`**：`@deepseek-ai/dsh-*` 的 peer range 由 `^0.2.0-rc.2` 改为 `^0.2.2-rc.1`，devDependencies 精确固定 `0.2.2-rc.1`。改用 `^0.2.2-rc.1` 而非沿用 `^0.2.0-rc.2` 是必需的：`^0.2.0-rc.2` 按 npm 的 prerelease 元组规则只匹配 `0.2.0-*`，匹配不到 `0.2.2-rc.1`；新区间仍以 `0.2.2-rc.1` 为下限，低于它一律拒绝。`@deepseek-ai/cordis` peer `^4.0.1` 与 `@deepseek-ai/schemastery` peer `^3.18.4` **保持不变**（区间已覆盖宿主内置的 cordis 4.1.0 与 schemastery 3.19.0，且两者非 prerelease，不存在元组匹配问题）。对使用者的影响：**行为不兼容变更**——宿主低于 `0.2.2-rc.1` 时将因 peer 冲突无法安装，需先升级 DSH。

### 文档

- **README 依赖表 schemastery peer 修正**：兼容性一节原写 `schemastery` peer `^3.18.1`，与 `package.json` 实际的 `^3.18.4` 不符，现已对齐。
- **README 前置条件同步至 `0.2.2-rc.1`**：原文写「宿主 DSH ≥ `0.2.0-rc.2`」，与新的 peer range 自相矛盾，已改写为 `^0.2.2-rc.1`；同时补明该版本为 prerelease（dist-tag `next`）以及宿主自身要求 Node ≥ 24.9.0，并说明 per-child `agentPreset` 所需的 `0.2.1` 已被新下限涵盖。
- **组合创作技能的 workflow 示例修正**：`presets/cohub-cordis/skills/editing-cordis-compositions/SKILL.md` 中的示例原写 `dsh-workflow-worker-thread`，该名称在宿主运行时不提供，已改为实测存在的 `dsh-workflow-ptc`。
- **技能补充 preset 布局形态与并发写风险说明**：`skills/cordis.md` 注明 `~/.dsh/.agent-presets/<id>/agent.cordis.yml` 属目录式 preset 布局，新版宿主另支持 `dsh-agent-preset` 声明行，动手前须先确认目标 preset 是哪种形态；`skills/orchestrator.md` 把 `~/.dsh/.agent-presets/**` 列入需要标注并发风险的配置类文件（cohub 自身会重装、宿主亦可能回写），并要求改完复查全量 diff 而非只看目标行。

## [0.11.0] - 2026-11-04

### 修复

- **停滞检测不再误杀慢思考子代理**：S2「无结果空转」原先以「距上次工具结果」计时，且完全忽略 `text-delta` 与长命令执行期，导致「先读上下文再写长方案」的规划类任务与带构建验证的任务被结构性中断（实测空转 188s–957s 后被 abort）。现将 tool/call、tool/result、reasoning-delta、text-delta 四类事件统一刷新活动时钟，S2 改为只判「最近任意活动」。对使用者的影响：长时间思考或执行长命令的子代理不再被误判中止。
- **`volatileSchema` 返回类型失真**：原签名标注返回 `T`，抹掉了 `.volatile()` 产物的 `Volatile<T>` 信息，导致 `typecheck:0.2` 的契约夹具报 4 条 TS2741（运行时一直正确）。现改为推导 `.volatile()` 产物类型。对使用者的影响：类型检查恢复全绿，无运行时行为变化。

### 变更

- **`delegate_batch` 增加 skill 白名单校验**：原先拼错 skill 名（如 `analyze`）会被静默降级为 `co-fixer`，且返回标签不带任何兜底标记，调用方无从察觉。现改为：非空但无效的 skill 名使该 task 单独返回 error 并列出全部合法值，同批其它 task 不受影响；空串/缺失仍保留原兜底行为。对使用者的影响：**行为不兼容变更**——拼错 skill 名将明确报错而非静默执行。
- **`delegate_batch` 参数描述补全**：`tasks` 与 `skill` 的 description 现明确写出「每项仅接受 id/skill/prompt 三个字段」及 13 个合法 skill 值。对使用者的影响：调用方在调用前即可看到正确形态，减少因字段名拼写错误导致的整批校验失败。

### 文档

- **orchestrator 技能新增「通道前置检查（bootstrap 检查）」**：当待修对象与执行工具是同一套基础设施时，先派极小探针验证通道可用，连续 2 次基础设施类中止即停手止血而非继续委派；并记录「raced abort（result 未结算）不代表子代理未执行，须用 git status/diff 核对落盘副作用」。

## [0.10.5] - 2026-11-02

### 修复

- **前台委派中止后仍卡在等待**：`delegate` 原先直接 `await run.result`，用户点停止后即便中止信号已触发，调用方仍要等子代理自己停下来才返回，表现为「点了停止没反应」。现在把 `run.result` 与 abort 竞速，中止时先释放（abort）子代理、再返回中止结果。对使用者的影响：停止立即生效，不再有数秒到数十秒的等待。
- **主代理已停、后台子代理还在跑**：后台委派的取消控制器此前没有绑定父轮次的 `exec.signal`，父轮被中止后后台子代理成孤儿继续消耗。现在 `cancelAc` 绑定父轮信号，父轮停止即连带杀掉后台子代理。
- **无信号时静默免疫中止**：原实现会造一个永不 abort 的哑 signal 作为兜底，等价于让该次委派彻底无法被中止，且无任何提示。现移除该兜底，无 signal 时改为打印告警，让「为什么停不下来」变得可查。
- **中止被误记为失败**：中止归因判断漏了 `outerSignal?.aborted`，经由外层信号触发的中止会被当成普通失败记入结果与日志，误导排查。现已补判。
- **`delegate_batch` 同类问题**：同步补齐前台竞速收回、幂等 `dispose`（并显式吃掉 `dispose` 的 rejection，避免未处理拒绝）、超时文案改报实际耗时（此前报的是配置上限而非真实等待时长）。

  > 保留既有契约：入口前已中止的 signal 仍会 spawn 并原样转发，由子代理侧结算，不做短路——这样中止的判定与回收责任始终留在子代理一侧，避免入口处提前返回与子代理真实状态不一致。

## [0.10.4] - 2026-10-30

### 修复

- **委派给未知 skill 名会继承 orchestrator 全量工具面**：`delegate` 传入无法识别的 skill 名时，兜底逻辑退回 orchestrator preset，子代理因此在只该写文档或改代码的场景里拿到了编排者的全部工具。现在兜底收窄为 write preset，并把兜底原因写进返回文本。对使用者的影响：skill 名拼错不会再把超出所需的权限交给子代理，且从返回结果就能看出发生了降级。
- **降级提示中回显的 skill 名会破坏提示结构**：skill 名是调用方自由填写的字符串，带换行、超长内容或半角方括号时会撑破提示的单行形态与 `[...]` 结构。现在回显前统一归一：只取首行、连续空白压成单个空格、截断到 80 字符、半角方括号转全角。
- **`delegate_batch` 降级提示中回显的 taskId 会破坏提示结构**：原因同上（换行／半角方括号／超长），现同样走归一，上限 40 字符；`task.id` 的原始值在结果映射等处不受影响。

### 变更

- **无法判定委派深度时改为按兼容策略放行**：深度守卫在三处候选（`header.delegationDepth`、`options.subagentDepth`、`session.delegationDepth`）全部缺失或非法、且 `header.origin` 非 subagent 时，曾改为 fail-closed 直接拒绝，实测宿主元数据缺口会连带瘫痪整条编排链，故回滚为 fail-open：warn 后放行。同时保留诊断 warn，打印四个候选的原始值与 `typeof`，便于区分「元数据缺失」与「类型写错（如字符串 `"0"`）」；拒绝文案也补了对应提示。`depth=0` 放行、`depth>=1` 拒绝、`origin` 为 subagent 时兜底为 1 仍拒绝这三条不变。

## [0.10.3] - 2026-10-28

### 变更

- **`/cohub-review` 改为阻塞式执行，跑完直接返回结果**：此前命令立即返回「正在生成报告…」后转入后台，分析完成或失败都不会再通知，用户只能自己去报告目录翻找。现在 handler 会等待分析结束再返回，结果文本直接包含报告路径、结论条数与分类分布、子会话覆盖情况与耗时；失败时返回错误详情与错误日志路径而不是静默失败。对使用者的影响：命令会占用几十秒才返回（实测期间不影响会话内发消息、不阻塞其他操作、无网关超时），换来的是跑完立刻知道结果落在哪、有没有成功。
- **`--no-llm` 仍为秒级返回**：只做统计不调模型的路径不受影响。

### 修复

- **取消分析会产出残缺报告并报成功**：读根会话、发现子会话、读取子会话这几步都有「失败就地降级」的异常处理，会把取消信号产生的 AbortError 当作普通读取失败吞掉，继续用残缺数据生成报告，最后返回成功。对使用者的影响：现在取消会真正中断并返回失败状态，不再产生看起来正常、实际缺数据的报告。
- **外部取消信号未被接入**：命令的取消信号此前没有传入分析链路，只有内部的 60 秒超时会生效。现在两者合并，任一触发都会中断，且监听器在结束时清理。

## [0.10.2] - 2026-10-28

### 修复

- **复盘报告会静默丢弃超量的子会话，却声称覆盖完整**：发现子会话时存在 50 个的硬上限，超出部分直接丢弃，且不写进缺口列表、也不影响「覆盖完整」的结论。实测某个 32 轮的会话产生了 109 个子会话，报告只分析了前 50 个（漏掉 54%），却仍显示为完整覆盖。同时取样顺序按遍历序（早期先取），导致近期的修复与交付会话反而被挤掉。现在改为全量收集后按创建时间倒序取样，并在报告首页明确显示「已分析 N / 共 M 个子会话」。对使用者的影响：**报告里的会话数会比以前大**（以前是被截断后的数字），且会如实标出取样比例；此前基于旧报告得出的「某会话消耗不大」之类结论可能低估，建议重新生成。
- **读取失败的子会话未计入不完整**：原先只有取样截断才算不完整，若取样范围内有子会话读取失败（如文件损坏、持久化校验不通过），报告仍会宣称「全部 N 个子会话」已覆盖。现改为按「实际分析数 < 血缘总数」判定，两种情况都会如实标注。
- **根会话可能被重复计入子会话数**：真实数据中根会话 id 带 `session-` 前缀而子会话为裸 uuid，原先按原始字符串比较无法识别同一个会话，导致血缘总数多算一个。现引入 id 归一化比较。
- **删除从未生效的子会话查询退化路径**：该路径的调用签名与宿主接口不符（传对象而接口要求数组），每次触发都落进异常分支，从未产出过结果；且其单次调用成本等同于一次全量会话列举，保留反而会在修好签名后变成性能隐患。
- **血缘遍历存在深度 8 的隐性截断**：原实现超过 8 层即静默停止，深层子会话会被无声丢弃。现改为 64 层（仅防栈溢出），并在计数上如实反映。

### 变更

- **`coverage` 新增会话集合覆盖字段**：`lineageTotal`（子会话血缘总数）、`sessionsAnalyzed`（实际分析数）、`sessionsTruncated`（是否不完整）、`samplingNote`（取样规则）。四个字段均为可选，`schemaVersion` 保持 1。对使用者的影响：报告首页与索引都能直接看到覆盖比例；旧报告没有这些字段时显示「未知」，不再暗示完整覆盖。
- **拆分「事件流完整性」与「会话集合覆盖」两个维度**：原先的「采集完整性：complete（所有目标会话已读至末尾）」把两件事混为一谈。现在分别显示，两者可同时成立（例如事件流完整、但子会话有取样截断）。
- **报告新增快照边界提示**：覆盖范围章节顶部明确「根会话截至 seq N，此后的 turn 与委派需重新生成报告」。

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
