// dsh-port/src/index.ts
// CoHub DSH 插件行：中文指令注入 + 13 技能（12 专职代理 + orchestrator）+（M4）多模型共识工具
// + 内置 agent preset（co-orchestrator）自动安装到用户 preset root。
//
// 插件行导出约定（cordis 组合行）：
//   name    —— 插件名（重复检测 / 注入元数据）
//   inject  —— 依赖的服务 seam（systemPrompt / skills / tools）
//   Config  —— schemastery 运行时配置 schema（cordis.patch.yml 的 config 据此校验）
//   apply   —— 挂载时执行：注册系统提示词 section、runtime skills、内置 agent preset
import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cosmokit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { applyPresetPatchDeclarations, copyTree, installShippedPresets, resolveProfilePatchPath } from "./preset-install";
import { registerCohubPresets, unregisterCohubPresets } from "./preset-runtime";
import { CHINESE_LANGUAGE_INSTRUCTION } from "./chinese";
import { COHUB_SKILLS } from "./skills";
import { renderLeadSection } from "./roles.ts";
import { CUSTOM_ROLE_POLL_MS, createCustomSkillRegistry } from "./custom-skills.ts";
import { createCouncilTool } from "./council";
import { createDelegateTool } from "./delegate";
import { createDelegateBatchTool } from "./delegate_batch.ts";
import { createReviewCollector } from "./review-collector.ts";
import { registerReviewCommand } from "./review-command.ts";
import { registerTodoGate } from "./todo-gate.ts";
import { COUNCIL_TIMEOUT_MS, WALL_CLOCK_BUDGET_MS } from "./shared/constants.ts";
import {
  DEFAULT_BATCH_TASK_CHARS,
  DEFAULT_BATCH_TOTAL_CHARS,
  DEFAULT_CONTEXT_WARN_TOKENS,
  DEFAULT_DELEGATE_RESULT_CHARS,
  DEFAULT_PARTIAL_BUDGET_CHARS,
  resolveResultBudget,
} from "./result-budget.ts";

import { DEFAULT_ERROR_CATEGORIES } from "./env-signatures";

/**
 * 安全地标记为 volatile（配置热更新）。
 * `Schema.prototype.volatile` 自 schemastery 3.18.4 起提供；
 * 若被安装到更旧的版本（如某些宿主环境或裸装场景），降级为普通字段，
 * 而不是在模块顶层求值时抛 TypeError 导致整个插件导入失败。
 *
 * 类型层面：`Config` 的 volatile 字段在类型上必须如实带 `.get()`。但不能把返回类型
 * 直接写成 `Volatile<T>`——schemastery 的 `z.object` 用 `TypeT<X> = ReturnType<From<X>>`
 * 推断字段类型，而 `From<X>` 只认 schema 节点；`Volatile<T>` 不是 schema 节点，会退化为
 * `never`（表现为 `parsed.skills.get()` 报 "Property 'get' does not exist on type 'never'"）。
 * 因此这里推导 `.volatile()` 自身的产物类型：它仍是 schema 节点，但解析输出是 `Volatile<T>`，
 * 同时用 `Volatile` 做静态保证（产物必须是 cosmokit 引用），避免退化成普通 schema。
 */
type VolatileSchema<S> = S extends { volatile: (...args: any[]) => infer R }
  ? R extends (...args: any[]) => infer O
    ? O extends Volatile<unknown> ? R : never
    : never
  : never;

function volatileSchema<T extends object>(schema: T): VolatileSchema<T> {
  const fn = (schema as { volatile?: () => VolatileSchema<T> }).volatile;
  return (typeof fn === "function" ? fn.call(schema) : schema) as VolatileSchema<T>;
}

/** 单个 councillor 配置（M4 council 工具使用） */
const Councillor = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  // 字段可选：schemastery 3.18 的 default(value) 签名要求 T 或 Partial<S>，
  // 不接受 undefined；object 内字段本就允许缺省（缺省时输出对象不含该键，
  // 消费端按 undefined 处理），故去掉 default(undefined)，运行时语义不变。
  prompt: z.string(),
});

/** 单个 skill 的路由配置（delegate 工具使用） */
const SkillRoute = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number(),
  // 推理强度（DSH 的 ReasoningEffortId）：可选，缺省/空串 = 不覆盖。
  //
  // 为什么是 string 而不是 union：合法档位由「该 provider + model 的模型目录」决定
  // （LlmModelReasoningInfo.efforts[].id，如 low / medium / high），是 adapter 拥有的
  // 不透明字符串（dsh-llm brand.ts：ReasoningEffortId 无校验，"no validation is performed"），
  // 不是跨 provider 的固定枚举——写死 union 会把别的 provider 的档位拒之门外。
  //
  // 配了当前模型不支持的档位，DSH 会在发出请求前硬失败（llm resolveCallWithInfo 抛
  // UNSUPPORTED_REASONING_EFFORT），因此 delegate.ts 的 buildAgentOptions 会在
  // 「已确定 provider+model」时先用 resolveModelInfo 预校验，不支持则丢弃并告警（fail-soft）。
  //
  // 不加 .required()：schemastery 中未 required 即可选（缺省时解析结果不含该键）；
  // 不加 .default()：避免官方设置页把默认值强制写回每一条路由。
  reasoningEffort: z
    .string()
    .description(
      "推理强度：合法值由该 provider+model 的模型目录决定（models[].reasoning.efforts[].id，常见 low/medium/high，可含 minimal/xhigh 等 adapter 自有档），非跨 provider 固定枚举；留空 = 按模型默认档/继承父会话",
    ),
  // 输出契约启用等级（波2b）：定义在 src/output-contract.ts（12 角色的 JSON Schema 子集）。
  //
  // 缺省 off —— 不注入契约段、不校验、不重写，因此默认配置下运行时行为与旧版**完全一致**。
  //   lite   = 注入契约段 + 校验 + 标记违约（不改写子代理输出）
  //   strict = 注入 + 校验 + 违约重写一次
  // 本波只做配置管道（字段 + 透传），注入/校验/重写在波3 接入 delegate。
  //
  // 用 z.union 而不是 z.enum：schemastery 的枚举即 union（同 council 的工具模式字段）。
  // 不加 .default()：未配置的路由不写回该键，避免官方设置页把默认值强制写回每条路由
  // （与 reasoningEffort 的处理一致）。
  outputContract: z
    .union(["off", "lite", "strict"])
    .description("输出契约等级（off=不注入不校验 / lite=注入+校验+标记违约 / strict=注入+校验+重写一次；留空=off）"),
});

