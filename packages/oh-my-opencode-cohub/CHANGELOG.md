# CHANGELOG
## [1.18.5] - 2026-10-16

### 变更
- **子会话复用软预算提示（默认 200,000 输入 token）**：看板 Reusable Sessions 追加「复用建议」列，三态展示——已采样未超阈值「最近输入 N」、严格超阈值「超预算，不建议复用」、采样缺失/未知「输入未知」；仅为软提示，不强制换会话、不清空历史、不删合法 task_id，不声称自动压缩；阈值可经配置 `reuseBudget.maxInputTokens` 调整、可 `enabled: false` 关闭（关闭时看板与旧版一致）；复用条件收紧为「同一任务紧接续作且原会话上下文仍必要」，跨任务/阶段新建会话，交接只保留目标、关键结论、文件位置与未解决问题
- **captureResult 有界读取与「可确认最新」采样**：子会话结果捕获改为 limit=20 有界读取；复用采样仅当存在带数值 time.created 的 assistant、无时间缺失消息、且最大时间唯一（无并列）时写入——三字段非负有限且求和不溢出才取归一化输入（input + cache.read + cache.write），任何不确定情形一律「未知」而非 0，绝不捞旧消息回填或伪造新鲜度（sampledAt 只用消息真实 time.created）
- **摘要时间优先回退**：keyOutput 优先取最大有效 time.created 候选组的 text，乱序/并列/缺时间时稳定回退，不再误取数组尾旧消息；未知采样不破坏摘要
- **精简交接与大输出提示**：orchestrator 规则 4「上下文预算与子会话复用」——委派时先定位再定向读大文件（offset/limit/分片），完整日志/证据保留位置、回传结论与必要片段，不截断测试错误、不破坏证据；子代理输出短而足够验收即可，不机械统一字数上限，用户显式要求完整输出时按要求输出

### 修复
- build 脚本 `--external` glob 参数（如 `"@opencode-ai/plugin/*"`）加引号，修复 Windows shell 通配符展开导致的构建问题

## [1.18.4] - 2026-10-16

### 文档
- README 补齐 1.15.1 至 1.18.4 版本变更记录：
  - 编排与并行 Wave：无依赖、无共享可变状态冲突的任务同消息并行派发，Wave 仅展示依赖层次、不构成整体等待屏障
  - 上下文读取与诊断配置：`summaryReadMode`（bounded 默认 / full 可选）与 opt-in 诊断开关（环境变量 / 配置文件）的配置说明
  - 任务取消与超时：任务生命周期精确关联与真实收尾说明；后台任务超时清理为兜底例外（非依赖级联取消）
- 仅文档修订，无运行时 API / TUI / MCP 变更。

## [1.18.3] - 2026-10-16

### 变更（提示词并发语义修正）
- 移除编排提示词中默认 2-3 / 固定数量 / 强制分批的限制：无依赖、无共享可变状态冲突的任务在同一条消息中同时派发，不以任务数量/文件数量或猜测的容量预先限制（容量未知不构成串行理由）
- Wave 仅展示依赖层次，不构成整体等待屏障：任务实际前置依赖完成且无共享可变状态冲突即可派发，同次所有已就绪任务同时启动，不等无关的慢任务
- 同文件独立只读可并行；仅真实写冲突（多写）或要求特定文件版本/读取结果的读写任务按实际冲突与依赖串行，其他任务不陪等
- 保留真实 429/TPM 限流反馈处理（尊重 retry.next / Retry-After）、有限重试、后台已启动任务不重复派发、定向规则分析与已核实事实复用

仅提示词文案调整，无运行时 API / TUI / MCP 变更，无自动 DAG 调度新增。

## [1.18.2] - 2026-10-16

### 修复
- **任务生命周期精确关联与真实收尾**：`tool.execute.before/after` 按 `(parentSessionID, callID)` 精确配对，消除共享别名回退；后台任务终态不再仅凭 `session.idle` 判定，需有界读取（`session.messages` limit=10）验证最新 assistant 明确结束/失败/取消才收尾，读失败/空/无终态信号/未知 finish 一律保持 running，不假成功
  - 复用子会话：已结束历史不阻碍唯一活动归属，按调用精确终结；消息时间晚于本轮调用开始的新鲜度边界防止旧完成消息抢新调用
  - 宿主 promotion：after 原生 metadata `background:true` 精确升级后台任务（不从输出文本推断）；首次 child 绑定前的早到 idle 由 after 绑定后补一次有界核验兜底
  - 原生 subtask 失败路径：after 结果 `undefined` 不再被当作成功，保留 running/unknown 等原生精确终态；`message.part.updated` 关联优先 `(parent, part.callID)`、兼容已登记 `(parent, part.id)`，两键命中不同 alias 拒绝歧义
  - 精确取消与质量回写：`close_job` 真实取消经第 4 回调同步内部状态并精确刷新父会话；质量回写按调用快照复核，不再按子会话首条匹配旧历史
  - 内部状态机诚实镜像原生 task 生命周期，不激活自动调度/自动重试；重复注册用预检避免异常路径

### 新增
- 上下文读取 `summaryReadMode` 支持 `bounded`（默认）与 `full` 可选：`bounded` 按预算读取，每文件正文窗口硬上限 1 MiB，另读 4 字节 lookahead，超限保守截断；UTF-8 安全仅指读取窗口边界；`full` 可显式回退
- 限流/网络错误分类器（rate_limit / retryable_network / other，仅信息透传不控制原生重试）与 opt-in 任务生命周期诊断（默认关闭，字段白名单与长度截断；分类摘要不携带原始错误正文或 headers）
- 编排提示词按需增量取证与分批软策略，替代无预算的批量整读

