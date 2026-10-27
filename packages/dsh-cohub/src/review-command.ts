// cohub 复盘命令入口：`/cohub-review`（零 turn、不经过模型，异步生成 MD 报告）
//
// 纪律：
//   · 命令 handler 立即返回 CommandResult，**不 await 分析**；分析走 fire-and-forget，
//     内部全 try/catch，只 logger.warn —— 对宿主必须抛零异常；
//   · sessionId 取 inv.agent.session.id（不是顶层字段）；
//   · 只调一次 LLM，不重试、无工具循环；输入是压缩后的统计摘要（不是全量事件）；
//   · LLM 失败 / 解析失败 → findings 留空、analysis.status='failed'，报告照常落盘；
//   · 落盘路径复用 review-store.ts 的 reviewStorePath（.tmp → rename 原子替换）；
//   · 不对 Session/Event 载荷做 JSON.stringify / structuredClone，只取叶子字段（.rules/06:117）。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { buildReport, type SessionEvents } from "./review-report.ts";
import { renderMarkdown } from "./review-render.ts";
import { reviewStorePath } from "./review-store.ts";
import type { Finding, ReviewReport } from "./review-types.ts";

/** 喂给 LLM 的摘要字符上限（超限截断并标记 inputTruncated） */
const DIGEST_LIMIT_CHARS = 12000;
/**
 * 单次分析的最大输出 token。
 * 真机实测：13 个会话 / 14 个 turn 的摘要要求输出 ≤12 条 findings，每条含中文结论 +
 * evidence 数组 + limitations，2000 token（约 2000～3000 汉字/ASCII 混合）**必然在数组中途截断**，
 * 而截断输出没有结尾 `]` → 旧解析器直接判失败（B-2 未闭环的真实原因）。
 * 5000 足够 12 条中文 findings 收尾，且仍远低于主流模型的输出上限，成本可控。
 */
const ANALYSIS_MAX_TOKENS = 5000;
/** 解析失败时留档的原始输出字符数（够定位「截断」还是「格式错误」） */
const RAW_OUTPUT_KEEP_CHARS = 2000;
/** 子会话读取上限（防御异常血缘树把内存拖爆） */
const MAX_CHILD_SESSIONS = 50;
/** filterSessions 逐层 BFS 的最大调用次数（防御血缘树爆炸；每层一次查询） */
const MAX_CHILD_FILTER_CALLS = 20;
/** 单次复盘的整体超时（读会话 + LLM 全链路；阻断「无界挂死」） */
const ANALYSIS_TIMEOUT_MS = 60_000;

/** 上溯根会话的最大层数（防御异常血缘树） */
const MAX_ROOT_ASCEND = 32;

