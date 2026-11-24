// src/delegate_batch.ts —— 批量并行委派工具
// 在一次工具调用内部用 Promise.allSettled() 并行启动多个子代理任务，
// 每个 task 有独立的 AbortController 超时控制，超时时主动中止子代理。
// 跳过 N2 停滞检测和 P1-2 重试，保持简单可靠。
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  resolveSkillAndRoute,
  buildAgentOptions,
  budgetSubagentResult,
  resolveContractText,
  buildDelegatePrompt,
  createEnvContract,
  createEnvSig,
  resolveSkillToolFilter,
  resolveSkillAgentPreset,
  formatSkillLabel,
  formatDegradeNotes,
  upsertDegradeNote,
  firstLineClamped,
  DEFAULT_FALLBACK_SKILL,
  guardDelegationDepth,
  DELEGATE_PERSONA,
  DEFAULT_SPAWN_TRANSPORT,
  startSubagentRun,
  DELEGATE_OUTPUT_CONFIG,
  resolveRouteOutputContract,
  buildOutputContractBlock,
  CONTRACT_REWRITE_MAX_CHARS,
  type SkillRouteSource,
  type DelegateConfig,
  type SkillRouteConfig,
  type DegradeNote,
} from "./delegate.ts";
import { applyResultBudget, approxTokens, resolveResultBudget, resolveSkillResultMaxChars } from "./result-budget.ts";
import { validateContractText, formatContractViolation } from "./output-contract.ts";
import { COHUB_SKILLS, type CoHubSkill } from "./skills.ts";
import { resolveSkillSnapshot, type SkillSnapshot } from "./roles.ts";
import { contentText } from "./text-utils.ts";
import { WALL_CLOCK_BUDGET_MS } from "./shared/constants.ts";
import { maybeDeferTodoNudge } from "./todo-nudge.ts";
import { validateTaskScope } from "./granularity.ts";
import { describeActivationContractError } from "./contract-probe.ts";

/**
 * 降级提示里回显 taskId 的字符上限。
 *
 * 只作用于提示回显（`[<taskId> <what>，…]`）：taskId 是调用方自由填写的字符串，
 * 可能带换行（破坏单行）、带半角方括号（伪造提示边界）或极长（撑爆返回预算）。
 * 归一用 delegate.ts 的 firstLineClamped（取首行 + 压空白 + 方括号转全角 + 截断加 `…`）。
 * `task.id` 的原始值在结果映射等处**不受此上限影响**——这里只是展示层归一。
 */
const BATCH_TASK_ID_ECHO_MAX = 40;

/**
 * **内置**角色的静态名单（唯一权威来源：skills.ts 的 COHUB_SKILLS 运行时值）。
 * 仍用于 parameters 里 skill.description 的可读名单（schema 是静态的，装不下运行时自定义角色）。
 *
 * 派发前的**白名单校验**已改为运行时统一快照（内置 ∪ config.customRoles，见
 * {@link assertKnownSkill}）——自定义角色因此可被 delegate_batch 引用，与 delegate 一致。
 */
const KNOWN_SKILL_NAMES: readonly string[] = COHUB_SKILLS.map(s => s.name);

/** 内置名单的「13 选 1」单行文案（schema description 用） */
const SKILL_NAMES_TEXT = KNOWN_SKILL_NAMES.join(", ");

/**
 * 白名单校验：非空 skill 必须在**运行时快照**（内置 ∪ config.customRoles）内，且未被禁用。
 * 空串/缺失一律放行（由调用方的既有兜底逻辑处理，保持 :382-394 行为不变）。
 * 命中返回 { ok: true }；未命中返回带「正确写法」的错误文案，由调用方转成该 task 的 error 结果。
 *
 * 错误文案区分两种失败（接线自定义角色后才可能出现第二种）：
 *   - 不存在（拼错 / 未登记）→ 回显**当前**可用角色全名单（含自定义角色）；
 *   - 存在但被 config.disabledSkills 禁用 → 明确提示「改配置而非改名」。
 *
 * 导出仅为单测（test/roles-dispatch.ts）覆盖批量路径的白名单判据；运行时只在本文件内调用。
 */
export function assertKnownSkill(raw: string, snapshot: SkillSnapshot): { ok: true } | { ok: false; error: string } {
  if (raw.length === 0) return { ok: true };
  const lookup = snapshot.resolve(raw);
  if (lookup.ok) return { ok: true };
  const names = snapshot.names.join(" / ");
  if (lookup.reason === "disabled") {
    return {
      ok: false,
      error: `skill 名 "${raw}" 存在但已被禁用（config.disabledSkills），当前不可派发；`
        + `如需使用请将其从禁用清单中移除，而不是改名。可用角色：${names}`,
    };
  }
  return {
    ok: false,
    error: `skill 名 "${raw}" 不存在。可用角色：${names}`
      + `（co-orchestrator 为主代理，通常委派用其余 ${snapshot.names.length - 1} 个）`,
  };
}

/** 单个批量委派任务 */
export interface DelegateBatchTask {
  /** 可选任务标识，用于结果映射；不提供时自动生成 task-0, task-1... */
  id?: string;
  /** 必填，专职代理技能名（必须是 co-* 代理名），如 co-fixer / co-explorer / co-oracle。
   *  漏传会被参数校验直接拒绝；万一绕过校验（旧调用 / 手写 args），运行时兜底到 co-fixer 并 warn。 */
  skill: string;
  /** 必填，给该代理的具体任务描述（自包含，写全目标、文件路径、约束） */
  prompt: string;
  /** 可选，任务粒度声明 —— 「单包硬上限」的**运行时版本**（软约束见 orchestrator 技能的粒度纪律）。
   *  - demands：可独立判定诉求数，上限 3；
   *  - domains：模块域（受影响的模块名），上限 2。
   *  超限时本 task 直接落 error 并附拆分建议（其它 task 照常派发）；**不传 = 不校验**，
   *  向后兼容历史调用（详见 granularity.ts 的 validateTaskScope）。 */
  scope?: { demands?: number; domains?: string[] };
}

/** 规范化后的批量任务：skill 已 trim 并兜底，taskId 已生成 */
interface NormalizedBatchTask {
  task: DelegateBatchTask;
  taskId: string;
  /** 规范化后的 skill 名（空值已兜底为 DEFAULT_FALLBACK_SKILL） */
  requestedSkill: string;
  /** 是否为「未提供 skill → 兜底」的情形（决定 label 里是否带 (default:co-fixer)） */
  skillFallback: boolean;
}

