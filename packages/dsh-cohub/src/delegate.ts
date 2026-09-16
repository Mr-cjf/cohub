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
import { EnvSignatureLearner, envFingerprint, pickEnvContractText, readEnvSignatures, writeEnvSignatures, type EnvSignaturesConfig } from "./env-signatures.ts";
import { contentText } from "./text-utils.ts";

/** 单个 skill 的路由配置（来自组合层 cordis.patch.yml 或 DSH settings 的 cohub.skills） */
export interface SkillRouteConfig {
  name: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
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
}

/** 归一化错误签名（S1）：从 tool/result data 提取可比较的错误特征；无法提取返回 null */
function normalizeErrorSignature(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  const err = data.error;
  if (typeof err === "string" && err.trim()) return "err:" + err.trim().slice(0, 120);
  if (err && typeof err === "object") {
    const msg = typeof (err as any).message === "string" ? (err as any).message : "";
    const code = typeof (err as any).code === "string" ? (err as any).code : "";
    if (msg || code) return "err:" + (code ? code + " " : "") + msg.slice(0, 120);
  }
  const text = contentText(data?.message?.content).trim();
  if (text) return "err:" + text.slice(0, 120);
  return data?.message?.isError === true ? "err:unknown" : null;
}

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
 * 根据路由配置构造 agentOptions：仅当 route 有 provider 且该 provider 在可用集合中才覆盖；
 * provider 不可用或未配置则返回 undefined（继承父/会话模型）。
 *
 * 模型回退（P4-1）：route 只配了 provider、没配 model 时**不能**只交出 provider ——
 * 子代理会回落到父会话的模型名，而该模型名往往不属于这个 provider，请求在发出前就会以
 * `UNKNOWN_MODEL` 失败（DSH 实测：provider: tokenproto + 继承父模型 deepseek-flash → 秒失败）。
 * 这里改为向该 provider 查询模型目录并取第一个（适配器偏好顺序的第一项）作为回退模型，
 * 使「留空则继承」退化为「用该 provider 自己的默认模型」这一安全语义。
 * 查询失败或无可用模型时保持原样（不传 model），维持旧行为，交由上层报错。
 */
