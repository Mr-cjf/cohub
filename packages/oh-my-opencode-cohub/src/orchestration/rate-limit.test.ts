// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
// src/orchestration/rate-limit.test.ts
//
// 限流分类器测试（Wave3 激活）：纯函数模块 ./rate-limit 已实现。
//   1. 表驱动矩阵 RATE_LIMIT_CASES：逐条断言 classifyRateLimit 的 kind / retryAfterMs /
//      maskedMessage 脱敏（矩阵 17 case 全部从 test.todo 激活为真实断言，case 与字段一字未改）；
//   2. 补充断言：SDK 官方 { name:'APIError', data:{...} } 包装形状、可注入固定 now 验证 HTTP-date、
//      403 认证不误判。
//
// 断言约定：
//   - expectedRetryAfter '>0'：retryAfterMs 必须存在且 > 0；
//   - expectedRetryAfter 'none'：retryAfterMs 必须为 undefined（缺失/非法/过期不提供正等待）；
//   - Retry-After 为整数秒时额外精确断言 retryAfterMs = 秒 * 1000；
//   - maskedMessage 不得包含 mustNotContain 片段（密钥/完整 body 等）。

import { describe, it, expect, test } from 'bun:test';
import { classifyRateLimit } from './rate-limit';

/** 限流/网络错误分类的期望类别 */
export type RateLimitCaseKind = 'rate_limit' | 'retryable_network' | 'other';

export interface RateLimitCase {
  /** 用例名（同时作为测试标题） */
  name: string;
  /** 输入：兼容 SDK ApiError 的 unknown 结构（允许字符串/null/非对象等异常输入） */
  input: unknown;
  /** 期望分类 */
  expectedKind: RateLimitCaseKind;
  /** retryAfterMs 语义：'none'= 不等待（缺失/非法/过期）；'>0' = 应产生有限等待毫秒数 */
  expectedRetryAfter: 'none' | '>0';
  /** 脱敏要求：maskedMessage 不得包含的片段（密钥/完整 responseBody 等） */
  mustNotContain?: string[];
  /** 说明（优先级约定 / 边界语义） */
  note: string;
}

/**
 * 表驱动 case 矩阵（输入一律按 unknown 传递，模拟真实运行时 error 对象未经过类型收窄）。
 */
