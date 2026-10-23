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
  type ResultBudgetConfig,
} from "./result-budget.ts";

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
  /** 后台 job 模式（background delegate）：默认关闭 → 完全保持前台同步行为。
   *  开启后 delegate 把这次运行注册为 DSH 后台 job 并立即返回 jobId，
   *  主代理用 job_output 取结果（或等完成时自动唤醒），等待期间可并行推进其他工作。
   *  jobs 服务不可用 / start() 拒绝时自动降级回前台同步（对该次调用完全透明）。 */
  delegateBackground?: {
    /** 总开关；false（缺省）时即使 args.background=true 也走前台 */
    enabled?: boolean;
    /** 这些 skill 默认走后台（无需显式传 background: true） */
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
  agentOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** toolFilter 被拒的可识别特征：restrict() 报未知全局工具名，或 provider 无该能力 */
const TOOL_FILTER_REJECTED = /unknown global tool|toolFilter|tool filter|capabilit/i;

/**
 * 跨版本 spawn 子代理的统一入口（对外）。
 *
 * 在 {@link startSubagentRunOnce} 外面包一层 fail-soft 重试：当 toolFilter 被
 * 服务端拒绝（`tools.restrict() names unknown global tool ...` 或 provider 不支持
 * toolFilter 能力）时，**去掉 filter 重试一次**，让委派照常跑（全量工具），
 * 只留一行 warn。裁剪是优化，不是功能前提。
 */
export async function startSubagentRun(
  ctx: any,
  provider: string,
  spec: SpawnRunSpec,
): Promise<SubagentRunHandle> {
  try {
    return await startSubagentRunOnce(ctx, provider, spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = spec.signal?.aborted === true
      || /abort/i.test(message);
    if (spec.toolFilter !== undefined && !aborted && TOOL_FILTER_REJECTED.test(message)) {
      ctx?.logger?.warn?.("[cohub toolfilter] 子代理工具表裁剪被拒绝，已回退全量工具重试：" + message);
      return await startSubagentRunOnce(ctx, provider, { ...spec, toolFilter: undefined });
    }
    throw error;
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
        ...(spec.agentOptions !== undefined ? { agentOptions: spec.agentOptions } : {}),
        ...(spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {}),
      },
      signal,
      delivery: "caller",
    });
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
        const sig = normalizeErrorSignature(d) ?? "err:unknown";
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
 * 注意：路由查找使用原始 requestedSkill（可能为空/undefined），而非兜底后的 skill 名。
 */
export function resolveSkillAndRoute(
  requestedSkill: string,
  getRoutes: SkillRouteSource,
  ctx: any,
  logger?: any,
): { skill: CoHubSkill; route: SkillRouteConfig | undefined } {
  const skillName = requestedSkill || "co-fixer";
  let skill = COHUB_SKILLS.find(s => s.name === skillName);
  if (!skill) {
    (logger ?? ctx.logger)?.warn?.('delegate: unknown skill "' + skillName + '", falling back to co-fixer');
    skill = COHUB_SKILLS.find(s => s.name === "co-fixer")!;
  } else if (!requestedSkill) {
    (logger ?? ctx.logger)?.info?.('delegate: skill not specified, defaulting to co-fixer');
  }
  // 路由查找使用原始 requestedSkill（可能为空），而非 skillName（兜底后）
  const route = (getRoutes() ?? []).find(s => s.name === requestedSkill);
  return { skill, route };
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
 * 取法与 result-budget 取 spillStore 完全一致：先走 ctx.get 非 inject 通道，再退到
 * ctx.reflect.get（cordis 内置 accessor）。**绝不直接读 ctx.jobs**——包装 loader 会触发
 * cordis 的 inject 强校验报错。都取不到时返回 undefined，由调用方降级到前台。
 */
export function resolveJobsService(ctx: any): any {
  try {
    const viaGet = typeof ctx?.get === "function" ? ctx.get("jobs") : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  } catch { /* 落到 reflect 通道 */ }
  try {
    return ctx?.reflect?.get?.("jobs", false);
  } catch {
    return undefined;
  }
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
    return { retry, stall, schedule: scheduleCfg, budget, background };
  }

  // P3-2（N1）：环境契约持久化配置归一（默认 auto；无缓存时行为不变；读写失败静默降级）
  const envSig = createEnvSig(config);

  return defineTool({
    name: "delegate",
    description: "把任务委派给指定专职代理：按 skill 名路由 provider/model，自动注入该代理的精简指令后 spawn 子代理。"
      + "默认前台同步（阻塞到子代理结束）。传 background=true（需开启 delegateBackground.enabled）时改为"
      + "注册为 DSH 后台 job 并立即返回 jobId：用 job_output({ job_id, wait: true }) 取结果，"
      + "或等完成时自动唤醒；等待期间可继续推进其他工作。适合长任务（预计 >2 分钟）或多路并行。",

    parameters: {
      skill: {
        type: "string",
        description: "专职代理技能名，如 co-fixer/co-explorer/co-oracle。缺省时默认 co-fixer",
      },
      prompt: {
        type: "string",
        required: true,
        description: "给该代理的具体任务（写全目标、相关文件路径、约束、期望输出格式）",
      },
      background: {
        type: "boolean",
        description: "true=注册为 DSH 后台 job 并立即返回 jobId（需 delegateBackground.enabled 已开启；"
          + "jobs 不可用时自动降级为前台）；false/缺省=前台同步等待结果",
      },
    },

    output: DELEGATE_OUTPUT_CONFIG,

    isConcurrencySafe: () => true,

    async execute(args: { skill: string; prompt: string; background?: boolean }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate requires a calling agent (exec.agent was undefined)");

      // P3-3（N3）：每次调用解析生效配置（settings > config > 保守默认）；RETRYABLE 随 retryableReasons 动态
      const { retry, stall, schedule, budget, background } = resolveRuntimeConfig();
      const RETRYABLE = new Set(retry.retryableReasons);
      ctx.logger?.info?.("[cohub schedule] 生效调度参数：batch=" + (schedule?.maxParallelBatch ?? 3)
        + " wallMs=" + (schedule?.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS));

      // ① 按 skill 名精确匹配技能 + 查找路由配置（共享函数）
      const { skill, route } = resolveSkillAndRoute(args.skill, getRoutes, ctx);

      // ③ 注入该 skill 的精简指令（brief）+ 用户具体任务（spawn 不继承父上下文，必须自包含）
      const brief = skill.brief?.trim();
      if (!brief) {
        ctx.logger?.warn?.('delegate: skill "' + args.skill + '" 缺少 brief，回退完整 content');
      }

      // ④ 构造 agentOptions（共享函数；provider 未配 model 时解析该 provider 的默认模型；
      //    P1-2：路由未显式配置的字段由 skill 分层默认值补，用户配置永远优先）
      const agentOptions = await buildAgentOptions(route, ctx, skill.name);

      // ④b P1-1 子代理工具表裁剪：按规范化后的 skill 名查 deny 表（开关默认开；
      //     构造失败已在 resolveSkillToolFilter 内 fail-soft 成 undefined = 全量工具）
      const toolFilter = resolveSkillToolFilter(skill.name, config.toolFilter?.enabled ?? true, ctx.logger);

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
              label: "delegate:" + args.skill,
              prompt: [{ type: "text", text: promptText }],
              parent,
              persona: DELEGATE_PERSONA,
              // P1-1：工具表裁剪（undefined 时不透传，等价于全量工具）
              ...(toolFilter !== undefined ? { toolFilter } : {}),
              ...(agentOptions ? { agentOptions } : {}),
              signal,
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
              if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
              retries++;
              await new Promise(r => setTimeout(r, retry.retryDelayMs));
              continue;
            }
            throw error;
          }
          if (watchdog) watchdog.bind(run.id);
          if (learner) learner.bind(run.id);
          run.result.catch(() => {}); // dispose 后的拒绝不产生 unhandledRejection
          let outcome: any;
          try {
            outcome = await run.result;
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
            // P1-3：结果先经「契约保留 + 预算裁剪 + 落盘定位」再回传，
            // 避免子代理全文永久驻留父会话历史并被每轮重发。
            return await budgetSubagentResult(ctx, exec, contentText(outcome.output), {
              maxChars: budget.maxChars,
              scope: "delegate",
              label: args.skill,
              enabled: budget.enabled,
            });
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
              label: args.skill,
              locatorFallback: "未落盘（失败路径不写盘）",
            }).text
            : partialRaw;
          stallState.last = stallInfo;
          // N2：停滞触发的中止仅在 recoverable=true 时按可重试中止处理；否则直接失败
          if (stallInfo && !stall.recoverable) break;
          if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
          retries++;
          await new Promise(r => setTimeout(r, retry.retryDelayMs));
        }

        // ⑧ 重试耗尽（或不可重试）：抛错并回传结构化 cause（通用，不依赖任何环境枚举）
        const err: any = new Error(
          'delegate: subagent stopped with reason "' + lastReason + '" after ' + retries + ' retry(ies)'
          + (lastDiagnostic === undefined ? "" : "; diagnostic: " + lastDiagnostic)
          + (stallState.last ? "; stalled: " + stallState.last.diagnostics : "")
          + "; partial: " + lastPartial,
        );
        err.cause = {
          stopReason: lastReason,
          ...(lastDiagnostic === undefined ? {} : { diagnostic: lastDiagnostic }),
          partial: lastPartial,
          ...(lastPartialBudget === lastPartial ? {} : { partialBudget: lastPartialBudget }),
          skill: args.skill,
          retries,
          ...(stallState.last ? { stall: stallState.last } : {}),
        };
        throw err;
      };

      // ⑦b 后台模式（background delegate）：把这次运行注册为 DSH 后台 job 并立即返回 jobId。
      //      - 缺省 enabled=false → 完全走原前台路径，行为不变（向后兼容）；
      //      - jobs 服务缺失 / start() 拒绝（无 job controller 服务该 owner、超出每 owner 并发
      //        上限 10、owner 不是存活 Agent 实例…）→ warn + 回退前台（降级对标快调用完全透明）。
      const bgWanted = typeof args.background === "boolean"
        ? args.background
        : background.defaultFor.includes(skill.name);
      if (bgWanted && background.enabled) {
        const jobs = resolveJobsService(ctx);
        if (jobs !== undefined && typeof jobs.start === "function") {
          // job cancel / owner 释放 → abort 子代理；子代理 run.dispose() 由 runAttempts 的
          // finally 保证（run.result 结算后必执行），因此 kill 路径不泄漏子代理。
          const cancelAc = new AbortController();
          let jobId: string | undefined;
          try {
            const started = jobs.start({
              kind: "delegate",
              label: skill.name + ": " + String(args.prompt ?? "").slice(0, 60),
              // owner 必须是存活的 Agent 实例：jobs-local 用 agents.get(owner.id) === owner 校验
              // （lib/index.js:398），并用 owner.ctx 做 scope 分层（servesOwner，:281）。
              // exec.agent 正是这个实例（同一对象也作为 spawn 的 parent）。
              owner: parent,
              // outputLimitBytes 只在**渲染期**截断（保尾丢头）；结果已由 budgetSubagentResult
              // 裁到 budget.maxChars，这里给足余量以保证头部契约段不被吃掉。
              outputLimitBytes: Math.max(65_536, budget.maxChars * 4),
              run: () => {
                const done = (async () => {
                  try {
                    // 结果先过 cohub 的 result-budget（含 spill locator）再写 job.output，
                    // 否则 outputLimitBytes 渲染期截断会把 locator 一起截掉。
                    const text = await runAttempts(cancelAc.signal);
                    return { status: "completed", output: text };
                  } catch (error) {
                    // job 被 kill → 生产方按 killed 结算（jobs-local settle 为 first-wins，
                    // 终端状态由生产方给出，不由注册表改写）。
                    if (cancelAc.signal.aborted) {
                      return { status: "killed", detail: "delegate 已取消（job_kill / owner 释放）" };
                    }
                    return { status: "failed", output: "", detail: String(error) };
                  }
                })();
                return {
                  cancel: () => { try { cancelAc.abort(); } catch { /* 已中止 */ } },
                  done,
                };
              },
            });
            if (typeof started === "string" && started.length > 0) jobId = started;
          } catch (error) {
            ctx.logger?.warn?.("[cohub background] background delegate 不可用，回退前台：" + String(error));
          }
          if (jobId !== undefined) {
            ctx.logger?.info?.("[cohub background] delegate 已注册为后台 job：" + jobId + "（skill=" + skill.name + "）");
            return "已在后台启动：" + skill.name + "（job: " + jobId + "）。"
              + "取结果：job_output({ job_id: \"" + jobId + "\", wait: true })；"
              + "或等自动唤醒（job 完成且你空闲时会自动开新一轮，最多连续 3 次）。"
              + "等待期间可以继续派发别的任务或推进其他工作。";
          }
        } else {
          ctx.logger?.warn?.("[cohub background] jobs 服务不可用（本组合未加载 dsh-jobs / dsh-tool-jobs），回退前台");
        }
      }

      // 前台同步路径：与加入后台模式之前完全一致
      return await runAttempts(exec.signal);
    },
  });
}
