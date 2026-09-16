# 极简模式分析与 cohub 优化决策记录

## 1. 背景
用户观察到 DSH 的「极简模式」下模型能力"巨幅提升"，且模型思考中几乎不出现 "let me ..." 这类元叙述。本文记录对极简模式的分析结论、其能力提升的机制解释，以及据此对 dsh-cohub 插件所做的优化决策与依据。

## 2. 极简模式是什么
- 定义：仅 2 个工具（持久 bash + str_replace_editor）+ 固定一句话 persona（"You are a helpful software engineer assistant."）+ 无上下文压缩 + 不注入运行时上下文快照。
- 官方公开口径：用于在最小环境里基准测试模型（benchmarking models in a minimal environment）。
- 官方内部定位（Agent Notes）：minimal preset 是「与 Claude SWE 兼容的 RL agent」的完整组合——官方原句 "The shipped Web `minimal` preset is the sole Web owner of the RL agent composition" / "owns the complete RL agent composition"（完整拥有 RL agent 组合，而非仅占其一）。
- 对照（standard 预设）：约 25–26 个模型可见工具（平台相关：bash/pwsh 二选一、read_image 视 attachments 挂载、subagent_codex/subagent_claude_code 默认禁用），常驻约 15 段系统提示词。

## 3. 为什么强（四项机制 + 边界）
1. RL 分布匹配（最根本）：模型很可能在双工具动作空间上做 RL 训练/偏好对齐；极简模式让推理分布 ≈ 训练分布。官方原文出现 "action space" 与 "match the intended training runtime"。
2. 认知负荷收窄：工具多 → 每步多一层"选工具"决策 + token 开销 + 出错面；收敛到双工具后选择退化为几乎无成本的二分（跑环境 bash / 改文件 editor），推理预算回笼主链路。
3. 系统提示词纯度：complete:true 移除所有其它系统提示 token（官方 persona README：complete mode removes every other system-prompt token）。指令遵循是基准性能第一驱动力。边界：complete:true 只收敛系统提示词段，不删除工具 schema；minimal 只有 2 个工具来自预设只挂 2 个工具行。KV Cache 前缀稳定仅属成本/延迟收益，不作为能力提升论据。
4. 元能力诱惑归零：subagent/workflow/plan/goal 的工具描述本身是软指令，会诱导"为了用而用"；物理移除 = 能力限制即正则化。
- 最小完备集：bash（持久）= 图灵完备的通用执行器；str_replace_editor = 精确可验证的写入器（不匹配即报错）。两者覆盖"观察执行"与"可控变更"两条不可约能力轴。
- "不会 let me"：元叙述消失 = 决策负担下降的行为指纹（社区/用户观测，机制自洽，因果未证实；公开资料中暂无对应讨论）。
- 应对决策（消除「let me 独自做」的个体叙述）：已将 Orchestrator persona 第 1 句改为「主调度者集群」集体身份——「你是 cohub 中文智能体编排体系的主调度者集群（Orchestrator）——思考时以集群方式协作，调用不同代理集群分工处理，而非以独立个体独自完成」；这是把自我认知从「独立个体」锚定为「集群」，让模型以团队分工思维替代个体独行叙述。
- 边界（反噬场景）：长任务（无压缩→上下文溢出）、多文件大重构（无 plan 脚手架）、检索/联网/视觉、并行扇出、强安全约束。
- 压缩版本更正（M7，重要）：rc.6 与当前 master 的 shipped minimal 预设都无压缩（头注释均为 "Context compaction is absent"）；提交 86d5dd4 当时的 Agent Note 决策段确曾写 "an entry-local compaction backend"，但当前 master 的 Agent Note 已修正为 "the current preset mounts an entry-local fs-local provider and no compaction backend"；RL 压缩策略参数属于 RL 训练 harness 侧，未随附到 shipped minimal。此前"master 有 RL 压缩后端、与 rc.6 存在版本差异"是误读。

## 4. 移植到 cohub 的原则
- 不能照搬双工具：cohub 是多工具编排器，subagent/subagent_fork/workflow 是"纯调度"的核心能力面。
- 可移植：persona 纯净、提示词质量、工具面收敛（restrict）、上下文注入最小化。
- 明确不做：toolOrder（code 模式下 native 名无效）、complete:true（会抑制 run_code SDK 声明）、includeHarnessIdentity:false。

