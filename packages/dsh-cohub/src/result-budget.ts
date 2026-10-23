// src/result-budget.ts —— 子代理结果的「契约保留 + 预算裁剪 + 落盘定位」
//
// 背景：父会话把子代理结果全文回传并永久驻留历史（delegate.ts 成功路径、delegate_batch.ts
// 把 N 份全文拼进一个 tool_result），一个子代理动辄 3–8k 字符，父侧每一轮都要重发。
//
// 落盘复用平台既有 spill 能力（不另造一套）：
//   - 本机 host 层已挂载 @deepseek-ai/dsh-spill-local + @deepseek-ai/dsh-spill-policy
//     （~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml，maxInlineBytes: 50000）；
//   - 后端通过 ctx.get("spillStore") 取得（与官方消费方 @deepseek-ai/dsh-spill-policy
//     lib/index.js:119 完全相同的取法）；
//   - saveText({ owner, source, suggestedName, content }) 返回 { locator, bytes, retrievalHint }；
//     对 dsh-spill-local 而言 locator 就是绝对文件路径（lib/index.js:564 SpillLocator(saved.path)），
//     retrievalHint 是 "Use read with offset/limit, or grep this path to search within it."，
//     因此模型侧用现有 read / grep 工具即可读回，**不新增任何工具**；
//   - 落盘失败（无后端 / 无会话归属 / 磁盘或权限错误）一律 fail-soft：绝不因为写盘失败而丢掉结果。
//
// 同步约束：裁剪核心 planResultBudget / applyResultBudget 是纯同步函数（无 I/O、无 await、
// 无外部依赖）；落盘必须 await（平台 SpillStore.saveText 是 async，见 dsh-spill-local
// lib/index.js:556），因此只有 spillFullText / budgetResultWithSpill 两个适配函数是 async。

/** 每 token 折算字符数（保守口径：宁可早裁；中英混排实测约 2.5–4 字符/token）。 */
export const CHARS_PER_TOKEN = 3;

/** delegate 单次子代理结果上限（字符）：6000 ≈ 2000 tokens。 */
export const DEFAULT_DELEGATE_RESULT_CHARS = 6_000;
/** 失败路径 partial 的预算上限（字符）。 */
export const DEFAULT_PARTIAL_BUDGET_CHARS = 3_000;
/** delegate_batch 单个任务结果上限（字符）。 */
export const DEFAULT_BATCH_TASK_CHARS = 2_500;
/** delegate_batch 拼装后总串上限（字符）。 */
export const DEFAULT_BATCH_TOTAL_CHARS = 6_000;
/** 预算守卫告警阈值（消息体量 tokens）。 */
export const DEFAULT_CONTEXT_WARN_TOKENS = 60_000;

/** 预算配置（来自插件 Config 的 resultBudget 段；全部可选，缺省即用上面的默认值）。 */
export interface ResultBudgetConfig {
  /** 是否启用结果预算裁剪；false = 完全回到「全文回传」的旧行为 */
  enabled?: boolean;
  /** delegate 单次结果上限（字符） */
  maxChars?: number;
  /** 失败路径 partial 上限（字符） */
  partialMaxChars?: number;
  /** delegate_batch 单任务上限（字符） */
  batchTaskMaxChars?: number;
  /** delegate_batch 总串上限（字符） */
  batchTotalMaxChars?: number;
  /** 预算守卫告警阈值（tokens）；超过只 warn，绝不阻断 */
  warnMessageTokens?: number;
}

/** 归一后的预算配置（所有字段已带默认值，可直接使用）。 */
export interface ResolvedResultBudget {
  enabled: boolean;
  maxChars: number;
  partialMaxChars: number;
  batchTaskMaxChars: number;
  batchTotalMaxChars: number;
  warnMessageTokens: number;
}

/** 单个字符数配置的最小可用值：低于它会产生「越裁越长」的畸形输出。 */
const MIN_BUDGET_CHARS = 200;

/** 契约段识别：XML 风格标签（大小写不敏感） */
const XML_TAGS: readonly string[] = ["summary", "results", "answer", "changes", "verification", "risk"];
/** 命中这两个就优先采用（任务书：取到 results / answer 优先用它） */
const PRIMARY_XML_TAGS: readonly string[] = ["results", "answer"];
/** 无 XML 命中时退回的 Markdown 标题前缀（## 结论 / ## 摘要） */
const MD_TITLE_PREFIXES: readonly string[] = ["结论", "摘要"];