/**
 * 用户自定义团队角色的单条配置（Config.customRoles 的数组元素）。
 *
 * 定位：内置角色（co-orchestrator + 各专职代理，见 src/skills.ts）之外的**用户自带角色**，
 * 让用户在 profile patch 里声明「某个名字 + 该角色干什么 + 用哪些工具」，
 * 由后续批次的注册逻辑映射为一个可被 delegate({ skill }) 引用的 runtime skill。
 *
 * **工具与模型解耦**：`tools`（自由绑定工具插件 id）优先于 `tier`（快捷组合）；
 * 角色专属模型由 `Config.skills` 的路由（按角色名匹配）单独配置，不放在这里。
 *
 * 校验全部落在 schema 层（官方设置页 / cordis.patch.yml 校验共用同一份），便于 GUI 生成表单：
 *   - name / description / prompt 三个字段 `.required()`：缺字段报
 *     `$.customRoles[0].name missing required value`；
 *   - name 用 pattern 约束 kebab-case（首尾无分隔符、只含 a-z0-9 与单个连字符），
 *     与内置角色命名（co-explorer / co-rule-user）一致；空串也被该 pattern 拒绝；
 *   - description / prompt 用 `.min(1)`：空串报 `expected string length >= 1 but got 0`；
 *   - tools 用 `z.array(z.string().min(1)).default([])`：元素空串报
 *     `$.customRoles[0].tools[0] expected string length >= 1 but got 0`；缺省为 []
 *     （= 回退按 tier 取默认组合，tier 也空则视为只读组合）。**不做 id 形状校验**：
 *     工具插件 id 的存在性与可用性依赖运行时插件表，由注册/派发逻辑 fail-soft 处理；
 *   - tier 可选（不 `.required()`）：非法值仍报
 *     `expected "ro" | "ro-net" | "rw" | "rw-shell" | "cordis" but got "nope"`。
 *
 * **不在这里做重名检查**（是否与内置角色或彼此的 name 重复）——那需要运行时上下文
 * （内置角色表 / 已注册技能目录），由后续批次的注册逻辑负责。
 */
const CustomRole = z.object({
  /** 角色名：kebab-case，未来作为 delegate({ skill }) 的取值 */
  name: z
    .string()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .required()
    .description("角色名（kebab-case，如 my-reviewer）；不得与内置角色重名（重名检查在注册时进行）"),
  /** 一句话职责：进技能目录给主代理选人，也作为 GUI 列表的副标题 */
  description: z.string().min(1).required().description("角色职责（必填，非空）：一句话说明什么时候该派给它"),
  /** 该角色的任务指令，未来映射为子代理 brief（prompt 前缀） */
  prompt: z.string().min(1).required().description("该角色的任务指令（必填，非空）：未来映射为子代理 brief"),
  /** 角色绑定的工具插件 id：优先于 tier；为空时回退按 tier 取默认组合 */
  tools: z
    .array(z.string().min(1))
    .default([])
    .description(
      "角色绑定的工具插件 id（如 tool-fs / tool-web / tool-pwsh）；为空 = 回退按 tier 取默认组合（tier 也空则视为只读组合）；id 存在性由运行时校验",
    ),
  /** 工具档位（快捷组合/展示用）：可选；tools 非空时以 tools 为准 */
  tier: z
    .union(["ro", "ro-net", "rw", "rw-shell", "cordis"])
    .description(
      "工具档位（可选，快捷组合/展示用）：ro=只读 / ro-net=只读+联网 / rw=读写 / rw-shell=读写+shell / cordis=Cordis 插件改写；tools 非空时以 tools 为准，tools 与 tier 都空 = 只读组合",
    ),
});

/**
 * 团队配置（Config.teams 的数组元素）：把角色池（内置角色 + customRoles）按用途编组，
 * 并映射为 DSH 的一个 **Agent 预设**——团队切换改为在 DSH 的 Agent 预设里选择
 * （Config.activeTeam 已废弃，仅作旧配置兼容）。
 *
 * 校验只落在 schema 能表达的范围内（与 CustomRole 同一风格）：
 *   - id 用 pattern 约束 kebab-case（首尾无分隔符、只含 a-z0-9 与单个连字符）；
 *   - name 用 `.min(1)`：空串报 `expected string length >= 1 but got 0`；
 *   - members 用 `z.array(z.string().min(1)).min(1)`：空数组报
 *     `expected array length >= 1 but got 0`，元素为空串同样被拒；
 *   - presetId 可选（不 `.required()`），省略时按 `cohub-team-<id>` 推导。
 *
 * **不在这里做**「成员必须是真实存在的角色（内置 16 或 customRoles 的 name）」与
 * 「id 之间不得重复」——两者都需要运行时上下文（内置角色表 / customRoles 快照），
 * 由后续批次的运行时校验负责。
 */
