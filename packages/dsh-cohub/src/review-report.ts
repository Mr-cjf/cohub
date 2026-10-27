// cohub 会话复盘 —— 事件重放与统计构建（buildReport）
//
// 纪律：
//   · 信封上的 seq/time 是唯一证据键；turn/end 的 seq/time 取信封，不取 payload。
//   · 缺失数据只能记 null 或进 gaps，绝不编造、绝不记 0。
//   · 只取叶子字段做归一，不对事件对象整体序列化（确定性 + 避免把大 payload 拖进内存）。
//   · 同一输入两次调用输出深层相等：排序稳定、字段顺序固定、无时间/随机来源。
import { createHash } from "node:crypto";
import type {
  ReviewReport, SessionSummary, TurnSummary, ToolRecord, UsageRecord,
} from "./review-types.ts";

/** 单个会话的事件序列（header 信息 + 完整事件数组）。 */
export interface SessionEvents {
  sessionId: string;
  parentSessionId: string | null;
  cwd?: string;
  events: Array<{ seq: number; time: number; type: string; data: any }>;
}

/** buildReport 的输入：根会话 + 可达子代理会话。 */
export interface BuildReportInput {
  root: SessionEvents;
  children?: SessionEvents[];
}

/** 参与累加的 usage 字段（顺序固定，便于确定性输出）。 */
const USAGE_FIELDS = [
  "inputTokens", "outputTokens", "totalTokens",
  "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
] as const;