/** 宽松取会话 id（不同版本 SessionRecord 字段名不同） */
function idOf(rec: any): string | undefined {
  const v = rec?.session?.id ?? rec?.id ?? rec?.sessionId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 宽松取父会话 id */
function parentOf(rec: any): string | undefined {
  const v = rec?.session?.parentSession ?? rec?.parentSession ?? rec?.parentSessionId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 把 readSession 结果映射成 buildReport 需要的 SessionEvents（只取叶子字段） */
function toSessionEvents(read: any, fallbackId: string): SessionEvents {
  const header = read?.session ?? {};
  const rawEvents = Array.isArray(read?.events) ? read.events : [];
  const events: SessionEvents["events"] = [];
  for (const ev of rawEvents) {
    const seq = typeof ev?.seq === "number" ? ev.seq : null;
    const time = typeof ev?.time === "number" ? ev.time : null;
    const type = typeof ev?.type === "string" ? ev.type : null;
    if (seq === null || time === null || type === null) continue;
    events.push({ seq, time, type, data: ev?.data });
  }
  return {
    sessionId: typeof header.id === "string" ? header.id : fallbackId,
    parentSessionId: typeof header.parentSession === "string" ? header.parentSession : null,
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    events,
  };
}

/** 从血缘树里宽松收集所有会话 id（任意深度的 id/sessionId 键） */
function collectLineageIds(node: any, out: Set<string>, depth = 0): void {
  if (node === null || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLineageIds(item, out, depth + 1);
    return;
  }
  const direct = idOf(node);
  if (direct) out.add(direct);
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") collectLineageIds(value, out, depth + 1);
  }
}

/** 找出根会话的所有可达子会话 id（优先 traceSession，退化到 listSessions 的 parent 链） */
async function findChildIds(ctx: any, rootId: string, signal?: AbortSignal): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const trace = ctx?.sessionQuery?.traceSession;
    if (typeof trace === "function") {
      const tree = await trace.call(ctx.sessionQuery, rootId, signal);
      const found = new Set<string>();
      collectLineageIds(tree?.descendants, found);
      for (const id of found) if (id !== rootId) ids.add(id);
    }
  } catch (error) {
    ctx.logger?.warn?.("[cohub review] traceSession 失败：" + String((error as any)?.message ?? error));
  }
  if (ids.size > 0) return [...ids].slice(0, MAX_CHILD_SESSIONS);

  // 退化路径 1：filterSessions({ parentSessionId }) 做 BFS，只查「某个父会话的子会话」，
  // 避免 listSessions 的全量列举（该 cwd 实测 690 个会话）。调用次数受 MAX_CHILD_FILTER_CALLS 限制。
  try {
    const filter = ctx?.sessionQuery?.filterSessions;
    if (typeof filter === "function") {
      const queue = [rootId];
      let calls = 0;
      while (queue.length > 0 && ids.size < MAX_CHILD_SESSIONS && calls < MAX_CHILD_FILTER_CALLS) {
        const parentId = queue.shift() as string;
        calls++;
        const listed = await filter.call(ctx.sessionQuery, { parentSessionId: parentId }, signal);
        const records: any[] = Array.isArray(listed) ? listed : [];
        for (const rec of records) {
          const id = idOf(rec);
          if (!id || id === rootId || ids.has(id)) continue;
          ids.add(id);
          queue.push(id);
          if (ids.size >= MAX_CHILD_SESSIONS) break;
        }
      }
    }
  } catch (error) {
    ctx.logger?.warn?.("[cohub review] filterSessions 失败：" + String((error as any)?.message ?? error));
  }
  if (ids.size > 0) return [...ids].slice(0, MAX_CHILD_SESSIONS);

  // 退化路径 2：全量列举，按 parentSession 链从根做 BFS。
  // 代价：该 cwd 下可能有数百个会话（实测 690 个），全部列举并建表，O(N) 内存 + 一次全量读；
  // 仅在 traceSession 与 filterSessions 都不可用/为空时走到这里。
  try {
    const list = await ctx.sessionQuery.listSessions(signal);
    const records: any[] = Array.isArray(list) ? list : [];
    const byParent = new Map<string, string[]>();
    for (const rec of records) {
      const id = idOf(rec);
      const parent = parentOf(rec);
      if (!id || !parent) continue;
      const bucket = byParent.get(parent) ?? [];
      bucket.push(id);
      byParent.set(parent, bucket);
    }
    const queue = [rootId];
    while (queue.length > 0 && ids.size < MAX_CHILD_SESSIONS) {
      const cur = queue.shift() as string;
      for (const child of byParent.get(cur) ?? []) {
        if (child === rootId || ids.has(child)) continue;
        ids.add(child);
        queue.push(child);
      }
    }
  } catch (error) {
    ctx.logger?.warn?.("[cohub review] listSessions 失败：" + String((error as any)?.message ?? error));
  }
  return [...ids];
}

/** 原子写文本：mkdir -p → <file>.tmp → rename（同目录 rename 为替换语义） */
function writeTextAtomic(file: string, text: string): boolean {
  const tmp = file + ".tmp";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) renameSync(tmp, tmp + ".failed");
    } catch { /* 清理失败不影响主流程 */ }
    return false;
  }
}

/** 把错误追加到 <reviews>/<cwdHash>/_errors.log（一行一条，绝不抛错） */
function appendErrorLog(cwd: string | null | undefined, sessionId: string, message: string): void {
  try {
    const logPath = reviewStorePath(cwd, sessionId, "_errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, new Date().toISOString() + "\t" + sessionId + "\t" + message.replace(/\s+/g, " ").slice(0, 500) + "\n", "utf8");
  } catch { /* 日志失败不影响主流程 */ }
}

/** 落盘一份 error-<ts>.json（与 report 同目录），返回是否写成功 */
function writeErrorRecord(
  cwd: string | null | undefined,
  sessionId: string,
  error: unknown,
): boolean {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    error: String((error as any)?.message ?? error),
    stack: typeof (error as any)?.stack === "string" ? (error as any).stack : undefined,
    sessionId,
    cwd: cwd ?? null,
    timestamp: new Date().toISOString(),
  };
  return writeTextAtomic(reviewStorePath(cwd, sessionId, "error-" + stamp + ".json"), JSON.stringify(payload, null, 2));
}