const Team = z.object({
  /** 团队 id：kebab-case；同时作为预设 id（presetId）的 slug 来源 */
  id: z
    .string()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .required()
    .description(
      "团队 id（kebab-case，如 writing）；同时作为预设 id 的 slug 来源（见 presetId）；不得与其他团队重复（唯一性检查在运行时）",
    ),
  /** 显示名：进技能目录 / 设置页给人看 */
  name: z.string().min(1).required().description("团队显示名（必填，非空）"),
  /** 一句话说明这组角色适合什么任务；可省略 */
  description: z.string().description("团队说明（可省略）：一句话描述这组角色适合什么任务"),
  /** 成员角色名：内置角色或 customRoles 的 name，至少 1 个 */
  members: z
    .array(z.string().min(1))
    .min(1)
    .description("成员角色名（内置角色或 customRoles 的 name；至少 1 个；存在性检查在运行时）"),
  /** 队长角色名：可省略；空 = 默认 co-orchestrator。只有 string 这一层校验（非空由运行时判） */
  lead: z.string().description("队长的角色名；必须在本团队成员内；空 = 默认 co-orchestrator"),
  /** 该团队注册成的 Agent 预设 id：省略时按 cohub-team-<id> 推导 */
  presetId: z
    .string()
    .description("该团队注册成的 Agent 预设 id（省略 = 按 cohub-team-<id> 推导）；在 DSH 的 Agent 预设里选择团队"),
});

/** delegate 执行器环境契约注入配置（P1-1）：默认开、可关闭、文本可覆盖 */
const EnvContractConfig = z.object({
  /** 是否在 delegate spawn prompt 前注入执行器环境契约；默认开 */
  enabled: z.boolean().default(true),
  /** 部署覆盖文本；缺省 = 通用探测式默认文本（DEFAULT_ENV_CONTRACT，不写死环境断言） */
  text: z.string(),
}).default({});

/** N2 停滞检测器配置（P3-1）：默认关闭（保守），跨环境三态（探测/配置/降级） */
const StallDetector = z.object({
  /** 默认关闭（保守）：enabled=false 时看门狗完全不介入，走现有单次/重试逻辑 */
  enabled: z.boolean().default(false),
  /** S1 连续同类错误阈值（同一归一化错误签名连续出现且期间无成功工具结果） */
  consecutiveErrors: z.number().default(3),
  /** S2 无结果空转毫秒（距上次工具结果超过它且仍在产出推理块） */
  idleMs: z.number().default(600_000),
  /** S3 纯推理无动作阈值（连续推理块数，期间 0 次工具调用） */
  reasoningWithoutAction: z.number().default(50),
  /** S4 重复调用循环阈值（同工具名 + 归一化参数重复且结果均为错误/未变） */
  loopCount: z.number().default(3),
  /** 宽限窗口：距最近一次成功工具结果超过它才允许触发（最近成功过不触发） */
  graceMs: z.number().default(30_000),
  /** 触发后是否按可重试中止处理（进入 retryableReasons 判定与 maxRetries 预算） */
  recoverable: z.boolean().default(true),
}).default({});

/** delegate 中止/失败自动重试配置（P1-2）：默认不重试（maxRetries=0），保持现状 */
const DelegateRetry = z.object({
  /** 中止/可重试失败后的自动重试上限；0 = 不重试（保持现状） */
  maxRetries: z.number().default(0),
  /** 重试间隔（毫秒） */
  retryDelayMs: z.number().default(1000),
  /** 可自动重试的 stopReason 集合；默认仅 "aborted"；未知 reason 一律不重试（保守，跨版本安全） */
  retryableReasons: z.array(z.string()).default(["aborted"]),
  /** N2 停滞检测（P3-1）：默认关闭；启用后从运行期事件在线估计「停滞」并提前中止（复用本重试机制） */
  stall: StallDetector,
}).default({});

/** 已固化的执行器环境契约事实（manual 模式或自动学习缓存；moduleLoading=unknown 表示未固化，回退探针式） */
const EnvContractFacts = z.object({
  /** "await-import" | "require" | "static-import" | "unknown" */
  moduleLoading: z.string().default("unknown"),
  /** 顶层 await 是否可用（探测观测值；manual 模式部署可覆盖） */
  topLevelAwait: z.boolean().default(true),
  /** 单次执行墙钟上限毫秒（探测观测值；manual 模式部署可覆盖） */
  wallClockLimitMs: z.number().default(600_000),
  /** 后台任务跟踪（job）是否可用（探测观测值；manual 模式部署可覆盖） */
  hasJobTracking: z.boolean().default(false),
});

/** P3-2（N1）环境契约持久化配置：默认 auto（无缓存时行为不变，回退探针式）；读写失败静默降级 */
const EnvSignatures = z.object({
  /** auto（缺省，无缓存时行为不变）/ off（完全关闭读写）/ manual（只读手动契约事实） */
  use: z.union(["auto", "off", "manual"]).default("auto"),
  /** 缓存 TTL（毫秒），缺省 7 天（到期重探，防环境静默升级） */
  ttlMs: z.number().default(604_800_000),
  /** 同一签名确认次数后才写入，缺省 2（观察一致才写入，防瞬态误判） */
  confirmCount: z.number().default(2),
  /** manual 模式部署直接给的契约事实（可选；moduleLoading=unknown 视为未提供） */
  contract: EnvContractFacts,
  /** 环境契约类错误分类子串（仅观测分类用，缺省 DEFAULT_ERROR_CATEGORIES） */
  errorCategories: z.array(z.string()).default(DEFAULT_ERROR_CATEGORIES),
}).default({});