export const RATE_LIMIT_CASES: RateLimitCase[] = [
  {
    name: 'statusCode 429 + Retry-After 整数秒 → rate_limit，等待 5s',
    input: {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { 'retry-after': '5' },
      responseBody: 'rate limited',
    },
    expectedKind: 'rate_limit',
    expectedRetryAfter: '>0',
    mustNotContain: ['rate limited'], // 完整 responseBody 不得进入脱敏摘要
    note: 'Retry-After 整数秒 → retryAfterMs = 5000，来源 header-seconds',
  },
  {
    name: 'statusCode 429 + 无 Retry-After → rate_limit，不等待',
    input: { statusCode: 429, isRetryable: true, responseHeaders: {}, responseBody: undefined },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    note: '429 是强信号；无 Retry-After 时 retryAfterMs 缺省（由调用方用默认退避）',
  },
  {
    name: 'statusCode 429 + Retry-After HTTP-date（未来）→ rate_limit，等待至该时间',
    input: {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    },
    expectedKind: 'rate_limit',
    expectedRetryAfter: '>0',
    note: 'HTTP-date 解析为 Date.now() 差值；未来时间 → retryAfterMs > 0，来源 header-date',
  },
  {
    name: 'statusCode 429 + Retry-After 非法值 → rate_limit，不抛错且不等待',
    input: { statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after': 'abc' } },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    note: '非法 Retry-After 必须静默忽略（不抛错、不 NaN、不无限等待）',
  },
  {
    name: 'statusCode 429 + Retry-After 过期 HTTP-date → rate_limit，不等待',
    input: {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { 'retry-after': 'Mon, 01 Jan 2020 00:00:00 GMT' },
    },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    note: '过期时间视为可立即重试（retryAfterMs 缺省/0），由调用方退避兜底',
  },
  {
    name: '无状态码 + message 含 TPM 文本 → rate_limit',
    input: { statusCode: undefined, isRetryable: true, message: 'Tokens per minute limit exceeded' },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    note: '无状态码时按 TPM/rate-limit 特征文本判定（tokens per minute / rate limit / quota）',
  },
  {
    name: '无状态码 + responseBody 含 quota 文本 → rate_limit',
    input: { statusCode: undefined, isRetryable: true, responseBody: 'You have exceeded your quota. Rate limit: 20 req/min.' },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    mustNotContain: ['quota', 'Rate limit'],
    note: 'body 文本也可作为判定来源；但完整 body 不得进入脱敏摘要',
  },
  {
    name: 'statusCode 429 + responseBody 含 API 密钥 → rate_limit 且脱敏密钥',
    input: {
      statusCode: 429,
      isRetryable: true,
      responseBody: 'apiKey=sk-1234567890abcdef quota exceeded',
    },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    mustNotContain: ['sk-1234567890abcdef'],
    note: '脱敏红线：任何密钥片段不得出现在 maskedMessage/日志',
  },
  {
    name: 'responseHeaders 含 authorization 密钥 → 摘要脱敏',
    input: {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { authorization: 'Bearer sk-secret-token-xyz', 'retry-after': '3' },
    },
    expectedKind: 'rate_limit',
    expectedRetryAfter: '>0',
    mustNotContain: ['sk-secret-token-xyz'],
    note: '脱敏覆盖 header 值；分类仍依据 429 与 Retry-After',
  },
  {
    name: 'cause 为 socket 错误（ECONNRESET）→ retryable_network，非 rate_limit',
    input: { statusCode: undefined, isRetryable: true, message: 'read ECONNRESET', cause: { code: 'ECONNRESET' } },
    expectedKind: 'retryable_network',
    expectedRetryAfter: 'none',
    note: 'socket 错误与限流区分：message/cause 含 ECONNRESET/socket hang up 等网络特征 → 网络类',
  },
  {
    name: 'message 含 timeout → retryable_network，非 rate_limit',
    input: { statusCode: undefined, isRetryable: true, message: 'fetch timeout after 120s' },
    expectedKind: 'retryable_network',
    expectedRetryAfter: 'none',
    note: 'timeout 归网络类；不得误判为 rate_limit（无 429/TPM 特征）',
  },
  {
    name: '未知错误 statusCode 500 → other，不推断',
    input: { statusCode: 500, isRetryable: false, message: 'internal server error' },
    expectedKind: 'other',
    expectedRetryAfter: 'none',
    note: '非 429 且无限流文本 → other；isRetryable 由 SDK 字段透传，分类器不臆测',
  },
  {
    name: '无特征 message（isRetryable=true）→ other，不推断为限流',
    input: { statusCode: undefined, isRetryable: true, message: 'something went wrong' },
    expectedKind: 'other',
    expectedRetryAfter: 'none',
    note: 'isRetryable=true 不等于限流；无 429/TPM/socket/timeout 特征一律 other',
  },
  {
    name: '非对象输入（字符串）→ other，不抛错',
    input: 'rate limit happened',
    expectedKind: 'other',
    expectedRetryAfter: 'none',
    note: 'unknown 输入须先做形状收窄；裸字符串不按文本特征判定（无 ApiError 结构）',
  },
  {
    name: 'null 输入 → other，不抛错',
    input: null,
    expectedKind: 'other',
    expectedRetryAfter: 'none',
    note: 'null/undefined 输入静默返回 other（不抛 TypeError）',
  },
  {
    name: '429 + isRetryable=false → 仍 rate_limit（429 优先于 isRetryable）',
    input: { statusCode: 429, isRetryable: false, responseHeaders: {} },
    expectedKind: 'rate_limit',
    expectedRetryAfter: 'none',
    note: '优先级约定：statusCode=429 是强信号，优先于 isRetryable 字段',
  },
  {
    name: '输入混入 providerID/modelID（SDK 无此字段）→ 忽略未知字段，不推断 provider/model',
    input: {
      statusCode: undefined,
      isRetryable: true,
      message: 'x',
      providerID: 'openai',
      modelID: 'gpt-4o',
    },
    expectedKind: 'other',
    expectedRetryAfter: 'none',
    mustNotContain: ['openai', 'gpt-4o'],
    note: 'ApiError 无 providerID/modelID；分类器不得把未知字段当特征，摘要也不得输出它们',
  },
];

/** 固定 now：HTTP-date 用例使用可注入时间基准，避免依赖真实时钟 */
const FIXED_NOW = Date.parse('2026-10-16T00:00:00Z');

/** 从输入中提取整数秒 Retry-After（用于精确毫秒断言；未命中返回 null） */
function retryAfterSeconds(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const headers = (input as Record<string, unknown>)['responseHeaders'];
  if (typeof headers !== 'object' || headers === null) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after' && typeof v === 'string' && /^\d+$/.test(v.trim())) {
      return Number(v.trim());
    }
  }
  return null;
}

