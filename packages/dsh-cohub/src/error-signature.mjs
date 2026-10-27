// src/error-signature.mjs —— 错误签名归一化（零依赖共用模块）
//
// 供运行时（env-signatures / delegate）与会话审计脚本（scripts/audit-session.mjs）共用同一套算法，
// 避免两处各写一份、口径漂移。
//
// 设计要点：
//   - 纯 ESM，零 import：脚本侧「仅使用 Node 内置模块」的约束不受影响；
//   - 取源优先用结构（tool/result 的 data.error / data.message.content），无结构时才退回文本；
//   - 数字归一（1234 → #）默认开启，用于「同类错误」聚合；需要区分度的场景（停滞检测）
//     显式传 { digits: 'keep' }。
//
// 类型声明见伴生文件 error-signature.d.mts。

/** 默认选项 */
const DEFAULT_OPTS = Object.freeze({ digits: '#', maxLen: 240, prefix: 'err:' });

/**
 * 从 ContentBlock 数组提取文本（与 src/text-utils.ts 的 contentText 同口径，
 * 但多块用 \n 连接；此处内联实现以保持零依赖）。
 * @param {unknown} output
 * @returns {string}
 */
function blocksText(output) {
  if (!Array.isArray(output)) return '';
  const parts = [];
  for (const b of output) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * 归一化错误签名。
 * @param {unknown} data 错误文本（string）或 tool/result 的 data（object）
 * @param {{ digits?: '#' | 'keep', maxLen?: number, prefix?: string }} [opts]
 * @returns {string | null} 无法提取时返回 null
 */
export function normalizeErrorSignature(data, opts) {
  const digits = opts && opts.digits === 'keep' ? 'keep' : DEFAULT_OPTS.digits;
  const maxLen = opts && typeof opts.maxLen === 'number' && Number.isFinite(opts.maxLen)
    ? opts.maxLen
    : DEFAULT_OPTS.maxLen;
  const prefix = opts && typeof opts.prefix === 'string' ? opts.prefix : DEFAULT_OPTS.prefix;

  // 数字归一仅在 digits === '#' 时执行；digits === 'keep' 完全跳过（保留数值区分度）
  const finish = (text) => {
    const normalized = digits === '#' ? String(text).replace(/\d+/g, '#') : String(text);
    const body = normalized.slice(0, maxLen);
    return prefix + body;
  };

  // 1) 文本分支：首行 → 去行首 "Error: " → 归一数字 → 截断 → 前缀
  if (typeof data === 'string') {
    const first = data.split(/\r?\n/)[0].trim().replace(/^Error:\s*/, '');
    if (!first) return null;
    return finish(first);
  }

  if (!data || typeof data !== 'object') return null;

  // 2) 结构优先分支
  const err = /** @type {any} */ (data).error;
  let text = '';
  if (typeof err === 'string' && err.trim()) {
    text = err.trim();
  } else if (err && typeof err === 'object') {
    const msg = typeof err.message === 'string' ? err.message : '';
    const code = typeof err.code === 'string' ? err.code : '';
    if (msg || code) text = (code ? code + ' ' : '') + msg;
  } else {
    text = blocksText(/** @type {any} */ (data).message && /** @type {any} */ (data).message.content);
  }

  const trimmed = String(text).trim();
  if (!trimmed) {
    const isError = (/** @type {any} */ (data).message && /** @type {any} */ (data).message.isError === true)
      || /** @type {any} */ (data).isError === true;
    return isError ? prefix + 'unknown' : null;
  }
  return finish(trimmed);
}