/** P3-3（N3）调度参数配置：批大小 / 墙钟预算。
 * 缺省值（5 / 600s）仅为本环境观测值，部署可调。
 * useJobTracking 与 adaptiveBatch 已于 2026-09-03 移除（声明但代码不读的死参数）。 */
const ScheduleConfig = z.object({
  /** 单批并行委派上限；缺省 5（本环境观测值，部署可调） */
  maxParallelBatch: z.number().default(5),
  /** 单次执行单元墙钟预算（毫秒）；缺省取自共享常量 WALL_CLOCK_BUDGET_MS（本环境观测值，部署可调） */
  wallClockBudgetMs: z.number().default(WALL_CLOCK_BUDGET_MS),
}).default({});

/** P1-3（子代理结果预算）：契约保留 + 预算裁剪 + 落盘定位。
 *  全部字段内建默认值 → 用户不改也能生效；enabled=false 完全回到「全文回传」的旧行为。
 *  字符上限按 3 字符/token 折算：12000 字符 ≈ 4000 tokens（父会话每轮都要重发，故仍设上限；
 *  但阈值过低会让父代理拿到 locator 却因禁读无权读取、只能重复委派，实测得不偿失）。 */
const ResultBudgetConfig = z.object({
  /** 是否启用结果预算裁剪；默认 true */
  enabled: z.boolean().default(true),
  /** delegate 单次子代理结果上限（字符） */
  maxChars: z.number().default(DEFAULT_DELEGATE_RESULT_CHARS),
  /** 失败路径 partial 的预算上限（字符）；只进 err.cause，不进模型上下文 */
  partialMaxChars: z.number().default(DEFAULT_PARTIAL_BUDGET_CHARS),
  /** delegate_batch 单个任务结果上限（字符） */
  batchTaskMaxChars: z.number().default(DEFAULT_BATCH_TASK_CHARS),
  /** delegate_batch 拼装后总串上限（字符） */
  batchTotalMaxChars: z.number().default(DEFAULT_BATCH_TOTAL_CHARS),
  /** 预算守卫告警阈值（消息体量 tokens）；超过只 warn，绝不阻断 agent loop */
  warnMessageTokens: z.number().default(DEFAULT_CONTEXT_WARN_TOKENS),
}).default({});

/** delegate 后台 job 模式（background delegate）：默认关闭 = 完全保持前台同步行为。
 *  开启后 delegate spawn 完子代理即把这次运行注册为 DSH 后台 job 并**立即返回 jobId**，
 *  主代理用 job_output({ job_id, wait: true }) 取结果，或等完成时的自动唤醒；
 *  等待期间可以并行推进其他工作。jobs 服务不可用 / start() 拒绝时自动降级回前台同步，
 *  降级对该次调用完全透明（绝不因后台不可用而失败）。
 *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
const DelegateBackgroundConfig = z.object({
  /** 总开关；默认 false（不改现有行为） */
  enabled: z.boolean().default(false),
  /** 默认走后台的 skill 名列表（如 ["co-explorer"]）；空数组 = 仅显式 background: true 才走后台 */
  defaultFor: z.array(z.string()).default([]),
}).default({});

/** P1-1 子代理工具表裁剪（按角色 deny 裁剪子代理继承的工具表）。
 *  默认开启：把只读代理用不到的 write/pwsh、写类代理不该有的再委派工具从子代理
 *  工具表里裁掉（每请求省下数千 schema tokens）。裁剪被服务端拒绝时自动回退全量
 *  工具，只留一行 warn——绝不因此阻断委派。 */
const ToolFilterConfig = z.object({
  enabled: z.boolean().default(true),
}).default({});

/** 子代理独立精简 preset（按 skill 映射 cohub-subagent-readonly / cohub-subagent-write）。
 *  默认开启：子代理不再继承父 preset co-orchestrator（省下每子代理 ≈2.4k tokens 的
 *  错位人设），工具表也不再带 delegate / subagent / workflow 等委派类工具。
 *  preset 缺失或挂载失败时自动降级为「继承父 preset」，绝不阻断委派。 */
const DelegateSubagentPresetConfig = z.object({
  /** 总开关；默认 true。设为 false = 回到子代理完整继承父 preset 的旧行为 */
  enabled: z.boolean().default(true),
}).default({});

export const name = "cohub";
export const inject = ["systemPrompt", "skills", "tools", "sessionProjections", "llm", "subagents"];

