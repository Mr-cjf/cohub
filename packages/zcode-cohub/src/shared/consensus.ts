// ⚠️ 本文件由 cohub-shared/src/consensus.ts 自动同步生成，请勿直接编辑。
// 修改请改 cohub-shared/src/consensus.ts，然后运行 bun cohub-shared/sync.ts
/**
 * 多模型共识算法纯逻辑（零平台依赖）。
 * 从 oh-my-opencode-cohub/src/tools/council.ts 搬移 A 类 + B 类函数与常量。
 * C 类（依赖 @opencode-ai/sdk / @opencode-ai/plugin）不搬。
 */

import { shortModelLabel } from "./model.js";

// ============================================================================
// Type Definitions（从 council.ts 与 quality.ts 搬移到共享层）
// ============================================================================

/** 失败分类（搬自 quality.ts） */
export type FailureCategory = "timeout" | "empty" | "error" | "quality-low";

/** 重试决策结果（搬自 council.ts T2 decision table） */
export type RetryAction = "retry" | "needs-human" | "give-up" | "budget-exhausted";

/** 结构化摘要（搬自 council.ts CouncillorSummary） */
export interface CouncillorSummary {
  conclusions: string[];
  entities: string[];
}

/** 共识检测输入（搬自 council.ts ConsensusInput） */
export interface ConsensusInput {
  name: string;
  summary: CouncillorSummary;
}

/** 共识检测结果（搬自 council.ts ConsensusResult） */
export interface ConsensusResult {
  consensus: boolean;
  agreementScores: Record<string, number>;
  averageAgreement: number;
}

/**
 * 最小化 councillor 配置引用（搬自 council.ts CouncillorConfig 的结构等价接口）。
 * 仅保留 adaptiveKey 所需的字段。
 */
export interface CouncillorModelRef {
  model: string;
  variant?: string;
}

/**
 * 最小化 councillor 结果条目（搬自 council.ts 内部 CouncillorResult 的结构等价接口）。
 * 原类型未 export；此处定义为共享层兼容接口，供 formatCouncillorResults 等函数使用。
 */
export interface CouncillorResult {
  name: string;
  model: string;
  status: string;
  result?: string;
  error?: string;
  summary?: CouncillorSummary;
}

// ============================================================================
// Constants（A 类：零依赖）
// ============================================================================

/** Per-category retry limits（empty 保留 legacy councillor_retries 默认） */
export const RETRY_LIMITS: Record<FailureCategory, number> = {
  empty: 3,
  timeout: 1,
  error: 0,
  "quality-low": 1,
};

export const CONCLUSION_MARKERS = [
  "综上", "结论", "因此", "总之", "建议", "推荐", "我认为", "最终", "关键结论",
  "conclusion", "therefore", "in summary", "in conclusion", "recommend", "suggest", "overall",
];

export const ENTITY_MARKERS = [
  "决策", "决定", "方案", "采用", "选择", "关键", "实体", "要点", "关键决策",
  "decision", "entity", "key point", "option", "recommendation", "key entity",
];

export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "been", "this", "that", "it", "as", "at", "by", "from", "我们",
  "的", "了", "是", "在", "和", "与", "及", "或", "一个", "这个", "进行", "以及",
  // P1-1: 模板词剥离，避免"结论：采用X方案"高度模板化导致的共识假阳性
  "结论", "综上", "总之", "因此", "建议", "推荐", "最终", "我认为", "关键", "要点",
  "采用", "方案", "决策", "决定", "选择", "实体",
  "conclusion", "therefore", "summary", "recommend", "suggest", "overall",
  "decision", "option", "recommendation", "key", "point", "entity", "error",
]);

export const VARIANT_ORDER = ["max", "high", "medium", "low"] as const;

// ============================================================================
// A 类函数（零依赖）
// ============================================================================

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Jaccard overlap between two token sets. */
export function jaccard(x: string[], y: string[]): number {
  if (x.length === 0 || y.length === 0) return 0;
  const xs = new Set(x);
  const ys = new Set(y);
  const inter = [...xs].filter((t) => ys.has(t)).length;
  const union = new Set([...xs, ...ys]).size;
  return union === 0 ? 0 : inter / union;
}

/** Downgrade a variant one step ("max" -> "high" -> "medium" -> "low" -> undefined). */
export function downgradeVariant(variant?: string): string | undefined {
  if (!variant) return undefined;
  const idx = VARIANT_ORDER.indexOf(variant as "max" | "high" | "medium" | "low");
  if (idx < 0 || idx >= VARIANT_ORDER.length - 1) return undefined;
  return VARIANT_ORDER[idx + 1];
}