## 5. 第一波优化（已完成）
- persona 由三环改六步（对齐工作流），封堵 run_code 内 node:fs 后门，删除重复中文行（由全局 chinese.ts 单源覆盖）。
- skills/orchestrator.md 工具清单补全（含 workflow/ralph/goal/send_message/interrupt_agent），三处"禁止"合并到规则2，封堵 node:fs。
- 5 个长 skill（oracle/designer/council/fixer/rule-app）保守精简为四段式，领域知识全保留。
- 12 个 skill description 单句化（≤30 字）。
- 版本 v0.1.1 → v0.2.0；构建通过。

## 6. 第二波优化（已完成）
- 删除 tool-ralph（低频委派工具）✅
- compaction（自动压缩）❌ 已移除：用户决定不需要自动压缩，长会话不做摘要/压缩
- 新增 tokenMeter 测量点（src/index.ts，inject 加 sessionProjections，监听 session/event 输出 contextBreakdown 诊断日志）✅
- maxParallelSubCalls ❌ 未落地：审查发现全局副作用（影响所有 agent）+ 可能被后置 patch 覆盖失效 + YAGNI，且追加时引入 YAML 缩进错误（P0），已删除该覆盖，保留默认 10。

## 7. 第三波：工具代理（工具与推理分离）

### 背景
用户实验发现：模型使用工具时推理能力下降（工具上下文本身抑制推理深度）。据此把「工具执行」与「深度推理」分离：推理型代理保持无工具的纯净上下文，工具操作统一交给专门的工具代理。

### 已落地（软约束版）
- 新增 co-tool 工具代理（第 13 个 skill）：唯一持有文件/命令操作（node:fs + child_process），补输出截断（8000 字符）、二进制 base64、命令超时（300s）/退出码约束。
- 11 个专职代理去工具化：职责改为「决策/方案/分析」，文件读写/搜索/构建/测试统一 delegate 给 co-tool。
- delegate 工具：按 skill 路由 provider/model（DSH settings 配置 `cohub.skills` 热更新，`cordis.patch.yml` 的 `config.skills` 作为组合层默认值（base））、自动拼 skill 完整指令、中性 persona 覆盖（避免子代理继承调度者的「绝不亲自操作」persona 冲突）。
- provider 可用性校验：委派前用 `ctx.llm.listProviders()` 查已注册供应商，动态判断可用性。
- 兜底：provider 未配置或不可用（不在注册列表）→ 不传 `agentOptions` → 子代理自动继承会话模型，不报错。
- 配置示例（settings.yaml）：
```yaml
# settings.yaml
cohub:
  skills:
    - { name: co-fixer, provider: deepseek-official, model: deepseek-v4-flash }
    - { name: co-oracle, provider: anthropic, model: claude-sonnet-4 }
    # 未配置的 skill 继承会话模型
```
- 数字对齐：13 技能（12 专职代理 + orchestrator）。

### 物理隔离结论（关键，诚实记录）
- 调研发现：cohub 的文件操作实际经 run_code 的 node:fs（mode:code），而 node:fs 是 worker-thread 的固有 JS 能力，**不归 sandbox / toolFilter 管辖**（toolFilter 只管「工具」，管不到 run_code 内部 API）；官方源码明言 run_code 隔离是「containment, not a security boundary」。
- DSH sandbox 只有 read-only（只拒写、读全盘放行），无「无文件访问」模式；SubagentStartRequest 无 sandbox/preset 字段，子代理只能继承父 preset。
- per-child preset/mode 切换 DSH 不支持（spawn 硬编码 composeFrom 继承父 preset；recompose 有竞态与日志失配风险）。
- 结论：**物理隔离在 cohub 插件层面不可行，需改 DSH 源码**（给 ChildComposition/SubagentStartRequest 加 preset 字段并让 applyChildComposition 走 mount）。按用户决策接受软约束。
- 软约束的实际效果：省工具 schema（对「工具抑制推理」有部分缓解）；但 node:fs 挡不住，数据隔离未达成。