/** 把报告压成 LLM 输入摘要（只含统计数字 + 缺口，不含消息正文） */
function buildDigest(report: ReviewReport): { text: string; digest: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push("rootSessionId: " + report.rootSessionId);
  lines.push("projectCwd: " + (report.project.cwd ?? "(null)"));
  lines.push("coverageComplete: " + String(report.coverage.complete));
  lines.push("gaps: " + (report.coverage.gaps.length > 0 ? report.coverage.gaps.join(" | ") : "(none)"));
  lines.push("throughSeq: " + JSON.stringify(report.coverage.throughSeq));
  for (const s of report.sessions) {
    lines.push("");
    lines.push("session " + s.sessionId + " parent=" + (s.parentSessionId ?? "(root)") + " turns=" + s.turns.length);
    for (const t of s.turns) {
      const u = t.usage;
      const tools = t.tools.map(x => x.name + ":" + x.status + (x.callSeq !== null ? "@seq" + x.callSeq : "")).join(",");
      lines.push(
        "  turn " + t.turn
        + " end=" + t.end.kind + "@seq" + t.end.seq
        + " usage=" + (u ? ("in" + (u.inputTokens ?? "?") + "/out" + (u.outputTokens ?? "?")) : "(none)")
        + " tools=[" + tools + "]",
      );
    }
  }
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > DIGEST_LIMIT_CHARS) {
    text = text.slice(0, DIGEST_LIMIT_CHARS);
    truncated = true;
  }
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return { text, digest, truncated };
}

/** 剥掉 Markdown 围栏（```json / ```）；围栏未闭合（被截断）时返回原文 */
function stripFence(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}

/** 从 text[start]（必须是 `[` 或 `{`）开始扫描，返回与其配对的收尾括号下标；未配平返回 -1（疑似截断） */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 严格解析成数组；非数组或报错返回 null */
function tryParseArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 抢救式提取：从 start（外层 `[`）开始逐个扫描**完整**的 `{...}` 对象并单独解析。
 * 用于「外层数组没闭合（被 maxTokens 截断）」或「整体 JSON 非法」时，至少保住能用的部分。
 * 单个对象自身被截断（scanBalanced 返回 -1）即停止——后面不可能再有完整对象。
 */
function salvageObjects(text: string, start: number): unknown[] {
  const out: unknown[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "]") break;
    if (ch === "{") {
      const end = scanBalanced(text, i);
      if (end < 0) break;
      const one = text.slice(i, end + 1);
      try {
        out.push(JSON.parse(one));
      } catch {
        try {
          out.push(JSON.parse(one.replace(/,\s*([\]}])/g, "$1")));
        } catch { /* 单条坏 → 跳过，继续下一个完整对象 */ }
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 从模型输出里提取 JSON 数组。容忍：Markdown 围栏、前后说明文字、尾随逗号、输出被截断。
 *
 * 真机根因：旧实现用 `lastIndexOf("]")` 找结尾，**输出被 maxTokens 截断时根本没有 `]`**，
 * 于是 slice(start, -1+1) 拿到的是"从 `[` 到倒数第 1 个字符"的半截 JSON，必然 parse 失败，
 * 整份 findings 被丢弃。现在改为括号配对扫描 + 逐对象抢救，并把 truncated 上报给报告。
 */
export function extractJsonArray(text: unknown): { items: unknown[] | null; truncated: boolean } {
  const empty = { items: null, truncated: false };
  if (typeof text !== "string" || text.length === 0) return empty;
  const body = stripFence(text);
  const start = body.indexOf("[");
  if (start < 0) return empty;

  const end = scanBalanced(body, start);
  if (end > start) {
    const candidate = body.slice(start, end + 1);
    const strict = tryParseArray(candidate);
    if (strict) return { items: strict, truncated: false };
    // 尾随逗号等常见非严格写法：去掉 ] } 前的逗号再试
    const repaired = tryParseArray(candidate.replace(/,\s*([\]}])/g, "$1"));
    if (repaired) return { items: repaired, truncated: false };
    // 整体非法（某条对象坏）→ 逐对象抢救，仍算「非截断」
    const salvaged = salvageObjects(body, start);
    return { items: salvaged.length > 0 ? salvaged : null, truncated: false };
  }

  // 没有配对的 `]` → 输出疑似被 maxTokens 截断：抢救所有完整对象
  const salvaged = salvageObjects(body, start);
  return { items: salvaged.length > 0 ? salvaged : null, truncated: true };
}