describe('rate-limit 分类器（表驱动矩阵激活）', () => {
  for (const c of RATE_LIMIT_CASES) {
    test(
      c.name +
      ' → ' + c.expectedKind +
      (c.expectedRetryAfter === '>0' ? '（应等待）' : '（不应等待）'),
      () => {
        const info = classifyRateLimit(c.input, FIXED_NOW);
        expect(info.kind).toBe(c.expectedKind);

        if (c.expectedRetryAfter === '>0') {
          expect(info.retryAfterMs).toBeDefined();
          expect(info.retryAfterMs!).toBeGreaterThan(0);
        } else {
          expect(info.retryAfterMs).toBeUndefined();
        }

        for (const frag of c.mustNotContain ?? []) {
          expect(info.maskedMessage).not.toContain(frag);
        }

        // 整数秒 Retry-After → 精确毫秒（如 '5' → 5000）
        const secs = retryAfterSeconds(c.input);
        if (secs !== null) expect(info.retryAfterMs).toBe(secs * 1000);
      },
    );
  }
});

describe('rate-limit 分类器（SDK 官方包装形状与可注入 now）', () => {
  it('识别 SDK ApiError { name:"APIError", data:{...} } 的 429', () => {
    const info = classifyRateLimit({
      name: 'APIError',
      data: {
        message: 'rate limited',
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { 'retry-after': '2' },
      },
    });
    expect(info.kind).toBe('rate_limit');
    expect(info.retryAfterMs).toBe(2000);
    expect(info.retryAfterSource).toBe('header-seconds');
    expect(info.maskedMessage).not.toContain('rate limited');
  });

  it('识别 SDK data.message 中的 TPM 文本', () => {
    const info = classifyRateLimit({
      name: 'APIError',
      data: { message: 'Tokens per minute limit exceeded', isRetryable: true },
    });
    expect(info.kind).toBe('rate_limit');
  });

  it('now 注入：同一 HTTP-date 在 now 前后结果不同', () => {
    const date = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const input = { statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after': date } };
    const before = Date.parse('2026-10-16T00:00:00Z');
    const after = Date.parse('2026-10-22T00:00:00Z');
    expect(classifyRateLimit(input, before).retryAfterMs).toBeGreaterThan(0);
    expect(classifyRateLimit(input, after).retryAfterMs).toBeUndefined();
  });

  it('403 认证错误 → other，不误判限流', () => {
    const info = classifyRateLimit({ statusCode: 403, isRetryable: false, message: 'unauthorized' });
    expect(info.kind).toBe('other');
    expect(info.isRetryable).toBe(false);
  });
});
