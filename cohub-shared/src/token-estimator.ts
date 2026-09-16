/**
 * Token 估算与预算截断工具。
 * 从 oh-my-opencode-cohub/src/context/extractor.ts 逐字搬移。
 * CJK 字符按 1 token，其余按 0.25 token/字符。
 */

/**
 * 估算文本的 token 数。
 * 中文字符（CJK 及东亚表意区）按 1 token/字符，其余字符按 0.25 token/字符。
 */
export function estimateTokens(text: string): number {
  let used = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af);   // 韩文谚文
    used += isCjk ? 1 : 0.25;
  }
  return used;
}

/**
 * 强制 prompt 预算约束。
 * 若 full 的估算 token 数 ≤ maxTokens → 返回 full（完整保留）；
 * 否则 → 返回 base（丢弃全部 CoHub 注入后缀，只保留用户原始 prompt）。
 */
export function enforcePromptBudget(base: string, full: string, maxTokens: number): string {
  if (estimateTokens(full) <= maxTokens) return full;
  return truncateByTokens(base, maxTokens);
}

/**
 * 按 token 预算截断文本。
 * P2-5: 估算规则区分中西文——中文字符（CJK 及东亚表意区）按 1 token/字符，
 * 其余字符按 4 字符 ≈ 1 token（原统一 4 字符/token 对中文低估 2-4 倍）。
 * 仅用于 summary 策略下文件正文裁剪；空文本或 maxTokens<=0 返回空串；
 * 未超预算时原样返回，超预算时保留头部并在末尾追加省略标记。
 */
export function truncateByTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  // 逐字符累计估算 token 数，找到首个超过预算的位置作为截断点
  let used = 0;
  let cut = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);
    used += isCjk ? 1 : 0.25;
    if (used > maxTokens) {
      cut = i;
      break;
    }
  }
  return text.slice(0, cut) + '\n… [正文已按 token 预算截断]';
}