/** 真实事件定位点：该 seq 所属 turn（继承最近一次 data.turn）与该 seq 上的工具 callId（非工具事件为 null）。 */
interface EvidenceAnchor {
  turn: number | null;
  callId: string | null;
}
type EvidenceIndex = Map<string, Map<number, EvidenceAnchor>>;

/** 取某条事件上的工具配对键（只对 tool/call、tool/result 有意义） */
function callIdOf(type: string, data: any): string | null {
  if (type !== "tool/call" && type !== "tool/result") return null;
  const message = data?.message && typeof data.message === "object" ? data.message : undefined;
  const v = data?.callId ?? message?.toolCallId ?? data?.toolCallId ?? data?.tool_call_id ?? data?.id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 为每个会话建立 seq → {turn, callId} 索引；turn 用「最近一次 data.turn」继承，取不到就留 null（不编造）。 */
function buildEvidenceIndex(sessions: SessionEvents[]): EvidenceIndex {
  const index: EvidenceIndex = new Map();
  for (const s of sessions) {
    const bySeq = new Map<number, EvidenceAnchor>();
    let currentTurn: number | null = null;
    for (const ev of s.events) {
      const data = ev.data && typeof ev.data === "object" ? ev.data : {};
      const declared = typeof data.turn === "number" && Number.isFinite(data.turn) ? data.turn : null;
      if (declared !== null) currentTurn = declared;
      bySeq.set(ev.seq, { turn: currentTurn, callId: callIdOf(ev.type, data) });
    }
    index.set(s.sessionId, bySeq);
  }
  return index;
}

/**
 * 把 LLM 原始条目规整成 Finding（无效条目丢弃）。
 * evidence 校验：seq 必须真实存在；该 seq 事件的 turn 必须等于声明的 turn（事件 turn 未知时无从证伪，只做 seq 校验）；
 * 声明了 callId 时，该 seq 处必须是同一个工具调用事件。不通过的 evidence 丢弃。
 */
function normalizeFindings(raw: unknown[], index: EvidenceIndex, defaultSessionId: string): Finding[] {
  const KINDS = new Set(["observation", "praise", "issue", "suggestion"]);
  const out: Finding[] = [];
  for (const item of raw) {
    const rec = item as any;
    const text = typeof rec?.text === "string" ? rec.text.trim() : "";
    if (text.length === 0) continue;
    const kind = KINDS.has(rec?.kind) ? rec.kind : "observation";
    const evidence: Finding["evidence"] = [];
    const rawEv = Array.isArray(rec?.evidence) ? rec.evidence : [];
    for (const e of rawEv) {
      const sessionId = typeof e?.sessionId === "string" && e.sessionId.length > 0 ? e.sessionId : defaultSessionId;
      const turn = typeof e?.turn === "number" ? e.turn : null;
      const seq = typeof e?.seq === "number" ? e.seq : null;
      if (turn === null || seq === null) continue;
      const bySeq = index.get(sessionId);
      if (!bySeq) continue;
      const anchor = bySeq.get(seq);
      if (!anchor) continue; // seq 必须是真实存在的事件
      if (anchor.turn !== null && anchor.turn !== turn) continue; // turn 必须与真实事件一致
      const callId = typeof e?.callId === "string" && e.callId.length > 0 ? e.callId : null;
      if (callId !== null && anchor.callId !== callId) continue; // 声明的 callId 必须落在该 seq 上
      evidence.push({ sessionId, turn, seq, callId });
    }
    const limitations = Array.isArray(rec?.limitations)
      ? rec.limitations.filter((x: unknown) => typeof x === "string").slice(0, 5)
      : [];
    out.push({ id: "f-" + String(out.length + 1).padStart(3, "0"), kind, text, evidence, limitations });
    if (out.length >= 30) break;
  }
  return out;
}

/** 非空字符串判定 */
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 从本次请求的 Agent 上直读真实 provider/model（优先级最高）。
 * 两个来源：AgentOptions（loop 构造时注入）与 session.requestHeader().config（已落盘的请求配置，
 * 见 dsh-agent-loop prepareRequest：route = { provider: options.provider ?? "", model: options.model ?? "" }）。
 * 二者都是「这次请求实际使用的模型」，比 listProviders()[0] 靠谱得多。
 */
function routeFromAgent(agent: any, diag: string[]): { provider: string; model: string } | null {
  const options = agent?.options;
  diag.push("agent.options=" + (options ? "present" : "absent")
    + (options ? "(provider=" + JSON.stringify(options.provider ?? null) + ",model=" + JSON.stringify(options.model ?? null) + ")" : ""));
  if (nonEmpty(options?.provider) && nonEmpty(options?.model)) {
    return { provider: options.provider, model: options.model };
  }
  try {
    const header = typeof agent?.session?.requestHeader === "function" ? agent.session.requestHeader() : null;
    const config = header?.config;
    diag.push("session.requestHeader().config=" + (config
      ? "(provider=" + JSON.stringify(config.provider ?? null) + ",model=" + JSON.stringify(config.model ?? null) + ")"
      : "absent"));
    if (nonEmpty(config?.provider) && nonEmpty(config?.model)) {
      return { provider: config.provider, model: config.model };
    }
  } catch (error) {
    diag.push("session.requestHeader 抛错：" + String((error as any)?.message ?? error));
  }
  return null;
}

/**
 * 惰性取 llm 服务：命令挂在局部注入（commands + sessionQuery）的 child ctx 上，ctx.llm 可能不在该层。
 * 顺序：ctx.llm → agent.ctx.llm（Agent 自己的 scoped context，最可靠）→ ctx.get → ctx.root.get → ctx.parent.get。
 */
function llmOf(ctx: any, diag: string[], agent?: any): any {
  const direct = ctx?.llm;
  diag.push("ctx.llm=" + (direct ? "present" : "absent"));
  if (direct) return direct;
  const candidates: Array<[string, any]> = [
    ["agent.ctx.llm", () => agent?.ctx?.llm],
    ["agent.ctx.get('llm')", () => agent?.ctx?.get?.("llm")],
    ["ctx.get('llm')", () => ctx?.get?.("llm")],
    ["ctx.root.get('llm')", () => ctx?.root?.get?.("llm")],
    ["ctx.parent.get('llm')", () => ctx?.parent?.get?.("llm")],
  ];
  for (const [label, resolve] of candidates) {
    try {
      const svc = resolve();
      diag.push(label + "=" + (svc ? "present" : "absent"));
      if (svc) return svc;
    } catch (error) {
      diag.push(label + " 抛错：" + String((error as any)?.message ?? error));
    }
  }
  return null;
}

/**
 * 解析本次分析用的 provider/model。
 * 顺序：agent 真实路由 → ctx.llm.listProviders() 首个 provider 的首个模型。
 * 失败时把诊断轨迹一并返回（用于写进报告，而不是只 warn 到日志）。
 */
async function resolveRoute(
  ctx: any,
  agent: any,
): Promise<{ route: { provider: string; model: string }; source: string } | { route: null; reason: string }> {
  const diag: string[] = [];
  const fromAgent = routeFromAgent(agent, diag);
  if (fromAgent) return { route: fromAgent, source: "agent" };

  const llm = llmOf(ctx, diag, agent);
  if (!llm) return { route: null, reason: "llm 服务不可用（" + diag.join("；") + "）" };
  try {
    const providers = await llm.listProviders();
    diag.push("listProviders=" + (Array.isArray(providers) ? String(providers.length) + " 个" : "非数组"));
    const provider = Array.isArray(providers) ? providers.find((p: any) => nonEmpty(p?.id)) : undefined;
    if (!provider) return { route: null, reason: "agent 无 provider/model，且 listProviders 为空（" + diag.join("；") + "）" };
    const models = await llm.listModels(provider.id);
    diag.push("listModels(" + provider.id + ")=" + (Array.isArray(models) ? String(models.length) + " 个" : "非数组"));
    const model = Array.isArray(models) ? models.find((m: any) => nonEmpty(m?.id)) : undefined;
    if (!model) return { route: null, reason: "provider " + provider.id + " 无可用模型（" + diag.join("；") + "）" };
    return { route: { provider: provider.id, model: model.id }, source: "llm.listProviders" };
  } catch (error) {
    return {
      route: null,
      reason: "listProviders/listModels 抛错：" + String((error as any)?.message ?? error) + "（" + diag.join("；") + "）",
    };
  }
}

/** 单次 LLM 分析调用（无重试、无工具循环）；失败时带回可读原因，供写进报告 */
async function callAnalysis(
  ctx: any,
  agent: any,
  digest: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; raw: string; provider: string; model: string; source: string }
  | { ok: false; reason: string; provider: string; model: string }
> {
  const resolved = await resolveRoute(ctx, agent);
  if (resolved.route === null) return { ok: false, reason: resolved.reason, provider: "", model: "" };
  const route = resolved.route;
  const llm = llmOf(ctx, [], agent);
  if (!llm) return { ok: false, reason: "llm 服务不可用，无法发起分析调用", provider: route.provider, model: route.model };
  if (typeof llm.prepareCall !== "function") {
    return { ok: false, reason: "llm 服务缺少 prepareCall 方法，无法发起分析调用", provider: route.provider, model: route.model };
  }
  try {
    const prepared = await llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens: ANALYSIS_MAX_TOKENS },
      signal,
    );
    const system = "你是会话复盘分析器。只输出 JSON 数组，不要解释、不要 Markdown 围栏。";
    const prompt = [
      "下面是某会话的统计摘要（每行 turn 含 end 事件 seq、usage、工具状态）。",
      "请输出 JSON 数组，每项形如：",
      '{"kind":"observation|praise|issue|suggestion","text":"中文结论","evidence":[{"sessionId":"...","turn":1,"seq":42,"callId":null}],"limitations":["..."]}',
      "硬规则：每条必须带至少 1 条 evidence；evidence 的 sessionId/turn/seq 必须来自下方摘要中真实出现的数据；",
      "不要编造 seq，不要给无证据的结论（无证据结论将被丢弃）。最多 12 条。",
      "",
      "摘要：",
      digest,
    ].join("\n");
    let raw = "";
    // dsh-llm 会在 prepareCall 阶段为若干字段（如 reasoningEffort）回填模型默认值，
    // 而 prepared.stream() 会用 callConfigEquals 逐字段校验；因此必须把 prepared.config
    // 整体展开回传，否则会出现「一侧有值一侧 undefined」的 INVALID_PREPARED_CALL。
    const preparedConfig: Record<string, unknown> = (prepared as any)?.config ?? {};
    for await (const chunk of prepared.stream({
      ...preparedConfig,
      provider: route.provider,
      model: route.model,
      maxTokens: ANALYSIS_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      signal,
    } as any)) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") raw += chunk.text;
    }
    return { ok: true, raw, provider: route.provider, model: route.model, source: resolved.source };
  } catch (error) {
    return {
      ok: false,
      reason: "LLM 调用失败（" + route.provider + "/" + route.model + "）：" + String((error as any)?.message ?? error),
      provider: route.provider,
      model: route.model,
    };
  }
}