/** 单个批量委派结果 */
export interface DelegateBatchResult {
  id: string;
  skill: string;
  status: "completed" | "failed" | "error";
  result?: string;
  error?: string;
  stopReason?: string;
  /** SubagentResult.diagnostic 原样透传（provider 侧失败详情） */
  diagnostic?: string;
  /** 本任务的降级提示（已 formatDegradeNotes 渲染；无降级时省略）。
   *  仅作结构化字段供程序化排查——返回文本里的降级提示统一在末尾合并输出一次，
   *  这里不再重复拼进 output，避免同一提示出现两遍。 */
  degrade?: string;
  /** 该 task 实际开始派发的 epoch ms（闭包内取 Date.now()；未进入派发时省略） */
  startedAt?: number;
  /** 该 task 结束的 epoch ms（完成 / 失败 / 超时 / 启动失败 / 白名单拒绝都补） */
  endedAt?: number;
  /** endedAt - startedAt（毫秒，恒 ≥ 0）；startedAt 缺失时一并省略 */
  durationMs?: number;
  /** 子运行 id（run.id，契约上等于宿主 childId）；拿不到时省略 */
  runId?: string;
  /** 波3：结果未满足输出契约（lite 恒为标记；strict 仅在重写后仍违约时标记）。
   *  level=off / 合规时**字段不出现**（逐字节兼容）。 */
  contractViolated?: true;
}

/** 批量事件阶段枚举 */
export type BatchEventPhase =
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "timeout"
  | "skill-error"
  | "scope-error"
  /** 波3：strict 档契约违约 → 重写一次（该 task 的第二次派发） */
  | "contract-retry";

/** 单个 task 的时间线事件（每 task 最多 MAX_EVENTS_PER_TASK 条，detail ≤ BATCH_EVENT_DETAIL_MAX） */
export interface BatchEvent {
  /** 归属 task（调用方传入的 id 或自动生成的 task-N） */
  taskId: string;
  phase: BatchEventPhase;
  /** 事件发生时刻（epoch ms） */
  at: number;
  /** 附加说明（已单行化并截断到 ≤120 字符）；无内容时省略 */
  detail?: string;
}

/**
 * 工具返回的结构化载荷：`text` 是拼好的返回文本，`events` 是**顶层可选**的事件流。
 *
 * 为什么 execute 仍返回字符串而不是本对象：`DELEGATE_OUTPUT_CONFIG.schema` 是 string，
 * 宿主 render 走 `String(value)`——返回对象会被渲染成 "[object Object]"，
 * 直接打断 runtime-0.2.ts 对返回文本的既有断言。因此结构化字段通过本类型约定：
 * 文本里有人可读的「task 时间线」，程序化调用方可从 `events` 取同一批事件
 * （execute 末尾经 `exec.onBatchEvents` 可选回调发射；宿主不支持则静默跳过）。
 */
export interface DelegateBatchEnvelope {
  text: string;
  results: DelegateBatchResult[];
  events?: BatchEvent[];
}

/** 批量委派最大任务数（硬上限，防止意外超量并行压垮系统） */
const MAX_BATCH_SIZE = 20;

/**
 * 每个 task 最多保留的事件条数。
 * 事件会进上下文，必须硬限：超出**静默丢弃**（pushBatchEvent 返回 false），绝不抛错——
 * 打点是观测手段，任何情况下都不允许反过来打断派发或收集。
 */
const MAX_EVENTS_PER_TASK = 5;

/** 单条事件 detail 的字符上限（超长截断并补 `…`） */
const BATCH_EVENT_DETAIL_MAX = 120;

/** task 时间线最多渲染的 task 行数（超出的折叠成一行 `…+N`） */
const TIMELINE_MAX_ROWS = 20;

/** task 时间线单行字符上限（超长截断并补 `…`） */
const TIMELINE_LINE_MAX_CHARS = 120;

/** detail 归一：压成单行 + 压空白 + 截断到 BATCH_EVENT_DETAIL_MAX（超长保留前 N-1 字符加 `…`） */
function clampEventDetail(raw: string): string {
  const oneLine = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= BATCH_EVENT_DETAIL_MAX) return oneLine;
  return oneLine.slice(0, BATCH_EVENT_DETAIL_MAX - 1) + "…";
}

/** 记录一条事件：超每 task 上限即丢弃（返回 false），任何入参都不抛错 */
function pushBatchEvent(events: BatchEvent[], event: BatchEvent): boolean {
  if (events.length >= MAX_EVENTS_PER_TASK) return false;
  events.push({
    taskId: event.taskId,
    phase: event.phase,
    at: event.at,
    ...(event.detail === undefined ? {} : { detail: clampEventDetail(event.detail) }),
  });
  return true;
}

/**
 * 结果条目补时间字段（startedAt / endedAt / durationMs / runId）。
 * startedAt 缺失时整组字段省略——旧调用与测试桩的行为零变化（向后兼容）。
 * 只用 Date.now() 的差值，不插入任何 await / sleep（stall-p3 有 5-8ms 级时序断言）。
 */
function withTiming(
  entry: DelegateBatchResult,
  startedAt: number | undefined,
  endedAt: number,
  runId?: string,
): DelegateBatchResult {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return entry;
  return {
    ...entry,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    ...(typeof runId === "string" && runId.length > 0 ? { runId } : {}),
  };
}

/**
 * 渲染「task 时间线」段：每 task 一行
 * `- [任务id] 状态 · 耗时 1234ms · 关键事件串`。
 *
 * 无任何耗时数据时返回空串（整段省略，向后兼容）；最多 TIMELINE_MAX_ROWS 行 + 一行 `…+N`；
 * 单行超 TIMELINE_LINE_MAX_CHARS 截断。**本段必须在 applyResultBudget 之后拼接**，
 * 与 degradeNotes 同策略，保证预算裁剪切不到它。
 */
function renderTaskTimeline(results: DelegateBatchResult[], eventsByTask: BatchEvent[][]): string {
  // 行按 startedAt 升序（同刻保留收集顺序）：时间线本来就该按时间读，
  // 而不是按「先收集失败条目、再收集 run 结果」的实现顺序读。
  const entries: Array<{ line: string; startedAt: number; order: number }> = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r === undefined) continue;
    const duration = typeof r.durationMs === "number"
      ? r.durationMs
      : typeof r.startedAt === "number" && typeof r.endedAt === "number"
        ? Math.max(0, r.endedAt - r.startedAt)
        : undefined;
    if (duration === undefined) continue;
    const chain = (eventsByTask[i] ?? []).map(e => e.phase).join("→");
    let line = "- [" + firstLineClamped(r.id, BATCH_TASK_ID_ECHO_MAX) + "] " + r.status
      + " · 耗时 " + duration + "ms" + (chain.length > 0 ? " · " + chain : "");
    if (line.length > TIMELINE_LINE_MAX_CHARS) line = line.slice(0, TIMELINE_LINE_MAX_CHARS - 1) + "…";
    entries.push({ line, startedAt: typeof r.startedAt === "number" ? r.startedAt : (r.endedAt ?? 0), order: i });
  }
  if (entries.length === 0) return "";
  entries.sort((a, b) => (a.startedAt - b.startedAt) || (a.order - b.order));
  const rows = entries.map(e => e.line);
  const shown = rows.length > TIMELINE_MAX_ROWS ? rows.slice(0, TIMELINE_MAX_ROWS) : rows;
  const overflow = rows.length - shown.length;
  return "## task 时间线\n" + shown.join("\n") + (overflow > 0 ? "\n…+" + overflow : "") + "\n\n";
}