/** 头部保留比例（占可用于正文的预算） */
const HEAD_RATIO = 0.55;
/** 尾部保留比例（占可用于正文的预算）；0.55 + 0.35 = 0.9，余量留给标记与间距 */
const TAIL_RATIO = 0.35;

const SEP = "\n\n";
/** 无 locator 时的占位文案（落盘失败/未尝试写盘） */
const LOCATOR_FALLBACK = "落盘失败";
/** 固定开销预留（分隔符 + 数字长度抖动的最坏情况） */
const OVERHEAD_RESERVE = 24;

/** 尾部使用指引（中文；只在确实裁剪过时才出现） */
const USAGE_HINT = "（需具体行号/原始报错时才读全文；只需结论时勿读；同一 locator 最多读 2 次）";

/** 契约段自身的收缩标记（仅当契约段自己就把预算吃穿时出现） */
const CONTRACT_CLIP_MARK = "\n…[契约段自身超预算，已中段省略]…\n";

/** 字符数 → 估算 token 数（向上取整，保守）。 */
export function approxTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 归一预算配置：未配置或非法值一律落到默认值，因此「用户不改也能生效」。
 *
 * @param config 插件 Config 的 resultBudget 段（可能为 undefined / 空对象）
 * @returns 全部字段已就绪的预算配置
 */
export function resolveResultBudget(config?: ResultBudgetConfig | null): ResolvedResultBudget {
  const pick = (value: unknown, fallback: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return n >= MIN_BUDGET_CHARS ? n : fallback;
  };
  const pickTokens = (value: unknown, fallback: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return n > 0 ? n : fallback;
  };
  return {
    enabled: config?.enabled !== false,
    maxChars: pick(config?.maxChars, DEFAULT_DELEGATE_RESULT_CHARS),
    partialMaxChars: pick(config?.partialMaxChars, DEFAULT_PARTIAL_BUDGET_CHARS),
    batchTaskMaxChars: pick(config?.batchTaskMaxChars, DEFAULT_BATCH_TASK_CHARS),
    batchTotalMaxChars: pick(config?.batchTotalMaxChars, DEFAULT_BATCH_TOTAL_CHARS),
    warnMessageTokens: pickTokens(config?.warnMessageTokens, DEFAULT_CONTEXT_WARN_TOKENS),
  };
}

/** 预算裁剪的可选参数 */
export interface ResultBudgetOptions {
  /** 本段文本的字符上限 */
  maxChars: number;
  /** 语义范围（"delegate" / "delegate:partial" / "batch:task" / "batch:total"，仅用于日志与落盘命名） */
  scope?: string;
  /** 段标识（skill 名 / taskId，仅用于日志与落盘命名） */
  label?: string;
  /** 全文 locator（已落盘时由调用方传入） */
  locator?: string;
  /** 无 locator 时展示的占位文案，缺省「落盘失败」 */
  locatorFallback?: string;
}

/** 预算裁剪结果 */
export interface ResultBudgetResult {
  /** 最终回传给父代理的文本（未超预算时与输入完全相同） */
  text: string;
  /** 原始字符数（始终保留，告知父代理原文多大） */
  fullChars: number;
  /** 本次保留的字符数 */
  keptChars: number;
  /** 被省略的字符数 */
  omittedChars: number;
  /** 是否发生了裁剪 */
  truncated: boolean;
  /** 全文 locator（仅当调用方传入时存在） */
  locator?: string;
}

/** 预算计划的快速判定结果（不构造输出文本，供调用方决定是否需要落盘） */
export interface BudgetPlan {
  truncated: boolean;
  fullChars: number;
  keptChars: number;
  omittedChars: number;
  headChars: number;
  tailChars: number;
}

/** 一段文本在原文中的区间 */
interface TextRange {
  start: number;
  end: number;
}

/** XML 风格契约段命中 */
interface XmlHit extends TextRange {
  tag: string;
  /** 原文切片（含标签），保证契约段可辨识 */
  raw: string;
}

/** 契约段选取结果 */
interface ContractPick {
  /** 选中块拼起来的文本（原样，保持原顺序） */
  text: string;
  /** 这些块在原文中的区间（用于从「剩余正文」中扣除） */
  ranges: TextRange[];
}

/** 布局计算结果 */
interface Layout extends BudgetPlan {
  text: string;
}

/** 归一字符上限：非法值回到默认，低于最小值抬到最小值。 */
function normalizeMaxChars(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DELEGATE_RESULT_CHARS;
  return Math.max(MIN_BUDGET_CHARS, n);
}

