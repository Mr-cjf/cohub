// src/review-render.ts —— 把 ReviewReport 渲染成「用户真正会读」的可追溯 Markdown 报告
//
// 【硬规则（改本文件前先读这三条）】
// 1. 每条结论必须能指回 (sessionId, turn, seq)——任何结论行都必须带锚点，不允许裸结论。
// 2. 缺失数据渲染为 `—` 或进 gaps，绝不编造、绝不把缺失写成 0（usage 为 null 时不得显示 0）。
// 3. 无证据（evidence 为空数组）的 finding 不得混入正式结论区，只能落在「未验证」节。
//
// 章节顺序固定：标题/元信息 → 覆盖范围(含不完整告警) → 分轮总览 → 委派树 → 发现 → 未验证 → 限制说明。
// 纯渲染层：不做采集、不做分析、不依赖 review-report.ts。
import type {
  AttemptRecord, Evidence, Finding, ReviewReport, SessionSummary, TurnSummary, UsageRecord,
} from "./review-types.ts";

/** 缺失值的统一占位符（绝不替换成 0）。 */
const DASH = "—";

/** findings 分组的固定顺序（praise → issue → suggestion → observation）。 */
const KIND_ORDER = ["praise", "issue", "suggestion", "observation"] as const;

/** 每个 kind 的小标题（英文 kind 打头，便于机器消费）。 */
const KIND_TITLE: Record<string, string> = {
  praise: "praise（值得肯定）",
  issue: "issue（问题）",
  suggestion: "suggestion（建议）",
  observation: "observation（观察）",
};

export interface RenderOptions {
  /** 摘录保留的最大字符数（默认 120）。 */
  excerptLimit?: number;
  /** 按 (sessionId, seq) 取原文摘录；返回 null 表示无摘录可给，此时不渲染摘录行。 */
  excerptLookup?: (sessionId: string, seq: number) => string | null;
}

/** 数字渲染：非有限数一律 `—`，避免把缺失写成 0。 */
function num(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : DASH;
}

/** 文本渲染：null/undefined/空串一律 `—`。 */
function text(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : DASH;
}

/** 单轮 tokens 单元格：usage 为 null → `—`（绝不写 0）；否则 `in/out`。 */
function usageCell(usage: UsageRecord | null | undefined): string {
  if (!usage) return DASH;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  if (input === DASH && output === DASH) return DASH;
  return `${input}/${output}`;
}

/** 工具统计：总调用数 / 出错数（pending 不计入错误）。 */
function toolCounts(turn: TurnSummary): { total: string; errors: string } {
  const tools = Array.isArray(turn?.tools) ? turn.tools : [];
  const errors = tools.filter(t => t?.status === "error").length;
  return { total: String(tools.length), errors: String(errors) };
}

/** 锚点文本：`[<sessionId> · turn N · seq S]`，有 callId 时追加 ` · call <callId>`。 */
function anchorOf(ev: Evidence): string {
  const base = `[${text(ev?.sessionId)} · turn ${num(ev?.turn)} · seq ${num(ev?.seq)}]`;
  return typeof ev?.callId === "string" && ev.callId.length > 0
    ? `${base.slice(0, -1)} · call ${ev.callId}]`
    : base;
}

