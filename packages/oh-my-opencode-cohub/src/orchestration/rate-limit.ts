// src/orchestration/rate-limit.ts
// 限流/网络错误分类器（纯函数，零 I/O，无外部依赖，便于单测）。
//
// 兼容输入形状（按受控深度解析，最多两层：根对象 + SDK `data` 包装）：
//   1. SDK ApiError（@opencode-ai/sdk 1.17.15 实测）：
//      { name: 'APIError', data: { message, statusCode?, isRetryable, responseHeaders?, responseBody? } }
//   2. 日志/事件包装的扁平形状（插件内部 appendLog / event 包装的明确形状）：
//      { statusCode?, isRetryable?, responseHeaders?, responseBody?, message?, cause? }
//
// 红线：
//   - 未知字段（providerID/modelID 等）一律忽略，不参与分类、不进入摘要；
//   - maskedMessage 为固定安全摘要，禁止完整 responseBody / header 值 / 密钥；
//   - isRetryable 仅为信息透传，本模块不发起请求、不排队、不计时重派。

export type RateLimitKind = 'rate_limit' | 'retryable_network' | 'other';

export type RetryAfterSource = 'header-seconds' | 'header-date' | 'body-text' | 'none';

export interface RateLimitInfo {
  kind: RateLimitKind;
  /** 服务端 Retry-After 换算的等待毫秒；缺失/非法/过期/非正数时不提供 */
  retryAfterMs?: number;
  /** Retry-After 来源：header 整数秒 / header HTTP-date / 其它（none） */
  retryAfterSource?: RetryAfterSource;
  /** SDK/宿主字段透传（仅信息，不改变任何宿主重试策略） */
  isRetryable: boolean;
  /** 脱敏后的固定安全摘要：不包含完整 responseBody、任何 header 值或密钥片段 */
  maskedMessage: string;
}

/** 限流特征文本（小写匹配；message 与 responseBody 均参与判定） */
const RATE_LIMIT_TEXT = ['tokens per minute', 'rate limit', 'quota'] as const;

/** 可重试网络错误特征文本（socket/timeout 类；message 与 cause.code 均参与判定） */
const NETWORK_TEXT = ['econnreset', 'socket hang up', 'timeout', 'etimedout'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface NormalizedError {
  statusCode?: number;
  isRetryable: boolean;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  message?: string;
  causeCode?: string;
}

/**
 * 受控深度归一化：只读取白名单字段，根层优先、`data` 包装兜底。
 * 非对象 / null / 数组 → null（不做任何文本特征判定）。
 */
function normalizeError(error: unknown): NormalizedError | null {
  if (!isPlainObject(error)) return null;
  const obj = error as Record<string, unknown>;
  const data = isPlainObject(obj['data']) ? (obj['data'] as Record<string, unknown>) : undefined;

  const pick = (key: string): unknown => {
    if (obj[key] !== undefined) return obj[key];
    if (data && data[key] !== undefined) return data[key];
    return undefined;
  };

  const statusCode = pick('statusCode');
  const isRetryable = pick('isRetryable');
  const headers = pick('responseHeaders');
  const body = pick('responseBody');
  const message = pick('message');
  const cause = pick('cause');

  // headers 单层遍历：只保留 string 值（用于 Retry-After 查找；值本身不进摘要）
  const headersOut: Record<string, string> = {};
  if (isPlainObject(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') headersOut[k] = v;
    }
  }

  const causeCode =
    isPlainObject(cause) && typeof cause['code'] === 'string' ? cause['code'] : undefined;

  return {
    statusCode: typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : undefined,
    isRetryable: typeof isRetryable === 'boolean' ? isRetryable : false,
    responseHeaders: headersOut,
    responseBody: typeof body === 'string' ? body : undefined,
    message: typeof message === 'string' ? message : undefined,
    causeCode,
  };
}

/** 大小写不敏感查找 Retry-After 头 */
function findRetryAfter(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/**
 * 解析 Retry-After（整数秒 / HTTP-date）。
 * - 整数秒 > 0 → retryAfterMs = 秒 * 1000（header-seconds）
 * - HTTP-date 且未来 → retryAfterMs = dateMs - now（header-date）
 * - 缺失 / 非法（如 'abc'）/ 过期 / 0 秒 → 不提供正等待时间（none）
 */
function parseRetryAfter(
  headers: Record<string, string>,
  nowMs: number,
): { retryAfterMs?: number; retryAfterSource: RetryAfterSource } {
  const raw = findRetryAfter(headers);
  if (raw === undefined) return { retryAfterSource: 'none' };

  if (/^\d+$/.test(raw)) {
    const secs = Number(raw);
    if (secs > 0) return { retryAfterMs: secs * 1000, retryAfterSource: 'header-seconds' };
    return { retryAfterSource: 'none' };
  }

  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return { retryAfterSource: 'none' };
  const waitMs = dateMs - nowMs;
  if (waitMs > 0) return { retryAfterMs: waitMs, retryAfterSource: 'header-date' };
  return { retryAfterSource: 'none' };
}

/**
 * 分类限流/网络错误。`now` 为可注入的时间基准（毫秒时间戳，默认 Date.now()），
 * 用于 HTTP-date 型 Retry-After 的确定性解析。
 */
export function classifyRateLimit(error: unknown, now?: number): RateLimitInfo {
  const norm = normalizeError(error);
  if (!norm) {
    return {
      kind: 'other',
      retryAfterSource: 'none',
      isRetryable: false,
      maskedMessage: 'non-object-input',
    };
  }

  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  // 1) 429 是强信号（优先于 isRetryable 字段）
  if (norm.statusCode === 429) {
    const ra = parseRetryAfter(norm.responseHeaders, nowMs);
    return {
      kind: 'rate_limit',
      ...ra,
      isRetryable: norm.isRetryable,
      maskedMessage: 'rate-limit-classified (http-429)',
    };
  }

  // 2) 无状态码时的 TPM / quota 文本特征（message 与 responseBody 均参与）
  const text = [norm.message, norm.responseBody]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join('\n')
    .toLowerCase();
  if (RATE_LIMIT_TEXT.some(t => text.includes(t))) {
    return {
      kind: 'rate_limit',
      retryAfterSource: 'none',
      isRetryable: norm.isRetryable,
      maskedMessage: 'rate-limit-classified (text-signal)',
    };
  }

  // 3) socket / timeout 类可重试网络错误
  const causeText = norm.causeCode?.toLowerCase() ?? '';
  if (
    NETWORK_TEXT.some(t => text.includes(t)) ||
    NETWORK_TEXT.some(t => causeText.includes(t))
  ) {
    return {
      kind: 'retryable_network',
      retryAfterSource: 'none',
      isRetryable: norm.isRetryable,
      maskedMessage: 'retryable-network-error (socket/timeout)',
    };
  }

  // 4) 其余一律 other：不臆测、不推断未知 provider/model
  return {
    kind: 'other',
    retryAfterSource: 'none',
    isRetryable: norm.isRetryable,
    maskedMessage: 'unclassified-error',
  };
}