export async function buildAgentOptions(
  route: SkillRouteConfig | undefined,
  ctx: any,
): Promise<Record<string, unknown> | undefined> {
  if (!route?.provider) return undefined;
  const available = new Set(ctx.llm.listProviders().map((p: any) => p.id));
  if (!available.has(route.provider)) return undefined;

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
  return options;
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
 */
export function resolveContractText(
  envContract: { enabled: boolean; text?: string },
  envSig: EnvSignaturesConfig,
  ctx: any,
): { text: string; source: string } {
  if (!envContract.enabled) return { text: "", source: "disabled" };
  const fp = envFingerprint();
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
 * 路由经 getRoutes() 读取（组合层或 settings 解析后的当前值）；仅当该 skill 配置了可用
 * 的 provider 时才用 agentOptions 覆盖，provider 不可用或未配置则继承父/会话模型。
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
  const envContract = {
    enabled: config.delegateEnvContract?.enabled ?? true,
    // text 保留原始覆盖值（undefined = 未覆盖），最终文本由 pickEnvContractText 决定
    text: config.delegateEnvContract?.text,
  };
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
    return { retry, stall, schedule: scheduleCfg };
  }

  // P3-2（N1）：环境契约持久化配置归一（默认 auto；无缓存时行为不变；读写失败静默降级）
  const envSig = {
    use: (config.envSignatures?.use ?? "auto") as "auto" | "off" | "manual",
    ttlMs: Math.max(0, config.envSignatures?.ttlMs ?? 604_800_000),
    confirmCount: Math.max(1, Math.trunc(config.envSignatures?.confirmCount ?? 2)),
    contract: config.envSignatures?.contract,
    errorCategories: config.envSignatures?.errorCategories,
    cachePath: config.envSignatures?.cachePath,
  };

  return defineTool({
    name: "delegate",
    description: "把任务委派给指定专职代理：按 skill 名路由 provider/model，自动注入该代理的精简指令后 spawn 子代理。",

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
    },

    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },

    isConcurrencySafe: () => true,

    async execute(args: { skill: string; prompt: string }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate requires a calling agent (exec.agent was undefined)");

      // P3-3（N3）：每次调用解析生效配置（settings > config > 保守默认）；RETRYABLE 随 retryableReasons 动态
      const { retry, stall, schedule } = resolveRuntimeConfig();
      const RETRYABLE = new Set(retry.retryableReasons);
      ctx.logger?.info?.("[cohub schedule] 生效调度参数：batch=" + (schedule?.maxParallelBatch ?? 3)
        + " wallMs=" + (schedule?.wallClockBudgetMs ?? 600_000)
        + " jobTracking=" + (schedule?.useJobTracking ?? "auto")
        + " adaptiveBatch=" + (schedule?.adaptiveBatch ?? "auto"));

      // ① 按 skill 名精确匹配技能 + 查找路由配置（共享函数）
      const { skill, route } = resolveSkillAndRoute(args.skill, getRoutes, ctx);

      // ③ 注入该 skill 的精简指令（brief）+ 用户具体任务（spawn 不继承父上下文，必须自包含）
      const brief = skill.brief?.trim();
      if (!brief) {
        ctx.logger?.warn?.('delegate: skill "' + args.skill + '" 缺少 brief，回退完整 content');
      }

      // ④ 构造 agentOptions（共享函数；provider 未配 model 时解析该 provider 的默认模型）
      const agentOptions = await buildAgentOptions(route, ctx);

      // ⑤ 执行器环境契约注入（共享函数）
      const contractResult = resolveContractText(
        { enabled: envContract.enabled, text: envContract.text },
        envSig,
        ctx,
      );
      const contractText = contractResult.text;
      // 计算指纹，供学习者使用（resolveContractText 内部已计算一次，但此处需要独立引用）
      const fp = envFingerprint();

      // ⑥ 中止/失败重试循环（P1-2）+ N2 停滞检测（P3-1）：
      //    默认 maxRetries=0 → 单次尝试，失败即抛错（带结构化 cause）；
      //    stall.enabled=true 时每个 attempt 挂看门狗，提前中止并计入同一 maxRetries 预算。
      let lastReason = "unknown";
      let lastPartial = "";
      let lastStall: StallInfo | null = null;
      let retries = 0;

      for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
        const stallNote = lastStall ? "；停滞诊断：" + lastStall.diagnostics : "";
        const retryNote = attempt > 0
          ? "\n\n[重试 #" + attempt + "] 上一次执行中止，原因：" + lastReason
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
        if (ac && exec.signal) {
          if (exec.signal.aborted) forwardAbort();
          else { onExecAbort = forwardAbort; exec.signal.addEventListener("abort", onExecAbort, { once: true }); }
        }
        const signal = ac ? ac.signal : exec.signal;
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

        // ⑦ spawn 子代理（第一个参数是 transport provider 名，固定 "spawn"；
        //    agentOptions.provider 才是 LLM 供应商名，两者不同，别搞混）
        let run: any;
        try {
          run = await ctx.subagents.start("spawn", {
            label: "delegate:" + args.skill,
            prompt: [{ type: "text", text: promptText }],
            parent,
            persona: "你是被委派的专职代理：严格遵循任务消息中的角色定义、关键约束、输出格式与工具指令，并完成末尾的具体任务。",
            ...(agentOptions ? { agentOptions } : {}),
            signal,
          });
        } catch (error) {
          // T3：spawn 前/期间中止（prePublicationAbort）可能使 start() 抛错——归一为 aborted 处理
          if (watchdog) watchdog.detach();
          if (learner) learner.detach();
          if (onExecAbort && exec.signal) exec.signal.removeEventListener("abort", onExecAbort);
          if (ac?.signal.aborted) {
            lastReason = "aborted";
            lastPartial = "";
            lastStall = stallInfo;
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
          if (onExecAbort && exec.signal) exec.signal.removeEventListener("abort", onExecAbort);
          try { run.dispose(); } catch { /* 已释放 */ }
        }

        if (outcome?.stopReason === "completed") return contentText(outcome.output);
        lastReason = String(outcome?.stopReason ?? "unknown");
        lastPartial = contentText(outcome?.output ?? []).slice(0, 500);
        lastStall = stallInfo;
        // N2：停滞触发的中止仅在 recoverable=true 时按可重试中止处理；否则直接失败
        if (stallInfo && !stall.recoverable) break;
        if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
        retries++;
        await new Promise(r => setTimeout(r, retry.retryDelayMs));
      }

      // ⑧ 重试耗尽（或不可重试）：抛错并回传结构化 cause（通用，不依赖任何环境枚举）
      const err: any = new Error(
        'delegate: subagent stopped with reason "' + lastReason + '" after ' + retries + ' retry(ies)'
        + (lastStall ? "; stalled: " + lastStall.diagnostics : "")
        + "; partial: " + lastPartial,
      );
      err.cause = {
        stopReason: lastReason,
        partial: lastPartial,
        skill: args.skill,
        retries,
        ...(lastStall ? { stall: lastStall } : {}),
      };
      throw err;
    },
  });
}