/**
 * Parse "provider/model" reference.
 * Returns null if format is invalid.
 */
export function parseModelReference(model: string): { providerID: string; modelID: string } | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

/**
 * Build a human-readable model composition string.
 * e.g. "expert1: gpt-4, expert2: claude-3"
 */
export function formatModelComposition(councillorResults: CouncillorResult[]): string {
  return councillorResults
    .map((cr) => `${cr.name}: ${shortModelLabel(cr.model)}`)
    .join(", ");
}

/**
 * T8: 自适应参数表的 (strategy, agent) 键。
 * strategy 取 councillor 的 variant 档位（未配置时为 "default"），agent 取模型引用；
 * 与 tracker computeStats 的 (strategy, agent) 聚合维度对齐。
 */
export function adaptiveKey(config: CouncillorModelRef): string {
  return `${config.variant ?? "default"}\u0000${config.model}`;
}

/**
 * Merge the user prompt with the optional councillor-specific prompt prefix.
 */
export function formatCouncillorPrompt(userPrompt: string, councillorPrompt?: string): string {
  if (!councillorPrompt) return userPrompt;
  return `${councillorPrompt}\n\n---\n\n${userPrompt}`;
}

/**
 * Shared retry budget (T4): a total retry counter plus an elapsed-time cap.
 * Both runCouncillorWithRetry retries and serial extra rounds draw from it.
 */
export class RetryBudget {
  retriesLeft: number;
  readonly maxElapsedMs: number;
  readonly startedAt: number;