export const Config = z.object({
  /** 多模型共识 councillors（M4：非空时注册 council_session 工具） */
  councillors: z.array(Councillor).default([]),
  /** 单 councillor 超时（毫秒） */
  councilTimeoutMs: z.number().default(COUNCIL_TIMEOUT_MS),
  /** 子代理 provider（spawn 为内置进程内后端） */
  councilProvider: z.string().default("spawn"),
  /** skill 路由表（delegate 工具）：按 skill 名覆盖 provider/model/maxTokens/reasoningEffort，缺省继承父模型。
   *  角色专属模型即由此配置（按角色名给一条路由，如 { name: my-auditor, provider, model }），
   *  与 customRoles(工具绑定) 解耦；不配 provider/model 时只覆盖推理强度，provider/model 仍继承父会话。
   *  volatile：DSH 0.2 起由 Loader 按活动 profile entry id 投影为设置页可编辑字段，
   *  变更经 loader/volatile-update 提交到同一引用，无需重挂载（apply 内以 config.skills.get() 实时读取）。 */
  skills: volatileSchema(z.array(SkillRoute).default([])),
  /** 用户自定义团队角色（内置角色之外的扩展）：每项 name/description/prompt 必填、
   *  name 必须 kebab-case；tools 自由绑定工具插件 id（默认 []，优先于 tier）、
   *  tier 可选（快捷组合/展示用，取自 5 个档位枚举；tools 与 tier 都空 = 只读组合）。
   *  角色专属模型不在这里配，而在 skills 路由里按角色名覆盖 provider/model/maxTokens/reasoningEffort。
   *  默认 []（= 只用内置角色）。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）——用户可改、热生效。 */
  customRoles: volatileSchema(z.array(CustomRole).default([])),
  /** delegate 执行器环境契约注入（P1-1）：默认开，文本可覆盖 */
  delegateEnvContract: EnvContractConfig,
  /** delegate 中止/失败自动重试（P1-2）：默认不重试。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
  delegateRetry: volatileSchema(DelegateRetry),
  /** delegate 执行器环境契约持久化（P3-2/N1）：默认 auto（无缓存时行为不变） */
  envSignatures: EnvSignatures,
  /** 调度参数（P3-3/N3）：批大小 / 墙钟预算 / job 跟踪 / 批间自适应；settings 可覆盖。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
  schedule: volatileSchema(ScheduleConfig),
  /** 子代理结果预算（P1-3）：单次/批单任务/批总量上限与总开关；默认值即生效。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
  resultBudget: volatileSchema(ResultBudgetConfig),
  /** delegate 后台 job 模式：默认关闭；开启后 delegate 立即返回 jobId，主代理轮询 job_output。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
  delegateBackground: volatileSchema(DelegateBackgroundConfig),
  /** 子代理工具表裁剪（P1-1）：按角色 deny 裁剪，默认开启，失败自动回退全量工具 */
  toolFilter: ToolFilterConfig,
  /** 子代理独立精简 preset：按 skill 映射 readonly / write preset，默认开启。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。 */
  delegateSubagentPreset: volatileSchema(DelegateSubagentPresetConfig),
  /** 是否把内置 agent preset 安装/升级到用户 preset root（~/.dsh/.agent-presets/）。
   *  默认 true。设为 false 后本插件不再动该目录（已安装的 preset 不会自动删除，
   *  需要时手动清理 ~/.dsh/.agent-presets/ 下对应目录）。 */
  installPresets: z.boolean().default(true),
  /** 团队（角色池编组）：与 customRoles 配合，把内置角色 + 自定义角色按用途分组，
   *  每个团队映射为一个 DSH Agent 预设（presetId，省略时按 cohub-team-<id> 推导），
   *  团队切换改为在 DSH 的 Agent 预设里选择（activeTeam 已废弃）。每项 id/name/members 必填，
   *  id 必须 kebab-case，members 至少 1 个，presetId 可选。默认 []（= 未编组，行为与旧版一致）。
   *  成员是否存在、id 是否重复均由后续批次的运行时逻辑接入；注册为预设、工具表派生
   *  （customRoles.tools 优先、tier 兜底）在后续批次接入。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）——用户可改、热生效。 */
  teams: volatileSchema(z.array(Team).default([])),
  /** 已废弃：团队切换改为在 DSH 的 Agent 预设里选择（见 teams.presetId）；
   *  该字段仅作旧配置兼容，不再参与派发判定。
   *  volatile：见 skills 字段注释（0.2 Loader 投影/提交语义）。
   *  「该 id 必须存在于 teams」的检查在运行时（schema 只能表达 string）。 */
  activeTeam: volatileSchema(z.string().default("")),
});

/** 团队的解析后类型（供外部 / 测试引用） */
export type Team = ReturnType<typeof Team>;
export { ScheduleConfig, ResultBudgetConfig, DelegateBackgroundConfig, CustomRole, Team, CohubSettingsSchema };
/** 兼容/测试导出：preset 安装台账与递归复制（实现位于 preset-install.ts） */
export { copyTree, installShippedPresets, hashTree, removeInstallRecord } from "./preset-install";
// 测试与维护入口：preset 声明生成 / 幂等写入 profile patch / 活动 profile 解析
export { applyPresetPatchDeclarations, buildPresetPatchDeclarations, resolveProfilePatchPath } from "./preset-install";
// 测试与维护入口：档位 preset 的运行时注册（正解）/ 卸载 / 定义读取 / YAML 子集解析
export {
  COHUB_PRESETS_DIR,
  evaluatePlatformExpr,
  loadCohubPresetDefs,
  materializeJsTags,
  parseMiniYaml,
  registerCohubPresets,
  unregisterCohubPresets,
} from "./preset-runtime";

/**
 * 0.1 时代的 settings namespace 段 schema（settings.yaml 的 cohub.* 段）。
 *
 * DSH 0.2 起官方 settings 服务改为「按活动 profile entry id 投影 Config 的
 * `.volatile()` 字段」（SettingsForms.volatileForm），不再注册任意 cohub
 * namespace；本插件也不再调用 installSettingsSection/settingsNamespace。
 * 该 schema 保留仅为对外类型/测试 fixture（与 Config 的 volatile 字段同形状），
 * 不再参与运行时挂载。0.1 用户写在 settings.yaml 的 cohub.* 段不会被自动迁移。
 *
 * @deprecated 仅供测试/类型复用；运行时请读取 Config 的 volatile 字段（config.skills.get() 等）。
 */
const CohubSettingsSchema = z.object({
  skills: z.array(SkillRoute).default([]),
  schedule: ScheduleConfig,
  delegateRetry: DelegateRetry,
  resultBudget: ResultBudgetConfig,
  delegateBackground: DelegateBackgroundConfig,
});

/** 本包内置的 agent preset 目录（随 files 字段打包进 npm 包） */
const SHIPPED_PRESETS_DIR = fileURLToPath(new URL("../presets/", import.meta.url));