### 测试
- 新增集成回归（隔离 HOME 子进程）覆盖：并发乱序精确配对、复用收尾/歧义、宿主 promotion、早到 idle 补核验、after undefined、part.id 兼容关联、取消与质量写回、finish 中间轮/未知值/不成功结局分类、diag 默认关闭与开启结构化记录；tracker 侧固定种子随机序列与精确 callID 命中不变量保留

## [1.18.1] - 2026-10-16

### 修复
- **修复 Background Job Board 跨会话泄漏**：`messages.transform` 注入时未向 tracker 传父会话 ID，tracker 回退到最近一次 tool hook 收到的全局父会话，导致 A 会话的 Board 注入 B 会话的任务
  - `src/index.ts`：仅当 `sessionID` 为非空字符串时才注入 Board，并显式将当前 `sessionID` 传给 `getBoardText`，避免全局回退
  - `src/task-manager/tracker.ts`：`getBoardText` 参数由可选改为必传 string，移除 `_currentParentSessionId` 全局回退；未知/无效 ID（无参、空串、null、非字符串等）一律返回空、不注入任务

### 新增
- 会话隔离回归测试 14 个：
  - `tracker.test.ts` 新增 8 用例：父会话隔离 3（A/B 交错注册各自只看自己任务、未知会话返回空、嵌套 A→C→D 各直接父互不聚合孙任务）+ 空值/非法值 5（无参 / 空串 / null / 0 / 123 均不回退最近全局父会话）
  - 新增 `index.test.ts` 真实插件入口回归 6 用例：每用例经隔离临时 HOME 子进程加载真实插件、调用真实 `tool.execute.before` 与 `experimental.chat.messages.transform` hooks，验证 A/B 交错不泄漏、无任务会话不注入 Board、sessionID 缺失/为空不泄漏、空 content 补占位后 Board 仍可注入、非 user 消息不改写、嵌套 A→C→D 保持直接父不聚合孙任务

## [1.18.0] - 2026-10-16

### 变更（⚠️ 行为变更）
- **上下文注入诊断日志改为 opt-in，默认关闭**。此前每次委派都会向 `os.tmpdir()/opencode/ctx-diag.log` 同步写盘（`statSync` + `appendFileSync`），阻塞 opencode 主进程事件循环（实测 ~0.65ms/次委派）。
- 开启方式（二选一，环境变量优先）：
  - 环境变量 `COHUB_CTX_DIAG=1`（`=0` 强制关闭）
  - 配置 `~/.config/opencode/oh-my-opencode-cohub.json` → `{ "diag": { "enabled": true } }`（项目级 `.opencode/oh-my-opencode-cohub.json` 同样支持）
- 需继续排查上下文注入问题的用户请显式开启；开启后日志**路径与字段不变**，排查习惯不受影响。

### 修复
- 修复诊断日志的「读全文 + 重写」循环：旧逻辑「超 50KB → 读全文 → 重写末 30 行 → 立即又追加」，导致反复全量读+全量写；改为「异步追加 + 累计写入超 256KB 时压缩一次，且只读 64KB 尾部窗口」，文件体积有硬上界且不再全量读写。
- 诊断日志写入改为异步串行队列（`fs/promises`），不再阻塞事件循环；文件创建时使用 mode `0o600` 收紧权限。
- **oracle / council 提示词改为按需取证读取（软预算）**：替换原先无预算的批量整读指令。先确认问题与差异范围，分支审查优先利用调用方提供的 diff/stat/numstat 差异材料或现有只读工具定点定位（Grep 查符号/调用处、Read `offset`/`limit`），默认单次 Read 150–200 行，批次输出以 ≤30000 字符为软目标而非硬截断；保留互不依赖的定位搜索与片段读取并行，预留约 20% 上下文余量，大方法、关键生命周期/锁/异常/回调、跨文件不变量允许说明必要性后补读乃至整读，禁止因省预算把未核实项当安全；不新增硬轮数、不默认追加子代理，最终简明列出证据覆盖范围与未核实假设。多模型共识职责不受影响。

