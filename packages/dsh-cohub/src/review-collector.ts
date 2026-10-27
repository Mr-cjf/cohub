// A2 复盘采集器：订阅全局 session/event，在 turn/end 时零 LLM 采集本会话统计并排队落盘。
//
// 设计纪律：
//   · 只取叶子字段（type/seq/time/data.turn/data.usage/data.callId…），**不对 Session/Event
//     载荷做 JSON.stringify / structuredClone**（.rules/06:117）——载荷可能含循环引用与巨量消息；
//   · 零 LLM 调用：本文件不 import 任何 llm 相关服务；
//   · 不阻塞主流程：turn/end 只入队，不 await 落盘；失败仅 logger.warn（同 delegate.ts 的日志风格）；
//   · 同一会话单写队列（Map<sessionId, Promise> 串行化），避免并发写同一 stats.json；
//   · 按 (sessionId, seq) 去重，防日志重放/重复订阅导致重复计数；
//   · 子会话：收到子会话事件（header.parentSession 非空）→ 按 parentSession 归到根会话名下
//     （stats.rootSessionId）；收不到子会话事件（scope 过滤）不报错、不阻塞，只在 gaps 里留
//     "subagent events not received for session X"，A1 阶段用 sessionQuery.traceSession 兜底补读。
import type { ToolRecord, TurnSummary, UsageRecord } from "./review-types.ts";
import { loadStats, saveStats, REVIEW_STATS_VERSION, type ReviewStatsFile } from "./review-store.ts";

/** 采集器配置（A2 不接 Config，全部走硬编码缺省；由后续任务接 Config 覆盖） */
export interface ReviewCollectorOptions {
  /** 是否启用采集（缺省 true，false 时只返回空壳、不挂监听） */
  enabled?: boolean;
  /** 落盘防抖（毫秒，缺省 200）：同一会话连续 turn/end 合并成一次写盘 */
  debounceMs?: number;
  /**
   * 预期子会话 id 提供者（可选兜底钩子，缺省 undefined）。
   * 返回某根会话「应该出现」的子会话 id 列表；若这些 id 从未在事件流中出现，
   * 说明子会话事件被 scope 过滤，落盘时记 gap（A1 用 traceSession 补读）。
   */
  expectChildSessions?: (rootSessionId: string) => readonly string[];
}

/** 采集器句柄 */
export interface ReviewCollector {
  /** 停止采集：摘监听、清定时器；未落盘的统计触发一次尽力写盘 */
  dispose(): void;
  /** 等待当前所有排队中的落盘完成（测试/收尾用；正常流程不需要调用） */
  flush(): Promise<void>;
}

/** 单轮累加器 */
interface TurnAcc {
  turn: number;
  end: { seq: number; time: number; kind: string } | null;
  usage: UsageRecord | null;
  usageEvidenceSeqs: number[];
  tools: Map<string, ToolRecord>;
}

/** 单会话累加状态 */
interface SessionState {
  sessionId: string;
  cwd: string | null;
  /** null 表示根会话 */
  parentSessionId: string | null;
  /** 归属根会话 id（子会话折叠到 parentSession） */
  rootSessionId: string;
  /** 已处理的事件 seq（(sessionId, seq) 去重） */
  seenSeqs: Set<number>;
  /** 按 turn 号索引的累加器 */
  turns: Map<number, TurnAcc>;
  /** 观测到的子会话 id */
  childSessions: Set<string>;
  /** 采集缺口（去重后写入 stats.gaps） */
  gaps: Set<string>;
}

