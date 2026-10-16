// src/context/prompt-budget.ts — summary 有界读取的预算换算与 UTF-8 边界工具（纯函数，无 I/O）

/**
 * 单文件有界读取的字节硬上限（每文件 1 MiB）。
 * 目的：防止 tokenBudgetToByteLimit 对极大预算（如 1e9）返回与文件全量同量级的 byteLimit，
 * 导致 Buffer.allocUnsafe 整文件级分配。正常预算（默认 2000 → 16000 字节）远低于此上限，
 * 不受影响；触发 cap 时读取窗口可能不足「预算对应的全部内容」，注入会附加诚实截断标记
 * （见 engine.ts attachTruncatedBodies），并可在配置中改用 summaryReadMode:'full' 恢复旧行为。
 */
export const SUMMARY_READ_MAX_BYTES_PER_FILE = 1024 * 1024;

/**
 * 有界读取的 lookahead 字节数（至少 4 字节，等于 UTF-8 单字符最大字节序列）。
 * 用途：一次性多读 4 字节，用于「判定文件是否超出读取上限」——
 * 若实际读到的字节数 > byteLimit，说明 byteLimit 之后仍有内容，需要诚实提示截断；
 * 同时保证窗口边界处 UTF-8 序列（最长 4 字节）能被完整判定与回退，避免 U+FFFD 与孤立代理项。
 */
export const SUMMARY_READ_LOOKAHEAD_BYTES = 4;

/**
 * 由 token 预算推导可读字节上限。
 *
 * 推导依据（与 shared/token-estimator.ts 的 estimateTokens 对齐，仅只读依赖）：
 * - 非 CJK 按 0.25 token/codeunit → 每 token 至多 4 codeunit（最宽字符率，保证截断点覆盖任何语言）；
 * - UTF-8 单字符 1~4 字节，取平均覆盖 2 字节/codeunit（ASCII 1B、CJK 3B 均被覆盖，ASCII 有 2 倍冗余）。
 * 因此：byteLimit ≈ budgetTokens × 4 codeunit/token × 2 字节/codeunit。
 *
 * 兼容边界（诚实说明，不宣称逐字节等价）：
 * - ASCII / CJK 常规场景：窗口必然覆盖「按预算截断的截断点」，注入结果与旧全量读+截断**等价**；
 * - 纯 emoji 等 4 字节非 CJK 字符：估算为 2 codeunit/token → 1 token = 8 字节，窗口恰好停在预算边界，
 *   不会触发 token 截断（estimate == budget），此时若文件超出上限会附加**读取截断标记**（诚实提示），
 *   且不产生旧 truncateByTokens 在边界切出的孤立 surrogate——这是对旧截断缺陷的修复差异；
 * - 预算极大触发 SUMMARY_READ_MAX_BYTES_PER_FILE 时同样附加读取截断标记，不再宣称与旧行为等价。
 *
 * 数值边界：NaN / ±Infinity / 0 / 负数 → 返回下限 4 字节（安全，不发生不安全 int / Buffer alloc）。
 *
 * @param budgetTokens 单文件 token 预算（调用方已做 max(1, floor(summarizeMaxTokens / files.length)) 均摊）
 * @returns 应读取的字节数上限（至少 4 字节，至多 SUMMARY_READ_MAX_BYTES_PER_FILE）
 */
export function tokenBudgetToByteLimit(budgetTokens: number): number {
  const n = Number(budgetTokens);
  if (!Number.isFinite(n) || n <= 0) return 4;
  const raw = Math.ceil(n * 4 * 2);
  return Math.min(SUMMARY_READ_MAX_BYTES_PER_FILE, Math.max(4, raw));
}

/**
 * 截断 Buffer 到 UTF-8 字符边界：丢弃末尾不完整的多字节序列。
 *
 * 原因：Buffer.toString('utf-8') 会把窗口末尾被切断的多字节序列替换为 U+FFFD（乱码），
 * 有界读取按字节窗口切分后必须先修正边界再解码。
 * 本函数只回退「最后一个可能不完整的序列」，对窗口内部的完整内容不做任何改动。
 */
export function utf8TrimIncomplete(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const last = buf[buf.length - 1];
  if (last < 0x80) return buf; // 末尾是 ASCII → 窗口完整

  // 从末尾向前定位最后一个多字节序列的首字节（跳过 0x80-0xBF 连续字节）
  let i = buf.length - 1;
  while (i > 0 && (buf[i] & 0b1100_0000) === 0b1000_0000) i--;

  const head = buf[i];
  let seqLen = 0;
  if ((head & 0b1110_0000) === 0b1100_0000) seqLen = 2;        // 2 字节序列
  else if ((head & 0b1111_0000) === 0b1110_0000) seqLen = 3;   // 3 字节序列
  else if ((head & 0b1111_1000) === 0b1111_0000) seqLen = 4;   // 4 字节序列
  else return buf; // 孤立连续字节（异常数据），保留原样交由解码层处理

  // 序列完整需要 i + seqLen <= buf.length；不足则整段回退到首字节之前
  if (buf.length - i < seqLen) return buf.subarray(0, i);
  return buf;
}