### 新增
- 新增 `src/context/diag-log.ts`：诊断日志开关解析（env > 配置 > 缺省关闭）与异步有界写入实现；`CoHubConfig` 新增可选字段 `diag`（缺省即安全，旧配置文件无需改动）。
- **规则分析代理接入仓库根 `.rules/` 规范发现**：
  - `co-rule-project` 职责扩展：从项目根目录（首个含 `.git` 的祖先目录）到当前目录逐级发现 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md` 及该级 `.rules/*.md`（存在则按文件名升序全部读入），越靠近当前目录优先级越高（就近覆盖）；输出实际读到的文件清单 + 内容摘要 + 与当前方案的遗漏/冲突，未读到任何规范时明确报告
  - `co-rule-user`：用户级 `~/.config/opencode/AGENTS.md` 不存在或为空时明确报告，不得默默返回空分析
  - `co-rule-app`：未指定文件时提示先由 `co-rule-project` 完成项目级规范发现或明确指定 `.opencode/rules/` 下要分析的文件名，不得自行猜测或扫描目录；仓库根 `.rules/*.md` 明确归属 `co-rule-project` 分析范围
  - `co-orchestrator`：`co-rule-project` 代理描述同步为「分析项目 AGENTS.md / .rules/*.md 等仓库级规范」

## [Unreleased]

## [1.17.0] - 2026-09-16

### 新增
- 新增 `co_ocr_review` 工具，`co-oracle` 可选调用 [alibaba/open-code-review](https://github.com/alibaba/open-code-review) 做结构化静态审查（逐行评论 + 类别 + 严重级别）
- 严格软依赖设计：未安装 OCR CLI 时返回引导提示并自动回退到原生审查方式，不影响任何现有功能

### 变更
- `co-oracle` 提示词新增「OCR 辅助审查」段，明确 preview 优先原则以控制双重 token 开销
- 工具权限收敛：`co_ocr_review` 仅 `co-oracle` 可调用（代码层 + 权限层双重防御）

## [1.16.0] - 2026-09-15

### 新增
- 新增 `PARALLEL_TOOL_INSTRUCTION` 并行工具调用总则，经 `experimental.chat.system.transform` hook 统一注入，覆盖全部 12 个代理（含未来新增的代理）

### 修复
- 修正 `co-observer` 提示词中唯一的串行指令（「逐一分析」→「并行读取」）
- 修正并行总则中与 `co-orchestrator`「禁止使用 bash」硬性规则冲突的措辞

### 变更
- 并行工具调用指导从「分散硬编码至 5 个提示词文件」升级为「hook 统一注入」，提示词源文件不再重复承载该指令

## [1.15.3] - 2026-09-15

### 变更
- 上下文引擎 `fillContextAsync` 缓存机制改为 in-flight promise 去重：并发同 key 调用共享同一请求，settle 后自动清理，兼顾去重与无脏读
- `co-explorer` 提示词新增「搜索策略」段落：首轮宽泛并行、最多 4 轮、结果收敛规则、glob→grep→read 优先级
- 上下文引擎测试重写为 8 个用例，覆盖并发共享、跨批次无脏读、失败重试、跨 session 隔离

### 修复
- 修正 `co-observer` 兜底模型残留（`codermxtest/gpt-5.5` → `deepseek/deepseek-v4-flash`），`src/tui.ts` 与 `README.md` 同步

## [1.15.1] - 2026-09-03

### 变更
- README 对齐 v1.15.0 现状：
  - 移除虚假功能描述（OpenSpec + Superpowers 死板路由）
  - 新增「编排引擎」章节（状态机/重试/契约/调度器 + 工具权限 + 上下文 4 策略 + 注入膨胀防护 + 质量回送 + stats）
  - 工作流章节重写为 Wave 波次分组并行模式
  - 版本历史补齐 v1.13.0 ~ v1.15.0

## [1.15.0] - 2026-09-03

### 新增
- 子代理并行工具调用指令：让 fixer/designer/librarian/rule-app/explorer 在调用工具时尽可能合并并发调用
  - fixer/designer/rule-app：需改/读多个文件时，同一条消息并行 read 所有目标文件
  - librarian：同一消息并行调用 context7 + gh_grep + websearch
  - explorer：在并行搜索基础上补"并行读取多个匹配文件"
  - 约束：并行仅限互相独立的调用，有依赖的仍串行

## [1.14.1] - 2026-09-03

### 修复
- 修复 Dependabot 安全漏洞（3 high + 1 moderate，均为传递依赖）
  - `brace-expansion` 2.1.2 → 2.1.4（DoS 内存溢出）
  - `browserslist` 4.28.5 → 4.28.9（无界内存增长 / 原型写入）
  - `toml` 4.1.2 → 4.3.0（无界递归 DoS）
  - `baseline-browser-mapping` 2.10.42 → 2.11.21（进程终止 DoS）
  - 全部为 patch/minor 升级，零 breaking risk；仅更新 package-lock.json

## [1.14.0] - 2026-09-03

### 变更
- 引入「修改 Wave vs 验证 Wave」区分，并行改文件不再各自编译：
  - fixer.md：验证策略场景区分——多文件并行修改 Wave 只改不编译（注明"验证待统一执行"），单文件独立任务正常自验
  - orchestrator.md：执行清单新增区分修改/验证 Wave 检查项；委派修改 Wave 的 fixer 必须注明"只修改不验证"
  - planner.md：Wave 模板标注"仅修改，不编译/测试 — 验证在下一 Wave"
- 多文件修改完成后统一编译一次，避免 N 个并行 fixer 各自跑 build 互相等待/失败

## [1.13.2] - 2026-09-03

### 修复
- 根治 CoHub 注入导致的 task prompt JSON 超长问题（`Unterminated string in JSON`，84K+ 处截断）
  - 总量兜底：`enforcePromptBudget` 拼接超 12,000 token 时降级为裸用户 prompt，JSON 从根上不再超限
  - CONTRACT 去重：`stripExistingContracts` 一次清空历史残留 30~80 个契约块
  - 错误防滚雪球：单条错误 ≤200 字符 + 渲染总量 ≤600，失败原文不再整段带入下一条
  - 依赖截断：captureResult 500→200 + 渲染端双保险
  - 无关文件过滤：denylist 精确锚点，不误伤同名项目源码
  - Job Board 折叠 15 条 + `pruneTerminalJobs` 接入运行时清理 30 分钟终态任务

## [1.13.1] - 2026-09-03

### 变更
- 重构调度/规划/审查三个核心代理提示词，引入 Wave（波次）分组并行执行模式
  - planner.md：输出格式改为按依赖关系分 Wave 1/2/3...，同一 Wave 内任务可全并行
  - orchestrator.md：调度执行改为"按波次并行"，同一 Wave 任务一次消息同时启动
  - oracle.md：新增结构化审查报告格式，要求多文件审查时先一次性并行读取再综合分析
- 解决 planner 输出扁平串行列表 → orchestrator 逐个执行 → 不并行的问题

## [1.13.0] - 2026-09-03

### 新增
- **编排引擎（Orchestration Engine）**：`src/orchestration/` 6 个模块 ~580 行，通过代码级保障 orchestrator 编排可靠性
  - 状态机引擎（engine.ts）：六状态 DAG（pending→ready→running→completed/failed→pending/cancelled），级联取消
  - 重试管理器（retry.ts）：指数退避 + 降级路由，按 agent 类型配置重试策略
  - 上下文契约（contract.ts）：`<!-- CONTRACT_BEGIN/END -->` 标记块，子代理间结构化上下文传递
  - 调度器（scheduler.ts）：全局并发控制，maxConcurrency=20，DAG 依赖自然控制并行度
  - 集成入口（index.ts）：工厂函数 + 3 个 hook 集成点（tool.execute.before/after + event）
  - orchestrator 提示词更新为"引擎驱动"工作流
- `close_job` 工具：主代理可按 Session ID 或任务别名真正中止卡住的子代理后台任务（session.abort + 任务状态同步），仅 co-orchestrator 可调用，其余代理配置层 deny 双层防护
- 定时清理增强：超时后台任务自动执行真实 abort，不再残留幽灵 running 状态
- TaskTracker 新增 abortJob 方法与幂等守卫；cleanupStaleJobs 返回超时会话列表
- 新增 tracker 单元测试 10 用例（pending abort / 重复 abort 幂等 / 终态守卫边界）

### 变更
- fixer/designer 提示词新增"最小实现自查阶梯"（复用优先、拒绝投机抽象；安全与验证永不省略）
- oracle 审查清单新增"该删没删的代码"与"过度工程检测"维度
- 默认并发上限从 5 提升到 20，让 DAG 依赖和 orchestrator 规则自然控制并行度

### 移除
- （无）

## [1.13.0-beta.1] - 2026-08-27

### 新增
- `close_job` 工具：主代理可按 Session ID 或任务别名真正中止卡住的子代理后台任务（session.abort + 任务状态同步），仅 co-orchestrator 可调用，其余代理配置层 deny 双层防护
- 定时清理增强：超时后台任务自动执行真实 abort，不再残留幽灵 running 状态
- TaskTracker 新增 abortJob 方法与幂等守卫；cleanupStaleJobs 返回超时会话列表
- 新增 tracker 单元测试 10 用例（pending abort / 重复 abort 幂等 / 终态守卫边界）

### 变更
- fixer/designer 提示词新增"最小实现自查阶梯"（复用优先、拒绝投机抽象；安全与验证永不省略）
- oracle 审查清单新增"该删没删的代码"与"过度工程检测"维度

### 移除
- （无）

## [1.13.0-beta.0] - 2026-08-26

### 新增
- council 共识机制鲁棒性升级：失败分类、重试决策表、共识检测（≥⌈2n/3⌉）、共享重试预算、前馈降级、自适应参数、协商轮次驱动态收敛
- 新增工具模块：adaptive-params（自适应调整 retries/timeout，带限幅+滞后防振荡）、model-stats（模型级失败历史）、quality（assessQuality 质量判定）
- CLI 新增 `stats [N]` 子命令，展示任务成功率/延迟/token
- summary 策略真正注入截断正文，truncateByTokens 中西文 token 估算
- TUI 读 State 轮询退避 + 独立 spinner 定时器
- docs/control-architecture.md：CoHub 多级分层控制架构文档
- 新增 6 个测试文件覆盖共识/质量/统计/截断逻辑

### 修复
- council_session 工具权限管控：仅 co-council 可调用，其余 11 代理配置层 deny + 运行时白名单纵深防御（原 orchestrator 等代理会尝试调用并报错）
- 任务质量回送闭环：子代理结果经 assessQuality 评估后回送到调度

### 变更
- src/config/loader.ts：Council 类型改为从 council.ts re-export，消除双定义漂移
- package.json test script 改为 `bun test ./src`（限定测试目录）

### 移除
- （无）

## [1.12.13] - 2026-08-07

### 修复
- 修复 messages.transform 仅对最后一条 user 消息做占位修复，恢复含 file-only 历史消息的旧会话时触发 API `messages.N: all messages must have non-empty content` 错误

## [1.12.12] - 2026-08-04

### 变更
- 子代理模型降级为 Flash：co-oracle、co-council、co-planner 从 deepseek-v4-pro 改为 deepseek-v4-flash（适配 DeepSeek-V4-Flash 2026-07-31 Agent 能力增强，优化扣费）

### 修复
- 修复 Board 诱导子代理会话复用：非背景任务完成即标记为已调和，不再暴露 session ID

## [1.12.11-beta.0] - 2026-07-31

### 修复
- 修复 Board 诱导子代理会话复用：非背景任务完成即标记为已调和，不再暴露 session ID

## [1.12.10] - 2026-07-31

### 修复
- 移除 `coreRulesInjectionText` 注入逻辑，修复 Orchestrator 提示词泄漏到子代理的问题

### 变更
- orchestrator 提示词优化：增强并行调度策略，新增四阶段并行决策框架，验证阶段 @co-oracle 与 @co-designer 并行
- orchestrator 提示词增强并行退火机制：执行前检查清单 + 退火警告 + 自检清单并行项

## [1.12.9] - 2026-07-29

### 修复
- install 后 OpenCode 报 `tool_use ids found without tool_result`：删除 messages.transform 全量兜底逻辑，避免破坏含 tool_use 块的 assistant 消息结构
- messages.transform 核心规则注入包裹标记（`--- 核心规则提醒 ---`）被发送给 AI 模型：去掉包裹标记，仅保留提示词内容
- install 架构缺陷：改为 `npm install` 到 `~/.cache/opencode/packages/` 缓存目录，含完整 node_modules 依赖树
- opencode.json plugin 条目改为带版本号格式 `oh-my-opencode-cohub@x.y.z`，已有条目自动更新版本号
- orchestrator 角色定义与规则1 流程不一致：补上"委派信息收集"步骤
- critical_rules 注入可能受覆盖影响：改为注入完整内置常量，不受外部配置覆盖
- publish CI 因 `package-lock.json` 版本不同步失败：`npm ci` 改为 `npm install`

### 变更
- 删除 `copyPluginFiles`/`copyRecursive`，不再手动复制 dist 到 plugins 目录
- 回退 v1.12.7-1.12.8 双保险架构（install 仅写 mode+description，model/variant 由 config hook 注入）
- CI publish 增加 prerelease 自动检测 `--tag beta`

### 新增
- `uninstallCoHub` 新增清理 `~/.cache/opencode/packages/` 缓存目录 + 旧 `~/.config/opencode/plugins/` 目录
- hub config 支持项目级覆盖（`.opencode/oh-my-opencode-cohub.json` > `~/.config/opencode/oh-my-opencode-cohub.json`）
- 全链路诊断日志：config hook / syncAgentConfig / messages.transform 均打印注入状态预览

## [1.12.6] - 2026-07-29

### 修复
- 修复子代理 `@` 不可见/无法调用：OpenCode 1.17.20 不从 `return { agent }` 发现代理，改为安装时将全部 12 个 co-* 代理最简模板（mode + description）写入 opencode.json，model/variant 仍由 config hook 从 oh-my-opencode-cohub.json 注入

## [1.12.5] - 2026-07-29

### 修复
- `co-orchestrator` 主代理条目兜底：opencode.json 保留最小化条目（仅 `mode: primary` + `description`）确保 TAB 切换可靠，其余 11 个子代理完全由插件运行时管理
- 修正安装提示文案：`已注册到 opencode.json` → `由插件运行时管理`

## [1.12.4] - 2026-07-29

### 修复
- 纯 slim 架构：opencode.json 不写任何 agent 定义（包括 co-orchestrator），`mode: primary` 由 `return { agent }` 和 `config` hook 运行时提供，消除一切覆盖冲突

## [1.12.3] - 2026-07-29

### 修复
- 根除 agent model/variant 配置不生效：参照 oh-my-opencode-slim 架构，agent 定义不再写入 opencode.json，改由 config hook 运行时管理。config hook 改为 slim 风格合并策略（插件兜底 + 用户优先），新增 model/variant 防御回填；registerCoHubAgents 简化为安全清理（仅删除纯模板条目，保留用户自定义）

### 变更
- agent 架构重构：opencode.json 不再写入 agent 定义，消除与插件运行时配置的优先级冲突

## [1.12.2] - 2026-07-28

### 修复
- 修复 `opencode.json` 中旧版残留的 `model`/`variant` 字段覆盖 `oh-my-opencode-cohub.json` 配置的问题——`registerCoHubAgents` 升级时自动清理，确保配置分离生效

### 变更
- `install` 重复运行完全幂等：多次安装不会重复清理、不覆盖用户自定义 prompt

## [1.12.1] - 2026-07-28

### 修复
- 修复 `install` 升级时 `co-orchestrator` 的 `mode` 字段未从 `subagent` 更新为 `primary` 的问题——`registerCoHubAgents` 新增 mode 不匹配检测，自动同步 prompt 和 mode

### 变更
- `.gitignore` 新增 `*.tgz` 和 `references/` 忽略规则，防止误提交

## [1.12.0] - 2026-07-28

### 新增
- CLI install 完成自动输出 AI 配置文案，README 新增"方式三：复制文案交给 AI 配置"章节，用户复制粘贴给 AI 即可自动生成 `oh-my-opencode-cohub.json`
- `writeDefaultConfig()` 智能模型匹配：从 `opencode.json` 动态读取 provider/model，按重型（pro/max/sonnet/opus）/轻型（flash/mini/haiku）/设计/观察者关键词自动分配，无 provider 时生成带 `_comment` 的引导配置

### 修复
- 代理数量硬编码 13→12 修正（`src/cli/index.ts` 注释和 console.log）
- README 部首字符错误修复（`执⾏` → `执行`）

### 变更
- 删除 `DEFAULT_CONFIG` / `DEFAULT_MODELS` 硬编码导出，配置完全由外部文件管理
- `src/index.ts` 移除所有 agent `config` 中的 `model`/`variant` 硬编码，council 默认 preset 改为空对象
- `messages.transform` hook 新增防御性编程兜底（空 parts 补全、content 为空设占位、诊断日志）
- Orchestrator 工作流优化：方案制定由 Orchestrator 自身执行改为委派 @co-planner，规则分析策略移至信息收集步骤

## [1.11.1] - 2026-07-28

### 修复
- 修复 v1.11.0 中 `install` 覆盖 `opencode.json` 的问题——`readJSON` 不支持 JSONC 格式导致解析失败后创建空对象覆盖全部配置（包括 provider 和 agent）
- 修复 agent model/variant 与 `opencode.json` 存在冲突的问题

### 变更
- agent 架构重构：`opencode.json` 只存 agent 结构（description/mode/prompt），model/variant 由 `oh-my-opencode-cohub.json` 唯一管理，消除一切覆盖冲突
- `co-orchestrator` 改为 `mode: "primary"`，install 自动写入 `default_agent`
- 移除 v1.11.0 引入的 `syncAgentConfigToOpencode` 同步机制

## [1.11.0] - 2026-07-28

### 新增
- 插件启动时自动将 `oh-my-opencode-cohub.json` 中 agent model/variant 同步写入 `opencode.json`，解决 OpenCode 内部配置合并优先级导致用户覆盖不生效的问题（采用原子写入、类型守卫、诊断日志）

## [1.10.3] - 2026-07-25

### 新增
- co-rule-app 代理支持并行分片分析：Orchestrator 可按规则文件数量并行派发多个实例（每实例负责 1-2 个文件），替代原先的串行全量分析

### 变更
- orchestrator.md：新增"规则分析并行策略"指导段落，更新 @co-rule-app 子代理描述
- rule-app.md：从简短描述重写为完整的结构化代理定义，支持接收指定文件子集分析

## [1.10.2] - 2026-07-25

### 新增
- 新增诊断日志工具 `src/utils/log.ts`，异常信息写入 `~/.local/share/opencode/log/oh-my-opencode-cohub.YYYYMMDD.log`，按天轮转保留 7 天

### 修复
- 修复 `messages.169: all messages must have non-empty content` 错误——消息对象 `m.info` 增加可选链、`lastUserMsg.parts` 增加数组防御、`part.text` 安全拼接、`system.transform` 加 try-catch 容错
- 修复 `tracker label` 在 `description` 为空字符串时显示空白标签的问题

### 变更
- 所有 `throw` 异常消息统一加 `[oh-my-opencode-cohub]` 前缀，便于快速溯源
- 12 处静默 `catch {}` 和 `console.warn` 迁移到 `appendLog` 结构化日志文件
- `council.ts` 新增 `promptText` 空值断言防御
- 日志工具增加 `mkdir` 兜底、UTC 时区统一、`escapeRegex` 防御

## [1.10.1] - 2026-07-25

### 修复
- 修复 CI 发布缺失构建步骤导致 dist/ 版本号与源码不一致的问题

### 变更
- 发版技能文档同步更新，构建职责从本地转移到 CI
- 添加 @babel/core 版本锁定（overrides）

## [1.10.0] - 2026-07-25

### 新增
- CLI install 命令添加版本号显示，从 package.json 动态读取当前版本

### 变更
- 产品显示名称统一为 `oh-my-opencode-cohub`

## [1.9.3] - 2026-07-25

### 移除
- 移除 co-guardian 代理及 context-guard 上下文卫士模块（11个文件），回归精简架构

### 变更
- 代理数量从 12 个减少为 11 个
- 移除 context-guard 全部 hooks（event/chat.params/messages.transform/chat.message）
- CLI install 默认配置不再包含 co-guardian

### 修复
- 移除 filterEmptyMessages 幽灵消息过滤逻辑（该方案未能解决 empty content 错误）

## [1.9.2] - 2026-07-25

### 修复
- 修复上下文压缩产生幽灵消息（text part 全空）导致 LLM API 报 `empty content` 错误的问题，在 `messages.transform` 钩子入口添加 `filterEmptyMessages` 过滤

## [1.9.1] - 2026-07-25

### 修复
- chat.message hook 回复改为追加而非清空 parts，避免 LLM API "empty content" 错误

## [1.9.0] - 2026-07-25

### 新增
- messages.transform 末尾注入核心规则：从 orchestrator 提示词动态提取 `<critical_rules>` 并注入到消息末尾，利用 recency bias 对抗长会话注意力衰减

### 变更
- 核心规则注入采用单一事实来源：从 resolved prompt 正则提取，消除硬编码双写，用户覆盖提示词后自动同步

## [1.8.2] - 2026-07-24

### 修复
- Token 累计算法从覆盖改为累加（+=），修复阈值永不触发的问题
- 添加消息去重（防重播事件重复计数）

### 新增
- 上下文卫士菜单新增"稍后提醒"选项，阶梯阈值 20%→40%→60%→80%

## [1.8.1] - 2026-07-24

### 修复
- 安装脚本硬编码 agent 列表缺少 co-guardian，bunx install 无法注册该代理

## [1.8.0] - 2026-07-24

### 新增
- 新增 ContextGuard 上下文卫士模块：20% 阈值时主动弹出三选一菜单（自动压缩 / 会话压缩 / 分析迁移）
- 新增 co-guardian 子代理：启发式分析会话状态，推荐最优上下文处理策略
- CJK 中文 token 修正估算（1.8 chars/token），避免中文文本被低估 2-3 倍
- TUI 面板新增 co-guardian agent 展示

### 变更
- 拆除 PlanGate 方案批准门禁：orchestrator 回归纯提示词 + 用户选择模式
- Background Job Board：getBoardText 返回值类型优化，无任务时不再注入空表格
- oracle 提示词增强：新增 @council vs @oracle 选择指南

### 修复
- event hook sessionID 路径修正（properties.info.sessionID 替代 properties.sessionID）
- chat.message hook 改为 output.parts 直接变异（符合 SDK 类型签名）

### 移除
- 移除 PlanGate 门禁系统（plan-gate.ts / plan-gate-audit.ts 及测试文件）
- 移除 request_plan_approval 工具

## [1.7.0] - 2026-07-23

### 新增
- PlanGate 有界审计日志：记录批准生命周期事件（50 条环形缓冲区 + 原子写入 + fail-open）
- messages.transform 末尾注入核心规则：利用 recency bias 对抗长会话注意力衰减，不持久化

### 修复
- 修复 plan-execute 权限弹窗不弹出：co-orchestrator 配置新增 "plan-execute": "ask" 规则

## [1.6.0] - 2026-07-23

### 新增
- request_plan_approval 自定义工具：通过 OpenCode 原生权限确认框发起方案批准
- PlanApprovalManager 许可租约：generation 机制，新用户消息自动撤销旧批准
- tool.execute.before 可写代理执行门禁：未批准方案时拒绝 co-fixer/co-designer 委派
- system.transform 动态注入 plan gate 状态，每次 LLM 请求刷新

### 变更
- orchestrator 提示词升级：todowrite 状态锁 → 方案批准门禁，覆盖范围扩展至 co-designer
- 替代旧的 RuleInjector 周期性提醒机制（用户可见注入 → 程序化硬门禁）

### 移除
- src/rule-injector.ts：L2 周期性规则提醒注入器

## [1.5.3] - 2026-07-22

### 修复
- 修复 Background Job Board "reusable by alias" 指令导致 orchestrator 误用 alias 作为 task_id，session 复用不生效。重写为正向指引（用 Session ID 列），陈述传 alias 的真实后果（静默创建新 session 而非复用）
- 新增 task_id 防御拦截：非 ses_ 前缀的非法值在 tool.execute.before hook 中直接删除，不依赖 OpenCode 静默兜底

### 变更
- Background Job Board 输出格式重构：Active Jobs 字段重排（agent 在前，alias 后置加 alias= 标注），Reusable Sessions 改为表格格式
- 删除 Board 中未实现的"超时恢复"指令（运行中任务无 sessionId，功能从未存在）
- orchestrator 提示词优化：规则 3 强调"方案检查→使用 co-explorer 搜索→co-librarian 验证方案信息"

### 移除
- Board 中 "Timed-out running sessions are recoverable by alias" 指令（幻影功能）

## [1.5.2] - 2026-07-22

### 修复
- 诊断日志增加自动截断：超过 50KB 保留最后 30 条，防止无限累计

## [1.5.1] - 2026-07-22

### 修复
- 修复子代理上下文提取器使用不存在的 SDK Part 类型名（`tool_call`/`tool_result`），改为 SDK 实际 `type: 'tool'` + `state` 结构，使 Read/Edit/Write 等工具调用信息能正确提取
- 修复 `extractErrors` 中 `||` 短路语义问题，改为显式 `status === 'error'` 判断
- 修复诊断日志硬编码路径，改用 `os.tmpdir()`

### 新增
- 新增 `src/context/extractor.test.ts`，31 个单元测试覆盖 extractRelevantFiles / extractErrors / extractDecisions
- 升级诊断日志：注入完成后记录完整上下文（time/session/subagent/detailsPreview/detailsLen）
- 新增 `npm test` 脚本（`bun test`）

## [1.5.0] - 2026-07-22

### 新增
- L2 规则重注入：RuleInjector 模块，通过 chat.message hook 每 5 轮为 orchestrator 注入规则提醒
- L3 状态锁：规则 4（todowrite 状态锁），委派 co-fixer 前强制检查 todowrite 方案状态
- 自检清单：每次回复前强制逐条确认核心行为准则

### 变更
- orchestrator 提示词重构：核心规则从文件中间移到末尾（利用 recency bias），四条规则用 XML 标签包裹
- 规则 1 增加长会话警告，强调每次新需求必须重新执行分析→方案→确认→执行
- 自检清单从初版 4 条精简为 2 条核心检查
- event hook 拆分 session.deleted 分支，增加 RuleInjector 清理逻辑

## [1.4.0] - 2026-07-21

### 新增
- 子代理上下文共享系统：ContextEngine 完整生命周期，覆盖 registerContext → fillContextAsync → formatContextDetails → captureResult
- 四种上下文策略（none/relevant/summary/full），支持代理级默认 + 任务级 context_override 覆盖
- TaskContext 结构化上下文传播：相关文件、前置决策、错误信息、依赖结果自动在子代理间流转
- `📋 任务上下文` 自动注入子代理 prompt，无需手动拼接

### 修复
- 修复插件所有 hooks 失效：CHINESE_PROMPTS / CHINESE_INSTRUCTION 字符串被 export 导致 getLegacyPlugins() 抛异常
- 修复上下文注入未到达子代理：output.args.description 仅为 session 标题，改为优先写入 output.args.prompt
- 修复 fillContextAsync 竞态条件：异步调用未 await，导致上下文填充未完成子代理已启动
- 修复上下文详情未注入：formatContextDetails 返回值未追加到子代理 prompt
- 修复提取器无法从父 session 提取文件路径：新增文本扫描 + tool_call args 字符串值扫描

### 变更
- 简化 resolveStrategy 三段式条件判断为单行
- 空 catch {} 改为 console.warn 日志输出，避免静默吞错

### 移除
- 移除 CHINESE_PROMPTS / CHINESE_INSTRUCTION 的 export（改为内部常量）

## [1.3.0] - 2026-07-20

### 新增
- 提示词源文件迁移为 Markdown 格式（`src/prompts/*.md`），直接编辑更直观
- 新增 `scripts/generate-prompts.ts`，构建时自动将 .md 转换为 .ts 常量文件
- 用户自定义 .md 覆盖机制现已生效，支持项目级和用户级覆盖

### 修复
- 修复 co-oracle / co-librarian / co-explorer / co-designer / co-fixer / co-observer / co-planner / co-rule-user / co-rule-project / co-rule-app 共 10 个代理使用占位符而非完整提示词的问题
- 修复 `loadFileOverrides()` 死代码，运行时 .md 文件覆盖逻辑现在正确应用

### 变更
- `src/prompts/*.ts` 转为构建时自动生成，不再手动维护
- `package.json` build 脚本前置增加 `bun run scripts/generate-prompts.ts` 步骤
- `.gitignore` 新增 `src/prompts/*.ts` 忽略规则

## [1.2.4] - 2026-07-20

### 新增
- 子代理上下文共享系统：ContextEngine 三阶段流程（构造→注入→捕获），子代理启动时自动获取结构化上下文
- `src/context/` 模块：types / strategy / extractor / formatter / engine，5 个新文件
- 上下文策略：`none` / `relevant` / `summary` / `full`，静态默认 + 运行时 `context_override` 覆盖
- 子代理结果依赖传播：co-explorer 发现自动注入到后续 co-fixer 的上下文
- TaskTracker 自动 reconcile：新一轮任务启动时自动归档旧任务，Board 不再累积
- cancel_task 集成：取消任务立即标记为 cancelled 并从 Board 移除
- server 别名导出：兼容 OpenCode `PluginModule` 类型
- `getJobBySessionId()`：按子 session ID 查找 JobRecord

### 修复
- 防御 `output.args` 为 undefined 导致上下文标记注入 TypeError 被静默吞掉
- `contextConfig` 深合并 strategy 字段，避免用户部分覆盖时丢失默认策略
- `captureResult` 添加 `void` 前缀，消除潜在 unhandled Promise rejection
- `contextCleanupTimer` 在 dispose 中清理
- `CONTEXT_MARKER_PATTERN` 导入替代内联正则，消除重复定义

### 变更
- `JobRecord` 新增 `contextStrategy`、`dependencies` 可选字段
- `AGENTS.md` 补充 `src/context/`、`src/tools/` 目录说明
- 版本号 `1.2.0` → `1.2.4`

## [1.2.3] - 2026-07-20

### 新增
- GitHub Actions CI：推送 `v*` tag 自动构建并发布到 npm（OIDC 认证，零 token 管理）
- 版本一致性校验：CI 自动对比 tag 版本与 package.json 版本

### 变更
- 发版规范更新：使用 `npm version` + `git push --follow-tags` 简化发布流程

## [1.0.18] - 2026-07-15

### 新增
- `council_session` 工具：真正的多模型并行共识（`src/tools/council.ts`，628 行）
- Council 预设系统：支持多组 councillor 配置，可通过 `preset` 参数切换
- 兜底默认配置：无用户配置文件时自动使用 3-councillor 内置预设
- README 新增 Council 多模型共识配置章节（配置表 + 3 个预设示例）

### 修复
- councillors 不再引用不存在的 `councillor` agent，直接指定 model
- 重试逻辑扩展：覆盖 timeout、rate limit、503、429 等瞬态错误
- CLI `install` 自动写入 council 配置和 `council_session` 工具权限

## [1.0.17] - 2026-07-15

### 新增
- orchestrator 提示词新增 `@co-council` vs `@co-oracle` 选择指南（对比表格 + 决策规则 + 场景对照 + 反面教材）

### 修复
- 移除 `.idea/` 目录追踪，已加入 `.gitignore`

### 变更
- 移除 tool.execute.after 中的 DEBUG 日志写入

## [1.0.16] - 2026-07-15

### 新增
- 背景任务事件驱动跟踪：`event` hook 监听 `session.idle/deleted/error` 更新任务状态
- 30 分钟超时兜底清理（`setInterval` + `cleanupStaleJobs`）
- `extractChildSessionId`：从 tool output 提取子任务 session ID
- `updateByChildSessionId`：按子 session ID 精确匹配更新任务状态

### 修复
- 背景任务在 `tool.execute.after` 中被过早标记为 `completed` 的问题
- task 调度后 sessionId 匹配断裂问题

## [1.0.15] - 2026-07-14

### 修复
- `co-orchestrator` prompt 从简短占位文本改为完整 `ORCHESTRATOR_PROMPT` + 中文语言指令
- Agent 新增 `agent` 字段直接返回，确保 HTTP 服务器模式（Desktop App）兼容

## [1.0.14] - 2026-07-14

### 修复
- Agent 仅通过 `config` hook 注册导致 HTTP 服务器模式下不显示的问题
- 改为双重注册：`agent` 字段返回 + `config` hook 写入

## [1.0.13] - 初始发布

- 12 个 `co-*` 中文代理（co-orchestrator、co-oracle、co-librarian 等）
- 纯调度模式：Orchestrator 只使用 task/todowrite，文件操作全部委派子代理
- 中文注入：`experimental.chat.system.transform` 推送中文指令
- Background Job Board：`experimental.chat.messages.transform` 注入任务跟踪面板
- TUI 侧边栏面板
- CLI `install` / `uninstall` 命令