/**
 * 创建 delegate_batch 工具。
 * 一次调用并行启动多个子代理任务，返回结构化结果。
 * 每个 task 有独立的 AbortController，超时时主动中止子代理。
 * 跳过 N2 停滞检测和 P1-2 重试。
 */
export function createDelegateBatchTool(
  ctx: any,
  getRoutes: SkillRouteSource,
  config: DelegateConfig = {},
  getSettings?: () => any,
) {
  const envContract = createEnvContract(config);
  const envSig = createEnvSig(config);

  function resolveRuntimeConfig() {
    const settingsNow = getSettings ? (getSettings() ?? {}) : {};
    const scheduleCfg = settingsNow.schedule ?? config.schedule;
    // maxParallelBatch：从 settings 读取（默认 5，与 ScheduleConfig schema 缺省一致），与硬上限 MAX_BATCH_SIZE 取小值；
    // 保留 MAX_BATCH_SIZE 作为绝对安全上限（防止配置错误导致超量并行）。
    const rawMaxParallel = Math.max(1, scheduleCfg?.maxParallelBatch ?? 5);
    // P1-3（子代理结果预算）：settings 优先，config 兜底；缺省值即生效
    const budget = resolveResultBudget(settingsNow.resultBudget ?? config.resultBudget);
    // P1-1（子代理工具表裁剪）：默认开启；settings 未提供时回落 config
    const toolFilterEnabled = (settingsNow.toolFilter ?? config.toolFilter)?.enabled ?? true;
    // 子代理独立精简 preset：默认开启（settings 优先，config 兜底）
    const presetEnabled = (settingsNow.delegateSubagentPreset ?? config.delegateSubagentPreset)?.enabled ?? true;
    return {
      wallClockBudgetMs: Math.max(0, scheduleCfg?.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS),
      maxParallelBatch: Math.min(rawMaxParallel, MAX_BATCH_SIZE),
      budget,
      toolFilterEnabled,
      presetEnabled,
    };
  }

  return defineTool({
    name: "delegate_batch",
    description: "并发执行多个子代理任务：一次调用并行派发 N 个无依赖任务，返回各自结果。"
      + "每项 skill/prompt 必填，单批默认 5（上限 20），不重试。",

    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "任务列表（≤maxParallelBatch）。每项仅接受 4 个字段：id(可选) / skill(必填) / prompt(必填) / scope(可选，任务粒度声明)；出现其它字段会被参数校验拒绝。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "可选任务标识，用于结果映射" },
            skill: {
              type: "string",
              required: true,
              description: "必填。合法值（" + KNOWN_SKILL_NAMES.length + " 选 1）：" + SKILL_NAMES_TEXT
                + "。注意 co-orchestrator 为主代理，通常委派用其余 " + (KNOWN_SKILL_NAMES.length - 1) + " 个。",
            },
            prompt: { type: "string", required: true, description: "必填，给该代理的具体任务（自包含）" },
            // 粒度自检（「单包硬上限」的运行时版本）：可选声明，超限只让本 task 落 error 并附拆分建议。
            // 不传 = 不校验（历史调用零行为变化）；规则与文案见 granularity.ts。
            scope: {
              type: "object",
              additionalProperties: false,
              description: "可选，任务粒度声明：demands（可独立判定诉求数，上限 3）/ domains（模块域，上限 2）。"
                + "超限时本 task 直接落 error 并给出拆分建议（其它 task 照常执行）；不传则跳过校验。",
              properties: {
                demands: { type: "number", description: "可选，可独立判定诉求数（每个需单独拍板/验收的点算 1），上限 3" },
                domains: {
                  type: "array",
                  description: "可选，模块域（受影响的模块名），上限 2",
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
    },

    output: DELEGATE_OUTPUT_CONFIG,

    isConcurrencySafe: () => true,

    async execute(args: { tasks: DelegateBatchTask[] }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate_batch requires a calling agent (exec.agent was undefined)");

      // 嵌套委派守卫（与 delegate 同一判定）：子代理不可再派子代理。
      // 整批拒绝而非逐条跳过——一批全是同层子代理，跳过只会让调用方误判为「任务失败」。
      const depthRejection = guardDelegationDepth(parent, ctx.logger);
      if (depthRejection !== undefined) {
        ctx.logger?.warn?.("[cohub depth-guard] delegate_batch：" + depthRejection);
        throw new Error(depthRejection);
      }

      const { wallClockBudgetMs, maxParallelBatch, budget, toolFilterEnabled, presetEnabled } = resolveRuntimeConfig();
      // 统一技能快照（内置 ∪ config.customRoles）：白名单、技能解析、档位裁剪、preset、提示词
      // 全部经这一份名单，与 delegate 单发路径同一条解析链。每批重建 → customRoles 热改即生效。
      const skillSnapshot = resolveSkillSnapshot({
        customRoles: config.customRoles,
        disabledSkills: config.disabledSkills,
      });
      const tasks = args.tasks ?? [];

      if (tasks.length === 0) {
        return "delegate_batch: 无任务";
      }

      if (tasks.length > maxParallelBatch) {
        return `delegate_batch: 任务数 ${tasks.length} 超过上限 ${maxParallelBatch}，请分批执行。`;
      }

      // 批次计时起点：统计行「总耗时」的两个时间点之一（并发的 Promise.allSettled 从这里之后启动）
      const batchStartedAt = Date.now();

      // 所有 task 共享同一份环境契约文本（只计算一次，避免重复 I/O）
      const contractText = envContract.enabled ? resolveContractText(envContract, envSig, ctx).text : "";

      // 规范化每个 task 的 skill（schema 必填之外的**第二道防线**）：
      // 旧调用（改必填之前的 args）或手写 args 仍可能漏传——绝不把 undefined 带进
      // label / preset 解析 / 结果字段，一律 trim 后兜底 co-fixer 并打一条 warn。
      const normalized: NormalizedBatchTask[] = tasks.map((task, index) => {
        const taskId = task.id ?? `task-${index}`;
        const raw = typeof task.skill === "string" ? task.skill.trim() : "";
        const skillFallback = raw.length === 0;
        if (skillFallback) {
          ctx.logger?.warn?.(
            "[cohub delegate_batch] task \"" + taskId + "\" 缺少 skill（收到 "
            + JSON.stringify(task.skill ?? null) + "），已兜底为 " + DEFAULT_FALLBACK_SKILL
            + "；schema 已要求 skill 必填，出现本告警说明调用绕过了参数校验",
          );
        }
        return { task, taskId, requestedSkill: skillFallback ? DEFAULT_FALLBACK_SKILL : raw, skillFallback };
      });

      // 每 task 一条事件流（按 normalized 下标对齐，不用 taskId 做 key——调用方可以传重复 id）。
      // 事件全部由 pushBatchEvent 写入：每 task ≤ MAX_EVENTS_PER_TASK 条、detail ≤ 120 字符，
      // 超出静默丢弃，因此事件规模与上下文开销都是**有界**的。
      const batchEvents: BatchEvent[][] = normalized.map(() => []);
      for (let i = 0; i < normalized.length; i += 1) {
        const seed = normalized[i];
        if (seed === undefined) continue;
        pushBatchEvent(batchEvents[i], {
          taskId: seed.taskId,
          phase: "queued",
          at: batchStartedAt,
          detail: seed.skillFallback ? "skill 缺失，兜底 " + DEFAULT_FALLBACK_SKILL : seed.requestedSkill,
        });
      }

      // 并行启动所有子代理
      const starts = await Promise.allSettled(
        normalized.map(async ({ task, taskId, requestedSkill, skillFallback }, index) => {
          // spawn 起算时刻：单个 task 的超时预算从这里开始计（见下方 Promise.race），
          // 而不是从「逐个收集结果」的 await 时刻开始计——后者会让第 i 个 task 拿到
          // 从第 i-1 个 settle 起算的完整预算，整批最坏退化为 N × wallClockBudgetMs。
          const startedAt = Date.now();
          const taskEvents = batchEvents[index];
          pushBatchEvent(taskEvents, { taskId, phase: "started", at: startedAt });
          // 白名单校验（第三道防线）：非空 skill 必须在**运行时快照**（内置 ∪ config.customRoles）内。
          // 不合法时**只让该 task 失败**（返回 skillError，由收集阶段转成 status:"error"），
          // 绝不抛全局异常——同批其它 task 照常派发，不被一个写错的 skill 名拖垮。
          // 空串/缺失仍走上方的兜底（:382-394 不变），这里只拦「非空但不合法 / 已禁用」。
          const skillCheck = assertKnownSkill(requestedSkill, skillSnapshot);
          if (!skillCheck.ok) {
            ctx.logger?.warn?.(
              "[cohub delegate_batch] task \"" + taskId + "\" 的 skill 名 \"" + requestedSkill
              + "\" 不在合法名单内，已按错误返回（不再静默降级为 " + DEFAULT_FALLBACK_SKILL + "）",
            );
            // 不创建 run / AbortController：该 task 不进入 runs 清理列表
            // （终态事件 skill-error 在收集阶段统一补，闭包只负责 queued/started）
            return {
              taskId, skillName: requestedSkill, skillTag: requestedSkill, task,
              taskNotes: [], run: undefined, ac: undefined, onExecAbort: null, startedAt,
              startError: undefined, skillError: skillCheck.error,
            };
          }
          // D · 粒度自检（「单包硬上限」的运行时版本）：白名单之后、路由之前。
          // scope 未传 = 不校验（ok，历史调用零行为变化）；超限只让本 task 落 error 条目并附拆分建议，
          // 同批其它 task 照常派发——与上面的 skill 白名单同一风格，绝不整批拒绝。
          const scopeCheck = validateTaskScope(task.scope);
          if (!scopeCheck.ok) {
            ctx.logger?.warn?.(
              "[cohub delegate_batch] task \"" + taskId + "\" 的 scope 超出单包粒度上限（诉求 ≤"
              + "3 / 模块域 ≤2），已按错误返回并给出拆分建议",
            );
            // （终态事件 scope-error 在收集阶段统一补，闭包只负责 queued/started）
            return {
              taskId, skillName: requestedSkill, skillTag: requestedSkill, task,
              taskNotes: [], run: undefined, ac: undefined, onExecAbort: null, startedAt,
              startError: undefined, skillError: undefined, scopeError: scopeCheck.error,
            };
          }
          const { skill, role: skillRole, route, note: skillNote } =
            resolveSkillAndRoute(requestedSkill, getRoutes, ctx, ctx.logger, skillSnapshot);
          // 降级原因收集槽：**每个 task 独立一个数组**（对应 delegate 的单次 execute）。
          // 若整批共用一个数组，同一 id（如 "skill"）的 note 会被后一个 task 覆盖，
          // 前面任务的降级就再也回不到返回文本里了。
          const taskNotes: DegradeNote[] = [];
          // ① skill 名未命中 / skill 缺失兜底：resolveSkillAndRoute 已把原因写进 note，
          //    这里登记一条，确保「skill 拼错」这类静默降级出现在 batch 返回文本里。
          //    （upsertDegradeNote 现已由 delegate.ts 导出；每任务只登记一条，直接 push 等价。）
          if (skillNote !== undefined) {
            taskNotes.push({
              id: "skill",
              what: "skill 名未命中",
              effect: "子代理已按兜底角色 " + skill.name + " 执行",
              reason: skillNote,
            });
          }
          // label / 结果里的 skill 片段：兜底时显式标 (default:co-fixer)，绝不出现 ":undefined"
          const skillTag = formatSkillLabel(skill, skillFallback);
          // 波3：契约**按 task** 解析——同一批里各 task 的 skill 可能不同，绝不能整批共用一个契约。
          // off（默认）时 outputContractText === ""，prompt 与改动前逐字节一致。
          const outputContract = resolveRouteOutputContract(skill.name, route);
          const contractActive = outputContract.level !== "off" && outputContract.schema !== undefined;
          const outputContractText = contractActive && outputContract.schema !== undefined
            ? buildOutputContractBlock(outputContract.schema)
            : "";
          // 契约段插在任务正文之后（理由见 delegate.ts 的 buildOutputContractBlock 注释）；
          // rewriteNote 仅在 strict 重写时传入，正常路径为 undefined → 拼接结果不变。
          const buildPrompt = (rewriteNote?: string): string => buildDelegatePrompt({
            skill,
            // 自定义角色：注入其 prompt 作为角色指令（brief）；内置角色不传 → 逐字不变
            ...(skillRole !== undefined && !skillRole.builtin && skillRole.skill.brief.length > 0
              ? { customPrompt: skillRole.skill.brief }
              : {}),
            contractText,
            userPrompt: task.prompt,
            ...(rewriteNote === undefined ? {} : { retryNote: rewriteNote }),
            outputContractText,
          });
          const promptText = buildPrompt();
          // P1-1：按角色档位裁剪子代理工具表（resolveTier → TIER_TOOLS；构造失败已 fail-soft 成全量工具）
          const toolFilter = resolveSkillToolFilter(skill.name, toolFilterEnabled, ctx.logger, config.customRoles);
          // 子代理独立精简 preset：每个 task 按各自的 skill 档位解析（undefined = 继承父 preset）
          const agentPreset = resolveSkillAgentPreset(skill.name, presetEnabled, config.customRoles, ctx.logger);

          // 每个 task 独立的 AbortController
          const ac = new AbortController();
          let onExecAbort: (() => void) | null = null;

          if (exec.signal) {
            if (exec.signal.aborted) {
              ac.abort();
            } else {
              onExecAbort = () => { if (!ac.signal.aborted) ac.abort(); };
              exec.signal.addEventListener("abort", onExecAbort, { once: true });
            }
          }

          try {
            // buildAgentOptions 可能 await 路由解析（外部 provider 查询）：必须放在 try 内。
            // 否则它抛的错会被外层 Promise.allSettled 收成 rejected，收集阶段再静默 continue，
            // 整批只剩「0/N 完成 0.0s」——看不到任何原因（本函数修的就是这个静默失败）。
            // 降级收集：路由三处 fail-soft（provider 未注册 / model 回退 / 强度不支持）
            // 只登记进**本任务的** taskNotes —— 每 task 一个数组，绝不跨 task 串味；
            // 随后经 degradeField 进该 task 结果条目的 degrade 字段，并在批级降级段合并渲染。
            const agentOptions = await buildAgentOptions(
              route,
              ctx,
              skill.name,
              (note) => upsertDegradeNote(taskNotes, note),
            );
            // 派发工厂：首次派发与 strict 契约重写**共用同一通道**（同一 startSubagentRun 入参形状、
            // 同一 guard/preset/toolFilter/degradeNotes 槽），重写不会绕开任何既有机制。
            const spawnAgain = async (text: string, spawnSignal: AbortSignal): Promise<any> =>
              startSubagentRun(ctx, DEFAULT_SPAWN_TRANSPORT, {
                label: `delegate_batch:${taskId}:${skillTag}`,
                prompt: [{ type: "text", text }],
                parent,
                persona: DELEGATE_PERSONA,
                // P1-1：工具表裁剪（undefined 时不透传，等价于全量工具）
                ...(toolFilter !== undefined ? { toolFilter } : {}),
                // 子代理独立精简 preset（undefined 时不透传 = 继承父 preset）
                ...(agentPreset !== undefined ? { agentPreset } : {}),
                ...(agentOptions ? { agentOptions } : {}),
                signal: spawnSignal,
                // 降级原因收集槽：preset / toolFilter 的 fail-soft 会往这里登记原因，
                // 少了这一行，batch 路径的 preset/toolFilter 降级就只剩 warn（等同静默）。
                degradeNotes: taskNotes,
              });
            const run = await spawnAgain(promptText, ac.signal);
            return {
              taskId, skillName: skill.name, skillTag, task, taskNotes, run, ac, onExecAbort, startedAt,
              startError: undefined, skillError: undefined,
              outputContract, buildPrompt, spawnAgain,
            };
          } catch (startError) {
            // start 失败：清理 onExecAbort 监听器，返回带错误标记的对象
            if (onExecAbort && exec.signal) {
              try { exec.signal.removeEventListener("abort", onExecAbort); } catch { /* 可能已释放 */ }
            }
            return { taskId, skillName: skill.name, skillTag, task, taskNotes, run: undefined, ac, onExecAbort: null, startedAt, startError, skillError: undefined };
          }
        }),
      );

      // 收集结果（最外层 try-finally 确保所有 runs 被清理）
      const results: DelegateBatchResult[] = [];
      /** 与 results 下标一一对应的事件流（渲染 task 时间线用；不依赖 taskId 唯一） */
      const resultEvents: BatchEvent[][] = [];
      const runs: Array<{ run: any; safeDispose: () => void; ac: AbortController; onExecAbort: (() => void) | null; taskId: string; skillName: string; skillTag: string; taskNotes: DegradeNote[]; startedAt: number; taskEvents: BatchEvent[]; outputContract: ReturnType<typeof resolveRouteOutputContract>; buildPrompt: (rewriteNote?: string) => string; spawnAgain: (text: string, signal: AbortSignal) => Promise<any> }> = [];
      // 每任务的降级原因（按 starts 顺序），供末尾统一合并成一段提示
      const perTaskNotes: Array<{ taskId: string; notes: DegradeNote[] }> = [];
      // 结果对象上的 degrade 字段：渲染后逐字 trim（末尾合并提示另走 formatDegradeNotes 原样前缀）
      const degradeField = (notes: DegradeNote[]): { degrade?: string } => {
        const text = formatDegradeNotes(notes).trim();
        return text.length > 0 ? { degrade: text } : {};
      };

      try {
        // 索引循环（不用 starts.entries()）：与 normalized 一一对应，落 error 条目时要拿 taskId
        for (let index = 0; index < starts.length; index += 1) {
          const s = starts[index];
          if (s === undefined) continue;
          if (s.status === "rejected") {
            // 派发前异常（skill 解析 / buildAgentOptions / 其它 await）会被外层 allSettled 收成
            // rejected；原实现只 continue → 该 task 在输出里彻底消失，整批只剩「0/N 完成 0.0s」。
            // 这里改为落一条 error 结果，把原因（error.message）回显到输出，绝不静默。
            const seed = normalized[index];
            const rejectedId = seed?.taskId ?? `task-${index}`;
            const rejectedNotes: DegradeNote[] = [];
            perTaskNotes.push({ taskId: rejectedId, notes: rejectedNotes });
            // 打点：rejected（派发前异常）同样补终态事件 + endedAt/durationMs，
            // 起点用批次起点兜底（闭包内的 startedAt 随异常丢失，没有更精确的锚点）。
            const rejectedMessage = s.reason instanceof Error ? s.reason.message : String(s.reason);
            const rejectedAt = Date.now();
            const rejectedEvents = batchEvents[index] ?? [];
            pushBatchEvent(rejectedEvents, {
              taskId: rejectedId, phase: "failed", at: rejectedAt, detail: rejectedMessage,
            });
            resultEvents.push(rejectedEvents);
            results.push(withTiming({
              id: rejectedId,
              skill: seed?.requestedSkill ?? DEFAULT_FALLBACK_SKILL,
              status: "error",
              error: rejectedMessage,
              ...degradeField(rejectedNotes),
            }, batchStartedAt, rejectedAt));
            continue;
          }
          const val = s.value as any;
          if (val.scopeError) {
            // 粒度超限（D）：只让本 task 失败，同批其它 task 继续（无 run 对象，不加入 runs 清理列表）
            perTaskNotes.push({ taskId: val.taskId, notes: val.taskNotes ?? [] });
            // 打点：粒度超限也补终态事件 + endedAt/durationMs（起点用闭包内的 startedAt）
            const scopeAt = Date.now();
            const scopeEvents = batchEvents[index] ?? [];
            pushBatchEvent(scopeEvents, {
              taskId: val.taskId, phase: "scope-error", at: scopeAt, detail: String(val.scopeError ?? ""),
            });
            resultEvents.push(scopeEvents);
            results.push(withTiming({
              id: val.taskId,
              skill: val.skillTag,
              status: "error",
              error: val.scopeError,
              ...degradeField(val.taskNotes ?? []),
            }, val.startedAt, scopeAt));
            continue;
          }
          if (val.skillError) {
            // skill 名不合法：只让本 task 失败，同批其它 task 继续（无 run 对象，不加入 runs 清理列表）
            perTaskNotes.push({ taskId: val.taskId, notes: val.taskNotes ?? [] });
            // 打点：白名单拒绝同样有完整时间线（started → skill-error），失败也带耗时。
            const skillErrAt = Date.now();
            const skillErrEvents = batchEvents[index] ?? [];
            pushBatchEvent(skillErrEvents, {
              taskId: val.taskId, phase: "skill-error", at: skillErrAt, detail: String(val.skillError ?? ""),
            });
            resultEvents.push(skillErrEvents);
            results.push(withTiming({
              id: val.taskId,
              skill: val.skillTag,
              status: "error",
              error: val.skillError,
              ...degradeField(val.taskNotes ?? []),
            }, val.startedAt, skillErrAt));
            continue;
          }
          if (val.startError) {
            // start 失败：记录失败结果，不加入 runs 列表（没有 run 对象）
            perTaskNotes.push({ taskId: val.taskId, notes: val.taskNotes ?? [] });
            const startMessage = val.startError instanceof Error ? val.startError.message : String(val.startError);
            // A · 契约自检的归因兜底：宿主 reads 位置漂移时抛的是裸 TypeError
            // （Cannot read properties of undefined (reading 'id')），原始 message 无法归因。
            // 有归因文本就追加（**原文保留在前**，不被替换）；只影响本 task 的 error 条目，
            // 同批其它 task 的结果不受影响（逐 task 独立的对象字段，不是整批错误）。
            const attribution = describeActivationContractError(val.startError);
            // 打点：启动失败也要有终态事件与耗时（否则「卡在启动」在时间线里完全不可见）
            const startErrAt = Date.now();
            const startErrEvents = batchEvents[index] ?? [];
            pushBatchEvent(startErrEvents, {
              taskId: val.taskId, phase: "failed", at: startErrAt, detail: startMessage,
            });
            resultEvents.push(startErrEvents);
            results.push(withTiming({
              id: val.taskId,
              skill: val.skillTag,
              status: "error",
              error: attribution === undefined ? startMessage : `${startMessage}\n${attribution}`,
              ...degradeField(val.taskNotes ?? []),
            }, val.startedAt, startErrAt));
            continue;
          }
          const { run, taskId, skillName, skillTag, taskNotes, ac, onExecAbort, startedAt, outputContract, buildPrompt, spawnAgain } = val;
          // events 沿用闭包内那条流（queued → started 已在其中），终态事件由下面的收集循环追加
          const taskEvents: BatchEvent[] = batchEvents[index] ?? [];
          // 幂等 dispose：race 的超时/abort 分支与末尾统一清理共用同一个，重复调用安全。
          let disposed = false;
          const safeDispose = (): void => {
            if (disposed) return;
            disposed = true;
            // 同步调用的 reject 无人接（unhandledRejection）：显式吞掉并异步等释放完成
            void Promise.resolve().then(() => run.dispose()).catch(() => { /* 已释放 */ });
          };
          runs.push({ run, safeDispose, taskId, skillName, skillTag, taskNotes, ac, onExecAbort, startedAt, taskEvents, outputContract, buildPrompt, spawnAgain });
          perTaskNotes.push({ taskId, notes: taskNotes });

          // 防 unhandledRejection
          run.result.catch(() => {});
        }

        // 逐个 await run.result（带独立超时和独立 AbortController；父级 abort 也参与竞速）
        for (const { run, safeDispose, taskId, skillName, skillTag, taskNotes, ac, startedAt, taskEvents, outputContract, buildPrompt, spawnAgain } of runs) {
          let outcome: any;
          let timer: ReturnType<typeof setTimeout> | null = null;
          // 子运行 id（run.id 契约上等于宿主 childId）；拿不到就省略 runId 字段
          const runId = typeof run?.id === "string" && run.id.length > 0 ? run.id : undefined;
          // 用数组收集监听器清理函数：避开 TS 对「只在回调内赋值」的 let 变量窄化成 null
          const abortOffs: Array<() => void> = [];

          // 超时预算以 spawn 时刻为起点：扣除该 task 已耗时（含 start 前的 route/agentOptions 解析
          // 与前面 task 的等待）。若已耗尽则立即走超时分支（delay=0）。
          // 错误文本报「实际耗时」（= 此刻 - startedAt），预算值仅作括号内参考，便于排查。
          const remainingMs = Math.max(0, wallClockBudgetMs - (Date.now() - startedAt));
          const parentSignal: AbortSignal | undefined = exec.signal;

          try {
            outcome = await Promise.race([
              run.result,
              new Promise<never>((_, reject) => {
                // abort 与超时共用同一条收尾路径：先 dispose 释放 run，再 reject 结束等待，
                // 避免死等一个永不 settle 的 result（dispose 幂等，finally 再调无副作用）。
                const failFast = (message: string): void => {
                  if (timer) { clearTimeout(timer); timer = null; }
                  safeDispose();
                  reject(new Error(message));
                };
                const onAbort = (): void => {
                  if (!ac.signal.aborted) ac.abort();
                  failFast(`已取消：实际耗时 ${Date.now() - startedAt}ms（父级 abort）`);
                };
                if (parentSignal) {
                  if (parentSignal.aborted) { onAbort(); return; }
                  parentSignal.addEventListener("abort", onAbort, { once: true });
                  abortOffs.push(() => parentSignal.removeEventListener("abort", onAbort));
                }
                timer = setTimeout(() => {
                  // 超时时主动 abort 子代理
                  if (!ac.signal.aborted) ac.abort();
                  failFast(`超时：实际耗时 ${Date.now() - startedAt}ms（预算 ${wallClockBudgetMs}ms）`);
                }, remainingMs);
              }),
            ]);

            if (outcome?.stopReason === "completed") {
              // 波3 校验点（batch）：按**本 task** 的契约校验；off 时整段跳过（不解析、不校验）。
              // 违约处理：
              //   lite   → 不重写，末尾追加紧凑标记 + contractViolated 字段；
              //   strict → 长度 < CONTRACT_REWRITE_MAX_CHARS 时重写一次（新派发，非续聊），
              //            失败/仍违约都只标记，绝不第三次。
              // 校验与重写都发生在 completed 事件**之前**，使时间线读作 started→contract-retry→completed。
              let rawText = contentText(outcome.output);
              let contractViolated = false;
              let contractMark = "";
              if (outputContract.level !== "off" && outputContract.schema !== undefined) {
                let check = validateContractText(rawText, outputContract.schema);
                if (!check.ok && outputContract.level === "strict"
                  && rawText.length < CONTRACT_REWRITE_MAX_CHARS
                  && !ac.signal.aborted
                  && exec.signal?.aborted !== true) {
                  pushBatchEvent(taskEvents, {
                    taskId, phase: "contract-retry", at: Date.now(),
                    detail: check.errors[0] ?? "契约未满足",
                  });
                  // 独立 AbortController + 父级 abort 转发：与首次派发同一套中止语义
                  const ac2 = new AbortController();
                  const onParentAbort2 = (): void => { if (!ac2.signal.aborted) ac2.abort(); };
                  let off2: (() => void) | null = null;
                  if (exec.signal) {
                    if (exec.signal.aborted) ac2.abort();
                    else {
                      exec.signal.addEventListener("abort", onParentAbort2, { once: true });
                      off2 = () => { try { exec.signal.removeEventListener("abort", onParentAbort2); } catch { /* 已释放 */ } };
                    }
                  }
                  let run2: any;
                  let timer2: ReturnType<typeof setTimeout> | null = null;
                  try {
                    run2 = await spawnAgain(
                      buildPrompt("\n\n[契约重写] 上次输出未满足以下约束："
                        + check.errors.join("；") + "。请重新输出一个完整合法的 JSON 对象（不要解释）。"),
                      ac2.signal,
                    );
                    run2.result.catch(() => {});
                    // 超时预算沿用本 task 的同一墙钟预算（扣除已耗时）
                    const remaining2 = Math.max(0, wallClockBudgetMs - (Date.now() - startedAt));
                    const outcome2 = await Promise.race([
                      run2.result,
                      new Promise<never>((_, reject) => {
                        timer2 = setTimeout(() => {
                          if (!ac2.signal.aborted) ac2.abort();
                          reject(new Error("超时：实际耗时 " + (Date.now() - startedAt) + "ms（预算 " + wallClockBudgetMs + "ms）"));
                        }, remaining2);
                      }),
                    ]);
                    if (outcome2?.stopReason === "completed") {
                      const retried = contentText(outcome2.output);
                      const recheck = validateContractText(retried, outputContract.schema);
                      if (recheck.ok) {
                        rawText = retried;
                        check = { ok: true };
                      } else {
                        check = recheck;
                      }
                    }
                  } catch (retryError) {
                    // abort / 超时 / 启动失败：按既有失败语义**保留首次结果**并标记违约，
                    // 不让契约重写的失败把整条结果降级成 error（首版输出对调用方仍有价值）。
                    ctx.logger?.warn?.(
                      "[cohub contract] " + taskId + " 契约重写未完成（按违约标记收口）："
                      + (retryError instanceof Error ? retryError.message : String(retryError)),
                    );
                  } finally {
                    if (timer2) clearTimeout(timer2);
                    if (off2) off2();
                    if (!ac2.signal.aborted) ac2.abort();
                    if (run2) { try { await run2.dispose?.(); } catch { /* 已释放 */ } }
                  }
                }
                if (!check.ok) {
                  contractViolated = true;
                  contractMark = "\n\n" + formatContractViolation(check.errors);
                  ctx.logger?.warn?.("[cohub contract] " + taskId + " 输出未满足契约（"
                    + outputContract.level + "）：" + check.errors.join("；"));
                }
              }
              // 任务实际结束时刻：在预算裁剪的 await **之前**取，durationMs 只反映子代理耗时
              const endedAt = Date.now();
              pushBatchEvent(taskEvents, {
                taskId, phase: "completed", at: endedAt,
                detail: "stopReason: completed · 输出 " + rawText.length + " 字符"
                  + (contractViolated ? " · 契约违约" : ""),
              });
              resultEvents.push(taskEvents);
              // P1-3：每个任务结果先各自预算裁剪（超预算时落盘定位），之后才参与总串拼接
              // 改动 3 同款：按 skill 解析上限（现无分档特例，一律全局档；契约段仍优先保留）
              const resultText = await budgetSubagentResult(ctx, exec, rawText, {
                maxChars: Math.min(budget.batchTaskMaxChars, resolveSkillResultMaxChars(budget, skillName)),
                scope: "batch:task",
                label: taskId + ":" + skillTag,
                enabled: budget.enabled,
                toolName: "delegate_batch",
              });
              results.push(withTiming({
                id: taskId,
                skill: skillTag,
                status: "completed",
                // 契约标记拼在预算裁剪之后（与 delegate 一致：放进被裁文本里会被切掉）
                result: resultText + contractMark,
                ...degradeField(taskNotes),
                ...(contractViolated ? { contractViolated: true as const } : {}),
              }, startedAt, endedAt, runId));
            } else {
              const endedAt = Date.now();
              const diag = typeof outcome?.diagnostic === "string" ? outcome.diagnostic : undefined;
              // 打点：非 completed 的 stopReason（aborted / error / timeout…）也必须留痕
              pushBatchEvent(taskEvents, {
                taskId, phase: "failed", at: endedAt,
                detail: "stopReason: " + (outcome?.stopReason ?? "unknown") + (diag === undefined ? "" : " · " + diag),
              });
              resultEvents.push(taskEvents);
              results.push(withTiming({
                id: taskId,
                skill: skillTag,
                status: "failed",
                error: `stopReason: ${outcome?.stopReason ?? "unknown"}`
                  + (diag === undefined ? "" : `; diagnostic: ${diag}`),
                stopReason: outcome?.stopReason,
                ...(diag === undefined ? {} : { diagnostic: diag }),
                ...degradeField(taskNotes),
              }, startedAt, endedAt, runId));
            }
          } catch (e) {
            // 打点：超时 / 父级 abort / result 抛错都在这里收口——终态事件 + endedAt 一个都不能少
            const endedAt = Date.now();
            const message = e instanceof Error ? e.message : String(e);
            pushBatchEvent(taskEvents, {
              taskId, phase: message.startsWith("超时") ? "timeout" : "failed", at: endedAt, detail: message,
            });
            resultEvents.push(taskEvents);
            results.push(withTiming({
              id: taskId,
              skill: skillTag,
              status: "error",
              error: message,
              ...degradeField(taskNotes),
            }, startedAt, endedAt, runId));
          } finally {
            if (timer) clearTimeout(timer);
            for (const off of abortOffs) { try { off(); } catch { /* 可能已释放 */ } }
          }
        }
      } finally {
        // 统一清理所有 runs（safeDispose 幂等：超时/abort 分支已释放过的不再重复）
        for (const { safeDispose, ac, onExecAbort } of runs) {
          if (onExecAbort && exec.signal) {
            try { exec.signal.removeEventListener("abort", onExecAbort); } catch { /* 可能已释放 */ }
          }
          if (!ac.signal.aborted) ac.abort();
          safeDispose();
        }
      }

      // 批次计时终点：所有 task 均已 settle（成功/失败/超时/启动失败）后的时间点
      const batchElapsedMs = Date.now() - batchStartedAt;

      // 格式化输出
      const completed = results.filter(r => r.status === "completed");
      const failed = results.filter(r => r.status !== "completed");

      // 统计行：自报并行度与总耗时，让「到底并行没并行」当场可见。
      // **独立前置、不参与 result-budget 裁剪**：下方 output 才进 applyResultBudget，
      // 本行在裁剪完成后才拼到最终返回值最前面，因此任何裁剪路径都切不到它。
      const statsLine = `并发 ${tasks.length} 个子代理 · ${completed.length}/${tasks.length} 完成 · 总耗时 ${(batchElapsedMs / 1000).toFixed(1)}s\n\n`;

      let output = "--- delegate_batch 结果 ---\n";
      output += `总计: ${results.length} 个任务 | 完成: ${completed.length} | 失败: ${failed.length}\n\n`;

      if (completed.length > 0) {
        output += "## 已完成任务\n\n";
        for (const r of completed) {
          output += `### ${r.id} (${r.skill})\n${r.result}\n\n`;
        }
      }

      if (failed.length > 0) {
        output += "## 失败/错误任务\n\n";
        for (const r of failed) {
          output += `### ${r.id} (${r.skill})\n`;
          output += `状态: ${r.status}\n`;
          if (r.error) output += `错误: ${r.error}\n`;
          if (r.stopReason) output += `stopReason: ${r.stopReason}\n`;
          if (r.diagnostic) output += `diagnostic: ${r.diagnostic}\n`;
          output += "\n";
        }
      }

      // P1-3：拼装后对总串再做一次总体预算（**不落盘**——各任务全文已各自落盘，
      // 重复写盘只产生无用副本）；失败任务保持上面的简短格式，不参与长文本回传。
      if (budget.enabled && output.length > budget.batchTotalMaxChars) {
        const fullChars = output.length;
        output = applyResultBudget(output, {
          maxChars: budget.batchTotalMaxChars,
          scope: "batch:total",
          label: "total",
          locatorFallback: "见各任务 locator",
        }).text;
        ctx?.logger?.warn?.(
          "[cohub budget] batch:total：拼装结果 " + fullChars + " 字符 ≈ " + approxTokens(fullChars)
          + " tokens 超过总预算 " + budget.batchTotalMaxChars
          + " 字符，已裁剪；各任务全文见各自的 locator。仅告警，不阻断。",
        );
      }

      // 批量结果已成型 → 注入「立刻 todo_write 回写」提醒（fail-soft，宿主不支持就静默跳过）
      maybeDeferTodoNudge(exec);

      // task 时间线：与 degradeNotes 同策略——**在 applyResultBudget 之后**拼接
      //（timelineText 不进入 output，预算裁剪永远切不到它）；无耗时数据时返回空串，
      // 旧调用返回文本逐字不变（向后兼容）。
      const timelineText = renderTaskTimeline(results, resultEvents);

      // 降级提示合并：**逐任务**渲染（每任务独立 notes，不会互相覆盖），并在每个
      // what 前带 taskId，让「哪个任务降级了」在返回文本里可见。
      // 关键：本段拼在 statsLine + output **之后**，即 applyResultBudget 已裁剪完毕——
      // 因此 batchTotalMaxChars 再小也切不到它（若放进 output 内会被从尾部裁掉，
      // 等于把本次修复的静默降级缺陷原样搬到小预算场景）。
      // formatDegradeNotes 无降级时返回空串，故正常路径的返回文本逐字不变。
      const allNotes: DegradeNote[] = [];
      for (const { taskId, notes } of perTaskNotes) {
        // 回显归一：taskId 是调用方自由填写的字符串（schema 只声明 string），可能带换行、
        // 半角方括号或极长内容——不归一会破坏 `[...]` 提示结构与单行形态。
        // 只归一**提示里的回显**：task.id 的原始值在结果映射、`### ${r.id}` 正文等处不受影响。
        const echoTaskId = firstLineClamped(taskId, BATCH_TASK_ID_ECHO_MAX);
        for (const note of notes) {
          allNotes.push({ id: note.id, what: echoTaskId + " " + note.what, effect: note.effect, reason: note.reason });
        }
      }

      const finalText = statsLine + output + timelineText + formatDegradeNotes(allNotes);

      // 结构化返回载荷的**顶层可选 events**：execute 仍返回字符串（output.schema=string，
      // 宿主 render 走 String(value)，返回对象会退化成 "[object Object]"），
      // 事件流经可选回调交给程序化调用方；没有该能力或回调抛错都静默跳过（观测不得打断回传）。
      const allEvents: BatchEvent[] = [];
      for (const evts of resultEvents) {
        for (const e of evts) allEvents.push(e);
      }
      if (allEvents.length > 0) {
        try {
          const envelope: DelegateBatchEnvelope = { text: finalText, results, events: allEvents };
          (exec as any)?.onBatchEvents?.(envelope);
        } catch { /* 观测失败不影响结果回传 */ }
      }

      return finalText;
    },
  });
}