/** 本包 package.json（与 lib/ 同级）——读取当前版本用于 preset 安装台账 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 安装 / 升级内置 agent preset 到用户 preset root（`~/.dsh/.agent-presets/`）。
 *
 * 语义（见 preset-install.ts）：
 *   - 首次安装：整目录复制（含 skills/ 等子目录）；
 *   - 版本升级：只覆盖**未被用户改动**的文件，用户改过的文件跳过并告警；
 *   - 无台账（首次或从旧版本升级上来）：退化为「仅新增」，不覆盖任何已存在目录。
 * 安装失败只告警，绝不拖垮插件挂载（preset 是可选增强，技能才是核心能力）。
 */
function installAgentPresets(logger: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | undefined) {
  const r = installShippedPresets(SHIPPED_PRESETS_DIR, dshHomePath(".agent-presets"), readPackageVersion(), logger);
  // ② 把 preset **声明**幂等写入当前 profile 的 cordis.patch.yml（新版宿主按声明行注册 preset，
  //    只复制目录不够）。已存在且一致 → 不写盘；内容不同 → 保留用户版本并告警；失败不阻断挂载。
  try {
    const patchPath = resolveProfilePatchPath(dshHomePath());
    if (patchPath === null) {
      logger?.info?.("cohub: 无法判定活动 profile（$DSH_PROFILE 未设置且 profiles 下不止一个），跳过 preset 声明写入");
    } else {
      const p = applyPresetPatchDeclarations(SHIPPED_PRESETS_DIR, patchPath, logger);
      if (p.appended.length > 0) {
        logger?.info?.(
          `cohub: 已向 ${patchPath} 追加 ${p.appended.length} 条 preset 声明（${p.appended.join(", ")}）${p.backup ? `，原文件已备份为 ${p.backup}` : ""}`,
        );
      }
      if (p.conflicts.length > 0) {
        logger?.info?.(`cohub: ${p.conflicts.length} 条 preset 声明保留你的版本：${p.conflicts.join(", ")}`);
      }
      if (p.degraded !== undefined) logger?.info?.(`cohub: preset 声明写入已跳过（${p.degraded}）`);
    }
  } catch (error) {
    // 防御：声明写入是可选增强，任何异常都不得拖垮插件挂载
    logger?.warn?.("cohub: 写入 profile patch 的 preset 声明失败（不影响插件启动）", error);
  }
  return r;
}

/**
 * 读取可能是 Volatile 引用的配置字段。
 * 正常情况（schemastery ≥ 3.18.4）teams / activeTeam / customRoles 是 Volatile，取 get() 得当前快照；
 * 旧版本降级为普通值，此时直接返回原值（与 customRoles 既有降级读法一致）。
 */
function readVolatile<T>(value: T | { get(): T }): T {
  const holder = value as { get?: () => T } | undefined;
  return typeof holder?.get === "function" ? holder.get() : (value as T);
}