/** 按 excerptLimit 截断摘录（超长补省略号）。 */
function excerptOf(raw: string, limit: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 渲染 findng 的详细块（锚点 + 摘录 + 局限），仅给正式结论区使用。 */
function renderFinding(
  finding: Finding,
  opts: RenderOptions,
  excerptLimit: number,
): string[] {
  const out: string[] = [];
  out.push(`- **${text(finding?.text)}**`);
  const evidence = Array.isArray(finding?.evidence) ? finding.evidence : [];
  // 硬规则 1：结论必须能指回 (sessionId, turn, seq)
  for (const ev of evidence) out.push(`  - 锚点：${anchorOf(ev)}`);
  // 摘录：只取第一条能拿到原文的证据，拿不到就不写「摘录」行
  if (opts.excerptLookup) {
    for (const ev of evidence) {
      let raw: string | null = null;
      try {
        raw = opts.excerptLookup(String(ev?.sessionId ?? ""), Number(ev?.seq ?? 0));
      } catch {
        raw = null;
      }
      if (typeof raw === "string" && raw.length > 0) {
        out.push(`  - 摘录：\`${excerptOf(raw, excerptLimit)}\``);
        break;
      }
    }
  }
  const limits = Array.isArray(finding?.limitations) ? finding.limitations : [];
  for (const l of limits) out.push(`  - 局限：${text(l)}`);
  return out;
}

/** 分析状态的中文说明（用户读的报告里不能只出现一个英文单词 failed）。 */
const STATUS_TITLE: Record<string, string> = {
  completed: "completed（分析完成）",
  interrupted: "interrupted（被取消，结论不完整）",
  failed: "failed（分析失败，本轮没有模型结论，原因见下方「分析错误说明」）",
};

/** 主入口：ReviewReport（宽松入参）→ Markdown 字符串。 */
export function renderMarkdown(report: any, opts: RenderOptions = {}): string {
  const r = (report ?? {}) as Partial<ReviewReport>;
  const excerptLimit = typeof opts.excerptLimit === "number" && opts.excerptLimit > 0
    ? Math.floor(opts.excerptLimit)
    : 120;
  const lines: string[] = [];

  const findings: Finding[] = Array.isArray(r.findings) ? r.findings : [];
  // 硬规则 3：evidence 非空 → 正式结论区；evidence 为空 → 未验证区
  const verified = findings.filter(f => (Array.isArray(f?.evidence) ? f.evidence.length : 0) > 0);
  const unverified = findings.filter(f => !(Array.isArray(f?.evidence) ? f.evidence.length : 0));
  const coverage = r.coverage ?? { throughSeq: {}, complete: false, gaps: [], inputTruncated: false };
  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : [];
  const complete = coverage.complete === true;

  // ---- 1. 标题 + 元信息 ----
  lines.push("# 会话复盘报告", "");
  lines.push(`- 项目 cwd：${text(r.project?.cwd)}`);
  lines.push(`- 项目键：${text(r.project?.key)}`);
  lines.push(`- root session id：${text(r.rootSessionId)}`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 采集完整性：${complete ? "complete（所有目标会话已读至末尾）" : "不完整（存在缺口，结论需降级）"}`);
  lines.push(`- 分析输入是否被裁剪：${coverage.inputTruncated ? "是（结论不得外推到未读区间）" : "否"}`);
  // 分析状态必须可见：LLM 失败时过去只 warn 到日志，用户在报告里毫无线索。
  const analysis = (r.analysis ?? {}) as any;
  const statusRaw = typeof analysis.status === "string" && analysis.status.length > 0 ? analysis.status : "";
  const statusLabel = STATUS_TITLE[statusRaw] ?? text(analysis.status);
  lines.push(`- 分析状态：${statusLabel}（provider/model：${text(analysis.provider)} / ${text(analysis.model)}，调用次数 ${num(analysis.invocations)}）`);
  if (typeof analysis.error === "string" && analysis.error.length > 0) {
    lines.push(`- 分析错误说明：${analysis.error}`);
  }
  // 诊断线索：原始输出留档长度（区分「被 maxTokens 截断」与「格式错误」）
  if (typeof analysis.rawOutputLength === "number" && Number.isFinite(analysis.rawOutputLength)) {
    const kept = typeof analysis.rawOutput === "string" ? analysis.rawOutput.length : 0;
    lines.push(`- 模型原始输出：全长 ${num(analysis.rawOutputLength)} 字，报告内留档前 ${num(kept)} 字（见 JSON 的 analysis.rawOutput）`);
  }
  if (statusRaw === "failed") {
    lines.push("- 本轮**没有产生任何模型结论**：findings 为空是分析失败的结果，不代表本次会话没有值得复盘之处。");
  }
  lines.push("");

  // ---- 2. 覆盖范围 ----
  lines.push("## 覆盖范围", "");
  const throughSeq = coverage.throughSeq ?? {};
  const throughEntries = Object.entries(throughSeq);
  if (throughEntries.length === 0) {
    lines.push(`- 无覆盖记录（throughSeq 为空，${DASH}）`);
  } else {
    lines.push("| session | throughSeq |", "| --- | --- |");
    for (const [sid, seq] of throughEntries) lines.push(`| ${sid} | ${num(seq)} |`);
  }
  lines.push("");
  if (!complete) {
    lines.push("## ⚠️ 覆盖不完整", "");
    if (gaps.length === 0) {
      lines.push("- 采集未完成，但未记录具体缺口（见 coverage.complete）。");
    } else {
      for (const g of gaps) lines.push(`- ${text(g)}`);
    }
    lines.push("");
  }

  // ---- 3. 分轮总览 ----
  lines.push("## 分轮总览", "");
  const sessions: SessionSummary[] = Array.isArray(r.sessions) ? r.sessions : [];
  if (sessions.length === 0) {
    lines.push(`- 无会话摘要（sessions 为空，${DASH}）`, "");
  } else {
    for (const s of sessions) {
      lines.push(`### ${text(s?.sessionId)}`, "");
      lines.push(
        "| turn | 结束原因 | tokens(in/out) | 工具数 | 错误数 |",
        "| --- | --- | --- | --- | --- |",
      );
      const turns = Array.isArray(s?.turns) ? s.turns : [];
      if (turns.length === 0) {
        lines.push(`| ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
      } else {
        for (const t of turns) {
          const counts = toolCounts(t);
          lines.push(
            `| ${num(t?.turn)} | ${text(t?.end?.kind)} | ${usageCell(t?.usage)} | ${counts.total} | ${counts.errors} |`,
          );
        }
      }
      lines.push("");
    }
  }

  // ---- 4. 委派树（仅当有 attempts 时渲染）----
  const attempts: AttemptRecord[] = Array.isArray(r.attempts) ? r.attempts : [];
  if (attempts.length > 0) {
    lines.push("## 委派树", "");
    for (const a of attempts) {
      const parent = a?.parent;
      const parentLabel = `${text(parent?.sessionId)} · turn ${num(parent?.turn)} · seq ${num(parent?.seq)} · call ${text(parent?.callId)}`;
      const cost = typeof a?.startedAt === "number" && typeof a?.endedAt === "number"
        ? `${Math.max(0, Math.round(a.endedAt - a.startedAt))}ms`
        : DASH;
      const tag = a?.attempt > 0 || a?.taskIndex > 0
        ? `（task ${num(a?.taskIndex)} / attempt ${num(a?.attempt)}）`
        : "";
      lines.push(`- ${parentLabel} → ${text(a?.childSessionId)} (${text(a?.outcome)}, ${cost})${tag}`);
    }
    lines.push("");
  }

  // ---- 5. 发现（按 kind 分组，固定顺序）----
  lines.push("## 发现", "");
  if (verified.length === 0) {
    // 措辞纪律：findings 为空时**不能**暗示「结论都带了锚点」——这里根本没有结论。
    lines.push(`- 本报告没有带证据的结论（findings 为空，${DASH}）；原因见「分析状态」与「限制说明」。`, "");
  } else {
    for (const kind of KIND_ORDER) {
      const group = verified.filter(f => f?.kind === kind);
      if (group.length === 0) continue;
      lines.push(`### ${KIND_TITLE[kind] ?? kind}`, "");
      for (const f of group) lines.push(...renderFinding(f, opts, excerptLimit));
      lines.push("");
    }
    // 未知 kind 兜底：不丢失结论
    const known = new Set<string>(KIND_ORDER);
    const rest = verified.filter(f => !known.has(String(f?.kind)));
    if (rest.length > 0) {
      lines.push(`### ${DASH}（未知 kind）`, "");
      for (const f of rest) lines.push(...renderFinding(f, opts, excerptLimit));
      lines.push("");
    }
  }

  // ---- 6. 未验证（无证据 finding 只落这里）----
  if (unverified.length > 0) {
    lines.push("## 未验证", "");
    lines.push("以下条目没有任何证据锚点，不能作为正式结论使用：", "");
    for (const f of unverified) {
      lines.push(`- **${text(f?.text)}**（无证据，未验证）`);
      const limits = Array.isArray(f?.limitations) ? f.limitations : [];
      for (const l of limits) lines.push(`  - 局限：${text(l)}`);
      lines.push(`  - kind：${text(f?.kind)}`);
    }
    lines.push("");
  }

  // ---- 7. 限制说明 ----
  lines.push("## 限制说明", "");
  const noConclusion = verified.length === 0;
  const analysisError = typeof (r.analysis as any)?.error === "string" && (r.analysis as any).error.length > 0
    ? String((r.analysis as any).error)
    : null;
  const needsReview = gaps.length > 0 || unverified.length > 0 || !complete;
  if (needsReview) {
    lines.push("本报告存在未覆盖部分，结论需人工复核。", "");
    if (gaps.length > 0) lines.push(`- 采集缺口 ${gaps.length} 处，相关区间的事件未被读到，不应据此下结论。`);
    if (unverified.length > 0) {
      lines.push(`- ${unverified.length} 条结论缺少证据，已移入「未验证」节，未计入正式分组。`);
    }
    if (noConclusion) {
      lines.push("- 本次复盘**没有产出任何带锚点的结论**（findings 为空），不存在可复核的结论条目。");
    }
    if (!complete) lines.push("- coverage.complete 为 false，统计数字不完整。");
    if (coverage.inputTruncated) lines.push("- 分析输入被裁剪，结论不得外推到未读区间。");
    if (analysisError) lines.push(`- 分析失败/降级原因：${analysisError}`);
    lines.push("");
  } else if (noConclusion) {
    // 无缺口但没有任何带证据的结论：不能说「所有结论均已带锚点」（这里没有结论）。
    lines.push("本报告覆盖范围内无已知缺口，但本次没有产出任何带锚点的结论（findings 为空）。", "");
    if (analysisError) lines.push(`- 分析说明：${analysisError}`, "");
  } else {
    lines.push("本报告覆盖范围内无已知缺口，所有结论均已带锚点。", "");
    if (analysisError) lines.push(`- 分析说明：${analysisError}`, "");
  }

  return lines.join("\n");
}