/** reason 归一化成 kind（宿主是 {kind} 对象，插件可能加字符串变体） */
function turnKind(reason: unknown): string {
  if (typeof reason === "string" && reason) return reason;
  const kind = (reason as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string" && kind) return kind;
  return "unknown";
}

/** 读取 TokenUsage → UsageRecord；整条缺失返回 null（**不记 0**） */
function readUsage(raw: unknown): UsageRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  if (input === null && output === null) return null;
  // 单个字段缺失记 null（不记 0）：渲染层 review-render.ts 的 num() 会把非有限数渲染成「—」。
  return {
    inputTokens: input as unknown as number,
    outputTokens: output as unknown as number,
    totalTokens: num(u.totalTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    reasoningTokens: num(u.reasoningTokens),
  };
}

/**
 * 累加两份用量：任一为 null 的字段累加后仍为 null（**不把未知当 0**）。
 * 注意 inputTokens/outputTokens 同样走 sum()：readUsage 在单侧缺失时会留 null，
 * 若直接 `a + b` 会把 null 隐式当 0（缺失被填 0），故必须统一按可空处理。
 */
function addUsage(acc: UsageRecord | null, add: UsageRecord): UsageRecord {
  if (!acc) return { ...add };
  const sum = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
  return {
    inputTokens: sum(acc.inputTokens, add.inputTokens) as unknown as number,
    outputTokens: sum(acc.outputTokens, add.outputTokens) as unknown as number,
    totalTokens: sum(acc.totalTokens, add.totalTokens),
    cacheReadTokens: sum(acc.cacheReadTokens, add.cacheReadTokens),
    cacheWriteTokens: sum(acc.cacheWriteTokens, add.cacheWriteTokens),
    reasoningTokens: sum(acc.reasoningTokens, add.reasoningTokens),
  };
}

/** 取事件 data 的 turn 号（叶子字段，不做深拷贝） */
function readTurn(data: Record<string, unknown>, fallback: number): number {
  const t = data.turn;
  return typeof t === "number" && Number.isFinite(t) ? t : fallback;
}

/** 工具调用结果判定：失败 = message.isError 或存在 error 载荷 */
function isToolError(data: Record<string, unknown>): boolean {
  const message = data.message as { isError?: unknown } | undefined;
  return message?.isError === true || data.error != null;
}

/** 打开（或取回）某轮累加器 */
function openTurn(state: SessionState, turn: number): TurnAcc {
  let acc = state.turns.get(turn);
  if (!acc) {
    acc = { turn, end: null, usage: null, usageEvidenceSeqs: [], tools: new Map() };
    state.turns.set(turn, acc);
  }
  return acc;
}

/** 累加器 → TurnSummary（只在该轮有 turn/end 时收口） */
function toSummary(acc: TurnAcc): TurnSummary | null {
  if (!acc.end) return null;
  const tools: ToolRecord[] = [...acc.tools.values()].sort((a, b) => a.callSeq - b.callSeq);
  return {
    turn: acc.turn,
    end: { seq: acc.end.seq, time: acc.end.time, kind: acc.end.kind },
    usage: acc.usage,
    usageEvidenceSeqs: [...acc.usageEvidenceSeqs],
    tools,
  };
}

/**
 * 创建复盘采集器。
 * 返回 { dispose(), flush() }；ctx 无事件源（无 ctx.on）时返回空壳，不抛错。
 */
export function createReviewCollector(ctx: any, opts: ReviewCollectorOptions = {}): ReviewCollector {
  const enabled = opts.enabled !== false;
  const debounceMs = Math.max(0, Math.trunc(opts.debounceMs ?? 200));
  const states = new Map<string, SessionState>();
  const queues = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let off: (() => void) | null = null;
  let disposed = false;

  const warn = (msg: string) => {
    try { ctx?.logger?.warn?.("[cohub review] " + msg); } catch { /* 日志失败不影响采集 */ }
  };

  const stateOf = (sessionId: string, session: any): SessionState => {
    let st = states.get(sessionId);
    if (!st) {
      const header = (session as { header?: { cwd?: unknown; parentSession?: unknown } } | null)?.header;
      const cwdRaw = header?.cwd;
      const cwd = typeof cwdRaw === "string" && cwdRaw ? cwdRaw : null;
      const parentRaw = header?.parentSession;
      const parentSessionId = typeof parentRaw === "string" && parentRaw ? parentRaw : null;
      st = {
        sessionId,
        cwd,
        parentSessionId,
        rootSessionId: parentSessionId ?? sessionId,
        seenSeqs: new Set<number>(),
        turns: new Map<number, TurnAcc>(),
        childSessions: new Set<string>(),
        gaps: new Set<string>(),
      };
      states.set(sessionId, st);
    }
    // cwd/parentSession 只在首次见到该会话时定型：目录路径由 cwd 决定，中途变更会分裂存储，
    // 因此不做"补齐"；header 缺失导致的归属不确定性由 gaps 留给 A1 补读阶段处理。
    return st;
  };

  /** 单会话串行写队列：同一 sessionId 的落盘一个接一个，绝不并发写同一文件 */
  const enqueue = (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => { /* task 内部已容错 */ });
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  };

  /** 落盘：读旧文件 → 合并 turns（同 turn 以新为准）→ 原子写 */
  const persist = async (st: SessionState): Promise<void> => {
    try {
      const turns = [...st.turns.values()]
        .map(toSummary)
        .filter((t): t is TurnSummary => t !== null)
        .sort((a, b) => a.turn - b.turn);
      if (turns.length === 0) return;
      const existing = loadStats(st.cwd, st.sessionId);
      const merged = new Map<number, TurnSummary>();
      for (const t of existing?.turns ?? []) merged.set(t.turn, t);
      for (const t of turns) merged.set(t.turn, t);
      const gaps = new Set<string>(existing?.gaps ?? []);
      for (const g of st.gaps) gaps.add(g);
      const stats: ReviewStatsFile = {
        version: REVIEW_STATS_VERSION,
        sessionId: st.sessionId,
        cwd: st.cwd,
        rootSessionId: st.rootSessionId,
        gaps: [...gaps],
        updatedAt: new Date().toISOString(),
        turns: [...merged.values()].sort((a, b) => a.turn - b.turn),
      };
      const ok = await saveStats(st.cwd, st.sessionId, stats);
      if (!ok) warn("统计落盘失败（静默降级，不影响主流程）：session=" + st.sessionId);
    } catch (err) {
      warn("统计落盘异常（已吞掉）：session=" + st.sessionId + " " + String(err));
    }
  };

  /** 防抖调度落盘（不 await、不阻塞） */
  const schedule = (st: SessionState) => {
    if (disposed) return;
    const sid = st.sessionId;
    const timer = timers.get(sid);
    if (timer) clearTimeout(timer);
    const handle = setTimeout(() => {
      timers.delete(sid);
      void enqueue(sid, () => persist(st));
    }, debounceMs);
    if (typeof (handle as { unref?: () => void }).unref === "function") (handle as { unref: () => void }).unref();
    timers.set(sid, handle);
  };

  /** 根会话的 gaps：预期子会话但事件从未到达（scope 过滤）→ 记 gap 供 A1 补读 */
  const collectChildGaps = (st: SessionState) => {
    if (!opts.expectChildSessions) return;
    let expected: readonly string[] = [];
    try {
      expected = opts.expectChildSessions(st.rootSessionId) ?? [];
    } catch (err) {
      warn("expectChildSessions 抛错（已忽略）：" + String(err));
      return;
    }
    for (const childId of expected) {
      if (typeof childId !== "string" || !childId) continue;
      if (states.has(childId) || st.childSessions.has(childId)) continue;
      st.gaps.add("subagent events not received for session " + childId);
    }
  };

  /** 子会话事件到达：登记到父会话，便于父会话落盘时校验可见性 */
  const registerChild = (childId: string, parentId: string) => {
    const parent = states.get(parentId);
    if (parent) parent.childSessions.add(childId);
  };

  /** 消费一条事件（叶子字段读取，零深拷贝） */
  const consume = (session: any, event: any): void => {
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || !sessionId) return;
    const type = event?.type;
    if (typeof type !== "string") return;
    const seq = event?.seq;
    const time = event?.time;
    if (typeof seq !== "number" || !Number.isFinite(seq)) return;

    const st = stateOf(sessionId, session);

    // (sessionId, seq) 去重：重放/重复投递只计一次
    if (st.seenSeqs.has(seq)) return;
    st.seenSeqs.add(seq);

    const data = (event.data ?? {}) as Record<string, unknown>;
    const fallbackTurn = st.turns.size > 0 ? Math.max(...st.turns.keys()) : 0;
    const turn = readTurn(data, fallbackTurn);

    switch (type) {
      case "turn/start": {
        openTurn(st, turn);
        return;
      }
      case "tool/call": {
        const callId = data.callId;
        const name = data.name;
        if (typeof callId !== "string" || !callId) return;
        const acc = openTurn(st, turn);
        acc.tools.set(callId, {
          callId,
          name: typeof name === "string" ? name : String(name ?? "unknown"),
          callSeq: seq,
          resultSeq: null,
          startedAt: typeof time === "number" && Number.isFinite(time) ? time : 0,
          endedAt: null,
          status: "pending",
        });
        return;
      }
      case "tool/result": {
        // 配对键：message.toolCallId（宿主契约）；兼容插件在 data 上直挂 callId 的写法
        const message = data.message as { toolCallId?: unknown } | undefined;
        const callIdRaw = data.callId ?? message?.toolCallId;
        const callId = typeof callIdRaw === "string" ? callIdRaw : null;
        if (!callId) return;
        const acc = openTurn(st, turn);
        const rec = acc.tools.get(callId);
        const endedAt = typeof time === "number" && Number.isFinite(time) ? time : 0;
        if (rec) {
          rec.resultSeq = seq;
          rec.endedAt = endedAt;
          rec.status = isToolError(data) ? "error" : "success";
        } else {
          // result 先于 call 到达（跨 step 乱序/订阅晚于事件）：以 result 建记录并标 pending 之外的成功/失败
          acc.tools.set(callId, {
            callId,
            name: "unknown",
            callSeq: seq,
            resultSeq: seq,
            startedAt: endedAt,
            endedAt,
            status: isToolError(data) ? "error" : "success",
          });
        }
        return;
      }
      case "assistant/message": {
        const usage = readUsage(data.usage);
        if (!usage) return; // 缺失 → 不累加，TurnSummary.usage 保持 null（不记 0）
        const acc = openTurn(st, turn);
        acc.usage = addUsage(acc.usage, usage);
        acc.usageEvidenceSeqs.push(seq);
        return;
      }
      case "turn/end": {
        const acc = openTurn(st, turn);
        acc.end = {
          seq,
          time: typeof time === "number" && Number.isFinite(time) ? time : 0,
          kind: turnKind(data.reason),
        };
        // 子会话可见性兜底：预期子会话里从未出现事件的，记 gap（A1 用 traceSession 补读）
        if (st.parentSessionId === null) {
          collectChildGaps(st);
        }
        schedule(st);
        return;
      }
      default:
        return;
    }
  };

  if (enabled && typeof ctx?.on === "function") {
    try {
      off = ctx.on("session/event", (session: any, event: any) => {
        try {
          consume(session, event);
          const sid = session?.id;
          const parentId = states.get(sid)?.parentSessionId;
          if (typeof sid === "string" && typeof parentId === "string") registerChild(sid, parentId);
        } catch (err) {
          // 观测器绝不打断会话主流程
          warn("采集异常（已吞掉）：" + String(err));
        }
      });
    } catch (err) {
      warn("挂载 session/event 失败，采集降级为关闭：" + String(err));
      off = null;
    }
  }

  return {
    dispose() {
      disposed = true;
      for (const [sid, timer] of timers) {
        clearTimeout(timer);
        timers.delete(sid);
      }
      if (off) {
        try { off(); } catch { /* 已释放 */ }
        off = null;
      }
      // 尽力把已采集的轮次写出去（不 await：dispose 不阻塞宿主卸载）
      for (const st of states.values()) void enqueue(st.sessionId, () => persist(st));
      states.clear();
    },
    async flush() {
      for (const [sid, timer] of timers) {
        clearTimeout(timer);
        timers.delete(sid);
        const st = states.get(sid);
        if (st) void enqueue(sid, () => persist(st));
      }
      // 等待队列排空（队列可能因等待期间的新入队而增长，最多等 3 轮）
      for (let i = 0; i < 3; i++) {
        const pending = [...queues.values()];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
  };
}