## 8. 关键来源
- 官方 Agent Notes（deepseek-ai/deepseek-harness 仓库 .agents/notes/implemented/）：
  - 2026-08-10-minimal-preset-owns-rl-composition.md
  - 2026-08-11-minimal-profiles-bare-two-tool-runtime.md
  - 2026-07-29-persistent-bash-str-replace-editor.md
  - 2026-08-10-default-presets-single-editor.md
- 官方 persona 机制：packages/preset/persona/README.md（complete mode + KV Cache 前缀稳定）
- 官方站：https://www.deepseek.com/harness/en/（"Minimal mode keeps only a shell tool and a file editor for benchmarking models in a minimal environment."）
- 官方 API 公告：https://api-docs.deepseek.com/zh-cn/news/news260813/（"对于公开基准测试集中的 Code Agent 任务，DeepSeek-V4-Pro-0813 使用 DeepSeek Harness 极简模式作为框架进行测试（使用 max 档位，topp=0.95，temperature=1.0），其他框架下结果可能略有不同。"）
- 社区：dev.to "DeepSeek Harness Is Open Source: Everything Is a Plugin"；Hacker News 294 评论帖（作者在场但未正面回答"RL 与推理是否同一 harness"）
- Anthropic 工程博客：multi-agent-research-system（工具设计"质量>数量"："Tool design and selection are critical... each tool needs a distinct purpose and a clear description"；"most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time"）

## 9. 待办 / 未决
- "DSec 沙箱 agent 在 RL 期间用 minimal mode" 系社区粉丝号声称，未经官方确认。
- "不会 let me" 现象无公开讨论，属用户观察，机制上自洽（决策负担下降）。
- 物理隔离（推理型代理无 node:fs、co-tool 有）为 DSH 层限制，需改 DSH 源码才能实现，属独立大需求（当前未做）。
- 压缩版本差异：此前"master 有 RL 压缩后端、与 rc.6 存在版本差异"为误读；rc.6 与当前 master 的 shipped minimal 均无压缩（详见第 3 节 M7 更正）。

## 10. 2026-08-17：三项优化落地（M2/M4/M3+M6）
- ① 提示词卫生（M2）：delegate 工具描述一句化；council_session 英文多行描述改为一句中文；orchestrator.md 三处"完整指令由 delegate 自动拼接"改为"精简指令由 delegate 自动注入"。
- ② 委派上下文最小化（M4）：12 技能各新增手写中文 brief（≤300 字，含角色/关键约束/输出契约/语言要求）；scripts/generate-skills.ts 生成 brief 字段并加契约校验（缺中文即失败、>300 字告警）；src/delegate.ts 改为注入 brief（缺失回退 content 并 logger.warn）；persona 更新为"严格遵循角色定义、关键约束、输出格式与工具指令"。
- ③ 工具面纪律（M3/M6）：工具面审计结论（delegate + council_session 条件注册 + preset 调度工具面无低频/重叠需删项；workflow 与 run_code 的局部重叠为产品语义差异，保守保留）；orchestrator.md 新增"规则 4：新增能力前先问——三问不过不新增"+ 自检清单新增"是否提议新增能力"条目。
- 测试：修复 test/unit.ts 基线（补挂 @deepseek-ai/dsh-tools 修复 ctx.tools undefined）+ 新增 brief 校验与 delegate 注入 brief 断言。
- 验证：npm run build + node test/unit.ts + node test/delegate-p1.ts 全部通过。
- 备注：本次改动与并发 P1（delegate 执行器环境契约注入 + 中止/失败自动重试，见 src/env-contract.ts、test/delegate-p1.ts）叠加于同一工作树，已共存验证；物理隔离（推理型代理无 node:fs）仍属 DSH 源码层待办。

## 11. 2026-08-19：P3 三切片落地（N1 环境契约持久化 / N2 停滞检测 / N3 调度参数）

### 11.1 目标
为 `delegate` 工具在长时间 / 多批次 / 跨环境的真实部署里补工程化韧性。三切片的目标彼此独立但合并后形成完整的运行期调度层。