/**
 * 把「发起命令的会话」上溯到真正的根会话，再返回根会话的 readSession 结果。
 *
 * P1（stats 与 report 不同源）：采集器用 resolveRootSessionId 沿 parentSession 上溯，
 * report 过去却直接把发起会话当 root —— 在子会话里执行 `/cohub-review` 时两者就会指向不同会话，
 * 落盘目录里的 stats.json 与 report 的 rootSessionId 对不上。此处统一为同一语义。
 * 任一环读取失败即就地收口（把当前层当根），不编造、不阻断复盘。
 */
async function readRootSession(
  ctx: any,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ sessionId: string; read: any; failed?: string }> {
  let current = sessionId;
  // 首个 readSession 曾是无保护的一行（runAnalysis 八步里唯一的裸调用）：它一抛错就穿透整个
  // runAnalysis，只被外层 fire-and-forget 的 catch 吞成一条 logger.warn → 磁盘零产物。
  // 此处与下面读父会话一致地就地降级：拿不到就退回空 events，让 buildReport 输出
  // coverage.complete=false 的不完整报告（有产物 > 无产物）。
  let read: any;
  let failed: string | undefined;
  try {
    read = await ctx.sessionQuery.readSession(current, signal);
  } catch (error) {
    failed = "根会话读取失败（" + String((error as any)?.message ?? error) + "）";
    ctx.logger?.warn?.("[cohub review] " + failed + "，降级为空事件继续出报告");
    read = { session: { id: current }, events: [] };
  }
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < MAX_ROOT_ASCEND; depth++) {
    const parent = parentOf(read);
    if (typeof parent !== "string" || parent.length === 0) break;
    if (seen.has(parent)) break; // 环链：就地收口
    let parentRead: any;
    try {
      parentRead = await ctx.sessionQuery.readSession(parent, signal);
    } catch (error) {
      ctx.logger?.warn?.("[cohub review] 上溯父会话失败，以 " + current + " 为根："
        + String((error as any)?.message ?? error));
      break;
    }
    seen.add(parent);
    current = parent;
    read = parentRead;
  }
  return { sessionId: current, read, failed };
}