/** 只接受有限数字，其余（含 undefined/null/字符串）一律视为「没有该字段」。 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 取第一个非空字符串。 */
function pickString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/** turn/end 的 reason 归一成字符串：字符串直接用；对象取 type/kind；取不到 → "unknown"。 */
function normalizeReason(reason: unknown): string {
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason && typeof reason === "object") {
    const r = reason as Record<string, unknown>;
    for (const key of ["type", "kind", "reason"] as const) {
      const v = r[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return "unknown";
}

/** tool/result 是否代表失败（宿主不同版本放在不同位置，只取叶子布尔）。 */
function isErrorResult(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  if (data.isError === true) return true;
  if (data.error !== undefined && data.error !== null) return true;
  const message = data.message;
  if (message && typeof message === "object" && message.isError === true) return true;
  const result = data.result;
  if (result && typeof result === "object" && result.isError === true) return true;
  return false;
}

/**
 * 累计值 → 可空数字：字段从未出现 → null（**不记 0**）。
 * 注：UsageRecord 声明 input/output 为 number，但渲染层 review-render.ts 的 num()
 * 已把非有限数渲染成「—」，因此这里显式放 null 以保证「缺失 ≠ 0」的硬规则。
 */
function nullable(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 把累加到的 usage 叶子字段定稿；一条 usage 证据都没有 → null（不记 0）。 */
function buildUsage(sum: Record<string, number>, evidenceSeqs: number[]): UsageRecord | null {
  if (evidenceSeqs.length === 0) return null;
  return {
    inputTokens: nullable(sum.inputTokens) as unknown as number,
    outputTokens: nullable(sum.outputTokens) as unknown as number,
    totalTokens: nullable(sum.totalTokens),
    cacheReadTokens: nullable(sum.cacheReadTokens),
    cacheWriteTokens: nullable(sum.cacheWriteTokens),
    reasoningTokens: nullable(sum.reasoningTokens),
  };
}

interface ReplayResult {
  summary: SessionSummary;
  throughSeq: number;
  complete: boolean;
  gaps: string[];
}

/** 重放单个会话：按 seq 升序（同 seq 保持原顺序），以 turn/end 切分轮次。 */
function replay(session: SessionEvents): ReplayResult {
  const sid = session.sessionId;
  const gaps: string[] = [];
  const ordered = session.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.seq - b.event.seq) || (a.index - b.index))
    .map(x => x.event);

  const throughSeq = ordered.length > 0 ? ordered[ordered.length - 1].seq : 0;
  const turns: TurnSummary[] = [];

  let usageSum: Record<string, number> = {};
  let usageSeqs: number[] = [];
  let tools: ToolRecord[] = [];
  const openCalls = new Map<string, number>();
  let pendingToolCount = 0;

  const resetTurn = () => {
    usageSum = {};
    usageSeqs = [];
    tools = [];
    openCalls.clear();
    pendingToolCount = 0;
  };

  for (const ev of ordered) {
    const data = ev.data && typeof ev.data === "object" ? ev.data : {};

    if (ev.type === "assistant/message") {
      const usage = data.usage;
      if (usage && typeof usage === "object") {
        // 只有真的累加过至少一个有限数值字段，才把该 seq 记进证据；
        // 空 usage 对象（有字段但无有效数值）不构成证据（否则证据不实）。
        let counted = 0;
        for (const field of USAGE_FIELDS) {
          const v = num(usage[field]);
          if (v === null) continue;
          usageSum[field] = (usageSum[field] ?? 0) + v;
          counted++;
        }
        if (counted > 0) usageSeqs.push(ev.seq);
      }
      continue;
    }

    if (ev.type === "tool/call") {
      const callId = pickString(data.callId, data.id, data.toolCallId, data.tool_call_id);
      const name = pickString(data.name, data.toolName, data.tool) ?? "unknown";
      if (callId === null) {
        gaps.push(`${sid}: tool/call at seq ${ev.seq} has no callId`);
      }
      const key = callId ?? "";
      const record: ToolRecord = {
        callId: key,
        name,
        callSeq: ev.seq,
        resultSeq: null,
        startedAt: ev.time,
        endedAt: null,
        status: "pending",
      };
      tools.push(record);
      pendingToolCount++;
      if (!openCalls.has(key)) openCalls.set(key, tools.length - 1);
      continue;
    }

    if (ev.type === "tool/result") {
      // 真实宿主把配对键放在 data.message.toolCallId；兼容插件把 callId 直挂 data 的写法。
      const msg = data.message && typeof data.message === "object" ? data.message : undefined;
      const callId = pickString(msg?.toolCallId, data.toolCallId, data.callId, data.id, data.tool_call_id);
      const key = callId ?? "";
      const idx = openCalls.get(key);
      if (idx === undefined) {
        gaps.push(`${sid}: tool/result at seq ${ev.seq} has no matching tool/call`);
        continue;
      }
      const record = tools[idx];
      if (record.status !== "pending") {
        gaps.push(`${sid}: duplicate tool/result for call ${key} at seq ${ev.seq}`);
        continue;
      }
      record.resultSeq = ev.seq;
      record.endedAt = ev.time;
      record.status = isErrorResult(data) ? "error" : "success";
      openCalls.delete(key);
      pendingToolCount--;
      continue;
    }

    if (ev.type === "turn/end") {
      const turnNo = num(data.turn);
      if (turnNo === null) gaps.push(`${sid}: turn/end at seq ${ev.seq} has no numeric turn`);
      for (const t of tools) {
        if (t.status === "pending") gaps.push(`${sid}: tool/call ${t.callId} has no result`);
      }
      turns.push({
        turn: turnNo ?? turns.length + 1,
        end: { seq: ev.seq, time: ev.time, kind: normalizeReason(data.reason) },
        usage: buildUsage(usageSum, usageSeqs),
        usageEvidenceSeqs: usageSeqs.slice(),
        tools,
      });
      resetTurn();
      continue;
    }
  }

  if (turns.length === 0) {
    gaps.push(`${sid}: no turn/end event; session has no complete turn`);
  }

  if (turns.length === 0) {
    for (const t of tools) gaps.push(`${sid}: tool/call ${t.callId} has no result`);
  }
  // 非空 + 有 turn/end + 任何轮次（含 turn 尾部）都不存在未配对的 tool/call
  const noPending = turns.every(t => t.tools.every(x => x.status !== "pending"))
    && pendingToolCount === 0;
  const complete = turns.length > 0 && noPending;

  return {
    summary: { sessionId: sid, parentSessionId: session.parentSessionId, turns },
    throughSeq,
    complete,
    gaps,
  };
}

/** 项目键：对 cwd 做 sha256 取前 16 位十六进制（确定性、无外部状态）。 */
function projectKey(cwd: string | null): string {
  return createHash("sha256").update(cwd ?? "", "utf8").digest("hex").slice(0, 16);
}

/** 把完整事件序列重放成结构化统计（不含任何 Markdown 渲染）。 */
export function buildReport(input: BuildReportInput): ReviewReport {
  const all = [input.root, ...(input.children ?? [])];
  const replays = all.map(replay);

  const throughSeq: Record<string, number> = {};
  const gaps: string[] = [];
  let complete = true;
  for (const r of replays) {
    throughSeq[r.summary.sessionId] = r.throughSeq;
    if (!r.complete) complete = false;
    for (const g of r.gaps) gaps.push(g);
  }

  const cwd = typeof input.root.cwd === "string" && input.root.cwd.length > 0 ? input.root.cwd : null;

  return {
    schemaVersion: 1,
    project: { cwd, key: projectKey(cwd) },
    rootSessionId: input.root.sessionId,
    coverage: { throughSeq, complete, gaps, inputTruncated: false },
    sessions: replays.map(r => r.summary),
    attempts: [],
    findings: [],
    analysis: {
      requestId: "",
      inputDigest: "",
      provider: "",
      model: "",
      invocations: 0,
      status: "completed",
    },
  };
}