export function apply(ctx: any, config: any) {
  // ① 中文语言指令 —— 注入到系统提示词（对应 OpenCode 的 experimental.chat.system.transform）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "cohub:language",
    order: 95,
    text: CHINESE_LANGUAGE_INSTRUCTION,
  }), "cohub.section()");

  // ①b 团队队长人格 —— 运行时按 Config.activeTeam 的团队队长决定主代理人格。
  //    · text 是**函数**：每次 assemble 现读 volatile 配置 → 设置页换队长度热生效，无需重启；
  //    · 空串 = 不注入（宿主会丢弃空 section），故「无团队 / 队长为空 / 队长就是 co-orchestrator」
  //      三种情形下系统提示词与改动前**逐字一致**（co-orchestrator 人格由 preset persona 自带）；
  //    · 有队长时注入的是队长 brief（不是全文 content，避免撑大每轮系统提示词），并附带边界声明
  //      + 可派队员名单 + 原调度纪律段：换队长不允许丢掉 orchestrator 的调度本职。
  ctx.effect(() => ctx.systemPrompt.section({
    name: "cohub:lead",
    order: 96,
    text: () => renderLeadSection({
      teams: readVolatile(config.teams),
      activeTeam: readVolatile(config.activeTeam),
      customRoles: readVolatile(config.customRoles),
    }),
  }), "cohub.lead()");

  // ② 13 技能（12 专职代理 + orchestrator）→ runtime skills
  //    主代理用 skill 工具按需加载，再通过 subagent 委派（DSH 原生），
  //    运行时技能目录中即出现 co-explorer / co-fixer / co-council 等条目。
  //    内置技能为生成物（COHUB_SKILLS），此处原样注册、不做任何改写。
  for (const skill of COHUB_SKILLS) {
    ctx.skills.register(skill);
  }

  // ②b 用户自定义角色（Config.customRoles）→ 同构 runtime skill（内置 ∪ 自定义）
  //    · 转换：name = 角色名，description = 角色职责，正文 = prompt，metadata.tier = 档位；
  //      tier 的正源仍是 roles.ts 的 resolveTier（派发层直读 config，保持「唯一映射源」），
  //      metadata.tier 只用于技能目录展示 / 运维排查。
  //    · 冲突与脏值全部在运行时兜底：与内置重名 → 跳过并 warn；自定义之间重名 → 保留第一条并 warn；
  //      tier 非法 → 跳过并 warn。任何一条都不抛错，插件启动不受用户配置质量影响。
  //    · 热生效：customRoles 是 volatile 字段（Loader 就地提交同一引用），Volatile 只暴露 get()
  //      且宿主无配置变更回调，因此用「轮询对账 + 差量同步」——注销被删/被改的旧技能、注册新增技能。
  //    effect 返回 dispose：插件卸载时停轮询并注销全部自定义技能。
  ctx.effect(() => {
    const customRoleSkills = createCustomSkillRegistry({
      skills: ctx.skills,
      // volatile 降级（旧 schemastery）时字段是普通数组，两种形状都读
      getRoles: () => (typeof config.customRoles?.get === "function" ? config.customRoles.get() : config.customRoles),
      logger: ctx.logger,
    });
    const stopPolling = customRoleSkills.start(CUSTOM_ROLE_POLL_MS);
    return () => {
      stopPolling();
      customRoleSkills.dispose();
    };
  }, "cohub.customRoles()");

  // ②c 档位 preset 的**运行时注册**（正解，免除重启）
  //    ctx.agentPresets.register() 是「当场生效」的：内部立即 activate() → mountPreset()，
  //    因此不再需要「先把声明写进 profile 的 cordis.patch.yml，等下一次启动才加载」。
  //    · 事实源仍是包内 presets/<id>/（preset.yml + agent.cordis.yml），与 patch 声明同源；
  //    · 幂等：注册前先释放同 id 的旧注册（重复 apply / 热重载都不会撞 Duplicate）；
  //    · fail-soft：agentPresets 缺失或单个档位失败只 warn，绝不阻断插件启动；
  //    · 卸载：effect 的 dispose 里调 unregisterCohubPresets，插件卸载时清干净。
  //    注册是 async 且 apply 是同步的，故用 effect 承载 promise，不阻塞挂载。
  ctx.effect(() => {
    registerCohubPresets(ctx, ctx.logger).catch((error: unknown) => {
      ctx.logger?.warn?.("cohub: 运行时注册档位 preset 失败（忽略，回退到 profile patch 声明）", error);
    });
    return () => {
      try {
        unregisterCohubPresets(ctx, ctx.logger);
      } catch (error) {
        ctx.logger?.warn?.("cohub: 卸载运行时 preset 失败（忽略）", error);
      }
    };
  }, "cohub.agentPresets()");

  // ③ 【兼容备用】内置 agent preset（co-orchestrator / cohub-cordis / 3 个子代理档位）
  //    的目录安装 + profile patch 声明写入。
  //    ⚠️ 主场景已由 ②c 的**运行时注册**覆盖：注册当场可用，不需要重启。
  //    这里保留（不删）仅为兼容旧版 DSH（无 agentPresets 服务）与外部工具/部署脚本
  //    对 patch 声明的依赖（例如用户手工编辑过 cordis.patch.yml，或工具读该文件枚举 preset）。
  //    开关仍是 config.installPresets：false 时既不复制目录、也不写声明。
  //    回退路径：万一运行时注册在某个宿主上不可用，这份声明会在下一次启动时接管。
  if (config.installPresets !== false) {
    try {
      const r = installAgentPresets(ctx.logger);
      if (r.skipped.length > 0) {
        ctx.logger?.warn?.(
          "cohub: " + r.skipped.length + " 个 preset 文件因本地修改而在升级时被跳过：" + r.skipped.join(", "),
        );
      }
    } catch (error) {
      // 防御：安装是可选增强，任何异常都不得拖垮插件挂载
      ctx.logger?.warn?.("cohub: agent preset 安装失败（忽略）", error);
    }
  }

// ④ delegate 工具（核心）：按 skill 名路由到配置的 provider/model 并委派专职代理
  //    始终注册，不依赖 councillors 是否配置。路由表可由 DSH 0.2 设置页（按活动 profile entry
  //    id 投影的 volatile 字段）实时修改，组合层（cordis.patch.yml 的 skills）作为初始值。
  // DSH 0.2 语义：Config 的 skills/schedule/delegateRetry 是 .volatile() 字段，apply 收到的是
  //    Volatile<T> 引用（stable reference）。Loader 在 loader/volatile-update 时把新值提交到
  //    同一引用（无需重挂载）；这里每次调用 get() 取得当前快照，因此：
  //      - 下一次工具 execute 即见设置更新；
  //      - 正在执行的一次使用 execute 起始时读取的 snapshot（既有每次 execute 读 getter 的行为保持）。
  const currentSettings = () => ({
    skills: config.skills.get(),
    schedule: config.schedule.get(),
    delegateRetry: config.delegateRetry.get(),
    resultBudget: config.resultBudget.get(),
    delegateBackground: config.delegateBackground.get(),
    delegateSubagentPreset: config.delegateSubagentPreset.get(),
    // 团队过滤（Config.teams / activeTeam）：派发层据此限定可派角色；activeTeam 为空 → 不限制。
    // 两者都是 volatile，每次 execute 经 getSettings() 取当前快照 → 设置页热改即生效。
    teams: config.teams.get(),
    activeTeam: config.activeTeam.get(),
  });
  const currentSkills = () => config.skills.get();

  // 防御性 subagents 检测：使用 ctx.reflect.get('subagents', false) 而不是直接读 ctx.subagents。
  // 原因：宿主 loader（如 @cordisjs/plugin-loader 的 cordis:include）可能把本插件 wrap 成新的
  // plugin 对象，导致 cordis 仅以包装层的 inject 解析依赖；若包装层未声明 subagents，
  // 直接读 ctx.subagents 会触发 cordis proxy 的 "cannot get property "subagents" without inject"
  // 错误（启动期 plugin tree failed to load）。reflect 是 cordis 内置 accessor，始终存在；
  // get(name, false) 不走 inject 强校验，缺失返回 undefined，于是我们落到自己的明确错误。
  const subagentsService = ctx.reflect?.get?.('subagents', false);
  if (!subagentsService) {
    throw new Error("cohub: delegate tool requires the subagents service (@deepseek-ai/dsh-subagent)");
  }
  ctx.tools.register(createDelegateTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
    envSignatures: config.envSignatures,
    toolFilter: config.toolFilter,
    delegateSubagentPreset: config.delegateSubagentPreset,
  }, () => currentSettings()));

  // ④c delegate_batch 工具（批量并行委派）：一次调用并行启动多个子代理
  //    复用 delegate 的共享函数（skill 匹配、路由、契约注入），跳过 stalled 和重试。
  //    始终注册，不依赖任何可选配置。
  ctx.tools.register(createDelegateBatchTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
    envSignatures: config.envSignatures,
    toolFilter: config.toolFilter,
    delegateSubagentPreset: config.delegateSubagentPreset,
  }, () => currentSettings()));