### 11.2 P3-1 N2 停滞检测（src/delegate.ts StallWatchdog）
- 决策：通过 `ctx.on("session/event")` 监听 session/event 全局事件总线，按 `run.id` 归属子代理事件。
- 四类噪声信号：S1 连续同类错误 / S2 无结果空转（> idleMs 且仍在产出推理）/ S3 纯推理无动作（> reasoningWithoutAction 块，期间 0 工具调用）/ S4 重复调用循环（同工具名 + 归一化参数反复 + 结果错误）。
- 触发条件组合：`S1 ∪ (S2 ∪ S3 ∪ S4)` **且**距最近一次成功工具结果超过 `graceMs`（最近成功过不触发）——防止误杀健康长任务。
- 触发后 `ac.abort()` 提前中止，复用 `delegateRetry` 重试预算（`recoverable=true`）；`recoverable=false` 则直接失败不重试。
- T3 父中止转发：通过内部 `AbortController` 把 `exec.signal` 转发到子代理；`start()` 在预中止抛错时归一为 `aborted` 走重试逻辑。
- 降级：若 `ctx.on` 缺失（无事件源），自动降级关闭，看门狗完全不介入（维持现状，不会因缺事件源而崩）。
- **默认关闭（enabled=false 保守）**——避免对未观测部署产生副作用；启用是 opt-in。
- 错误结构化：`error.cause.stall = { signals: [...], diagnostics: "..." }`；重试 prompt 自动追加停滞诊断。

### 11.3 P3-3 N3 调度参数（src/index.ts ScheduleConfig + systemPrompt 段）
- 决策：把调度参数（批大小 / 墙钟预算 / job 跟踪 / 自适应批）从 skill 文档字面量提升为可配置事实，并通过 `ctx.systemPrompt.section({ name: "cohub:schedule", order: 96 })` 注入实际生效值。
- **text 是函数**——每次 prompt 装配时动态读取当前 settings（`currentSettings().schedule`），改卡片立即生效，无需重启。
- 缺省值仅作"本环境观测值"：缺省 `maxParallelBatch=3` / `wallClockBudgetMs=600000` 是当前部署观测值，部署可调；不写死任何环境事实（与 P1 环境契约决策一致）。
- `useJobTracking`（auto/on/off）：`auto` = 有 job 能力则后台跟踪，无则前台逐批降级；不允许 force `--no-job` 类硬开关。
- `adaptiveBatch`（auto/off）：`auto` = 提示词级按本会话已观测错误/超时收放批大小（**不在代码层调度**，避免过度优化）；`off` = 固定配置值。
- 作用域：全局（子代理也可见）。文本必须极短、中性、无指令性——只报告部署参数。

### 11.4 P3-2 N1 环境契约持久化（src/env-signatures.ts EnvSignatureLearner）
- 决策：把"执行器环境契约"从每次 spawn 都探针 → 一次学习、持续使用，避免子代理每次进入新执行环境都盲试。
- 缓存路径：`dshHomePath("cohub", "env-signatures.json")`——插件自管，不依赖 settings。
- 优先级链（`pickEnvContractText`）：`delegateEnvContract.text`（P1 手工覆盖）> manual 的 `Config.contract`（静态指定）> 命中缓存（指纹一致 + TTL 内 + `confirmCount` 达标）> `DEFAULT_ENV_CONTRACT`（探针式）。
- 三态：`auto`（缺省，无缓存时与 P1 行为完全一致；累计 ≥ confirmCount 次一致签名后写缓存）/ `off`（不读不写，每次都走 DEFAULT_ENV_CONTRACT）/ `manual`（只读 manual 配置，不读缓存、不学习）。
- `confirmCount`（缺省 2）：同一归一化签名（`err:<msg>#`）连续确认后才写入，防瞬态误判。
- TTL（缺省 7 天）：到期重探，防环境静默升级（Node / OS / DSH 升级后旧契约误导）。
- 指纹 `envFingerprint()`：环境变了自动回退探针式，不依赖具体环境枚举。
- **容错**：读 / 写失败静默降级（行为同无缓存），不劣化。

