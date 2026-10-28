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

/** severity 的顺序权重（high 最重，用于 issue 组内降序排列）。 */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** severity 展示顺序（统计行固定 high → medium → low）。 */
const SEVERITY_ORDER = ["high", "medium", "low"] as const;

/** 取一条 finding 的有效 severity：只有 issue 且值在白名单内才算，其余返回 null。 */
function severityOf(finding: Finding): "low" | "medium" | "high" | null {
  if (finding?.kind !== "issue") return null;
  const s = (finding as any)?.severity;
  return s === "high" || s === "medium" || s === "low" ? s : null;
}

/** 渲染 findng 的详细块（锚点 + 摘录 + 局限），仅给正式结论区使用。 */
function renderFinding(
  finding: Finding,
  opts: RenderOptions,
  excerptLimit: number,
): string[] {
  const out: string[] = [];
  // issue 带等级时，标题行显式标注 `- **issue · high** — <text>`，方便扫读优先级。
  const sev = severityOf(finding);
  out.push(sev !== null ? `- **issue · ${sev}** — ${text(finding?.text)}` : `- **${text(finding?.text)}**`);
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

/**
 * 「会话集合覆盖」一行的取值。
 * 【向后兼容铁律】sessionsTruncated === undefined 是旧报告（0.10.1 及以前）——
 * 必须显示「未知」，**不能**默认成「未截断」（那会凭空声称全量），也不能显示成截断。
 */
/**
 * 会话集合是否截断：优先用显式 `sessionsTruncated`；
 * 【P2-3 读取时推断】缺失（undefined，旧报告）但 lineageTotal 与 sessionsAnalyzed 都已知时，
 * 按契约 `sessionsTruncated = sessionsAnalyzed < lineageTotal` 推断——只是读取时推断，**不改写数据**；
 * 两个数缺任一个仍返回 undefined（老实说未知，不凭空声称完整）。
 */
function inferSessionsTruncated(
  sessionsTruncated: boolean | undefined,
  lineageTotal: number | null,
  sessionsAnalyzed: number | null,
): boolean | undefined {
  if (typeof sessionsTruncated === "boolean") return sessionsTruncated;
  if (lineageTotal !== null && sessionsAnalyzed !== null) return sessionsAnalyzed < lineageTotal;
  return undefined;
}

/**
 * samplingNote 现在**只存规则、不存数量**（数量由本层从 lineageTotal / sessionsAnalyzed 拼），
 * 所以这里可以直接把规则塞进一层括号而不会再嵌套。
 * 契约：`samplingNote` 为空（旧报告 / 无截断）时返回空串，**不产出 `（）` 这种噪声**。
 */
function ruleText(note: string): string {
  return note.length > 0 && note !== DASH ? note : "";
}

/** 规则后缀：`（按创建时间倒序取最新）`；无规则时为空串。 */
function ruleSuffix(note: string): string {
  const rule = ruleText(note);
  return rule.length > 0 ? `（${rule}）` : "";
}

/**
 * 取样规则的三态：只取样截断 / 只读失败 / 两者并存（+ 未记录）。
 * 判据是 `samplingNote` 的文案（applyDiscoveryCoverage 是唯一写入方），
 * 因为两者都会让 sessionsTruncated=true，单看布尔值分不出来。
 */
function samplingKind(note: string): "sampled" | "readFailed" | "both" | "unknown" {
  const rule = ruleText(note);
  const sampled = rule.includes("取最新");
  const readFailed = rule.includes("读取失败");
  if (sampled && readFailed) return "both";
  if (sampled) return "sampled";
  if (readFailed) return "readFailed";
  return "unknown";
}

function sessionsCoverageText(
  sessionsTruncatedRaw: boolean | undefined,
  lineageTotal: number | null,
  sessionsAnalyzed: number | null,
  samplingNote: string,
  childCount: number | null,
): string {
  const sessionsTruncated = inferSessionsTruncated(sessionsTruncatedRaw, lineageTotal, sessionsAnalyzed);
  // 未截断时若未显式给 sessionsAnalyzed，用 sessions[]（含根会话）减 1 派生——此时集合是完整的，
  // 派生值等价于真实总数；截断时**绝不**这样推（那会把取样数当全量）。
  const analyzed = sessionsAnalyzed ?? (sessionsTruncated === false ? childCount : null);
  if (sessionsTruncated === true) {
    // 数量在前、规则平铺在括号里：`已分析 50 / 共 108 个子会话（按创建时间倒序取最新）`
    if (lineageTotal !== null && analyzed !== null) {
      return `已分析 ${analyzed} / 共 ${lineageTotal} 个子会话${ruleSuffix(samplingNote)}`;
    }
    if (lineageTotal !== null) return `共 ${lineageTotal} 个子会话（已分析数未记录）`;
    if (analyzed !== null) return `已分析 ${analyzed} 个子会话（总数未知）`;
    return "已取样截断（总数未记录）";
  }
  if (sessionsTruncated === false) {
    if (analyzed !== null) return `全部 ${analyzed} 个子会话`;
    if (lineageTotal !== null) return `全部 ${lineageTotal} 个子会话`;
    return "全部子会话（数量未记录）";
  }
  return "未知（本报告由旧版本生成，未记录子会话总数）";
}

/** sessions[]（含根会话）→ 子会话数（减掉 1 个根会话）；无法判定时 null。 */
function childCountFromSessions(report: any): number | null {
  const list = Array.isArray(report?.sessions) ? report.sessions : [];
  if (list.length === 0) return null;
  return Math.max(0, list.length - 1);
}

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
  // ---- 会话集合维度（与 complete 相互独立，见 review-types.ts:18-22）----
  // sessionsTruncated: true=确认截断 / false=已全量 / undefined=旧报告未知（**不得**当成 false）
  const sessionsTruncated = coverage.sessionsTruncated;
  const lineageTotal = typeof coverage.lineageTotal === "number" && Number.isFinite(coverage.lineageTotal)
    ? coverage.lineageTotal : null;
  const sessionsAnalyzedRaw = typeof coverage.sessionsAnalyzed === "number" && Number.isFinite(coverage.sessionsAnalyzed)
    ? coverage.sessionsAnalyzed : null;
  // P2-3：显式值缺失时按契约推断（只读取时推断，不动数据）
  const sessionsTruncatedEffective = inferSessionsTruncated(sessionsTruncated, lineageTotal, sessionsAnalyzedRaw);
  const samplingNote = text(coverage.samplingNote);

  // ---- 1. 标题 + 元信息 ----
  lines.push("# 会话复盘报告", "");
  lines.push(`- 项目 cwd：${text(r.project?.cwd)}`);
  lines.push(`- 项目键：${text(r.project?.key)}`);
  lines.push(`- root session id：${text(r.rootSessionId)}`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  // 两个独立完整性维度必须分开写：complete 只说「已分析会话内部事件流自洽」，
  // 绝不能说成「所有目标会话已读」（旧文案的误导点，本行不可回退）。
  lines.push(`- 事件流完整性：${complete ? "complete（已分析会话内部事件连续无缺口）" : "不完整（已分析会话内存在事件缺口，结论需降级）"}`);
  lines.push(`- 会话集合覆盖：${sessionsCoverageText(sessionsTruncated, lineageTotal, sessionsAnalyzedRaw, samplingNote, childCountFromSessions(r))}`);
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
  // 快照边界：报告是某一时刻的切片，此后的新 turn / 委派不在范围内（不提示用户就会误读为「最新」）。
  const rootSid = typeof r.rootSessionId === "string" ? r.rootSessionId : "";
  const rootSeq = rootSid.length > 0 ? (throughSeq as Record<string, number>)[rootSid] : undefined;
  if (typeof rootSeq === "number" && Number.isFinite(rootSeq)) {
    lines.push(`> 本报告是快照：根会话截至 seq ${rootSeq}。此后的新 turn 与委派不在本报告范围内，需要重新生成。`, "");
  } else {
    lines.push(`> 本报告是快照：根会话的已读 seq ${DASH}（未记录）。此后的新 turn 与委派不在本报告范围内，需要重新生成。`, "");
  }
  // 会话集合被取样截断：必须在覆盖范围区醒目提示（未分析的子会话消耗与问题都不在报告里）。
  if (sessionsTruncatedEffective === true) {
    const totalLabel = lineageTotal !== null ? `${lineageTotal} 个` : `${DASH}（未记录）个`;
    const analyzedLabel = sessionsAnalyzedRaw !== null ? `${sessionsAnalyzedRaw} 个` : `${DASH}（未记录）个`;
    // 两种成因文案分开：取样截断说「只分析了」，纯读失败说「成功分析」——
    // 前者是主动裁剪，后者是数据读不出来，混成一句会让人误解（规则用平铺括号，不嵌套）。
    if (samplingKind(samplingNote) === "readFailed") {
      lines.push(`⚠️ 部分子会话读取失败：共 ${totalLabel}，成功分析 ${analyzedLabel}。失败子会话的消耗与问题不在本报告内。`, "");
    } else {
      lines.push(`⚠️ 子会话取样截断：共 ${totalLabel}，只分析了 ${analyzedLabel}${ruleSuffix(samplingNote)}。未分析的子会话的消耗与问题不在本报告内。`, "");
    }
  }
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
    // 问题分布统计：只在有 issue 时出现（没有 issue 就没有「分布」可言，绝不显示 high 0 / low 0）。
    const issueCounts = new Map<string, number>();
    for (const f of verified) {
      const sev = severityOf(f);
      if (sev !== null) issueCounts.set(sev, (issueCounts.get(sev) ?? 0) + 1);
    }
    const totalIssues = [...issueCounts.values()].reduce((a, b) => a + b, 0);
    if (totalIssues > 0) {
      const dist = SEVERITY_ORDER
        .filter(s => (issueCounts.get(s) ?? 0) > 0)
        .map(s => `${s} ${issueCounts.get(s)}`)
        .join(" / ");
      lines.push(`- 问题分布：${dist}`, "");
    }
    for (const kind of KIND_ORDER) {
      let group = verified.filter(f => f?.kind === kind);
      if (group.length === 0) continue;
      // issue 组内按 severity 降序（high → medium → low）；Array#sort 稳定，同 severity 保持原序。
      if (kind === "issue") {
        group = [...group].sort((a, b) => {
          const ra = SEVERITY_RANK[severityOf(a) ?? ""] ?? SEVERITY_ORDER.length;
          const rb = SEVERITY_RANK[severityOf(b) ?? ""] ?? SEVERITY_ORDER.length;
          return ra - rb;
        });
      }
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
  const needsReview = gaps.length > 0 || unverified.length > 0 || !complete
    || coverage.inputTruncated === true || sessionsTruncatedEffective === true;
  if (needsReview) {
    lines.push("本报告存在未覆盖部分，结论需人工复核。", "");
    // 两种截断**分别**列出（输入裁剪 ≠ 会话取样），不许合并成一句含糊的「有截断」。
    if (coverage.inputTruncated === true) {
      lines.push("- 分析输入被裁剪：模型摘要超过 12000 字被裁剪（coverage.inputTruncated），结论不得外推到未读区间。");
    }
    if (sessionsTruncatedEffective === true) {
      const totalLabel = lineageTotal !== null ? `${lineageTotal}` : `${DASH}`;
      const analyzedLabel = sessionsAnalyzedRaw !== null ? `${sessionsAnalyzedRaw}` : `${DASH}`;
      // 与覆盖范围区同口径：读失败 ≠ 取样截断，两条分写（各占一行，规则平铺不嵌套）
      if (samplingKind(samplingNote) === "readFailed") {
        lines.push(`- 部分子会话读取失败：共 ${totalLabel} 个，成功分析 ${analyzedLabel} 个，失败子会话不在结论范围内。`);
      } else {
        lines.push(`- 子会话取样截断：共 ${totalLabel} 个，只分析了 ${analyzedLabel} 个${ruleSuffix(samplingNote)}，未分析的子会话不在结论范围内。`);
      }
    }
    if (gaps.length > 0) lines.push(`- 采集缺口 ${gaps.length} 处，相关区间的事件未被读到，不应据此下结论。`);
    if (!complete) lines.push("- coverage.complete 为 false，已分析会话内存在事件缺口，统计数字不完整。");
    if (unverified.length > 0) {
      lines.push(`- ${unverified.length} 条结论缺少证据，已移入「未验证」节，未计入正式分组。`);
    }
    if (noConclusion) {
      lines.push("- 本次复盘**没有产出任何带锚点的结论**（findings 为空），不存在可复核的结论条目。");
    }
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