/** 收集所有 XML 风格契约段（大小写不敏感，按出现顺序）。 */
function collectXmlHits(raw: string): XmlHit[] {
  const hits: XmlHit[] = [];
  for (const tag of XML_TAGS) {
    const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)</" + tag + ">", "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      hits.push({ tag, raw: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/** 找第一个 `## 结论` / `## 摘要` 标题块（到下一个同级或更高级标题，或文末）。 */
function firstHeadingBlock(raw: string): { text: string; start: number; end: number } | undefined {
  const re = /^(#{1,3})[ \t]*([^\n]*)$/gm;
  const headings: Array<{ level: number; title: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    headings.push({ level: m[1].length, title: m[2].trim(), start: m.index });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!MD_TITLE_PREFIXES.some(prefix => h.title.startsWith(prefix))) continue;
    let end = raw.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].start;
        break;
      }
    }
    return { text: raw.slice(h.start, end).trim(), start: h.start, end };
  }
  return undefined;
}

/**
 * 选取契约段（永不裁剪、置顶）。优先级：
 *   ① `<results>` / `<answer>`（结论载荷，最完整）
 *   ② `## 结论` / `## 摘要`
 *   ③ 其余 XML 块（`<summary>` / `<changes>` / `<verification>` / `<risk>`）
 */
function pickContractSegments(raw: string): ContractPick {
  const xml = collectXmlHits(raw);
  const primary = xml.filter(hit => PRIMARY_XML_TAGS.includes(hit.tag));
  if (primary.length > 0) {
    return { text: primary.map(hit => hit.raw).join(SEP), ranges: primary.map(hit => ({ start: hit.start, end: hit.end })) };
  }
  const heading = firstHeadingBlock(raw);
  if (heading) {
    return { text: heading.text, ranges: [{ start: heading.start, end: heading.end }] };
  }
  if (xml.length > 0) {
    return { text: xml.map(hit => hit.raw).join(SEP), ranges: xml.map(hit => ({ start: hit.start, end: hit.end })) };
  }
  return { text: "", ranges: [] };
}

/** 从原文中剔除若干区间（保持剩余内容的原有顺序）。 */
function stripRanges(raw: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return raw;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) out += raw.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  out += raw.slice(cursor);
  return out.trim();
}

/** 契约段自身超预算时的中段收缩（头 70% + 尾 30%）。 */
function clipContract(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - CONTRACT_CLIP_MARK.length);
  const headLen = Math.floor(room * 0.7);
  const tailLen = room - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  return head + CONTRACT_CLIP_MARK + tail;
}

/** 标记行 + 元信息行 + 指引行的保守长度上界（用于给正文留出预算）。 */
function measureOverhead(fullChars: number, locatorText: string): number {
  const tokenText = String(approxTokens(fullChars));
  const charsText = String(fullChars);
  const marker = "…[已省略 " + charsText + " 字符 ≈ " + tokenText + " tokens；全文 locator：" + locatorText + "]";
  const meta = "--- 原文共 " + charsText + " 字符 ≈ " + tokenText + " tokens；本次保留 " + charsText + " 字符 ---";
  return marker.length + meta.length + USAGE_HINT.length + SEP.length * 4 + OVERHEAD_RESERVE;
}

/**
 * 计算裁剪布局（纯函数，无副作用）。
 *
 * @param raw 原始结果文本
 * @param maxChars 本段字符上限（调用方已归一）
 * @param locatorText 展示用的 locator 文案
 * @returns 布局结果（含最终文本）
 */
function computeLayout(raw: string, maxChars: number, locatorText: string): Layout {
  const fullChars = raw.length;
  if (fullChars <= maxChars) {
    return {
      text: raw,
      truncated: false,
      fullChars,
      keptChars: fullChars,
      omittedChars: 0,
      headChars: fullChars,
      tailChars: 0,
    };
  }

  const picked = pickContractSegments(raw);
  const rest = stripRanges(raw, picked.ranges);
  const overhead = measureOverhead(fullChars, locatorText);

  // 契约段优先保留；只有它自己就把预算吃穿时才在契约段内部收缩（否则会「越裁越长」）。
  const contractBudget = Math.max(0, maxChars - overhead);
  const contractText = clipContract(picked.text, contractBudget);

  const bodyBudget = Math.max(0, maxChars - overhead - contractText.length);
  const headChars = Math.floor(bodyBudget * HEAD_RATIO);
  const tailChars = Math.floor(bodyBudget * TAIL_RATIO);
  const head = headChars > 0 ? rest.slice(0, headChars) : "";
  const tail = tailChars > 0 ? rest.slice(Math.max(headChars, rest.length - tailChars)) : "";

  const keptChars = contractText.length + head.length + tail.length;
  const omittedChars = Math.max(0, fullChars - keptChars);
  const omittedText = String(omittedChars);

  const marker = "…[已省略 " + omittedText + " 字符 ≈ " + approxTokens(omittedChars) + " tokens；全文 locator："
    + locatorText + "]";
  const meta = "--- 原文共 " + fullChars + " 字符 ≈ " + approxTokens(fullChars) + " tokens；本次保留 "
    + keptChars + " 字符 ---";

  const parts: string[] = [];
  if (contractText.length > 0) parts.push(contractText);
  if (head.length > 0) parts.push(head);
  parts.push(marker);
  if (tail.length > 0) parts.push(tail);
  parts.push(meta);
  parts.push(USAGE_HINT);

  return {
    text: parts.join(SEP),
    truncated: true,
    fullChars,
    keptChars,
    omittedChars,
    headChars: head.length,
    tailChars: tail.length,
  };
}