### 11.5 测试覆盖（test/stall-p3.ts / schedule-p3.ts / env-sig-p3.ts）
- stall-p3：12 用例覆盖默认关闭 / S1-S4 触发 / 宽限窗口 / `recoverable=false` / T3 父中止 / 无事件源降级 → 35 PASS / 0 FAIL
- schedule-p3：缺省 / 非法 / 优先级 / 运行时解析 / N2 stall 子配置也生效 → 24 PASS / 0 FAIL
- env-sig-p3：缓存命中 / 指纹变化 / TTL 过期 / manual 覆盖 / use=off / confirmCount / 纯函数 `render` / `classify` / `pick` → 50 PASS / 0 FAIL
- 合并 P1 单测（delegate-p1.ts 28 PASS）+ unit.ts 基线，合计 137 PASS / 0 FAIL。

### 11.6 客户端 settings 卡片补 UI（src/client/index.js A 阶段，commit cb497e2）
- 此前 `CohubSettingsCard` 只暴露 `batchSize / wallClockBudgetMs / maxRetries` 三个控件，P3 schema 已声明的 12 个新字段全部无法在 GUI 配置。
- 补 4 个 useState（scheduleDraft 扩 useJobTracking/adaptiveBatch；retryDraft 扩 retryDelayMs/retryableReasons；新增 stallDraft 7 字段；新增 envSigDraft 3 字段）+ 4 个 touched + 2 个 update 函数（`updateStall` / `updateEnvSig`，通用形式）。
- 渲染层：schedule 区块补 Job 跟踪 / 批间自适应两个 select；新增 retry 区块（maxRetries + retryDelayMs + retryableReasons 逗号分隔输入 + hint）；新增 stall 区块（enabled 复选框 + 5 个 number inputs + recoverable 复选框，未启用时数字输入框与 recoverable 全部 disabled）；新增 envSig 区块（use select + ttlMs + confirmCount）。
- i18n 同步补 zh/en（25 keys × 2）。
- `discard` / `save` / `useEffect` 三处同步重置与提交；`save` 内 stall 子配置与 `delegateRetry` 合并提交，envSignatures 单独提交。
- 实测：DSH 设置 → 插件 → "CoHub 代理模型" 卡片渲染完整 12 个新控件；console 0 错误；批大小默认 30（注意：当前部署 settings 已被某次 patch 改过，缺省 3 由 code 兜底覆盖）。

### 11.7 文档与 patch 同步（cordis.patch.yml 注释块 + README 重写）
- `cordis.patch.yml` 注释块从 P1 扩到 P3 全字段：每个新字段都有"默认值 / 含义 / 部署覆盖示例"三段式注释。
- README 重写：项目名 `dsh-cohub`（不是 `dsh-port`）；构建描述补 `build-client`；配置示例补 P3 三组完整 YAML；新增「settings 卡片」「环境契约持久化」「停滞检测」「会话审计」四节；目录结构补 `src/client/` / `scripts/{build-client.js,audit-session.mjs}` / `test/*-p3.ts`；测试基线补 5 个 test 命令。

