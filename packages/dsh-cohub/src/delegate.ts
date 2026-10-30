// dsh-port/src/delegate.ts —— 专职代理委派工具（核心）
// 按 skill 名路由到配置的 provider/model，并自动注入该 skill 的精简指令（brief）后 spawn 子代理。
// 子代理不继承父上下文，因此 prompt 必须自包含（skill 精简指令 + 执行器环境契约（可选）+ 用户具体任务）。
//
// P3-1（N2 停滞检测器）：可选的运行期观测器（默认关闭）。通过全局事件总线 ctx.on("session/event")
// 按 session.id === run.id 归属子代理事件，从噪声观测（S1 连续同类错误 / S2 无结果空转 /
// S3 纯推理无动作 / S4 重复调用循环）在线估计「停滞」，提前中止并复用 P1 的重试/续跑机制。
// 跨环境三态：
//   探测 —— 事件总线可用性（ctx.on 缺失自动降级关闭，维持现状）；
//   配置 —— delegateRetry.stall.* 全部默认保守（enabled=false，阈值宽）；
//   降级 —— 无事件源 / 无 abort 通道时维持现状（最终超时兜底）。
//
// P3-2（N1 环境契约持久化）：可选的「一次学习、持续使用」。delegate 运行中从 session/event
// 总线观测环境契约类错误（tool/result），同一归一化签名累计 ≥ confirmCount（缺省 2）即把
// 环境事实缓存到 dshHomePath("cohub", "env-signatures.json")（插件自管，不依赖 settings）；
// 下次 spawn 命中缓存（指纹一致 + TTL 内）→ 用确定性契约文本前馈注入，跳过探针。
// 优先级：delegateEnvContract.text（P1 手工覆盖）> manual 的 Config contract > 命中缓存
// > DEFAULT_ENV_CONTRACT（探针式）；use="off" 不读不写；读写失败静默降级，行为不劣化。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { COHUB_SKILLS, type CoHubSkill } from "./skills.ts";
import { EnvSignatureLearner, envFingerprint, normalizeErrorSignature, pickEnvContractText, readEnvSignatures, writeEnvSignatures, type EnvContractFacts, type EnvFingerprint, type EnvSignaturesConfig } from "./env-signatures.ts";
import { contentText } from "./text-utils.ts";
import { WALL_CLOCK_BUDGET_MS } from "./shared/constants.ts";
import {
  applyResultBudget,
  approxTokens,
  budgetResultWithSpill,
  resolveResultBudget,
  resolveSkillResultMaxChars,
  type ResultBudgetConfig,
} from "./result-budget.ts";
import { maybeDeferTodoNudge } from "./todo-nudge.ts";

/** 单个 skill 的路由配置（来自组合层 cordis.patch.yml 或 DSH settings 的 cohub.skills） */
export interface SkillRouteConfig {
  name: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  /** 推理强度（DSH ReasoningEffortId，adapter 拥有的不透明字符串：low/medium/high/...）。
   *  合法取值由「该 provider+model 的模型目录」决定；空串/缺省 = 不覆盖。 */
  reasoningEffort?: string;
}

/** delegate 工具运行时路由源：返回当前生效的 skill 路由表 */
export type SkillRouteSource = () => SkillRouteConfig[];

/** N2 停滞检测配置（P3-1）：默认关闭（保守），跨环境三态（探测/配置/降级） */
export interface StallDetectorConfig {
  enabled?: boolean;
  consecutiveErrors?: number;
  idleMs?: number;
  reasoningWithoutAction?: number;
  loopCount?: number;
  graceMs?: number;
  recoverable?: boolean;
  /** 内部：判定检查间隔（毫秒），非 schema 字段（测试/低延迟部署可覆盖；缺省 1000） */
  checkIntervalMs?: number;
}

/** 停滞触发时回传给调用者的结构化信息（进入 error.cause.stall / 重试 prompt 停滞诊断） */
export interface StallInfo {
  signals: string[];
  diagnostics: string;
}

/**
 * 一次 delegate attempt 的观测记录（P4）：每次 attempt 结束（成功/失败/超时/中止）上报一次。
 * 字段是 `AttemptRecord`（review-types.ts）的子集/兼容视图：skill+attempt(1-based)+
 * childSessionId+startedAt+endedAt 可直接对照；outcome 为其自由文本 outcome 的枚举化版本。
 */
export interface DelegateAttemptRecord {
  skill: string;
  /** 1-based 第几次尝试（= 循环内 attempt 索引 + 1）。 */
  attempt: number;
  /** 子会话 id；成功路径为 run.id（契约上等于子会话 session.id），拿不到时为空串。 */
  childSessionId: string;
  startedAt: number;
  endedAt: number;
  outcome: "completed" | "failed" | "timeout" | "aborted";
  stopReason?: string;
}
/** 可选观测者：不传 = 完全零行为变化（所有调用点仅在非空时才执行）。 */
export interface DelegateObserver { onAttempt?(r: DelegateAttemptRecord): void }

/** delegate 工具配置（来自插件 Config 的 delegateEnvContract / delegateRetry；未配置时用内置保守默认） */
export interface DelegateConfig {
  /** P1-1 执行器环境契约注入：默认开、可关闭、文本可覆盖 */
  delegateEnvContract?: {
    enabled?: boolean;
    text?: string;
  };
  /** P1-2 中止/失败自动重试：默认不重试（maxRetries=0），保持现状 */
  delegateRetry?: {
    maxRetries?: number;
    retryDelayMs?: number;
    retryableReasons?: string[];
    /** P3-1 N2 停滞检测：默认关闭 */
    stall?: StallDetectorConfig;
  };
  /** P3-2（N1）环境契约持久化：默认 auto（无缓存时行为不变，回退探针式） */
  envSignatures?: EnvSignaturesConfig;
  /** P3-3（N3）调度参数：maxParallelBatch / wallClockBudgetMs（settings 优先，config 为 fallback） */
  schedule?: {
    maxParallelBatch?: number;
    wallClockBudgetMs?: number;
  };
  /** 子代理结果预算（P1-3）：契约保留 + 预算裁剪 + 落盘定位；缺省值即生效 */
  resultBudget?: ResultBudgetConfig;
  /** P1-1 子代理工具表裁剪：默认开启（deny 减法，按角色裁剪；失败自动回退全量工具） */
  toolFilter?: {
    enabled?: boolean;
  };
  /** 子代理独立精简 preset（按 skill 映射 readonly / write 两个内置 preset）：
   *  默认开启。关闭后子代理回到「继承父 preset」的旧行为（人设与工具表全量继承）。
   *  preset 缺失 / 挂载失败时**自动降级继承父 preset**，绝不因此让委派失败。 */
  delegateSubagentPreset?: {
    enabled?: boolean;
  };
  /** 后台 job 模式（background delegate）：默认关闭 → 完全保持前台同步行为。
   *  开启后 delegate 把这次运行注册为 DSH 后台 job 并立即返回 jobId，
   *  主代理用 job_output 取结果（或等完成时自动唤醒），等待期间可并行推进其他工作。
   *  jobs 服务不可用 / start() 拒绝时自动降级回前台同步（对该次调用完全透明）。 */
  delegateBackground?: {
    /** 缺省判定总开关：**只影响「未显式传 background」的那一档**
     *  （enabled && defaultFor 命中 → 后台）。显式 args.background=true 永远强制后台，
     *  false 永远强制前台，都不看本字段。 */
    enabled?: boolean;
    /** 这些 skill 在「未显式传 background」时默认走后台 */
    defaultFor?: string[];
  };
}

/**
 * 并行工具纪律（注入 persona，进 system prompt）。
 * 依据 DSH agent loop 的 fail-closed 并发判定：只有显式声明 isConcurrencySafe 的工具才并发。
 * 硬约束：不得出现双花括号（persona 走 strict 插值，花括号会触发解析问题）；长度克制（每轮都在 system prompt 里）。
 */
export const PARALLEL_TOOL_DISCIPLINE =
  "【并行工具纪律】① 同一条消息内一次性发起全部独立只读查询，不要发一个等一个。"
  + "② 真并发的只读工具：read、read_image、web_search、web_fetch、subagent。"
  + "注意 glob、grep 虽然只读但不可并发（会被串行执行），别指望它们并行。"
  + "③ 可并发调用必须连续相邻，中间不要插 bash、edit、write、grep 等串行调用，"
  + "否则其后调用另起一组、并发度归零（[read, bash, read] 并发度=1，[read, read, read, bash] 并发度=3）。"
  + "④ 不要依赖平台真并发：需要 N 个互不依赖的子任务时，优先用 delegate_batch"
  + "（内部 Promise.allSettled，不依赖 agent loop 调度；该工具可用时）。";

/** delegate 委派时注入子代理的统一 persona 文本 */
export const DELEGATE_PERSONA = "你是被委派的专职代理：严格遵循任务消息中的角色定义、关键约束、输出格式与工具指令，并完成末尾的具体任务。"
  + "你的首条用户消息（下方任务书）已含 `--- 你的具体任务 ---` 分隔符，即身份判据成立：不要调用 skill 工具加载 co-orchestrator 技能——技能指令已由 brief 注入。"
  + PARALLEL_TOOL_DISCIPLINE;

/** 子代理 spawn transport 名（非 LLM provider；别跟 agentOptions.provider 搞混） */
export const DEFAULT_SPAWN_TRANSPORT = "spawn";

/** 统一入口返回的运行句柄：抹平 0.2.0（run.id）与 0.2.1（activation.childId）的差异 */
export interface SubagentRunHandle {
  id: string;
  result: Promise<any>;
  dispose: () => Promise<void>;
}

// ── P1-1 子代理工具表裁剪 ────────────────────────────────────────────────
//
// 每请求约 75 个工具 schema（native 42 个 ≈ 9,014 tokens）被子代理无差别继承，
// 而只读代理永远用不到 write/pwsh、写类代理也不该再往下委派。
//
// 机制（官方原生支持，无需自造）：SubagentStartRequest.toolFilter 被 SubagentRuntime
// 透传进 startActivation 的 composition，再由 child-agent 的 applyChildComposition
// 施为 childCtx.tools.restrict(filter)——时序在子代理创建窗口内、首次请求之前，
// 因此不污染父代理工具表，也不存在「先看见再被撤掉」的空窗。
//
// 策略：deny 减法，不用 allow 白名单。
//   - allow 会连带裁掉 todo_write / skill / list_agents / job_* / read_image 等
//     角色实际依赖的工具，漏一项就断链；deny 漏一项只是「没裁到」。
//   - restrict() 对未知名字是 loud 报错（unknown global tool），allow 拼错与 deny
//     拼错代价相同，但 allow 漏项是静默缺能力，deny 漏项无害。
//
// 硬约束：restrict() 只认**已挂载的全局工具精确名**。MCP 工具（mcp__github__*）、
// taskboard_* 以及本部署未挂载的工具一律不写；平台条件与 preset 的 disabled
// 表达式保持一致（tool-bash 仅非 win32 / tool-pwsh 仅 win32），否则换个平台
// 就是「未知名字 → 整个委派失败」。

/** 本平台实际挂载的 shell 工具名（preset 里 tool-bash 与 tool-pwsh 互斥挂载） */
const SHELL_TOOL = process.platform === "win32" ? "pwsh" : "bash";

/** 只读类代理：写入 / 执行 / 再委派全部裁掉（read、grep、glob、web、read_image 保留） */
const READ_ONLY_DENY: readonly string[] = [
  "write",
  "edit",
  SHELL_TOOL,
  "create_worktree",
  "workflow",
  "delegate",
  "delegate_batch",
  "subagent",
  "subagent_fork",
];

/** 写类代理：能干活的工具都留，只裁「再往下委派」与建工作树（避免无限套娃） */
const WRITE_DENY: readonly string[] = [
  "create_worktree",
  "workflow",
  "delegate",
  "delegate_batch",
  "subagent",
  "subagent_fork",
];

/** 通用裁剪（所有角色都加）：与本职无关的交互 / 目标循环 / 多媒体工具 */
const UNIVERSAL_DENY: readonly string[] = [
  "ask_user_question",
  "create_goal",
  "update_goal",
  "get_goal",
  "weather",
  "video_search",
];

const READ_ONLY_SKILLS = new Set([
  "co-explorer", "co-oracle", "co-planner", "co-council",
  "co-observer", "co-librarian",
  "co-rule-user", "co-rule-project", "co-rule-app",
]);

const WRITE_SKILLS = new Set(["co-fixer", "co-designer", "co-cordis"]);

/**
 * 未提供 skill（缺字段 / 空串 / 纯空白）时的兜底代理名。
 *
 * 实测事故：某次 delegate_batch 调用的某个 task 漏传 skill，原始 undefined 直接流进了
 * descriptor label（产出 `delegate_batch:xxx:undefined`）、preset 解析（拿到 undefined =
 * 不挂子代理 preset）与工具裁剪（退化成通用 deny 表）。schema 改成必填是第一道防线，
 * 这里是第二道：任何绕过校验的旧调用 / 手写 args 都兜底到 co-fixer（修复类任务最常见）。
 */
export const DEFAULT_FALLBACK_SKILL = "co-fixer";

/**
 * 按 skill 名解析子代理工具裁剪 filter（deny 减法）。
 *
 * fail-soft：任何构造异常都退回 undefined（= 全量工具，与改造前行为一致），
 * 只留一行 warn——裁剪是省 token 的优化，绝不能成为委派失败的来源。
 *
 * @param skillName - 规范化后的 skill 名（如 co-fixer）。
 * @param enabled - 总开关（Config.toolFilter.enabled，默认 true）。
 * @param logger - 可选日志器（仅用于 warn）。
 * @returns filter；undefined 表示不裁剪。
 */