/**
 * 快速判定是否需要裁剪（纯同步，不构造输出文本）。
 *
 * 调用方用它决定「是否值得付一次落盘 I/O」，避免对短结果空写盘。
 *
 * @param raw 原始结果文本
 * @param maxChars 本段字符上限
 * @returns 预算计划
 */
export function planResultBudget(raw: string, maxChars: number): BudgetPlan {
  const source = typeof raw === "string" ? raw : "";
  const cap = normalizeMaxChars(maxChars);
  const layout = computeLayout(source, cap, LOCATOR_FALLBACK);
  return {
    truncated: layout.truncated,
    fullChars: layout.fullChars,
    keptChars: layout.keptChars,
    omittedChars: layout.omittedChars,
    headChars: layout.headChars,
    tailChars: layout.tailChars,
  };
}

/**
 * 按预算裁剪子代理结果（纯同步，单一裁剪入口）。
 *
 * 行为：
 *   - 未超预算 → **原样返回**（零行为变化，不误伤短结果）；
 *   - 超预算 → 契约段（`## 结论` / `## 摘要` / `<results>` / `<answer>` / `<summary>` /
 *     `<changes>` / `<verification>` / `<risk>`）优先保留并置顶，剩余正文保留头 55% + 尾 35%，
 *     中间插入「已省略 N 字符 ≈ M tokens；全文 locator：…」标记，尾部追加中文使用指引；
 *   - `fullChars` 始终保留（告知父代理原文多大）。
 *
 * 全程同步、无 I/O、无外部依赖 → 可安全用于失败路径。
 *
 * @param raw 原始结果文本
 * @param options 预算参数（上限 / 语义范围 / 标识 / locator）
 * @returns 裁剪结果
 */
export function applyResultBudget(raw: string, options: ResultBudgetOptions): ResultBudgetResult {
  const source = typeof raw === "string" ? raw : "";
  const cap = normalizeMaxChars(options?.maxChars);
  const locator = typeof options?.locator === "string" && options.locator.length > 0 ? options.locator : undefined;
  const locatorText = locator
    ?? (typeof options?.locatorFallback === "string" && options.locatorFallback.length > 0
      ? options.locatorFallback
      : LOCATOR_FALLBACK);
  const layout = computeLayout(source, cap, locatorText);
  return {
    text: layout.text,
    fullChars: layout.fullChars,
    keptChars: layout.keptChars,
    omittedChars: layout.omittedChars,
    truncated: layout.truncated,
    ...(locator === undefined ? {} : { locator }),
  };
}

/** 落盘请求 */
export interface SpillRequest {
  /** 归属会话 id（`exec.agent.session.header.id`；缺失时拒绝落盘） */
  sessionId?: string;
  /** 要落盘的完整原文 */
  text: string;
  /** 来源工具名（`delegate` / `delegate_batch`），用于 suggestedName 与来源描述 */
  toolName?: string;
  /** 段标识（skill 名 / taskId），用于 suggestedName 与来源描述 */
  label?: string;
  /** 建议文件名（后端会清洗成单个安全路径段，绝不会当作可信路径） */
  suggestedName?: string;
}

/** 落盘结果（fail-soft：失败时只有 reason，不抛错） */
export interface SpillOutcome {
  /** 平台后端给出的不透明 locator（本地后端即绝对路径） */
  locator?: string;
  /** 后端给出的取回指引 */
  retrievalHint?: string;
  /** 实际写入字节数 */
  bytes?: number;
  /** 是否失败（失败时调用方继续用裁剪后文本，绝不丢结果） */
  failed: boolean;
  /** 失败原因（仅日志用） */
  reason?: string;
}