### 11.8 备注
- 本次 P3 三切片（src/delegate.ts +429 行 / src/index.ts +126 行 / src/env-signatures.ts 新文件 / test/*-p3.ts）+ 客户端 UI（src/client/index.js 新增 847 行）+ cordis.patch.yml 注释 + README 重写，叠加于同一工作树，已共存验证（测试 137 PASS、DSH 浏览器实测 0 错误）。
- 物理隔离（推理型代理无 node:fs）仍属 DSH 源码层待办，本次未动。

## 12. 第四波：编排硬化（preset 委派工具面补全 + cohub-standard 双模式 + restrict 回退）

### 12.1 背景与动机

v0.2.0 已落地 P3 三切片，但 co-orchestrator preset 仍有两个遗留问题：

- **委派工具面缺失**：原 preset 只挂 `tool-workflow`（编排多 agent 脚本），缺 `subagent` / `subagent_fork` / `subagent-control` / `list-agents` / `ralph`——主代理 spawn co-* 子代理的能力实际不可用，persona「全部委派给专职子代理」无法落地。
- **缺标准模式选项**：纯调度主代理对很多用户过严；想"直接动手 + 调度混合"的用户没有第二选择。

v0.3.0 解决上述两个问题，并尝试一个**已回退**的"运行时 restrict 物理收口"实验。

### 12.2 co-orchestrator preset 改造（presets/co-orchestrator/agent.cordis.yml）

保留 v0.2.0 的"工具不挂载 + persona 软约束"基线，**新增**：

- `delegation-subagents` group（`@deepseek-ai/dsh-tool-subagent-control` + `list-agents` + `subagent` / `subagent_fork` + `ralph`）—— 修复委派工具面缺失。
- `compaction` group（`compaction-basic` + `command-compact` + `tool-result-pruner` threshold=8192/head=4096/tail=1024）—— 防长会话爆 context。

顶部注释新增"v0.3.0 修正（修复派发）"段，说明原 preset 缺 spawn/fork 委派行、本版本补齐。

### 12.3 cohub-standard preset 新增（presets/cohub-standard/agent.cordis.yml）

骨架直接拷贝 `node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml`，仅修改 persona 段注入 cohub 中文身份与调度纪律；其余工具栈（fs / shell / web / subagent / planning / compaction / workflow / ralph）与 standard 完全一致。

**与 co-orchestrator 的差异**：

| 维度 | co-orchestrator | cohub-standard |
|---|---|---|
| 工具模式 | Code 模式（run_code SDK 包） | 标准模式（直接调工具） |
| fs/shell/web | 不挂载（persona 软约束） | 直接挂载 |
| 委派工具面 | delegate + subagent + ralph + workflow | delegate + subagent + ralph + workflow |
| 适用场景 | 长链调度 / 多模型共识 / 严格自律 | 直接动手 + 调度混合 |

两 preset 共用：12 个 co-* 技能 / delegate 工具 / cohub:language / cohub:schedule 段（host plane 注入，与 preset 解耦）。

### 12.4 已回退：运行时 restrict 物理收口（src/index.ts ⑦ 实验段）

**动机**：在 rc.6 限制（subagent 继承父 preset 工具表 + toolFilter 只能收窄）下，原想用「fs/shell/web 工具挂载让子代理继承 + 运行时 `tools.restrict({deny})` 把主代理自己收口」实现硬性隔离。

**实现**：监听 `agent/created` 事件，用 `ctx.reflect.get('agentPresets', false).composedPreset(agent.ctx)` 拿 preset id，对 `co-orchestrator` 主代理调 `agent.ctx.tools.restrict({ deny: [...] })` 把 11 个工具（read/write/edit/read_image/grep/glob/ast_grep_search/bash/pwsh/web_search/web_fetch）从主代理视图物理移除；disposer 挂 `agent.ctx.effect()` 自动撤销。

**回退原因**：实测发现主代理**无法派发任务给子代理**——症状超出 deny 列表范围（delegate / subagent / workflow / ralph 都不在 deny 列表里，但实际全部失效）。可能原因：

- `agent.ctx.tools.restrict({deny})` 在 DSH 0.1.0-rc.6 上行为与假设不符（白名单语义 / 调用抛错导致工具视图损坏 / 触发时机错位）。
- `agent/created` 事件挂载时机与主代理工具视图初始化次序错位。
- `presets.composedPreset(agent.ctx)` 返回值结构与假设不同。

由于无法联网对照 DSH 源码确认实际语义，且该路径不通过单测体系（`tools.restrict` 行为依赖宿主生命周期，模拟成本高），**选择回退该实现**——回到 v0.2.0 的「preset 不挂 fs/shell/web + persona 软约束」基线。

**教训**：cohub 工作流里"co-oracle 审查"环节本应拦下"未经验证的 restrict API 假设"——本次未走该环节。下次涉及宿主核心 API（tools / ctx / agentPresets）改动前，必须先在 DSH 主仓对应包目录下确认 API 存在与语义，或加单测覆盖，否则不准动手。

### 12.5 边界与后续候选（v0.4.0+）

- `delegation-subagents` group 已含 subagent-control / list-agents / ralph——DSH 后续若新增 spawn 后端（如 codex / claude-code 子代理 provider），preset 需对应补 disabled 块（参考 `presets/cohub-standard/agent.cordis.yml` 内已 disabled 的 `subagent-codex` / `subagent-claude-code` 写法）。
- cohub-standard preset 暂未接 cohub settings 卡片「preset mode」开关——若用户想 GUI 切换预设，可补 `installAgentPresets` 之外的安装入口。
- 物理隔离（推理型代理 ctx 无 node:fs）仍属 DSH 主仓改造范畴，本包未尝试——v0.3.0 不再假装 restrict 能接近该效果。