// ④b 调度参数注入：已移除（2026-09-01）。
  //    之前通过 systemPrompt.section("cohub:schedule") 全局注入，但子代理不需要调度参数。
  //    约束改为在 presets/*/agent.cordis.yml persona 中声明，运行时代码直接读取 settings。

  

  // ⑤ council_session 工具（M4）：配置了 councillors 时注册
  if ((config.councillors ?? []).length > 0) {
    // 防御性检测：同上一处（delegate 工具）。cordis:include 等包装 loader 可能剥离 inject，
    // 直接读 ctx.subagents 会抛 cordis 框架错误；用 reflect.get 走非强校验通道。
    if (!ctx.reflect?.get?.('subagents', false)) {
      throw new Error("cohub: council tool requires the subagents service (@deepseek-ai/dsh-subagent)");
    }
    ctx.tools.register(createCouncilTool(
      {
        councillors: config.councillors,
        councilTimeoutMs: config.councilTimeoutMs ?? COUNCIL_TIMEOUT_MS,
        councilProvider: config.councilProvider ?? "spawn",
      },
      ctx,
    ));
  }

  // ⑥ tokenMeter + 预算守卫（P2-1）
  //    监听 session/event 的 request/header 事件，读取 sessionProjections 的 contextBreakdown：
  //    ① 始终输出 token 诊断日志（既有行为）；
  //    ② 消息体量超过阀值时额外打一条带数字的中文告警——**只告警，绝不阻断**（平台没有
  //       能阻断 agent loop 的公共 API）；不新增工具、不写进模型上下文，故模型可见行为不变。
  //    effect 返回 off，插件卸载时自动撤销监听。
  ctx.effect(() => {
    const off = ctx.on("session/event", (session: any, event: any) => {
      if (event.type !== "request/header") return;
      const snap = ctx.sessionProjections.snapshot(session);
      const cb = snap.values.contextBreakdown;
      if (!cb) return;
      const total = cb.systemTokens + cb.toolsTokens + cb.messageTokens;
      ctx.logger.info("[cohub token] session=" + session.id + " system=" + cb.systemTokens + " tools=" + cb.toolsTokens + " messages=" + cb.messageTokens + " total=" + total);

      const guard = resolveResultBudget(config.resultBudget.get());
      if (!guard.enabled) return;
      if (cb.messageTokens <= guard.warnMessageTokens) return;
      ctx.logger.warn(
        "[cohub budget] 上下文告警：会话 " + session.id + " 的消息体量 " + cb.messageTokens
        + " tokens 超过阀值 " + guard.warnMessageTokens + " tokens（system " + cb.systemTokens
        + " + tools " + cb.toolsTokens + " + messages " + cb.messageTokens + " = total " + total
        + "）；建议精简历史或调小 resultBudget.maxChars（子代理结果每轮都会被重发）。仅告警，不阻断。",
      );
    });
    return off;
  }, "cohub.tokenMeter()");

  // ⑧ 复盘采集器（A2）：监听 session/event，turn/end 时零 LLM 采集轮次统计并排队落盘。
  //    enabled/debounceMs 暂按硬编码缺省（本任务不新增 Config 字段，避免 guard-schema 联动）；
  //    effect 返回 dispose，插件卸载时摘监听并清理定时器。
  ctx.effect(() => {
    const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 200 });
    return () => collector.dispose();
  }, "cohub.reviewCollector()");

  // ⑩ turn-stopping 收尾闸门：turn 即将关闭且 todo 投影仍有 in_progress 时，用 agent.steer()
  //    再走一步逼模型回写状态。官方语义见 todo-gate.ts 头部注释（@mode serial + 被 await）。
  //    注册包在 effect 内并返回 off → 插件卸载时自动摘监听（todo-gate.ts 的 ⑧）。
  //    纯副作用增强：内部全程 try/catch 吞错，任何失败都不得影响 turn 关闭。
  ctx.effect(() => registerTodoGate(ctx), "cohub.todoGate()");

  // ⑨ `/cohub-review` 命令（零 turn、不经过模型）：立即返回，异步跑一次 LLM 分析生成 MD 报告。
  //    局部注入：commands + sessionQuery 两者都就绪时才挂命令；缺任一则不挂，
  //    但绝不影响主插件（全局 inject 不含这两项，否则 fiber 会停在 INACTIVE）。
  const mountReviewCommand = (child: any) => {
    try {
      registerReviewCommand(child);
    } catch (error) {
      ctx.logger?.warn?.("[cohub review] 命令挂载失败（忽略）：" + String((error as any)?.message ?? error));
    }
  };
  if (typeof (ctx as any).inject === "function") {
    (ctx as any).inject(["commands", "sessionQuery"], mountReviewCommand);
  } else {
    // 极简 stub 上下文（部分测试/嵌入式宿主）无 inject：退化为直接挂载，
    // review-command 内部对缺失服务的访问都有 try/catch 与可选链，不会抛。
    mountReviewCommand(ctx);
  }
}