/** 取 spillStore 后端（非 inject 强校验通道，未挂载时返回 undefined）。 */
function getSpillStore(ctx: any): any {
  try {
    if (typeof ctx?.get === "function") return ctx.get("spillStore");
    return ctx?.reflect?.get?.("spillStore", false);
  } catch {
    return undefined;
  }
}

/**
 * 把完整原文交给平台 spill 后端落盘，取回 locator。
 *
 * 复用平台既有能力（`ctx.get("spillStore")` + `saveText`），因此模型侧用现有 read / grep
 * 即可读回，不新增工具、不引入第二套落盘格式。
 *
 * **fail-soft**：无后端 / 无会话归属 / 后端拒绝（权限、ENOSPC、路径异常）一律返回
 * `{ failed: true }`，绝不抛错——落盘失败不得让成功的委派变成失败，也不得丢掉结果。
 *
 * @param ctx 插件上下文（只用于取 spillStore）
 * @param request 落盘请求
 * @returns 落盘结果
 */
export async function spillFullText(ctx: any, request: SpillRequest): Promise<SpillOutcome> {
  try {
    const store = getSpillStore(ctx);
    if (!store || typeof store.saveText !== "function") {
      return { failed: true, reason: "spillStore 未挂载（缺少 @deepseek-ai/dsh-spill-local 后端）" };
    }
    const sessionId = typeof request.sessionId === "string" && request.sessionId.length > 0
      ? request.sessionId
      : undefined;
    if (!sessionId) {
      return { failed: true, reason: "缺少会话归属（无法确定 spill 命名空间）" };
    }
    const toolName = request.toolName ?? "delegate";
    const label = request.label ?? "result";
    const ref = await store.saveText({
      owner: { sessionId },
      source: { kind: "tool", toolName, callId: label, label },
      suggestedName: request.suggestedName ?? toolName + "-" + label + ".txt",
      content: typeof request.text === "string" ? request.text : String(request.text ?? ""),
    });
    const locator = typeof ref?.locator === "string" && ref.locator.length > 0 ? ref.locator : undefined;
    if (!locator) return { failed: true, reason: "后端未返回 locator" };
    return {
      locator,
      failed: false,
      ...(typeof ref?.retrievalHint === "string" ? { retrievalHint: ref.retrievalHint } : {}),
      ...(typeof ref?.bytes === "number" ? { bytes: ref.bytes } : {}),
    };
  } catch (error) {
    return { failed: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 裁剪 + 落盘的单一入口参数 */
export interface BudgetWithSpillOptions extends ResultBudgetOptions {
  /** 归属会话 id（缺失时跳过落盘，仍裁剪） */
  sessionId?: string;
  /** 来源工具名（用于落盘命名） */
  toolName?: string;
  /** 建议文件名（缺省由 toolName + label 拼） */
  suggestedName?: string;
}

/** 裁剪 + 落盘的结果（`spillFailed` 便于调用方打日志） */
export interface BudgetWithSpillResult extends ResultBudgetResult {
  spillFailed: boolean;
  spillReason?: string;
}

/**
 * 子代理结果的单一处理入口：判定 → （仅超预算时）落盘取 locator → 裁剪。
 *
 * 未超预算时**不写盘**（避免为短结果付 I/O 与磁盘占用），直接原样返回。
 *
 * @param ctx 插件上下文（用于取 spillStore）
 * @param raw 原始结果文本
 * @param options 预算与落盘参数
 * @returns 裁剪结果 + 落盘状态
 */
export async function budgetResultWithSpill(
  ctx: any,
  raw: string,
  options: BudgetWithSpillOptions,
): Promise<BudgetWithSpillResult> {
  const source = typeof raw === "string" ? raw : "";
  const cap = normalizeMaxChars(options?.maxChars);

  if (source.length <= cap) {
    return {
      text: source,
      fullChars: source.length,
      keptChars: source.length,
      omittedChars: 0,
      truncated: false,
      spillFailed: false,
    };
  }

  const spill = await spillFullText(ctx, {
    sessionId: options?.sessionId,
    text: source,
    toolName: options?.toolName,
    label: options?.label,
    suggestedName: options?.suggestedName,
  });

  const budgeted = applyResultBudget(source, {
    maxChars: cap,
    scope: options?.scope,
    label: options?.label,
    ...(spill.locator === undefined ? {} : { locator: spill.locator }),
    ...(options?.locatorFallback === undefined ? {} : { locatorFallback: options.locatorFallback }),
  });

  return {
    ...budgeted,
    spillFailed: spill.failed,
    ...(spill.reason === undefined ? {} : { spillReason: spill.reason }),
  };
}