export function resolveSkillToolFilter(
  skillName: string | undefined,
  enabled = true,
  logger?: { warn?: (...args: unknown[]) => void },
): { deny: string[] } | undefined {
  if (!enabled) return undefined;
  try {
    const key = (skillName ?? "").trim();
    // co-orchestrator 本身是委派发起方，被委派时保留全部工具；名字不在已知表里
    // （拼错 / 新增 skill）时只裁通用项——宁可少裁，不可炸链。
    if (key === "co-orchestrator") return undefined;
    const base = READ_ONLY_SKILLS.has(key)
      ? READ_ONLY_DENY
      : WRITE_SKILLS.has(key)
        ? WRITE_DENY
        : UNIVERSAL_DENY;
    const deny = [...new Set<string>([...base, ...UNIVERSAL_DENY])];
    return deny.length > 0 ? { deny } : undefined;
  } catch (error) {
    logger?.warn?.("[cohub toolfilter] 构造子代理工具裁剪失败，已回退全量工具："
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
}

// ── 子代理独立精简 preset ────────────────────────────────────────────────
//
// 根因（实测）：此前子代理完整继承父 preset co-orchestrator —— 每个子代理都背着一份
// 「你是主调度者、绝不亲自操作文件」的 persona（≈2.4k tokens/子代理白烧），工具表里还
// 带着 delegate / delegate_batch / subagent / subagent_fork / workflow 等委派类工具。
//
// 修法：DSH 0.2.1 的 SubagentStartRequest.agentPreset 是一等字段，child 创建时
// `presets.mount(childCtx, id)`（dsh-subagent lib/types/child-agent.js applyChildComposition），
// 官方 dsh-tool-subagent 的 Config.agentPreset 走的就是这条路。cohub 自己构造 request，
// 因此直接传 id 即可，无需 allowlist。两个 preset 随包安装在 ~/.dsh/.agent-presets/。

/** 只读子代理 preset（包内 presets/cohub-subagent-readonly；tool-fs 关掉 write/edit，不挂 shell） */
export const SUBAGENT_READONLY_PRESET = "cohub-subagent-readonly";

/** 实施类子代理 preset（包内 presets/cohub-subagent-write；含 write/edit + shell，无委派工具） */
export const SUBAGENT_WRITE_PRESET = "cohub-subagent-write";

/**
 * 按 skill 名解析子代理应挂载的独立 preset id。
 *
 * 语义（fail-soft 优先）：
 *   - 空/未传 skill → write preset（等价兜底 co-fixer：漏传 skill 的委派多为实施类任务；
 *     若返回 undefined 会退化成「继承父 preset」，把父的纯调度 persona 白烧一遍）
 *   - 只读类（explorer/librarian/observer/oracle/planner/council/rule-*）→ readonly preset
 *   - 实施类（fixer/designer/cordis）→ write preset
 *   - 任何未命中的名字（拼错 / 新增 skill 未登记）→ write preset，**与
 *     {@link resolveSkillAndRoute} 的兜底角色 co-fixer 保持一致**。此前返回 undefined
 *     会让子代理继承父会话 preset（co-orchestrator 全量工具面，含 delegate/write/pwsh），
 *     既与已兜底的「实施类」角色自相矛盾，也把父的纯调度 persona 白烧一遍。
 *   - co-orchestrator → undefined（= 继承父 preset）
 *
 * 为什么 co-orchestrator 返回 undefined：它本身是委派发起方，被委派时仍需完整工具面。
 *
 * @param skillName - 规范化后的 skill 名（如 co-fixer）。
 * @param enabled - 总开关（Config.delegateSubagentPreset.enabled，默认 true）。
 * @returns preset id；undefined 表示不指定（继承父）。
 */
export function resolveSkillAgentPreset(skillName: string | undefined, enabled = true): string | undefined {
  if (!enabled) return undefined;
  const key = (skillName ?? "").trim();
  if (key === "co-orchestrator") return undefined;
  // 空/纯空白 = 未提供 skill → 与 DEFAULT_FALLBACK_SKILL 对齐（实施类 preset）
  if (key.length === 0) return SUBAGENT_WRITE_PRESET;
  if (READ_ONLY_SKILLS.has(key)) return SUBAGENT_READONLY_PRESET;
  if (WRITE_SKILLS.has(key)) return SUBAGENT_WRITE_PRESET;
  // 未命中的名字（拼错 / 新增未登记）：兜底走实施类 write preset，与 co-fixer 兜底一致。
  // 绝不返回 undefined —— 那会让子代理继承父 preset（orchestrator 全量工具面）。
  return SUBAGENT_WRITE_PRESET;
}

/**
 * 用 restrictableNames 过滤 deny/allow 列表：只保留**真正可限制**的名字。
 * 背景（实测根因）：`tools.restrict(filter)` 会对 filter 里每个名字做 restrictableNames
 * 校验，不在名单里就 throw `unknown global tool ...`；而 restrictableNames 只含 inherited
 * （global + 祖先层）、**排除 own 层**（dsh-tools `view()`：限制只裁 scope 继承来的东西，
 * 永不裁它 own 层注册的）。preset 挂的工具在子 ctx 里成了 own 层工具 → 不在名单 →
 * 每次 spawn 都先炸一次、再被 fail-soft 丢掉整个 filter 全量重试（既没裁到，又白挨一次失败）。
 *
 * 解法：下发前先求交集，把「失败」前移成「过滤」。裁不到就是不下发（等价全量工具），绝不报错。
 *
 * @param filter - 原始裁剪意图（deny 减法 / allow 白名单）。
 * @param restrictableNames - 可限制名字集合；缺省（拿不到视图）时原样返回 filter（维持现有行为）。
 * @returns 交集后的 filter；两边都为空（无可裁项）时 undefined = 不下发
 *          （必须判空：`restrict({})` 会抛 "is a no-op" 错）。
 */
export function intersectWithRestrictable(
  filter: { allow?: string[]; deny?: string[] } | undefined,
  restrictableNames?: Set<string>,
): { allow?: string[]; deny?: string[] } | undefined {
  if (!filter || !restrictableNames) return filter;
  const allow = filter.allow?.filter(name => restrictableNames.has(name));
  const deny = filter.deny?.filter(name => restrictableNames.has(name));
  const next: { allow?: string[]; deny?: string[] } = {
    ...(allow !== undefined && allow.length > 0 ? { allow } : {}),
    ...(deny !== undefined && deny.length > 0 ? { deny } : {}),
  };
  return next.allow !== undefined || next.deny !== undefined ? next : undefined;
}

/** 统一入口的 spawn 参数 */
export interface SpawnRunSpec {
  label: string;
  prompt: Array<{ type: string; text: string }>;
  parent: any;
  /** 子代理人格前缀。0.2.1 起 SubagentStartRequest 不再把 persona 暴露给模型工具层，
   *  但服务端仍接受该字段；cohub 统一走 prompt 首块 / 原生字段两条路（见下）。 */
  persona?: string;
  /** P1-1 子代理工具表裁剪（deny 减法，见 resolveSkillToolFilter）。
   *  0.2.0 / 0.2.1 的 SubagentStartRequest 均接受 toolFilter。 */
  toolFilter?: { allow?: string[]; deny?: string[] };
  /** 子代理独立 agent preset id（见 resolveSkillAgentPreset）。
   *  DSH 0.2.1 起 SubagentStartRequest.agentPreset 是一等字段：child 创建时走
   *  presets.mount(childCtx, id) 硬切换组合，**不再继承父 preset** 的 persona 与工具表
   *  （dsh-subagent lib/types/child-agent.js applyChildComposition）。缺省 = 继承父（旧行为）。 */
  agentPreset?: string;
  agentOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  /** 降级原因的收集槽（可选）。
   *
   *  preset / toolFilter 的 fail-soft 会往这里 push 一条原因，由调用方在
   *  **result-budget 裁剪之后**拼到工具返回文本末尾——当前 DSH 进程不落盘 logger 输出，
   *  只打 warn 等于静默降级（preset 未声明、toolFilter 失效都不会被用户看到）。
   *  不传 = 保持旧行为（仅 warn），因此 delegate_batch / council 的调用面完全不受影响。
   *  注意是可变的共享数组：startSubagentRun 内部重试复用同一引用。 */
  degradeNotes?: DegradeNote[];
}

/** 一条降级提示（结构化，便于单条/多条合并成一行，不分散在多处拼字符串）。 */
export interface DegradeNote {
  /** 降级环节标识（去重键：同一环节多次重试只保留最后一次） */
  id: "preset" | "toolfilter" | "skill";
  /** 简短标题，如「子代理 preset 未生效」 */
  what: string;
  /** 后果说明，如「已降级为继承父 preset」 */
  effect: string;
  /**
   * 原因（**单行**，最多 200 字符，超出时末尾加 `…`；半角 `[` `]` 被换成全角）
   *
   * 由 {@link describeDegradeReason} 归一，渲染时 {@link formatDegradeNotes} 再归一一次（双保险）。
   */
  reason: string;
}

/** 回显 skill 名的字符上限：超出即截断加 `…`（名字本身极短，超长一定是异常输入）。 */
const SKILL_NAME_ECHO_MAX = 80;

/** 把文本压成单行（所有空白压成一个空格并去掉首尾）：渲染前的兜底归一。 */
function flattenToOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 回显文本归一：只取首行（遇 `\r` / `\n` 截断）、把空白压成单空格、方括号换成全角
 * （避免伪造 `[` / `]` 边框）、按字符数截断（超出加 `…`）。
 * 供「降级原因」与「原样回显的用户输入」（如 skill 名）共用。
 *
 * 为什么要归一：这类文本会直接拼进返回文本的 `[...]` 提示里，原始输入可能带换行
 * （破坏单行结构）、带方括号（伪造提示边界）或极长（撑爆返回预算）。
 * 归一后长度有界、恒为单行、不含半角方括号。
 */
export function firstLineClamped(raw: string, maxChars: number): string {
  const firstLine = flattenToOneLine(raw.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］");
  return firstLine.length > maxChars ? firstLine.slice(0, maxChars) + "…" : firstLine;
}

/**
 * 降级原因文本归一：只取 error.message 第一行并压平空白，截断到 200 字符（超出加 `…`）。
 *
 * 既去掉堆栈噪音，也不把内部路径/长上下文外泄。与后台降级（describeBgFallback）
 * 同一套取法 —— 那条路径已经证明「原因必须回到工具返回文本」才看得见。
 */
function describeDegradeReason(error: unknown): string {
  const message = (error as any)?.message;
  const raw = typeof message === "string" && message.length > 0 ? message : String(error);
  const text = firstLineClamped(raw, 200);
  return text.length > 0 ? text : "unknown";
}

/**
 * 把收集到的降级原因拼成返回文本末尾的一段（**无降级时返回空串**，
 * 因此正常路径的返回文本逐字不变）。
 *
 *   单条 → "\n\n[<what>，<effect>：<reason>]"
 *   多条 → "\n\n[降级提示：<what>，<effect>（<reason>）；<what2>，<effect2>（<reason2>）]"
 */
export function formatDegradeNotes(notes: readonly DegradeNote[] | undefined): string {
  if (notes === undefined || notes.length === 0) return "";
  // 兜底渲染兜底：无论 reason 来自哪条路径（未来新增调用点可能绕过 describeDegradeReason），
  // 这里统一再压成单行并限长，确保任何 reason 都不会带换行、也不会破坏 `[...]` 结构。
  const reasonOf = (note: DegradeNote): string => {
    const flat = firstLineClamped(String(note.reason ?? ""), 200);
    return flat.length > 0 ? flat : "unknown";
  };
  if (notes.length === 1) {
    const only = notes[0]!;
    return "\n\n[" + only.what + "，" + only.effect + "：" + reasonOf(only) + "]";
  }
  return "\n\n[降级提示：" + notes.map(n => n.what + "，" + n.effect + "（" + reasonOf(n) + "）").join("；") + "]";
}

/**
 * 覆盖式登记一条降级原因（同一 id 只保留最后一次）。
 *
 * 为什么覆盖而不是累加：spawn 的 fail-soft 会重试多次，同一个环节的降级会重复出现；
 * 累加只会让返回文本变长、信号变糊。notes 为 undefined（调用方不要诊断）时静默跳过。
 */
function upsertDegradeNote(notes: DegradeNote[] | undefined, note: DegradeNote): void {
  if (notes === undefined) return;
  const index = notes.findIndex(n => n.id === note.id);
  if (index >= 0) notes[index] = note;
  else notes.push(note);
}

/**
 * agentPreset 被拒 / 不可用的可识别特征 —— fail-soft 触发条件。
 *
 * 覆盖实测到的三类真实文本：
 *   ① preset 未安装：preset registry 抛 `RemoteError('agent-preset/not-found',
 *      'Unknown agent preset: <id>')`（见 dsh-agent-preset-registry lib/types/index.js）；
 *   ② preset 挂载失败：`agent-preset/invalid` + 失败行详情；
 *   ③ 运行时缺服务 / provider 无该能力：子代理 runtime 抛 `PRESET_UNAVAILABLE` /
 *      `UNSUPPORTED_CAPABILITY`（"...does not support independent agent preset selection"）。
 * 另加宽松兜底 `preset.*unavailable|preset revision`，覆盖跨版本措辞变化。
 */
const PRESET_REJECTED = /PRESET_UNAVAILABLE|agent-preset\/(not-found|invalid)|Unknown agent preset|agent preset|preset revision|preset.*unavailable/i;

/**
 * toolFilter 被拒的可识别特征：restrict() 报未知全局工具名，或 provider 无该能力 */
const TOOL_FILTER_REJECTED = /unknown global tool|toolFilter|tool filter|capabilit/i;

/**
 * restrict() 报错文本里的「已知可限制名字」清单。
 * 形如：`tools.restrict() names unknown global tool "x"; known global tools: a, b, c`
 * —— restrict() 自己就把子 ctx 的 restrictableNames 全量列出来了。
 */
const RESTRICTABLE_NAMES_IN_ERROR = /known global tools:\s*([^\n;]*)/i;

/**
 * 从 restrict() 的错误文本解析 restrictableNames（子 ctx 的「可限制」名字全集）。
 *
 * 为什么走错误文本而不是公开 API：`view()`（产出 restrictableNames 的地方）在 dsh-tools
 * 的类型里是 **private**，公开面只有 register / restrict / guard / get / schemas；而我们要的是
 * **子 ctx** 的视图，子 ctx 由 subagent runtime 内部创建，本插件根本拿不到它。
 * 唯一能如实反映「这个子 scope 允许裁哪些名字」的信息源，就是 restrict() 被拒时吐出的这份清单。
 *
 * @param message - 错误文本。
 * @returns 解析到的名字集合；文本中没有该清单（如 provider 无能力类错误）时 undefined。
 */
export function parseRestrictableNames(message: string): Set<string> | undefined {
  const matched = RESTRICTABLE_NAMES_IN_ERROR.exec(typeof message === "string" ? message : "");
  if (!matched) return undefined;
  const raw = matched[1].trim();
  if (raw.length === 0 || raw === "(none)") return new Set<string>();
  const names = raw
    .split(",")
    .map(name => name.trim().replace(/^"|"$/g, ""))
    .filter(name => name.length > 0);
  return new Set(names);
}

/**
 * 进程内已学到的 restrictableNames。
 *
 * 语义：「只有本进程第一条 spawn 可能白跑一次」——首条 spawn 失败后学到清单，
 * 之后每条 spawn 都在**下发前**求出交集，restrict() 不再因 own 层名字抛错，
 * 也就不再触发「丢 filter + 全量重试」的降级路径。
 * 失效处理：registry 变化导致交集后仍被拒时，下一次错误会刷成新清单（自愈）。
 */
let learnedRestrictableNames: Set<string> | undefined;

/** 读取已学到的 restrictableNames（诊断 / 测试） */
export function getLearnedRestrictableNames(): Set<string> | undefined {
  return learnedRestrictableNames;
}

/** 清空学习缓存（测试隔离用） */
export function resetLearnedRestrictableNames(): void {
  learnedRestrictableNames = undefined;
}

/** 两份 filter 是否等价（用于判定「求交集后有无进展」，防死循环） */
function sameToolFilter(
  a: { allow?: string[]; deny?: string[] } | undefined,
  b: { allow?: string[]; deny?: string[] } | undefined,
): boolean {
  const key = (f: { allow?: string[]; deny?: string[] } | undefined) =>
    JSON.stringify([f?.allow ?? null, f?.deny ?? null]);
  return key(a) === key(b);
}

/**
 * 跨版本 spawn 子代理的统一入口（对外）。
 *
 * 两段式 fail-soft（把「失败」前移成「过滤」）：
 *   ① **下发前**：已学过 restrictableNames 时先用它求交集，直接下发「能裁的那部分」；
 *   ② 被拒时：从 restrict() 错误文本解析 restrictableNames → 求交集 → 用**更小的 filter 重试**
 *      （而不是像旧版那样整个丢掉）。求交集后为空 / 无进展时，才退回全量工具（最后防线）。
 *
 * 因此：进程内第一条 spawn 最多白跑一次，之后每次都真裁；裁不到也绝不因 filter 失败。
 */
export async function startSubagentRun(
  ctx: any,
  provider: string,
  spec: SpawnRunSpec,
): Promise<SubagentRunHandle> {
  // 未指定 preset → 原样走（行为与改造前完全一致）
  if (spec.agentPreset === undefined) return spawnWithToolFilterFallout(ctx, provider, spec);
  try {
    return await spawnWithToolFilterFallout(ctx, provider, spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = spec.signal?.aborted === true || /abort/i.test(message);
    // 非 preset 类错误 / 中止 → 原样抛出（不掩盖真实故障）
    if (aborted || !PRESET_REJECTED.test(message)) throw error;
    // fail-soft：去掉 agentPreset 重试一次 → 子代理继承父 preset（本次改动之前的旧行为）。
    // 绝不因 preset 缺失（老安装、用户删了目录、preset 挂载失败）导致委派失败。
    // 同时把原因登记到 spec.degradeNotes：当前 DSH 进程不落盘日志，只打 warn 等于静默降级。
    const reason = describeDegradeReason(error);
    upsertDegradeNote(spec.degradeNotes, {
      id: "preset",
      what: "子代理 preset 未生效",
      effect: "已降级为继承父 preset",
      reason,
    });
    ctx?.logger?.warn?.(
      "[cohub preset] 子代理 preset \"" + spec.agentPreset + "\" 不可用，已降级为继承父 preset 重试："
      + message.slice(0, 300) + "（委派继续，不阻断）",
    );
    return spawnWithToolFilterFallout(ctx, provider, { ...spec, agentPreset: undefined });
  }
}

/**
 * 带 toolFilter fail-soft 的实际 spawn 实现（原 startSubagentRun 主体，未改动语义）。
 *
 * 两段式 fail-soft（把「失败」前移成「过滤」）：
 *   ① **下发前**：已学过 restrictableNames 时先用它求交集，直接下发「能裁的那部分」；
 *   ② 被拒时：从 restrict() 错误文本解析 restrictableNames → 求交集 → 用**更小的 filter 重试**
 *      （而不是像旧版那样整个丢掉）。求交集后为空 / 无进展时，才退回全量工具（最后防线）。
 */
async function spawnWithToolFilterFallout(
  ctx: any,
  provider: string,
  spec: SpawnRunSpec,
): Promise<SubagentRunHandle> {
  const wanted = spec.toolFilter;
  let filter = wanted === undefined
    ? undefined
    : intersectWithRestrictable(wanted, learnedRestrictableNames);
  let lastFilterError: unknown;

  // 最多 3 次：① 用缓存交集试 → ② 学到清单后交集重试 → ③ 全量工具兜底
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await startSubagentRunOnce(ctx, provider, { ...spec, toolFilter: filter });
      // 真的降级了才登记：原本想裁（wanted 有值）但最终没下发任何 filter = 子代理用全量工具。
      // 放在「成功后」而不是循环里的赋值点：中途失败/抛错时不该产出降级提示。
      if (wanted !== undefined && filter === undefined) {
        upsertDegradeNote(spec.degradeNotes, {
          id: "toolfilter",
          what: "工具裁剪未生效",
          effect: "子代理使用全量工具",
          reason: lastFilterError === undefined
            ? "可限制工具清单交集为空，无可裁项"
            : describeDegradeReason(lastFilterError),
        });
      }
      return handle;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = spec.signal?.aborted === true || /abort/i.test(message);
      // 没有 filter 可背锅 / 中止 / 非 filter 类错误 → 原样抛出（不掩盖真实故障）
      if (filter === undefined || wanted === undefined || aborted || !TOOL_FILTER_REJECTED.test(message)) {
        throw error;
      }
      lastFilterError = error;
      const learned = parseRestrictableNames(message);
      if (learned) learnedRestrictableNames = learned;
      // 交集基于「原始意图」而非上一次的 filter：清单变大时可以重新裁出更多名字
      const next = learned ? intersectWithRestrictable(wanted, learned) : undefined;
      const progressed = next !== undefined && !sameToolFilter(next, filter);
      ctx?.logger?.warn?.(
        "[cohub toolfilter] 子代理工具表裁剪被拒绝：" + message
        + (progressed
          ? "；已按可限制名字求交集（deny=" + (next?.deny ?? []).join(",")
            + (next?.allow ? " allow=" + next.allow.join(",") : "") + "）后重试"
          : "；无可裁项，回退全量工具重试"),
      );
      filter = progressed ? next : undefined;
    }
  }
  // 三次都没成功：最后一次已是全量工具仍被拒 → 把最初的 filter 错误原样抛出（非裁剪之过）
  throw lastFilterError ?? new Error("cohub: subagent spawn failed after toolFilter fallout");
}

/**
 * 探测式取 `ctx.agents` 服务（DSH 0.2.x 的 AgentRegistry）。
 *
 * 为什么不直接 `ctx.agents`：cohub 插件的 `inject` 列表里**没有** agents
 * （index.ts: `["systemPrompt","skills","tools","sessionProjections","llm","subagents"]`），
 * 而 cordis 的 Context proxy 对未 inject 的服务名会抛
 * `cannot get property "agents" without inject`。故先走非强校验通道：
 *   ① `ctx.get("agents")`（Cordis 4 把 reflect.get 混入 Context，非 strict）；
 *   ② `ctx.reflect.get("agents", false)`（strict=false：不要求提供方 fiber 活跃）；
 *   ③ 最后才试属性访问（测试桩 / 后续 inject 补齐时可用）。
 *
 * @param ctx 插件上下文
 * @returns AgentRegistry 实例（含 get/list/roots/isOwnedBy）；全通道失败返回 undefined（fail-soft）
 */
function resolveAgentsService(ctx: any): any {
  const pick = (fn: () => any): any => {
    try {
      const value = fn();
      return value === null ? undefined : value;
    } catch { return undefined; }
  };
  const viaGet = pick(() => (typeof ctx?.get === "function" ? ctx.get("agents") : undefined));
  if (viaGet !== undefined) return viaGet;
  const viaReflect = pick(() => ctx?.reflect?.get?.("agents", false));
  if (viaReflect !== undefined) return viaReflect;
  return pick(() => ctx?.agents);
}

/**
 * 直接对「已创建的子代理 scope」施加工具裁剪 —— 绕开运行时不消费 toolFilter 的问题。
 *
 * 根因（0.2.1-rc.3 实测，app.asar 内 dsh-subagent lib/index.js）：
 *   `startActivation` 组装子代理组合时写的是
 *     composition: { agentPreset: request.agentPreset }
 *   而 `applyChildComposition` 里 `if (composition.toolFilter !== void 0) tools.restrict(...)`
 *   只有在 composition 携带 toolFilter 时才会执行。于是 request.toolFilter 被**静默丢弃**：
 *   restrict 从未被调用 → 既不裁剪、也不抛错 → 不进入 spawnWithToolFilterFallout 的失败分支
 *   → 连降级提示都不会登记。这正是「只读子代理仍能看到 delegate/delegate_batch 且无提示」的原因。
 *
 * 修法：cohub 自己在 child 发布后取 `agents.get(childId).ctx.tools.restrict(filter)`。
 *   restrict 本来就是 scope-local 的层追加，语义与运行时内部那条完全一致（且晚追加同样有效，
 *   因为 view() 每次按 scope 链实时求值）。
 *
 * fail-soft：拿不到 scope / 被拒 / 交集为空都只登记一条降级提示（绝不阻断委派），
 *   保证失败一定在工具返回文本里可见。
 */
function applyChildToolFilterDirectly(
  ctx: any,
  childId: string | undefined,
  filter: { allow?: string[]; deny?: string[] } | undefined,
  degradeNotes: DegradeNote[] | undefined,
): void {
  if (filter === undefined) return;
  const noteFailure = (reason: string): void => {
    upsertDegradeNote(degradeNotes, {
      id: "toolfilter",
      what: "工具裁剪未生效",
      effect: "子代理使用全量工具（仍可见 delegate/delegate_batch 等）",
      reason,
    });
  };
  const agents = resolveAgentsService(ctx);
  if (agents === undefined) {
    // 静默跳过而非降级：走到本函数的一定是 0.2.1+ 的 startActivation 分支，而
    // startActivation 内部就用 `ownerCtx.agents.create()` 建子代理（lib/index.js:1815），
    // 故真实宿主必然存在 agents 服务；取不到只可能是单测桩 / 未来服务改名。
    // 这种情况登记「裁剪未生效」属于对外部环境的误报，故不下发提示（仍不阻断委派）。
    return;
  }
  if (childId === undefined) return;
  let child: any;
  let tools: any;
  try {
    child = agents.get(childId);
    // 必须用**属性访问**取 child ctx 上的 tools：它走 cordis 的 Context proxy，
    // 把 child 自己的 scoped ctx 作为调用上下文（createTraceable(ctx, …)），
    // restrict() 内部的 scopeOf(this.ctx) 才能拿到 child 的 scope。
    // 反过来 `child.ctx.get("tools")` 会以 ReflectService 所属的 root ctx 绑定，
    // scopeOf → undefined → 直接抛 "requires a scoped context"。
    tools = child?.ctx?.tools;
  } catch {
    tools = undefined;
  }
  if (tools === undefined || typeof tools.restrict !== "function") {
    noteFailure(child === undefined
      ? "子代理创建后未在 agents 注册表中存活（无法施加 restrict）"
      : "子代理 ctx 上取不到 tools 服务（无法施加 restrict）");
    return;
  }
  try {
    tools.restrict(filter);
    return;
  } catch (error) {
    // 与 spawnWithToolFilterFallout 同一套自愈：从错误文本学可限制名字 → 求交集 → 重试一次
    const message = error instanceof Error ? error.message : String(error);
    const learned = parseRestrictableNames(message);
    if (learned !== undefined) {
      learnedRestrictableNames = learned;
      const next = intersectWithRestrictable(filter, learned);
      if (next !== undefined) {
        try {
          tools.restrict(next);
          return;
        } catch (retryError) {
          noteFailure(describeDegradeReason(retryError));
          return;
        }
      }
    }
    noteFailure(describeDegradeReason(error));
  }
}

/**
 * 跨版本 spawn 子代理的实际实现。
 *
 * DSH 0.2.1 运行时 SubagentRuntime 移除了 start(provider, request)，改为 startActivation(spec)：
 *   - spec.provider 与 label/request/signal/delivery 同级；
 *   - request 是 Omit<SubagentStartRequest, "label" | "signal">：persona / toolFilter
 *     仍被接受（只是不再由模型面向的 subagent 工具暴露给 LLM），cohub 显式经 request 透传；
 *   - 返回 { childId, messageId?, result, dispose } —— 注意是 childId 不是 id；
 *   - delivery 必须显式传 "caller"：默认 "parent" 会在子代理 prompt 末尾追加 send_message 返回指引、
 *     并在父会话写入完成通知，而 cohub 三个工具都自行聚合结果，走 parent 路径是行为回归。
 *
 * 0.2.0 保留原生 start(provider, request)：persona / toolFilter 都是 SubagentStartRequest
 * 的一等字段（0.2.0-rc.2 的类型里就已存在），故两个分支都透传。特性探测双分支，两个版本都能跑。
 */
async function startSubagentRunOnce(
  ctx: any,
  provider: string,
  spec: SpawnRunSpec,
): Promise<SubagentRunHandle> {
  const subagents = ctx?.subagents;
  if (!subagents) throw new Error("cohub: startSubagentRun requires the subagents service");

  const signal = spec.signal ?? new AbortController().signal;

  if (typeof subagents.startActivation === "function") {
    // 0.2.1+：persona 前置到 prompt 首个 text 块补偿（原生能力不再对模型工具层暴露）
    const prompt = spec.persona !== undefined
      ? [{ type: "text", text: spec.persona }, ...spec.prompt]
      : spec.prompt;
    const receipt = await subagents.startActivation({
      provider,
      label: spec.label,
      request: {
        prompt,
        parent: spec.parent,
        ...(spec.agentPreset !== undefined ? { agentPreset: spec.agentPreset } : {}),
        ...(spec.agentOptions !== undefined ? { agentOptions: spec.agentOptions } : {}),
        ...(spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {}),
      },
      signal,
      delivery: "caller",
    });
    // request.toolFilter 在 0.2.1-rc.3 的 startActivation 里**不被消费**（其内部
    // composition 只组装 { agentPreset: request.agentPreset }），所以必须由 cohub 自己
    // 对子 scope 施加 restrict —— 见 applyChildToolFilterDirectly 的长注释。
    applyChildToolFilterDirectly(ctx, receipt.childId, spec.toolFilter, spec.degradeNotes);
    return {
      id: receipt.childId,
      result: receipt.result,
      dispose: () => receipt.dispose(),
    };
  }

  // 0.2.0 回退：provider 契约仍声明 persona / toolFilter 能力
  const run = await subagents.start(provider, {
    label: spec.label,
    prompt: spec.prompt,
    parent: spec.parent,
    ...(spec.persona !== undefined ? { persona: spec.persona } : {}),
    ...(spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {}),
    ...(spec.agentPreset !== undefined ? { agentPreset: spec.agentPreset } : {}),
    ...(spec.agentOptions !== undefined ? { agentOptions: spec.agentOptions } : {}),
    signal,
  });
  return {
    id: run.id,
    result: run.result,
    dispose: () => run.dispose(),
  };
}

/** 从 DelegateConfig 提取 envContract */
export function createEnvContract(config: DelegateConfig): { enabled: boolean; text?: string } {
  return {
    enabled: config.delegateEnvContract?.enabled ?? true,
    text: config.delegateEnvContract?.text,
  };
}

/** 归一化后的环境契约签名配置（createEnvSig 输出：use/ttlMs/confirmCount 已保证有值） */
export interface NormalizedEnvSig {
  use: "auto" | "off" | "manual";
  ttlMs: number;
  confirmCount: number;
  contract?: EnvContractFacts;
  errorCategories?: string[];
  cachePath?: string;
}

/** 从 DelegateConfig 提取 envSig 归一配置 */
export function createEnvSig(config: DelegateConfig): NormalizedEnvSig {
  return {
    use: (config.envSignatures?.use ?? "auto") as "auto" | "off" | "manual",
    ttlMs: Math.max(0, config.envSignatures?.ttlMs ?? 604_800_000),
    confirmCount: Math.max(1, Math.trunc(config.envSignatures?.confirmCount ?? 2)),
    contract: config.envSignatures?.contract,
    errorCategories: config.envSignatures?.errorCategories,
    cachePath: config.envSignatures?.cachePath,
  };
}

/** delegate / delegate_batch 共用 output 配置 */
export const DELEGATE_OUTPUT_CONFIG = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
} as const;

/** 归一化工具参数（S4）：空白折叠 + 截断，用于「同工具名 + 同参数」比较 */
function normalizeArguments(args: unknown): string {
  let raw: string;
  if (typeof args === "string") raw = args;
  else {
    try { raw = JSON.stringify(args); } catch { raw = String(args); }
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * N2 停滞看门狗（P3-1）：spawn 前挂到全局 session/event 总线，按 run.id 归属子代理事件，
 * 增量维护 S1-S4 信号状态，事件驱动 + 定时判定「停滞」，触发时经回调中止（ac.abort()）。
 * 纯观测器：不修改子代理内容，只决定「是否提前中止」（控制侧动作）。
 * 组合判定：S1 或（S2/S3/S4 任一），且「距最近一次成功工具结果 > graceMs」（最近成功过不触发）。
 */
class StallWatchdog {
  private readonly cfg: Required<StallDetectorConfig>;
  private readonly onStall: (info: StallInfo) => void;
  private off: (() => void) | null = null;
  private timer: any = null;
  private boundId: string | null = null;
  private buffer = new Map<string, any[]>();
  private triggered = false;
  private readonly maxBuffer = 5000;

  // 观测状态（每次 spawn 全新）
  private s = {
    lastToolAt: 0,
    lastToolResultAt: 0,       // 距上次工具结果（S2 用）
    lastSuccessAt: 0,          // 距最近一次成功工具结果（宽限窗口用；0 = 尚无成功）
    lastReasoningAt: 0,        // 最近一次推理产出时刻（S2 用）
    lastReasoningIndex: -1,    // 最近 reasoning-delta 的 index（按块计数，S3 用）
    sawReasoningChunks: false, // 是否已见到 chunk 级推理事件（避免与 message 级重复计数）
    reasoningStreak: 0,        // 连续推理块且期间 0 次工具调用（S3）
    consecutiveErrors: 0,      // 连续同类错误次数（S1）
    lastErrorSig: null as string | null,
    loopStreak: 0,             // 同工具+同参数且结果错误连续次数（S4）
    lastCallKey: null as string | null,
    pendingCall: null as { key: string; callId: unknown } | null,
  };

  constructor(cfg: StallDetectorConfig, onStall: (info: StallInfo) => void) {
    this.cfg = {
      enabled: cfg.enabled ?? false,
      consecutiveErrors: Math.max(1, Math.trunc(cfg.consecutiveErrors ?? 3)),
      idleMs: Math.max(0, cfg.idleMs ?? 180_000),
      reasoningWithoutAction: Math.max(1, Math.trunc(cfg.reasoningWithoutAction ?? 50)),
      loopCount: Math.max(1, Math.trunc(cfg.loopCount ?? 3)),
      graceMs: Math.max(0, cfg.graceMs ?? 30_000),
      recoverable: cfg.recoverable ?? true,
      checkIntervalMs: Math.max(50, cfg.checkIntervalMs ?? 1000),
    };
    this.onStall = onStall;
  }

  /** 挂载事件总线监听与定时检查；ctx.on 缺失（无事件源）返回 false → 调用方按降级处理 */
  attach(ctx: any): boolean {
    if (this.off) return true;
    if (typeof ctx?.on !== "function") return false;
    this.off = ctx.on("session/event", (session: any, event: any) => {
      const sid = session?.id;
      if (this.boundId === null) {
        // start 返回前：按 session.id 缓冲，稍后取 run.id 对应部分（start 返回前事件可能已产生）
        if (typeof sid === "string") {
          let list = this.buffer.get(sid);
          if (!list) { list = []; this.buffer.set(sid, list); }
          if (list.length < this.maxBuffer) list.push(event);
        }
        return;
      }
      if (sid !== this.boundId) return;
      this.consume(event);
    });
    this.timer = setInterval(() => this.check(), this.cfg.checkIntervalMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return true;
  }

  /** start 返回后绑定 run.id，回放缓冲事件并立即判定一次 */
  bind(runId: string) {
    this.boundId = runId;
    const buffered = this.buffer.get(runId) ?? [];
    this.buffer.clear();
    for (const event of buffered) this.consume(event);
    this.check();
  }

  detach() {
    if (this.off) { try { this.off(); } catch { /* 已释放 */ } this.off = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.buffer.clear();
    this.boundId = null;
  }

  private consume(event: any) {
    const type = event?.type;
    const d = event?.data ?? {};
    const now = Date.now();
    if (type === "tool/call") {
      this.s.lastToolAt = now;
      this.s.pendingCall = { key: String(d?.name ?? "") + "|" + normalizeArguments(d?.arguments), callId: d?.callId };
      // 工具调用打断纯推理连击（S3 重置）
      this.s.reasoningStreak = 0;
      this.s.lastReasoningIndex = -1;
    } else if (type === "tool/result") {
      const isError = d?.message?.isError === true || d?.error != null;
      const callId = d?.message?.callId;
      const key = this.s.pendingCall && this.s.pendingCall.callId === callId
        ? this.s.pendingCall.key
        : (this.s.pendingCall?.key ?? "");
      this.s.pendingCall = null;
      this.s.lastToolAt = now;
      this.s.lastToolResultAt = now;
      if (isError) {
        // S1：归一化签名连续相同 → 连续计数；签名变化 → 重置为 1
        // S1 停滞检测依赖签名区分度，不做数字归一，否则不同数值错误会被并成一类而误判停滞
        const sig = normalizeErrorSignature(d, { digits: "keep" }) ?? "err:unknown";
        this.s.consecutiveErrors = sig === this.s.lastErrorSig ? this.s.consecutiveErrors + 1 : 1;
        this.s.lastErrorSig = sig;
        // S4：同工具名+同参数且结果错误 → 连击；key 变化重置
        if (key && key === this.s.lastCallKey) this.s.loopStreak++;
        else { this.s.lastCallKey = key || null; this.s.loopStreak = 1; }
      } else {
        // 成功工具结果：重置 S1/S3/S4，并刷新宽限窗口
        this.s.consecutiveErrors = 0;
        this.s.lastErrorSig = null;
        this.s.reasoningStreak = 0;
        this.s.lastReasoningIndex = -1;
        this.s.loopStreak = 0;
        this.s.lastCallKey = null;
        this.s.lastSuccessAt = now;
      }
    } else if (type === "assistant/chunk") {
      const chunk = d?.chunk;
      if (chunk?.type === "reasoning-delta") {
        this.s.sawReasoningChunks = true;
        this.s.lastReasoningAt = now;
        // 按块（index 变化）计数，避免同一块的多个 delta 重复累计
        if (chunk.index !== this.s.lastReasoningIndex) {
          this.s.reasoningStreak++;
          this.s.lastReasoningIndex = chunk.index;
        }
      }
    } else if (type === "assistant/message" && !this.s.sawReasoningChunks) {
      // 无 chunk 级事件的 transport 兜底：按 assistant/message 内容里的 reasoning 块计数
      const blocks = Array.isArray(d?.message?.content) ? d.message.content : [];
      if (blocks.some((b: any) => b?.type === "reasoning")) {
        this.s.lastReasoningAt = now;
        this.s.reasoningStreak++;
      }
    }
    this.check();
  }

  /** 统一判定：S1 或（S2/S3/S4 任一）且距最近成功工具结果 > graceMs */
  private check() {
    if (this.triggered) return;
    const s = this.s;
    const cfg = this.cfg;
    const now = Date.now();
    const s1 = s.consecutiveErrors >= cfg.consecutiveErrors;
    const s2 = s.lastToolResultAt > 0
      && (now - s.lastToolResultAt) > cfg.idleMs
      && s.lastReasoningAt > s.lastToolResultAt;
    const s3 = s.reasoningStreak >= cfg.reasoningWithoutAction;
    const s4 = s.loopStreak >= cfg.loopCount;
    const fired: string[] = [];
    if (s1) fired.push("S1:连续同类错误x" + s.consecutiveErrors);
    if (s2) fired.push("S2:无结果空转");
    if (s3) fired.push("S3:纯推理无动作x" + s.reasoningStreak);
    if (s4) fired.push("S4:重复调用循环x" + s.loopStreak);
    if (fired.length === 0) return;
    // 宽限窗口：最近成功过且未超宽限 → 不触发
    const graceOk = s.lastSuccessAt === 0 || (now - s.lastSuccessAt) > cfg.graceMs;
    if (!graceOk) return;
    this.triggered = true;
    const diag = "停滞检测触发 [" + fired.join(", ") + "]；距最近成功工具结果 "
      + (s.lastSuccessAt === 0 ? "无" : (now - s.lastSuccessAt) + "ms")
      + "；最近工具结果 " + (s.lastToolResultAt === 0 ? "无" : (now - s.lastToolResultAt) + "ms 前");
    const info: StallInfo = { signals: fired, diagnostics: diag };
    // 延迟到微任务：避免在事件派发栈内重入中止；detach 后（run 已结束）不再触发
    queueMicrotask(() => { if (this.triggered && this.off) this.onStall(info); });
  }
}

/**
 * 按 skill 名精确匹配 COHUB_SKILLS；缺失或未知时兜底 co-fixer 并 warn。
 * 同时查找该 skill 的路由配置（找不到返回 undefined）。
 *
 * 规范化：先 trim，空串/纯空白一律视为「未提供」。此前 `requestedSkill || "co-fixer"`
 * 只挡得住空串，挡不住 `"   "`（truthy → 走 unknown skill 分支），也让空缺的 skill
 * 直接以 undefined 进入 label 与 preset 解析（实测产出 `:undefined`）。
 *
 * 注意：路由查找使用规范化后的 requested（可能为空），而非兜底后的 skill 名 ——
 * 兜底来的 co-fixer 不该冒领用户在路由表里为 co-fixer 配置的 provider/model。
 *
 * @returns fallback=true 表示 skill 缺失/空白、已兜底到 {@link DEFAULT_FALLBACK_SKILL}；
 *          note 为可选降级说明（skill 名未匹配 / skill 缺失兜底 / preset 随之回退），
 *          由调用方推进 degradeNotes，最终出现在工具返回文本里。
 */
export function resolveSkillAndRoute(
  requestedSkill: string,
  getRoutes: SkillRouteSource,
  ctx: any,
  logger?: any,
): { skill: CoHubSkill; route: SkillRouteConfig | undefined; fallback: boolean; note?: string } {
  const requested = (typeof requestedSkill === "string" ? requestedSkill : "").trim();
  const skillName = requested || DEFAULT_FALLBACK_SKILL;
  const fallback = requested.length === 0;
  // 回显用的 skill 名：先归一（首行 / 压空白 / 截断到 80 字符）再拼进 note。
  // 原始名字来自模型输入，可能超长、带换行或带 `]`，原样拼接会破坏返回文本的
  // `[...]` 单行结构，并能绕过结果预算；归一后长度有界、恒为单行。
  const echoName = firstLineClamped(skillName, SKILL_NAME_ECHO_MAX) || "unknown";
  let skill = COHUB_SKILLS.find(s => s.name === skillName);
  let note: string | undefined;
  if (!skill) {
    (logger ?? ctx.logger)?.warn?.('delegate: unknown skill "' + skillName + '", falling back to co-fixer');
    skill = COHUB_SKILLS.find(s => s.name === DEFAULT_FALLBACK_SKILL)!;
    // 拼错 / 未登记的 skill 名：角色与 preset 一起落到 co-fixer（实施类 write preset），
    // 原因必须回到返回文本，否则调用方只会看到「跑出一个 co-fixer」而不知道是自己写错了名字。
    note = '传入的 skill 名 "' + echoName + '" 未匹配任何 co-* 代理，已兜底为 '
      + DEFAULT_FALLBACK_SKILL + "，子代理 preset 同步回退为实施类 " + SUBAGENT_WRITE_PRESET;
  } else if (fallback) {
    (logger ?? ctx.logger)?.warn?.(
      "delegate: skill 未提供（缺字段/空串/纯空白），已兜底为 " + DEFAULT_FALLBACK_SKILL
      + "；schema 已要求必填，出现本告警说明调用绕过了参数校验",
    );
    note = "skill 未提供（缺字段/空串/纯空白），已兜底为 " + DEFAULT_FALLBACK_SKILL
      + "，子代理 preset 回退为实施类 " + SUBAGENT_WRITE_PRESET;
  }
  // 路由查找使用规范化后的 requested（可能为空），而非 skillName（兜底后）
  const route = (getRoutes() ?? []).find(s => s.name === requested);
  return { skill, route, fallback, ...(note === undefined ? {} : { note }) };
}

/**
 * 生成 descriptor label 里的 skill 片段：兜底时显式标注 `(default:co-fixer)`，
 * 绝不把 undefined/空串塞进 label（label 是事后排查的唯一锚点）。
 */
export function formatSkillLabel(skill: CoHubSkill, fallback: boolean): string {
  return fallback ? skill.name + " (default:" + DEFAULT_FALLBACK_SKILL + ")" : skill.name;
}

/**
 * 归一化推理强度：非字符串 / 空串 / 纯空白 一律视为「未配置」（undefined）。
 *
 * 必须归一化空串：官方设置页的文本字段被清空时会写回 ""（schemastery 的可选 string
 * 保留 ""，实测不吞空串），若把 "" 传给 DSH，会被当成一个显式档位去校验，
 * 以 UNSUPPORTED_REASONING_EFFORT 硬失败。
 */
export function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 根据路由配置构造 agentOptions。
 *
 * 三种出口（DSH 语义见 dsh-subagent resolveChildAgentOptions）：
 *   ① 配了 provider 且 provider 可用 → 覆盖 provider/model(/maxTokens/reasoningEffort)；
 *   ② 未配 provider、但配了 reasoningEffort → **只交出 { reasoningEffort }**
 *      （provider/model 仍继承父会话）。这是有意为之：DSH 先继承父的 provider/model/
 *      reasoningEffort/maxTokens，再展开 requested（本函数的返回值）覆盖，因此「只配强度、
 *      不配模型」是官方支持的差异化配置（例如让 co-explorer 用 low、co-oracle 用 high，
 *      两者都跑父会话的模型）。旧版此处 `if (!route?.provider) return undefined;` 会把这种
 *      配置静默丢弃。
 *   ③ 未配 provider 且未配强度 / provider 配了但不在可用集合 → 返回 undefined（完全继承，
 *      与旧行为一致）。provider 不可用时连强度一起丢弃：此时子代理会落到父会话的
 *      provider+model，而那段强度未必被父模型支持（会硬失败），保持「配置失效即完全继承」
 *      这一既有安全语义，只记一条告警。
 *
 * 模型回退（P4-1）：route 只配了 provider、没配 model 时**不能**只交出 provider ——
 * 子代理会回落到父会话的模型名，而该模型名往往不属于这个 provider，请求在发出前就会以
 * `UNKNOWN_MODEL` 失败（DSH 实测：provider: tokenproto + 继承父模型 deepseek-flash → 秒失败）。
 * 这里改为向该 provider 查询模型目录并取第一个（适配器偏好顺序的第一项）作为回退模型，
 * 使「留空则继承」退化为「用该 provider 自己的默认模型」这一安全语义。
 * 查询失败或无可用模型时保持原样（不传 model），维持旧行为，交由上层报错。
 *
 * reasoningEffort 预校验（fail-soft）：DSH 在发出请求前用模型目录校验档位，不支持的档位
 * 直接抛 UNSUPPORTED_REASONING_EFFORT（"no clamping or aliasing is performed"）。为免
 * 「改了个档位导致整次委派秒失败」，这里在 provider+model 都确定时先用 resolveModelInfo
 * 查该模型的 efforts，不支持就丢弃强度并告警（委派照常进行，只是按模型默认档跑）。
 * 无法判定时（无 resolveModelInfo / 查询抛错 / model 未定）一律放行，不改变既有行为。
 */
/**
 * P1-2 模型分层默认值：路由表未显式配置时，按 skill 名给保守默认。
 *
 * 用户已配置的字段**永远优先**——本函数只提供缺省值，绝不覆盖任何显式配置。
 * 依据：统一「高推理档 + 大输出预算」会让只做定位/读图的代理白付延迟与输出预算；
 * 探索类只降推理强度，实施类需要足够大的 maxTokens，规划类输出本来就短。
 * 其余代理（oracle / council / designer / rule-*）保持不动（完全继承父会话）。
 *
 * @param skillName 兜底后的 skill 名（COHUB_SKILLS 中的 name）
 * @returns 该 skill 的缺省 agentOptions 片段；无分层默认时 undefined
 */
export function skillTierDefaults(skillName: string | undefined): Record<string, unknown> | undefined {
  switch (skillName) {
    case "co-explorer":
    case "co-librarian":
    case "co-observer":
      return { reasoningEffort: "low" };
    case "co-fixer":
      return { maxTokens: 8192 };
    case "co-planner":
      return { maxTokens: 4096 };
    default:
      return undefined;
  }
}

export async function buildAgentOptions(
  route: SkillRouteConfig | undefined,
  ctx: any,
  skillName?: string,
): Promise<Record<string, unknown> | undefined> {
  const tier = skillTierDefaults(skillName);
  if (!route) {
    if (!tier) return undefined;
    // ③' 未配置路由但该 skill 有分层默认值：只交出分层字段（provider/model 仍继承父会话）
    ctx?.logger?.info?.(
      "[cohub tier] " + String(skillName) + " 未配置路由，启用模型分层默认值 " + JSON.stringify(tier),
    );
    return { ...tier };
  }
  const effort = normalizeReasoningEffort(route.reasoningEffort);

  // ② 只配强度、不配 provider：交出部分 options（provider/model 由 DSH 继承父会话）
  if (!route.provider) {
    // P1-2：用户没配的字段才用分层默认补（显式配置永远优先）
    const merged: Record<string, unknown> = {};
    const effectiveEffort = effort ?? normalizeReasoningEffort(tier?.reasoningEffort);
    if (effectiveEffort) merged.reasoningEffort = effectiveEffort;
    if (typeof tier?.maxTokens === "number") merged.maxTokens = tier.maxTokens;
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  const available = new Set(ctx.llm.listProviders().map((p: any) => p.id));
  if (!available.has(route.provider)) {
    if (effort) {
      ctx.logger?.warn?.(
        '[cohub route] ' + route.name + ' 配置的 provider "' + route.provider
        + '" 当前不可用，推理强度 "' + effort + '" 一并忽略（完全继承父会话）',
      );
    }
    return undefined;
  }

  const options: Record<string, unknown> = { provider: route.provider };
  if (route.model) {
    options.model = route.model;
  } else {
    const fallback = await resolveProviderFallbackModel(route.provider, ctx);
    if (fallback) {
      options.model = fallback;
      ctx.logger?.info?.(
        '[cohub route] ' + route.name + ' 未配置 model，回退为 provider "'
        + route.provider + '" 的首个模型 "' + fallback + '"',
      );
    } else {
      ctx.logger?.warn?.(
        '[cohub route] ' + route.name + ' 未配置 model，且无法解析 provider "'
        + route.provider + '" 的可用模型；将继承父会话模型（可能因模型不属于该 provider 而失败）',
      );
    }
  }
  if (route.maxTokens) options.maxTokens = route.maxTokens;
  else if (typeof tier?.maxTokens === "number") options.maxTokens = tier.maxTokens;
  // P1-2：分层默认的推理强度同样走预校验（fail-soft，判定不了时放行）
  const effectiveEffort = effort ?? normalizeReasoningEffort(tier?.reasoningEffort);
  if (effectiveEffort) {
    const eff = effectiveEffort;
    // 预校验只在 provider+model 都确定时进行（model 可能是上面解析出的回退模型）
    const supported = await isReasoningEffortSupported(route.provider, options.model as string | undefined, eff, ctx);
    if (supported === false) {
      ctx.logger?.warn?.(
        '[cohub route] ' + route.name + ' 的模型 "' + route.provider + '/' + String(options.model)
        + '" 不支持推理强度 "' + eff + '"，已忽略该强度（按模型默认档执行）',
      );
    } else {
      options.reasoningEffort = eff;
    }
  }
  return options;
}

// ── 嵌套委派上限（depth guard） ──────────────────────────────────────────
//
// 依据（真实会话实测）：一条 `main → planner(1) → oracle(2) → explorer(3) → 更深(4)` 的
// 4 层嵌套链，最深层跑 59s **只调了一次 skill 就结束**——每多一层，子代理就要各自重建一份
// 完整上下文（系统提示 + 工具表 + skill brief），产出却逐层稀薄，是纯开销。
//
// 数据来源（已核对 DSH 本体 asar 内 `@deepseek-ai/dsh-subagent/lib/types/depth.js`）：
//   export function delegationDepthOf(agent) {
//     const runtime = agent.options.subagentDepth;
//     ...
//     return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);
//   }
// 即官方口径是「会话 header 里持久化的 delegationDepth」与「运行期 options.subagentDepth」
// 取较大者。session header 就是会话日志首行那个 `{"type":"session",...}` 对象，实测确实带
// `delegationDepth` 字段（主会话为 0），本插件取父会话 id 时用的 `exec.agent.session.header.id`
// 与该对象是同一处，故 `agent.session.header.delegationDepth` 是可靠主来源。
//
// 三态（fail-open）：拿得到且 depth < MAX → 放行；拿得到且 depth ≥ MAX → 直接拒绝；
// 三处候选全缺失/非法且 header 未标记 `origin === "subagent"` → **warn 后放行**（返回 undefined）：
// 宿主版本差异不该让编排直接瘫痪，深度元数据读不到时按兼容策略继续，只留诊断日志备查。
// 代价是一条可能无限嵌套的链也能派生（见文件末尾 risk 说明）。

/** 嵌套委派上限：1 = 子代理不可再派子代理（主代理 depth=0 仍可派 1 层） */
export const MAX_DELEGATION_DEPTH = 1;

/**
 * 取当前 agent 的嵌套委派深度（0 = 主代理；1 = 一层子代理）。
 *
 * 逐层探测，任一层能给出合法值即返回；同时读 header（持久化）与 options（运行期），
 * 取较大者以复刻官方 `delegationDepthOf` 的 Math.max 语义。
 *
 * 兜底：header 明确标记 `origin === "subagent"` 却没写深度时按 1 层处理——子会话的
 * header 由 DSH 自己写入（`origin: "subagent"` 与 `delegationDepth` 总是同时出现），
 * 因此这条兜底只在极老版本上才会生效，语义仍是「我是子代理」。
 *
 * @param agent 调用方 agent（`exec.agent`）
 * @returns 深度；所有候选都取不到时 undefined（调用方据此**放行**，见 guardDelegationDepth）
 */
export function resolveDelegationDepth(agent: any): number | undefined {
  const header = agent?.session?.header;
  const candidates: unknown[] = [
    header?.delegationDepth,        // 主来源：会话 header 里持久化的深度
    agent?.options?.subagentDepth,  // 运行期镜像（官方取两者较大者）
    agent?.session?.delegationDepth, // 防御：某些版本把深度挂在 session 本体上
  ];
  let depth: number | undefined;
  for (const value of candidates) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
    depth = depth === undefined ? value : Math.max(depth, value);
  }
  if (depth === undefined && header?.origin === "subagent") return MAX_DELEGATION_DEPTH;
  return depth;
}

/**
 * 把一个深度候选值渲染成「原始值(typeof)」诊断片段，如 `undefined(undefined)` / `"0"(string)`。
 *
 * 仅用于「深度无法判定」路径的 warn：resolveDelegationDepth 会静默跳过非 number 的候选，
 * 若只报「缺失或非法」，就无法区分**元数据真缺失**与**类型写错（宿主写成字符串 "0"）**。
 */
function describeDepthCandidate(value: unknown): string {
  const kind = value === null ? "null" : typeof value;
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return shown + "(" + kind + ")";
}

/**
 * 嵌套委派守卫：子代理（depth ≥ MAX_DELEGATION_DEPTH）再派子代理时返回拒绝文案。
 *
 * 只读判定，无副作用（拿不到深度时打 `[cohub depth-guard]` warn 并**放行**，fail-open）。
 *
 * @param agent 调用方 agent（`exec.agent`）
 * @param logger 可选日志器（仅用于 warn）
 * @returns 拒绝文案；undefined = 放行
 */
export function guardDelegationDepth(agent: any, logger?: any): string | undefined {
  const depth = resolveDelegationDepth(agent);
  if (depth === undefined) {
    // fail-open：读不到深度时只 warn 后放行（与 commit 6c5c968 之前的行为一致）——宿主版本
    // 差异或元数据缺口不该让整条编排链拒绝服务。放行前仍打出三候选的原始值与 typeof，
    // 这样「元数据缺失」和「类型错（"0"）」在日志里可区分，排障照旧可用。
    const header = agent?.session?.header;
    logger?.warn?.("[cohub depth-guard] 深度候选原始值："
      + "header.delegationDepth=" + describeDepthCandidate(header?.delegationDepth)
      + " / options.subagentDepth=" + describeDepthCandidate(agent?.options?.subagentDepth)
      + " / session.delegationDepth=" + describeDepthCandidate(agent?.session?.delegationDepth)
      + " / header.origin=" + describeDepthCandidate(header?.origin));
    logger?.warn?.("[cohub depth-guard] 无法判定委派深度，按兼容策略放行（fail-open）"
      + "：session.header.delegationDepth / options.subagentDepth / session.delegationDepth 均缺失或非法，"
      + "且 header.origin 不是 \"subagent\"；本次委派继续执行，嵌套上限不再生效。"
      + "若上面某候选是字符串 \"0\" 之类的类型错误，请修宿主（合法值为 number 且为安全整数）");
    return undefined;
  }
  if (depth < MAX_DELEGATION_DEPTH) return undefined;
  return "拒绝：子代理不可再派子代理（当前嵌套 depth=" + depth + "，上限 " + MAX_DELEGATION_DEPTH
    + "）。请自己用 read/grep/glob 获取信息，或把需求回传主代理。";
}

/**
 * 取父会话 id（spill 落盘的归属命名空间）。
 *
 * 取法与官方消费方完全一致：`exec.agent.session.header.id`
 * （见 @deepseek-ai/dsh-spill-policy/lib/index.js 的 ownerSessionId）。
 *
 * @param exec 工具执行上下文
 * @returns 会话 id；缺失时 undefined（此后跳过落盘，只裁剪）
 */
export function resolveOwnerSessionId(exec: any): string | undefined {
  const id = exec?.agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * 取后台任务注册表服务（`ctx.jobs`，由 @deepseek-ai/dsh-jobs-local 提供；`dsh-tool-jobs`
 * 提供「控制器」使 `start()` 对该 owner 可用）。
 *
 * 取法与 result-budget 取 spillStore 一致：先走 ctx.get 非 inject 通道，再退到
 * ctx.reflect.get（cordis 内置 accessor）。**绝不直接读 ctx.jobs**——包装 loader 会触发
 * cordis 的 inject 强校验报错。
 *
 * 解析顺序：**优先 owner（agent）的 ctx，其次插件 ctx**。dsh-jobs-local 的 `start()`
 * 用 `servesOwner(spec.owner)` 按 scope / controller layer 判定该 owner 是否可后台化，
 * 而 controller 是由 dsh-tool-jobs 挂到具体组合（agent scope）里的；只从插件 ctx（host 层）
 * 解析实例会撞上跨 layer 的 controller 缺口并抛 "no job controller serves this agent"。
 * 都取不到时返回 undefined，由调用方降级到前台。
 *
 * @param ctx 插件上下文（兜底通道）
 * @param owner 任务 owner（`exec.agent`），其 `ctx` 才是权威解析起点
 */
export function resolveJobsService(ctx: any, owner?: any): any {
  const pick = (c: any) => {
    if (!c) return undefined;
    try {
      const viaGet = typeof c.get === "function" ? c.get("jobs") : undefined;
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    } catch { /* 落到 reflect 通道 */ }
    try {
      const viaReflect = c.reflect?.get?.("jobs", false);
      if (viaReflect !== undefined && viaReflect !== null) return viaReflect;
    } catch { /* 本层取不到，交给调用方的下一顺位 */ }
    return undefined;
  };
  // 关键：必须优先用 **owner（agent）的 ctx** —— dsh-jobs-local 的 start() 用
  // servesOwner(spec.owner) 按 scope/controller layer 判定，从插件 ctx（host 层）
  // 解析到的实例往往不覆盖该 agent scope 的 controller，会抛
  // "no job controller serves this agent" 并导致无谓降级。插件 ctx 保留为兜底。
  return pick(owner?.ctx) ?? pick(ctx);
}

/**
 * 解析后台 job 的 owner —— dsh-jobs-local 只接受「存活的 Agent 实例」：
 * `ensureOwnerCleanup(owner)`（lib/index.js:394-403）用 `agents.get(owner.id)` 校验实例身份、
 * 用 `owner.ctx.effect` 挂释放回调，`servesOwner` / `scopeOf`（:281）用 `owner.ctx` 做 controller 分层。
 * 因此 `owner.id` 必须是**字符串**、`owner.ctx` 必须可挂 effect。
 *
 * 实测把 `exec.agent` 原样当 owner 会以 `session "[object Object]" has no live agent` 降级：
 * 该字段在部分 DSH 版本里不是 Agent 实例本身（`id` 是对象），却被当 session 标识使用。
 * 故按官方契约探测：自身 → `.agent` / `.session.agent` / `.current` → agents 注册表按父 session id 反查。
 * 全部失败时返回入参（保持原行为：jobs.start 抛错 → 回退前台并把原因回传）。
 *
 * @param parent 调用方 agent（`exec.agent`）
 * @param ctx 插件上下文（取 agents 注册表的兜底通道）
 */
export function resolveJobOwner(parent: any, ctx: any): any {
  const isAgentLike = (x: any): boolean => !!x && typeof x === "object"
    && typeof x.id === "string" && x.id.length > 0 && x.ctx !== undefined;
  if (isAgentLike(parent)) return parent;
  for (const candidate of [parent?.agent, parent?.session?.agent, parent?.current]) {
    if (isAgentLike(candidate)) return candidate;
  }
  // agents 注册表反查：jobs-local 用 agents.get(owner.id) 校验存活，同一注册表可把 session 映射回实例
  const pickService = (c: any) => {
    if (!c) return undefined;
    try {
      const viaGet = typeof c.get === "function" ? c.get("agents") : undefined;
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    } catch { /* 落到 reflect 通道 */ }
    try {
      const viaReflect = c.reflect?.get?.("agents", false);
      if (viaReflect !== undefined && viaReflect !== null) return viaReflect;
    } catch { /* 本层取不到，交给下一顺位 */ }
    return undefined;
  };
  const sessionId = resolveOwnerSessionId({ agent: parent });
  const agents = pickService(parent) ?? pickService(ctx);
  if (agents && sessionId) {
    try {
      const direct = typeof agents.get === "function" ? agents.get(sessionId) : undefined;
      if (isAgentLike(direct)) return direct;
    } catch { /* 键不是 session id：继续扫注册表 */ }
    try {
      const raw = typeof agents.list === "function" ? agents.list() : undefined;
      const all: any[] = raw === undefined ? [] : (Array.isArray(raw) ? raw : Array.from(raw));
      const found = all.find((a: any) => a?.id === sessionId
        || a?.session?.id === sessionId || a?.session?.header?.id === sessionId);
      if (isAgentLike(found)) return found;
    } catch { /* 注册表不可枚举：放弃探测，回退原行为 */ }
  }
  return parent;
}

/** 0.2.x 契约：owner = 调用方 agent 的 session id 字符串；jobs 服务自己 agents.get(id) 解析实例。
 *  0.1.x 只认实例、传字符串会被拒，故保留实例作为降级重试值。 */
export function resolveJobOwnerId(parent: any): string | undefined {
  const asId = (x: any) =>
    typeof x === "string" && x.length > 0 ? x
    : (typeof x?.id === "string" && x.id.length > 0 ? x.id
    : (typeof x?.session?.id === "string" && x.session.id.length > 0 ? x.session.id : undefined));
  return asId(parent) ?? asId(parent?.agent) ?? asId(parent?.session) ?? undefined;
}

/** 子代理结果预算处理的调用参数 */
export interface SubagentBudgetOptions {
  /** 本段字符上限 */
  maxChars: number;
  /** 语义范围（"delegate" / "batch:task"，用于日志与落盘命名） */
  scope: string;
  /** 段标识（skill 名 / taskId） */
  label: string;
  /** 是否启用（false 时原样返回，完全回到旧行为） */
  enabled: boolean;
  /** 来源工具名（用于落盘命名） */
  toolName?: string;
}

/**
 * 把子代理结果按预算裁剪并（超预算时）落盘定位——delegate / delegate_batch 共用。
 *
 * 行为：
 *   - `enabled=false` 或未超预算 → **原样返回**（零行为变化）；
 *   - 超预算 → 走 result-budget 的单一入口（先落盘拿 locator，再裁剪）；
 *   - 任一步异常 / 落盘失败 → **fail-soft**：返回原文，只告警，绝不因预算逻辑丢掉结果。
 *
 * @param ctx 插件上下文（转发给 spillStore）
 * @param exec 工具执行上下文（取父会话 id）
 * @param raw 子代理结果原文
 * @param options 预算参数
 * @returns 回传给父代理的文本
 */
export async function budgetSubagentResult(
  ctx: any,
  exec: any,
  raw: string,
  options: SubagentBudgetOptions,
): Promise<string> {
  const text = typeof raw === "string" ? raw : "";
  if (!options.enabled || text.length === 0) return text;
  try {
    const budgeted = await budgetResultWithSpill(ctx, text, {
      maxChars: options.maxChars,
      scope: options.scope,
      label: options.label,
      toolName: options.toolName ?? "delegate",
      sessionId: resolveOwnerSessionId(exec),
    });
    if (budgeted.truncated) {
      const locatorNote = budgeted.locator
        ?? ("落盘失败" + (budgeted.spillReason ? "（" + budgeted.spillReason + "）" : ""));
      ctx?.logger?.warn?.(
        "[cohub budget] " + options.scope + " " + options.label + "：子代理结果 " + budgeted.fullChars
        + " 字符 ≈ " + approxTokens(budgeted.fullChars) + " tokens 超过预算 " + options.maxChars
        + " 字符，已裁剪保留 " + budgeted.keptChars + " 字符；locator=" + locatorNote + "。仅告警，不阻断。",
      );
    }
    return budgeted.text;
  } catch (error) {
    ctx?.logger?.warn?.(
      "[cohub budget] " + options.scope + " " + options.label + " 预算处理失败，回退原文（"
      + (error instanceof Error ? error.message : String(error)) + "）",
    );
    return text;
  }
}

/**
 * 查询某 provider+model 的模型目录，判断该推理强度是否被支持。
 * @returns true 支持 / false 明确不支持 / undefined 无法判定（放行，不改变行为）
 *
 * 只读查询；resolveModelInfo 缺失（老宿主 / 测试 stub）或抛错都返回 undefined，
 * 让调用方维持「照传」的既有行为，而不是因查询失败把用户的配置丢掉。
 */
async function isReasoningEffortSupported(
  provider: string,
  model: string | undefined,
  effort: string,
  ctx: any,
): Promise<boolean | undefined> {
  if (!model) return undefined; // 继承父模型时无法在本层判定
  const resolve = ctx?.llm?.resolveModelInfo;
  if (typeof resolve !== 'function') return undefined;
  try {
    const info = await resolve.call(ctx.llm, provider, model);
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return false; // 该模型不暴露任何档位
    return efforts.some((e: any) => e && e.id === effort);
  } catch {
    return undefined;
  }
}

/**
 * 解析某个 provider 模型目录中的第一个模型 id。
 * 只读查询；任何失败（未实现 listModels / 目录为空 / 抛错）都返回 undefined，
 * 使调用方维持既有行为，而不是让整次委派失败。
 */
async function resolveProviderFallbackModel(provider: string, ctx: any): Promise<string | undefined> {
  try {
    const listModels = ctx?.llm?.listModels;
    if (typeof listModels !== 'function') return undefined;
    const models = await listModels.call(ctx.llm, provider);
    if (!Array.isArray(models)) return undefined;
    const first = models.find((m: any) => m && typeof m.id === 'string' && m.id);
    return first ? first.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析执行器环境契约文本。
 * 优先级：manualText > manual contract > 命中缓存（指纹一致 + TTL 内）> DEFAULT_ENV_CONTRACT。
 * envContract.enabled 为 false 时返回空字符串。
 *
 * fpOverride：调用方已算好的指纹（避免同一流程内重复探测）。
 * 省略时现场计算——envFingerprint 自身已进程内记忆化，重复调用不再是 I/O 成本。
 */
export function resolveContractText(
  envContract: { enabled: boolean; text?: string },
  envSig: EnvSignaturesConfig,
  ctx: any,
  fpOverride?: EnvFingerprint,
): { text: string; source: string } {
  if (!envContract.enabled) return { text: "", source: "disabled" };
  const fp = fpOverride ?? envFingerprint();
  const cached = envSig.use !== "off" ? readEnvSignatures(envSig.cachePath) : null;
  const picked = pickEnvContractText({
    manualText: envContract.text,
    envSig,
    cached,
    fingerprint: fp,
  });
  if (picked.source === "cache") {
    ctx.logger?.info?.("[cohub envsig] 命中环境契约缓存（指纹一致 + TTL 内）");
  }
  const text = "\n\n--- "
    + (picked.source === "cache" || picked.source === "manual-contract"
      ? "执行器环境契约（本环境已验证）"
      : "执行器环境契约（通用原则 + 探测式自适应）")
    + " ---\n\n" + picked.text;
  return { text, source: picked.source };
}

/**
 * 构建委派给子代理的完整 prompt。
 * 拼接：skill 的 brief（或 content）+ contractText + 任务分隔 + userPrompt + retryNote。
 */
export function buildDelegatePrompt(params: {
  skill: CoHubSkill;
  contractText: string;
  userPrompt: string;
  retryNote?: string;
}): string {
  return (params.skill.brief || params.skill.content) + params.contractText + "\n\n--- 你的具体任务 ---\n\n" + params.userPrompt + (params.retryNote ?? "");
}

/**
 * 创建 delegate 工具。
 * 按 skill 名精确匹配 COHUB_SKILLS，注入该 skill 的精简指令（brief）+（可选）执行器环境契约 + 用户具体任务；
 * 通过 ctx.subagents.start("spawn", ...) 自包含地 spawn 子代理。
 * 路由经 getRoutes() 读取（组合层或 settings 解析后的当前值）：配了可用 provider 时覆盖
 * provider/model(/maxTokens/reasoningEffort)；只配了 reasoningEffort 时只覆盖推理强度
 * （provider/model 仍继承父会话）；两者都没配（或 provider 不可用）则完全继承父/会话模型。
 *
 * P1-1：config.delegateEnvContract.enabled=true（默认）时，在 skill 内容与任务之间插入
 *       「--- 执行器环境契约 ---」+ 通用原则/探测流程文本（text 可覆盖，缺省 DEFAULT_ENV_CONTRACT），
 *       让子代理在陌生执行环境里「带地图干活」而非现场盲试；文本不写死任何环境断言。
 * P1-2：config.delegateRetry 控制中止/失败后的自动重试。默认 maxRetries=0（一次尝试，失败即抛错，
 *       且带结构化 cause）；>0 时仅对 retryableReasons 中的 reason 重试（未知 reason 一律不重试，保守），
 *       重试 prompt 追加原因 + 已完成部分，提示从中断处继续。
 * P3-1（N2）：config.delegateRetry.stall.enabled=true（默认 false）时，spawn 前挂载停滞看门狗，
 *       从运行期事件在线估计「停滞」并 ac.abort() 提前中止；中止经 P1 重试机制处置（recoverable 且
 *       有预算则续跑，否则抛错带 cause.stall）。T3：父 exec.signal 中止转发到内部 ac；start() 因
 *       预中止抛错时归一为 aborted 处理。无事件源（ctx.on 缺失）自动降级关闭，维持现状。
 * P3-2（N1）：config.envSignatures.use="auto"（默认）时挂环境契约学习器，累计环境契约类错误签名，
 *       flush() 写缓存；spawn prompt 按「text 覆盖 > manual contract > 命中缓存 > DEFAULT」选择契约文本。
 *       默认无缓存时与 P1 行为完全一致；读写失败静默降级。
 */
export function createDelegateTool(ctx: any, getRoutes: SkillRouteSource, config: DelegateConfig = {}, getSettings?: () => any) {
  // 生效的注入/重试配置（防御式默认，未配置或配置为 undefined 时回落保守默认）
  const envContract = createEnvContract(config);
  // P3-3（N3）：delegateRetry（含 N2 stall 子配置）与 schedule 的生效值 = 当前 cohub settings
  // 优先（settings 未配置时回落 config，行为与现状完全一致）。settings 可在运行期变化
  // （设置卡片），故在每次 execute 时解析，而非工具注册时固定。
  function resolveRuntimeConfig() {
    const settingsNow = getSettings ? (getSettings() ?? {}) : {};
    const retryCfg = settingsNow.delegateRetry ?? config.delegateRetry;
    const retry = {
      maxRetries: Math.max(0, Math.trunc(retryCfg?.maxRetries ?? 0)),
      retryDelayMs: Math.max(0, retryCfg?.retryDelayMs ?? 1000),
      retryableReasons: retryCfg?.retryableReasons ?? ["aborted"],
    };
    // N2（P3-1）：停滞检测配置归一（默认关闭，阈值保守）
    const stall = {
      enabled: retryCfg?.stall?.enabled ?? false,
      consecutiveErrors: Math.max(1, Math.trunc(retryCfg?.stall?.consecutiveErrors ?? 3)),
      idleMs: Math.max(0, retryCfg?.stall?.idleMs ?? 180_000),
      reasoningWithoutAction: Math.max(1, Math.trunc(retryCfg?.stall?.reasoningWithoutAction ?? 50)),
      loopCount: Math.max(1, Math.trunc(retryCfg?.stall?.loopCount ?? 3)),
      graceMs: Math.max(0, retryCfg?.stall?.graceMs ?? 30_000),
      recoverable: retryCfg?.stall?.recoverable ?? true,
      checkIntervalMs: Math.max(50, retryCfg?.stall?.checkIntervalMs ?? 1000),
    };
    const scheduleCfg = settingsNow.schedule ?? config.schedule;
    // P1-3（子代理结果预算）：settings 优先，config 兜底；缺省值即生效（用户不改也能工作）
    const budget = resolveResultBudget(settingsNow.resultBudget ?? config.resultBudget);
    // 后台 job 模式（background delegate）：settings 优先，config 兜底；缺省 enabled=false（行为不变）
    const bgCfg = settingsNow.delegateBackground ?? config.delegateBackground;
    const background = {
      enabled: bgCfg?.enabled === true,
      defaultFor: Array.isArray(bgCfg?.defaultFor)
        ? bgCfg.defaultFor.filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
        : [],
    };
    // 子代理独立精简 preset：默认开启（settings 优先，config 兜底；缺省 true = 新行为）
    const presetCfg = settingsNow.delegateSubagentPreset ?? config.delegateSubagentPreset;
    const subagentPresetEnabled = presetCfg?.enabled ?? true;
    return { retry, stall, schedule: scheduleCfg, budget, background, subagentPresetEnabled };
  }

  // P3-2（N1）：环境契约持久化配置归一（默认 auto；无缓存时行为不变；读写失败静默降级）
  const envSig = createEnvSig(config);

  return defineTool({
    name: "delegate",
    description: "委派单一子代理：按 skill 路由模型并注入角色指令后运行。"
      + "background：true=强制后台返 jobId；false=强制前台；缺省=按配置。",

    parameters: {
      skill: {
        type: "string",
        required: true,
        description: "必填，co-* 代理名（如 co-fixer/co-explorer/co-oracle）",
      },
      prompt: {
        type: "string",
        required: true,
        description: "必填，自包含：目标、路径、约束、输出格式",
      },
      background: {
        type: "boolean",
        description: "true=强制后台返 jobId；false=强制前台同步；缺省=按配置（enabled && skill 命中 defaultFor）",
      },
    },

    output: DELEGATE_OUTPUT_CONFIG,

    isConcurrencySafe: () => true,

    async execute(
      args: { skill: string; prompt: string; background?: boolean },
      exec: any,
      observer?: DelegateObserver,
    ) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate requires a calling agent (exec.agent was undefined)");

      // 嵌套委派守卫：depth ≥ MAX_DELEGATION_DEPTH（自己就是子代理）时直接拒绝，不再 spawn。
      // 拒绝必须是硬失败（抛错）——返回成功文本会让子代理误以为已派出，继续等一个不存在的子代理。
      const depthRejection = guardDelegationDepth(parent, ctx.logger);
      if (depthRejection !== undefined) {
        ctx.logger?.warn?.("[cohub depth-guard] " + depthRejection + "（skill=" + String(args.skill) + "）");
        throw new Error(depthRejection);
      }

      // P3-3（N3）：每次调用解析生效配置（settings > config > 保守默认）；RETRYABLE 随 retryableReasons 动态
      const { retry, stall, schedule, budget, background, subagentPresetEnabled } = resolveRuntimeConfig();
      const RETRYABLE = new Set(retry.retryableReasons);
      ctx.logger?.info?.("[cohub schedule] 生效调度参数：batch=" + (schedule?.maxParallelBatch ?? 3)
        + " wallMs=" + (schedule?.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS));

      // ① 按 skill 名精确匹配技能 + 查找路由配置（共享函数；skill 缺失/空白会兜底 co-fixer 并 warn）
      const { skill, route, fallback: skillFallback, note: skillNote } =
        resolveSkillAndRoute(args.skill, getRoutes, ctx);
      // label 里的 skill 片段：兜底时显式标 (default:co-fixer)，绝不出现 ":undefined"
      const skillTag = formatSkillLabel(skill, skillFallback);

      // ③ 注入该 skill 的精简指令（brief）+ 用户具体任务（spawn 不继承父上下文，必须自包含）
      const brief = skill.brief?.trim();
      if (!brief) {
        ctx.logger?.warn?.('delegate: skill "' + skillTag + '" 缺少 brief，回退完整 content');
      }

      // ④ 构造 agentOptions（共享函数；provider 未配 model 时解析该 provider 的默认模型；
      //    P1-2：路由未显式配置的字段由 skill 分层默认值补，用户配置永远优先）
      const agentOptions = await buildAgentOptions(route, ctx, skill.name);

      // ④b P1-1 子代理工具表裁剪：按规范化后的 skill 名查 deny 表（开关默认开；
      //     构造失败已在 resolveSkillToolFilter 内 fail-soft 成 undefined = 全量工具）
      const toolFilter = resolveSkillToolFilter(skill.name, config.toolFilter?.enabled ?? true, ctx.logger);

      // 降级原因收集槽：preset / toolFilter 的 fail-soft 各登记一条，最终由
      // runAttempts 在 result-budget 裁剪**之后**拼到返回文本末尾（当前进程不落盘日志，
      // 只打 warn 等于静默失败 —— 今天为此时踩坑：preset 未声明 / toolFilter 失效都看不见）。
      const degradeNotes: DegradeNote[] = [];

      // ①b skill 名未匹配 / skill 缺失兜底：resolveSkillAndRoute 已把原因写进 note，
      //     这里登记一条，确保「skill 拼错」这类静默降级经 formatDegradeNotes 出现在返回文本里。
      if (skillNote !== undefined) {
        upsertDegradeNote(degradeNotes, {
          id: "skill",
          what: "skill 名未命中",
          effect: "子代理已按兜底角色 " + skill.name + " 执行",
          reason: skillNote,
        });
      }

      // ④c 子代理独立精简 preset（按 skill 映射 readonly / write）：undefined = 继承父 preset。
      //     preset 缺失 / 挂载失败由 startSubagentRun 的 fail-soft 重试兜底（去掉 id 再试一次）。
      const agentPreset = resolveSkillAgentPreset(skill.name, subagentPresetEnabled);

      // ⑤ 执行器环境契约注入（共享函数）：指纹只算一次，契约解析与随后的学习者共用
      const fp = envFingerprint();
      const contractResult = resolveContractText(
        { enabled: envContract.enabled, text: envContract.text },
        envSig,
        ctx,
        fp,
      );
      const contractText = contractResult.text;

      // ⑥ 中止/失败重试循环（P1-2）+ N2 停滞检测（P3-1）：
      //    默认 maxRetries=0 → 单次尝试，失败即抛错（带结构化 cause）；
      //    stall.enabled=true 时每个 attempt 挂看门狗，提前中止并计入同一 maxRetries 预算。
      // ⑥⑦ 前台/后台共用的尝试循环：原前台路径整体内联在此闭包内，前台照旧直接调用，
      //      后台由 job 生产者调用——同一个实现，避免两条路径行为分叉。
      // outerSignal：前台 = exec.signal（父轮次中止转发）；后台 = job cancel 驱动的独立 signal
      //      （后台不能沿用 exec.signal：工具返回后父轮次结束，会把子代理误杀）。
      const runAttempts = async (outerSignal: AbortSignal | undefined): Promise<string> => {
        let lastReason = "unknown";
        // P5：SubagentResult.diagnostic 原样保留（官方 run-settlement.js 用它拼错误详情）。
        // 必须与 lastReason 分开：lastReason 参与 RETRYABLE 精确匹配，拼接会破坏重试判定。
        let lastDiagnostic: string | undefined;
        let lastPartial = "";
        // P1-3：被丢弃的大段 partial 的预算内版本（只进 err.cause，不进 error.message）
        let lastPartialBudget = "";
        // 停滞信息经可变状态对象承载：直接 let 声明会在闭包/循环内被 TS 流分析收窄为 never
        // （循环头声明值为 null 时，三元判断的真分支类型为 never），对象属性则保持 StallInfo | null。
        const stallState: { last: StallInfo | null } = { last: null };
        let retries = 0;

        for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
          // P4（observer）：本 attempt 的起止时间与 1-based 序号；四条出口（成功/失败/超时/中止）
          // 统一经 reportAttempt 上报，observer 缺省时该函数立即 return（零行为变化）。
          const attemptStartedAt = Date.now();
          const attemptNo = attempt + 1;
          const reportAttempt = (
            childSessionId: string,
            outcome: DelegateAttemptRecord["outcome"],
            stopReason?: string,
          ): void => {
            const onAttempt = observer?.onAttempt;
            if (!onAttempt) return;
            try {
              onAttempt.call(observer, {
                skill: skill.name,
                attempt: attemptNo,
                childSessionId,
                startedAt: attemptStartedAt,
                endedAt: Date.now(),
                outcome,
                ...(stopReason === undefined ? {} : { stopReason }),
              });
            } catch (error) {
              // 观测者抛错绝不能中断委派：只 warn，调用方的返回/抛错路径保持原样
              ctx.logger?.warn?.("[cohub observer] onAttempt 抛出异常（已忽略）："
                + String((error as any)?.message ?? error));
            }
          };
          const stallNote = stallState.last ? "；停滞诊断：" + stallState.last.diagnostics : "";
          const retryNote = attempt > 0
            ? "\n\n[重试 #" + attempt + "] 上一次执行中止，原因：" + lastReason
              + (lastDiagnostic === undefined ? "" : "；诊断：" + lastDiagnostic)
              + "；已完成部分：" + (lastPartial || "（无）") + stallNote
              + "。请从中断处继续，不要重复已完成步骤。"
            : "";
          const promptText = buildDelegatePrompt({
            skill,
            contractText,
            userPrompt: args.prompt,
            retryNote,
          });

          // N2（P3-1）：启用时自建 AbortController 并转发 exec.signal（T3：父中止 → 子中止）；
          // 看门狗在 start 之前挂事件总线；enabled=false 时保持 P1 原路径（signal 直传，不注册监听）。
          const ac = stall.enabled ? new AbortController() : null;
          let onExecAbort: (() => void) | null = null;
          const forwardAbort = () => { if (ac && !ac.signal.aborted) ac.abort(); };
          if (ac && outerSignal) {
            if (outerSignal.aborted) forwardAbort();
            else { onExecAbort = forwardAbort; outerSignal.addEventListener("abort", onExecAbort, { once: true }); }
          }
          const signal = ac ? ac.signal : outerSignal;
          let watchdog: StallWatchdog | null = null;
          let stallInfo: StallInfo | null = null;
          if (ac) {
            watchdog = new StallWatchdog(stall, (info) => {
              stallInfo = info;
              ctx.logger?.info?.("[cohub stall] " + JSON.stringify(info));
              forwardAbort();
            });
            const attached = watchdog.attach(ctx);
            if (!attached) {
              // 三态降级：无 session/event 事件源 → 看门狗不可用，维持现状（最终超时兜底）
              ctx.logger?.warn?.("[cohub stall] 无 session/event 事件源，停滞检测降级为关闭（维持现状）");
            }
          }

          // P3-2（N1）：use="auto" 时挂独立轻量观测，累计环境契约类错误签名；
          // 无事件源（ctx.on 缺失）自动降级（不观测不写，行为不变）。
          let learner: EnvSignatureLearner | null = null;
          if (envSig.use === "auto") {
            learner = new EnvSignatureLearner({
              fingerprint: fp,
              confirmCount: envSig.confirmCount,
              errorCategories: envSig.errorCategories,
              write: (data) => writeEnvSignatures(data, envSig.cachePath),
            });
            if (!learner.attach(ctx)) learner = null;
          }

          // ⑦ spawn 子代理（startSubagentRun 抹平 0.2.0 start / 0.2.1 startActivation；
          //    provider 参数是 transport 名，固定 "spawn"；agentOptions.provider 才是 LLM 供应商名，别搞混）
          let run: any;
          try {
            run = await startSubagentRun(ctx, DEFAULT_SPAWN_TRANSPORT, {
              label: "delegate:" + skillTag,
              prompt: [{ type: "text", text: promptText }],
              parent,
              persona: DELEGATE_PERSONA,
              // P1-1：工具表裁剪（undefined 时不透传，等价于全量工具）
              ...(toolFilter !== undefined ? { toolFilter } : {}),
              // 子代理独立精简 preset（undefined 时不透传 = 继承父 preset）
              ...(agentPreset !== undefined ? { agentPreset } : {}),
              ...(agentOptions ? { agentOptions } : {}),
              signal,
              // preset / toolFilter 的 fail-soft 往这里登记降级原因（不传则仅 warn，旧行为）
              degradeNotes,
            });
          } catch (error) {
            // T3：spawn 前/期间中止（prePublicationAbort）可能使 start() 抛错——归一为 aborted 处理
            if (watchdog) watchdog.detach();
            if (learner) learner.detach();
            if (onExecAbort && outerSignal) outerSignal.removeEventListener("abort", onExecAbort);
            if (ac?.signal.aborted) {
              lastReason = "aborted";
              lastDiagnostic = undefined;
              lastPartial = "";
              stallState.last = stallInfo;
              // P4：spawn 期间中止 —— 无子会话 id（run 未创建）
              if (stallInfo) reportAttempt("", "timeout", "aborted");
              else reportAttempt("", "aborted", "aborted");
              if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
              retries++;
              await new Promise(r => setTimeout(r, retry.retryDelayMs));
              continue;
            }
            // P4：spawn 失败（非中止）—— 异常路径同样上报一次
            reportAttempt("", "failed", String((error as any)?.message ?? error));
            throw error;
          }
          if (watchdog) watchdog.bind(run.id);
          if (learner) learner.bind(run.id);
          run.result.catch(() => {}); // dispose 后的拒绝不产生 unhandledRejection
          let outcome: any;
          try {
            outcome = await run.result;
          } catch (error) {
            // P4：运行期拒绝也是失败出口（finally 已负责清理资源）
            reportAttempt(String(run?.id ?? ""), "failed", "error");
            throw error;
          } finally {
            if (learner) {
              if (learner.flush()) {
                ctx.logger?.info?.("[cohub envsig] 写入环境契约缓存（确认 " + envSig.confirmCount + " 次一致签名）");
              }
              learner.detach();
            }
            if (watchdog) watchdog.detach();
            if (onExecAbort && outerSignal) outerSignal.removeEventListener("abort", onExecAbort);
            try { run.dispose(); } catch { /* 已释放 */ }
          }

          if (outcome?.stopReason === "completed") {
            // P4：成功路径 —— childSessionId 用 run.id（契约上等于子会话 session.id）
            reportAttempt(String(run?.id ?? ""), "completed", "completed");
            // P1-3：结果先经「契约保留 + 预算裁剪 + 落盘定位」再回传，
            // 避免子代理全文永久驻留父会话历史并被每轮重发。
            // 改动 3：按 skill 分档取更小上限（co-planner 硬压到 1500 字符；契约段仍优先保留）。
            const budgeted = await budgetSubagentResult(ctx, exec, contentText(outcome.output), {
              maxChars: resolveSkillResultMaxChars(budget, skill.name),
              scope: "delegate",
              label: skillTag,
              enabled: budget.enabled,
            });
            // 降级提示必须拼在 budgeted **之后**（与 delegate_batch 统计行同一位置逻辑）：
            // 放进再被裁剪的文本里就会被 applyResultBudget 切掉，等于又回到静默降级。
            // 无降级时 formatDegradeNotes 返回空串 → 正常路径返回文本逐字不变。
            return budgeted + formatDegradeNotes(degradeNotes);
          }
          lastReason = String(outcome?.stopReason ?? "unknown");
          lastDiagnostic = typeof outcome?.diagnostic === "string" ? outcome.diagnostic : undefined;
          const partialRaw = contentText(outcome?.output ?? []);
          // 保留既有 slice(0, 500) 行为（error.message 与 retryNote 用它，绝不加长）
          lastPartial = partialRaw.slice(0, 500);
          // P1-3：被丢弃的大段 partial 也走同一个预算函数（上限更小，且**不落盘**——
          // 失败路径不额外引入失败点，也不产生无谓 I/O）；只进 cause，不进模型上下文
          lastPartialBudget = budget.enabled && partialRaw.length > budget.partialMaxChars
            ? applyResultBudget(partialRaw, {
              maxChars: budget.partialMaxChars,
              scope: "delegate:partial",
              label: skillTag,
              locatorFallback: "未落盘（失败路径不写盘）",
            }).text
            : partialRaw;
          stallState.last = stallInfo;
          // P4：非成功出口 —— 停滞看门狗触发即归为 timeout，其余按 lastReason 判定 aborted/failed
          const attemptOutcome: DelegateAttemptRecord["outcome"] = stallInfo
            ? "timeout"
            : (lastReason === "aborted" ? "aborted" : "failed");
          reportAttempt(String(run?.id ?? ""), attemptOutcome, lastReason);
          // N2：停滞触发的中止仅在 recoverable=true 时按可重试中止处理；否则直接失败
          if (stallInfo && !stall.recoverable) break;
          if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
          retries++;
          await new Promise(r => setTimeout(r, retry.retryDelayMs));
        }

        // ⑧ 重试耗尽（或不可重试）：抛错并回传结构化 cause（通用，不依赖任何环境枚举）
        //    降级提示（skill 兜底 / preset 回退）也进错误文本：失败路径原先只把信息塞进
        //    err.cause，调用方看到的是「跑了个不知名的代理」，同样属于静默降级。
        //    formatDegradeNotes 无降级时返回空串 → message 逐字不变，判定逻辑不受影响。
        const degradeText = formatDegradeNotes(degradeNotes).replace(/\s+/g, " ");
        const err: any = new Error(
          'delegate: subagent stopped with reason "' + lastReason + '" after ' + retries + ' retry(ies)'
          + (lastDiagnostic === undefined ? "" : "; diagnostic: " + lastDiagnostic)
          + (stallState.last ? "; stalled: " + stallState.last.diagnostics : "")
          + "; partial: " + lastPartial
          + degradeText,
        );
        err.cause = {
          stopReason: lastReason,
          ...(lastDiagnostic === undefined ? {} : { diagnostic: lastDiagnostic }),
          partial: lastPartial,
          ...(lastPartialBudget === lastPartial ? {} : { partialBudget: lastPartialBudget }),
          // 规范化后的 skill（兜底时即 co-fixer），不让 undefined 流进结构化诊断
          skill: skill.name,
          retries,
          ...(stallState.last ? { stall: stallState.last } : {}),
          ...(degradeText.length > 0 ? { degrade: degradeText } : {}),
        };
        throw err;
      };

      // ⑦b 后台模式（background delegate）：把这次运行注册为 DSH 后台 job 并立即返回 jobId。
      //      三档语义（显式传参永远优先于配置）：
      //        args.background === true  → 强制后台（显式指令，不看 delegateBackground.enabled）
      //        args.background === false → 强制前台（不看 defaultFor）
      //        args.background 缺省      → 看 config：enabled && defaultFor.includes(skill)
      //      （缺省 enabled=false 时即完全走原前台路径，行为不变、向后兼容）
      //      兜底：jobs 服务缺失 / start() 拒绝（无 job controller 服务该 owner、超出每 owner
      //      并发上限 10、owner 不是存活 Agent 实例…）→ warn + 回退前台（对快调用完全透明）。
      // 降级原因（诊断可见性）：后台不可用时的简短说明，供显式请求后台的调用方在返回文本里看到。
      // 当前 DSH 进程不落盘 logger 输出，只打 warn 等于静默降级 → 必须回传到工具返回文本。
      let bgFallbackReason: string | undefined;

      // 只取 error.message 第一行并压平空白：既去掉堆栈噪音，也不把内部路径/长上下文外泄；截断到 200 字符。
      const describeBgFallback = (error: unknown): string => {
        const message = (error as any)?.message;
        const raw = typeof message === "string" && message.length > 0 ? message : String(error);
        const firstLine = (raw.split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
        const text = firstLine.length > 0 ? firstLine : "unknown";
        return text.length > 200 ? text.slice(0, 200) : text;
      };

      const bgWanted = args.background === true
        || (args.background === undefined && background.enabled && background.defaultFor.includes(skill.name));
      if (bgWanted) {
        // 优先从 owner（exec.agent）的 ctx 取：servesOwner 按 agent scope 判定 controller，
        // 只用插件 ctx（host 层）会取到不服务该 scope 的实例并抛错降级。
        // 注意：resolveJobOwner 返回的是**实例**，只用于解析 jobs 服务（要用 owner.ctx 判 scope），
        // 不再作为 start() 的 owner 传参 —— 传参见下方 jobOwnerId（0.2.x 要字符串）。
        const jobOwner = resolveJobOwner(parent, ctx);
        if (jobOwner !== parent) {
          ctx.logger?.info?.("[cohub background] job owner 已归一为 spawn 用的 Agent 实例（exec.agent 非实例本身）");
        }
        const jobs = resolveJobsService(ctx, jobOwner);
        // 0.2.x 契约（resolveOwner，asar lib/index.js:537）：spec.owner 是 **session id 字符串**，
        // 服务端自己 `agents.get(session)` 解析回实例。传实例 → get("[object Object]") === undefined
        // → 抛 `session "[object Object]" has no live agent`。官方调用方 dsh-tool-workflow 也传 parent.id。
        // 拿不到 id 就不启动 job：传 undefined 会变成 unowned job（永不被 owner 释放回收），比降级前台更糟。
        const jobOwnerId = resolveJobOwnerId(parent);
        if (jobOwnerId === undefined) {
          bgFallbackReason = "无法解析调用方 session id（background job owner 契约要求字符串）";
          ctx.logger?.warn?.("[cohub background-fallback] " + bgFallbackReason + "，回退前台");
        } else if (jobs !== undefined && typeof jobs.start === "function") {
          // job cancel / owner 释放 → abort 子代理；子代理 run.dispose() 由 runAttempts 的
          // finally 保证（run.result 结算后必执行），因此 kill 路径不泄漏子代理。
          const cancelAc = new AbortController();
          let jobId: string | undefined;
          try {
            const startJob = (ownerValue: any) => jobs.start({
              kind: "delegate",
              label: skill.name + ": " + String(args.prompt ?? "").slice(0, 60),
              // owner 必须是 **session id 字符串**：0.2.x 的 resolveOwner（asar lib/index.js:413/537）
              // 把 spec.owner 直接当键 `agents.get(session)` 查注册表，再用解析出的实例做
              // servesOwner（:553）与 ensureOwnerCleanup（:802）。传实例会变成 [object Object] 键。
              owner: ownerValue,
              // outputLimitBytes 只在**渲染期**截断（保尾丢头）；结果已由 budgetSubagentResult
              // 裁到 budget.maxChars，这里给足余量以保证头部契约段不被吃掉。
              outputLimitBytes: Math.max(65_536, budget.maxChars * 4),
              run: () => {
                const done = (async () => {
                  try {
                    // 结果先过 cohub 的 result-budget（含 spill locator）再写 job 终态结果，
                    // 否则 outputLimitBytes 渲染期截断会把 locator 一起截掉。
                    // 字段名必须是 **result**：jobs-local 的 settle() 只读 outcome.result
                    // （lib/index.js: `job.result = outcome.result`），tool-jobs 的 job_output
                    // 再从 read().result 渲染正文。写 output → job.result === undefined →
                    // job_output 恒为 "(no new output)"（job 能完成但结果取不到）。
                    const text = await runAttempts(cancelAc.signal);
                    return { status: "completed", result: text };
                  } catch (error) {
                    // job 被 kill → 生产方按 killed 结算（jobs-local settle 为 first-wins，
                    // 终端状态由生产方给出，不由注册表改写）。
                    if (cancelAc.signal.aborted) {
                      return { status: "killed", detail: "delegate 已取消（job_kill / owner 释放）" };
                    }
                    // 失败没有正文结果：原因放 detail（job_output/job_list 的 statusLine 会渲染它）。
                    return { status: "failed", detail: String(error) };
                  }
                })();
                return {
                  cancel: () => { try { cancelAc.abort(); } catch { /* 已中止 */ } },
                  done,
                };
              },
            });
            let started: unknown;
            try {
              started = startJob(jobOwnerId);
            } catch (error) {
              // 0.1.x 兼容：只认实例、传字符串会被拒 → 用实例再试一次。
              // 安全性：start() 的**第一句**就是 resolveOwner（asar lib/index.js:413），
              // 而 spec.run(handle) 在最后（:439）。resolveOwner 抛错时 producer 从未启动，
              // 因此同一个 run 闭包被第二次 start() 复用不会重复 spawn 子代理。
              if (!/is not the registered agent instance/i.test(String((error as any)?.message ?? error))) throw error;
              started = startJob(jobOwner);
            }
            if (typeof started === "string" && started.length > 0) jobId = started;
          } catch (error) {
            bgFallbackReason = describeBgFallback(error);
            ctx.logger?.warn?.("[cohub background-fallback] background delegate 不可用，回退前台：" + bgFallbackReason);
          }
          if (jobId !== undefined) {
            ctx.logger?.info?.("[cohub background] delegate 已注册为后台 job：" + jobId + "（skill=" + skill.name + "）");
            return "已在后台启动：" + skill.name + "（job: " + jobId + "）。"
              + "取结果：job_output({ job_id: \"" + jobId + "\", wait: true })；"
              + "或等自动唤醒（job 完成且你空闲时会自动开新一轮，最多连续 3 次）。"
              + "等待期间可以继续派发别的任务或推进其他工作（后台任务不计入当前批次耗时）。";
          }
          // start() 未抛错但没给出 jobId：同样是降级，别让它静默
          if (bgFallbackReason === undefined) {
            bgFallbackReason = "jobs.start 未返回 jobId";
            ctx.logger?.warn?.("[cohub background-fallback] " + bgFallbackReason + "，回退前台");
          }
        } else {
          bgFallbackReason = "jobs 服务不可用（本组合未加载 dsh-jobs / dsh-tool-jobs）";
          ctx.logger?.warn?.("[cohub background-fallback] " + bgFallbackReason + "，回退前台");
        }
      }

      // 前台同步路径：与加入后台模式之前完全一致
      const foregroundText = await runAttempts(exec.signal);
      // 委派已拿到结果 → 注入「立刻 todo_write 回写」提醒（fail-soft，宿主不支持就静默跳过）。
      // 上面 jobId 分支不加：那里任务只是排队/启动未完成，提醒语义不成立。
      maybeDeferTodoNudge(exec);
      // 显式请求后台却降级 → 把原因附在**前台结果之后**回传（不能提前 return：
      // 前台结果本身才是有用产出）。走配置默认的那一档不追加，避免给常规调用添噪音。
      if (args.background === true && bgFallbackReason !== undefined) {
        return foregroundText + "\n\n[后台不可用，已回退前台同步执行：" + bgFallbackReason + "]";
      }
      return foregroundText;
    },
  });
}