/**
 * 主分析流程：读会话 → buildReport → （可选）单次 LLM → 落盘。
 *
 * 最外层兜底：任何一步抛错（含 buildReport / renderMarkdown 这类非网络异常）都不再静默——
 * 先把 error-<ts>.json 落到与 report 同一目录，再把错误继续抛给外层 fire-and-forget 的 catch
 * （那里负责 _errors.log）。这样「零产物」在结构上不可能发生。
 */
async function runAnalysis(
  ctx: any,
  agent: any,
  sessionId: string,
  cwdHint: string | null,
  withLlm: boolean,
): Promise<void> {
  // 全链路超时：读到一半的会话不会把命令永久挂死（timer 必须清理，否则进程多存活 60s）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  const signal: AbortSignal = controller.signal;
  try {
    await runAnalysisInner(ctx, agent, sessionId, cwdHint, withLlm, signal);
  } catch (error) {
    const wrote = writeErrorRecord(cwdHint, sessionId, error);
    ctx.logger?.warn?.("[cohub review] 分析失败（error-*.json " + (wrote ? "已" : "未") + "落盘）："
      + String((error as any)?.message ?? error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runAnalysisInner(
  ctx: any,
  agent: any,
  sessionId: string,
  cwdHint: string | null,
  withLlm: boolean,
  signal: AbortSignal,
): Promise<void> {
  // 与采集器同一套 root 判定：上溯到真根，保证 stats.json 与 report 的 rootSessionId 同源
  const { sessionId: rootId, read: rootRead, failed: rootFailed } = await readRootSession(ctx, sessionId, signal);
  const root = toSessionEvents(rootRead, rootId);

  const childIds = await findChildIds(ctx, root.sessionId, signal);
  const children: SessionEvents[] = [];
  const gaps: string[] = [];
  // 根会话自身读失败也是缺口：必须让 coverage.complete=false，报告自带「采集不完整」标记
  if (rootFailed) gaps.push(rootId + ": " + rootFailed);
  for (const childId of childIds) {
    try {
      const read = await ctx.sessionQuery.readSession(childId, signal);
      children.push(toSessionEvents(read, childId));
    } catch (error) {
      gaps.push(childId + ": 子会话读取失败（" + String((error as any)?.message ?? error) + "）");
    }
  }

  const report = buildReport({ root, children });
  report.coverage.gaps.push(...gaps);
  if (gaps.length > 0) report.coverage.complete = false; // 子会话读取失败 → 覆盖不完整
  const cwd = root.cwd ?? cwdHint;

  const { text: digest, digest: inputDigest, truncated } = buildDigest(report);
  report.coverage.inputTruncated = truncated;
  report.analysis.requestId = inputDigest;
  report.analysis.inputDigest = inputDigest;
  report.analysis.invocations = 0;
  report.analysis.status = "failed";

  // 失败原因必须进报告（不能只 warn 到日志）：analysis.error 落 JSON，并由 renderMarkdown 渲染进 MD。
  const analysis = report.analysis as typeof report.analysis & { error?: string };
  if (withLlm) {
    const result = await callAnalysis(ctx, agent, digest, signal);
    analysis.provider = result.provider;
    analysis.model = result.model;
    if (result.ok) {
      analysis.invocations = 1;
      const extracted = extractJsonArray(result.raw);
      const rawItems = extracted.items;
      if (rawItems !== null) {
        const index = buildEvidenceIndex([root, ...children]);
        report.findings = normalizeFindings(rawItems, index, root.sessionId);
        const dropped = rawItems.length - report.findings.length;
        // 输出被截断时即使解析成功也不算 completed：结论不完整，须人工复核
        if (extracted.truncated) {
          analysis.status = "interrupted";
          analysis.error = "模型输出疑似被 maxTokens 截断：已抢救出 " + report.findings.length
            + " 条完整结论（其余丢失，建议提高 maxTokens 或减少会话数）。"
            + (dropped > 0 ? "另有 " + dropped + " 条因证据无法校验被丢弃。" : "");
        } else {
          analysis.status = "completed";
          if (dropped > 0) {
            analysis.error = "模型返回 " + rawItems.length + " 条结论，" + dropped + " 条因证据无法校验被丢弃。";
          }
        }
      } else {
        analysis.status = "failed";
        analysis.error = "模型输出无法解析为 JSON 数组，findings 留空（原始输出见 analysis.rawOutput）。";
        ctx.logger?.warn?.("[cohub review] " + analysis.error);
      }
      // 解析失败 / 截断时留原始输出，用于下次判断「截断」还是「格式错误」
      if (analysis.status !== "completed") {
        analysis.rawOutput = result.raw.slice(0, RAW_OUTPUT_KEEP_CHARS);
        analysis.rawOutputLength = result.raw.length;
        ctx.logger?.warn?.("[cohub review] 模型输出长度 " + result.raw.length
          + "，末 40 字：" + result.raw.slice(-40));
      }
    } else {
      analysis.status = "failed";
      analysis.error = result.reason;
      ctx.logger?.warn?.("[cohub review] LLM 分析失败：" + result.reason);
    }
  } else {
    analysis.status = "completed";
    analysis.provider = "(skipped)";
    analysis.model = "(skipped)";
  }

  const md = renderMarkdown(report, { excerptLimit: 120 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 落盘目录用「发起命令的会话」sessionId，与采集器写 stats.json 的目录同源；
  // 报告内容里的 rootSessionId 仍标识真根会话（语义不同，不能替换成 sessionId）。
  const jsonPath = reviewStorePath(cwd, sessionId, "report-" + stamp + ".json");
  const mdPath = reviewStorePath(cwd, sessionId, "report-" + stamp + ".md");
  const jsonOk = writeTextAtomic(jsonPath, JSON.stringify(report, null, 2));
  const mdOk = writeTextAtomic(mdPath, md);
  if (!jsonOk || !mdOk) {
    ctx.logger?.warn?.("[cohub review] 报告落盘失败：json=" + jsonPath + " md=" + mdPath);
  } else {
    ctx.logger.info?.("[cohub review] 报告已生成：" + mdPath);
  }
}

/** 从会话上宽松取 cwd（拿不到就 null，由 review-store 记为 "nocwd"） */
function cwdHintOf(inv: any): string | null {
  const cwd = inv?.agent?.session?.header?.cwd
    ?? inv?.agent?.session?.meta?.cwd
    ?? inv?.agent?.options?.cwd
    ?? null;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/** 正在分析中的会话 id 集合：防同一会话并发重复跑 LLM */
const inFlight = new Set<string>();

/** 注册 `/cohub-review` 命令（零 turn、不经过模型） */
export function registerReviewCommand(ctx: any): void {
  // 契约：handler 必须返回 CommandResult = { kind: 'success' | 'error', text }。
  // 只返回 { text } 会被宿主 normalizeResult 判为非法（gateway/internal），因此每个分支都带 kind。
  const handler = (inv: any): { kind: "success" | "error"; text: string } => {
    try {
      const sessionId = inv?.agent?.session?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { kind: "error", text: "无法确定当前会话 id，已跳过复盘。" };
      }
      if (inFlight.has(sessionId)) {
        return { kind: "error", text: "上一次分析仍在进行中，请稍候（会话 " + sessionId + "）。" };
      }
      const rawInput = typeof inv?.rawInput === "string" ? inv.rawInput : "";
      const withLlm = !/(^|\s)--no-llm(\s|$)/.test(rawInput);
      const cwdHint = cwdHintOf(inv);

      // fire-and-forget：绝不 await，也绝不让异常冒泡到宿主
      inFlight.add(sessionId);
      void (async () => {
        try {
          await runAnalysis(ctx, inv?.agent, sessionId, cwdHint, withLlm);
        } catch (error) {
          const message = String((error as any)?.message ?? error);
          // warn 只在看不见的 stderr 里；同时落 _errors.log，让失败在磁盘上可查
          appendErrorLog(cwdHint, sessionId, message);
          ctx.logger?.warn?.("[cohub review] 报告生成失败：" + message);
        } finally {
          inFlight.delete(sessionId);
        }
      })();

      const dir = reviewStorePath(cwdHint, sessionId, "").replace(/[\\/]$/, "");
      return {
        kind: "success",
        text: "正在生成报告…（" + (withLlm ? "含一次 LLM 分析" : "仅统计，跳过 LLM") + "）输出目录：" + dir,
      };
    } catch (error) {
      return { kind: "error", text: "复盘命令启动失败：" + String((error as any)?.message ?? error) };
    }
  };

  try {
    ctx.commands.register({
      definitionId: "cohub-review",
      name: "cohub-review",
      description: "生成当前会话的可追溯复盘报告",
      handler,
    });
  } catch (error) {
    ctx.logger?.warn?.("[cohub review] 命令注册失败：" + String((error as any)?.message ?? error));
  }
}

/** 供外部（测试/调试）读取报告根目录 */
export function reviewRootDir(): string {
  return dshHomePath("cohub", "reviews");
}