  constructor(maxTotalRetries: number, maxElapsedMs: number, startedAt: number = Date.now()) {
    this.retriesLeft = Math.max(0, maxTotalRetries);
    this.maxElapsedMs = maxElapsedMs;
    this.startedAt = startedAt;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  expired(): boolean {
    return this.elapsedMs() >= this.maxElapsedMs;
  }

  /** Consume one retry slot; returns false when exhausted or expired. */
  consumeRetry(): boolean {
    if (this.retriesLeft <= 0 || this.expired()) return false;
    this.retriesLeft -= 1;
    return true;
  }
}

// ============================================================================
// B 类函数（仅依赖 A 类）
// ============================================================================

/** Map an error message to a failure category. */
export function classifyFailure(message: string): FailureCategory {
  if (message.includes("Empty response from provider")) return "empty";
  if (message.includes("timed out") || message.includes("OperationTimeoutError")) return "timeout";
  return "error";
}

/**
 * Heuristically extract a structured summary (conclusion sentences + key
 * entity/decision sentences) from a councillor response text.
 */
export function extractCouncillorSummary(text: string): CouncillorSummary {
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const conclusions = sentences.filter((s) =>
    CONCLUSION_MARKERS.some((m) => s.toLowerCase().includes(m)),
  );
  const entities = sentences.filter((s) =>
    ENTITY_MARKERS.some((m) => s.toLowerCase().includes(m)),
  );

  return {
    conclusions:
      conclusions.length > 0 ? conclusions : sentences.length > 0 ? [sentences[sentences.length - 1]] : [],
    entities,
  };
}

/**
 * Pairwise agreement between two summaries: 0.5 * conclusion overlap
 * + 0.5 * entity overlap (Jaccard on tokens).
 */
export function pairwiseAgreement(a: CouncillorSummary, b: CouncillorSummary): number {
  const aConcl = tokenize(a.conclusions.join(" "));
  const bConcl = tokenize(b.conclusions.join(" "));
  const aEnt = tokenize(a.entities.join(" "));
  const bEnt = tokenize(b.entities.join(" "));
  return 0.5 * jaccard(aConcl, bConcl) + 0.5 * jaccard(aEnt, bEnt);
}

/**
 * Compute consensus across councillor summaries.
 * Converged when >= ceil(2n/3) councillors have an average pairwise
 * agreement at or above the threshold.
 */
export function computeConsensus(inputs: ConsensusInput[], threshold: number): ConsensusResult {
  const n = inputs.length;
  if (n === 0) return { consensus: false, agreementScores: {}, averageAgreement: 0 };
  if (n === 1) {
    return { consensus: true, agreementScores: { [inputs[0].name]: 1 }, averageAgreement: 1 };
  }

  const agreementScores: Record<string, number> = {};
  for (const a of inputs) {
    let sum = 0;
    for (const b of inputs) {
      if (a.name === b.name) continue;
      sum += pairwiseAgreement(a.summary, b.summary);
    }
    agreementScores[a.name] = sum / (n - 1);
  }

  const values = Object.values(agreementScores);
  const averageAgreement = values.reduce((acc, v) => acc + v, 0) / values.length;
  const agreeing = values.filter((v) => v >= threshold).length;
  const required = Math.ceil((2 * n) / 3);
  return { consensus: agreeing >= required, agreementScores, averageAgreement };
}

/**
 * T2 retry decision table.
 * - consecutiveStreak >= 2 of the same category -> needs-human
 * - per-category retry limit reached            -> give-up
 * - shared budget exhausted                     -> budget-exhausted
 * - otherwise                                   -> retry
 */
export function decideRetryAction(
  category: FailureCategory,
  consecutiveStreak: number,
  categoryRetriesUsed: number,
  budgetAvailable: boolean,
  categoryLimit: number = RETRY_LIMITS[category],
): RetryAction {
  if (!budgetAvailable) return "budget-exhausted";
  if (consecutiveStreak >= 2) return "needs-human";
  if (categoryRetriesUsed >= categoryLimit) return "give-up";
  return "retry";
}

/** Append retry guidance to the prompt based on the failure category. */
export function appendRetryContext(prompt: string, category: FailureCategory): string {
  if (category === "timeout") {
    return `${prompt}\n\n[retry] 上次尝试超时。请精炼作答：先给出结论与关键决策，避免冗长过程。`;
  }
  if (category === "quality-low") {
    return `${prompt}\n\n[retry] 上次回答缺少明确的结论与关键实体/决策。请以"结论：..."开头，并列出关键决策/实体要点。`;
  }
  return prompt;
}

/**
 * Format all councillor results into a single structured text block that the
 * council agent can synthesize.
 */
export function formatCouncillorResults(
  originalPrompt: string,
  councillorResults: CouncillorResult[],
): string {
  const completedWithResults = councillorResults.filter(
    (cr) => cr.status === "completed" && cr.result,
  );

  const councillorSection = completedWithResults
    .map((cr) => {
      const shortModel = shortModelLabel(cr.model);
      return `**${cr.name}** (${shortModel}):\n${cr.result}`;
    })
    .join("\n\n");

  const failedEntries = councillorResults.filter((cr) => cr.status !== "completed");
  const failedSection = failedEntries
    .map((cr) => `**${cr.name}**: ${cr.status} — ${cr.error ?? "Unknown"}`)
    .join("\n");

  // All failed
  if (completedWithResults.length === 0) {
    const errorDetails = councillorResults
      .map(
        (cr) =>
          `**${cr.name}** (${shortModelLabel(cr.model)}): ${cr.status} — ${cr.error ?? "Unknown"}`,
      )
      .join("\n");
    return [
      "---",
      "",
      "**Original Prompt**:",
      originalPrompt,
      "",
      "---",
      "",
      "**Councillor Responses**:",
      "All councillors failed to produce output:",
      errorDetails,
      "",
      "Please generate a response based on the original prompt alone.",
    ].join("\n");
  }

  // Some or all succeeded
  const parts: string[] = [
    "---",
    "",
    "**Original Prompt**:",
    originalPrompt,
    "",
    "---",
    "",
    "**Councillor Responses**:",
    councillorSection,
  ];

  if (failedSection) {
    parts.push("", "---", "", "**Failed/Timed-out Councillors**:", failedSection);
  }

  parts.push(
    "",
    "---",
    "",
    "You MUST follow the Synthesis Process steps before producing output: " +
      "review each councillor response individually, then produce the required output " +
      "with a synthesized Council Response, per-councillor details using their exact names, " +
      "and a Council Summary with consensus confidence rating (unanimous, majority, or split).",
  );

  return parts.join("\n");
}

/**
 * P1-4: 构建 serial 模式第二轮起的协商 prompt —— 将上一轮其他成员的意见
 * 注入，要求当前 councillor 回应并修正或坚持立场，驱动收敛。
 */
export function buildDeliberationPrompt(
  originalPrompt: string,
  previousRound: CouncillorResult[],
  currentName: string,
): string {
  const others = previousRound
    .filter((cr) => cr.status === "completed" && cr.result && cr.name !== currentName)
    .map((cr) => `**${cr.name}** (${shortModelLabel(cr.model)}):\n${cr.result}`)
    .join("\n\n");
  if (!others) return originalPrompt;
  return [
    originalPrompt,
    "",
    "---",
    "",
    "以下是其他成员第一轮意见，请回应并修正或坚持你的立场：",
    "",
    others,
  ].join("\n");
}