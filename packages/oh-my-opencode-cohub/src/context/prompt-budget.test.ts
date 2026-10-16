// src/context/prompt-budget.test.ts
// 验证有界读取预算换算与 UTF-8 边界修正（纯函数）
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供

import {
  tokenBudgetToByteLimit,
  utf8TrimIncomplete,
  SUMMARY_READ_MAX_BYTES_PER_FILE,
  SUMMARY_READ_LOOKAHEAD_BYTES,
} from './prompt-budget';

// ===========================================================================
// 常量导出
// ===========================================================================
describe('有界读取常量', () => {
  test('每文件读取硬上限 = 1 MiB（防极大预算整文件级 Buffer alloc）', () => {
    expect(SUMMARY_READ_MAX_BYTES_PER_FILE).toBe(1024 * 1024);
  });

  test('lookahead = 4 字节（UTF-8 最长单字符序列，保证能判定截断）', () => {
    expect(SUMMARY_READ_LOOKAHEAD_BYTES).toBe(4);
  });
});

// ===========================================================================
// tokenBudgetToByteLimit
// ===========================================================================
describe('tokenBudgetToByteLimit', () => {
  test('默认预算 2000 tokens → 16KB（2000 × 4 codeunit/token × 2 字节）', () => {
    expect(tokenBudgetToByteLimit(2000)).toBe(16000);
  });

  test('均摊小预算 16 tokens → 128 字节', () => {
    expect(tokenBudgetToByteLimit(16)).toBe(128);
  });

  test('预算 0 或负数 → 至少 4 字节下限', () => {
    expect(tokenBudgetToByteLimit(0)).toBe(4);
    expect(tokenBudgetToByteLimit(-5)).toBe(4);
  });

  test('NaN/±Infinity → 至少 4 字节下限（不抛错，不发生不安全 alloc）', () => {
    expect(tokenBudgetToByteLimit(Number.NaN)).toBe(4);
    expect(tokenBudgetToByteLimit(Number.POSITIVE_INFINITY)).toBe(4);
    expect(tokenBudgetToByteLimit(Number.NEGATIVE_INFINITY)).toBe(4);
  });

  test('恰好触顶：131072 tokens × 8 = 1048576 = 1 MiB（不超 cap）', () => {
    expect(tokenBudgetToByteLimit(131072)).toBe(1048576);
  });

  test('超 cap：200000 tokens → 截到 1 MiB（不按预算全量分配）', () => {
    expect(tokenBudgetToByteLimit(200000)).toBe(SUMMARY_READ_MAX_BYTES_PER_FILE);
  });

  test('极端预算 1e9 tokens → 截到 1 MiB（硬上限生效）', () => {
    expect(tokenBudgetToByteLimit(1e9)).toBe(SUMMARY_READ_MAX_BYTES_PER_FILE);
  });
});

// ===========================================================================
// utf8TrimIncomplete
// ===========================================================================
describe('utf8TrimIncomplete', () => {
  test('空 Buffer 原样返回', () => {
    expect(utf8TrimIncomplete(Buffer.alloc(0)).length).toBe(0);
  });

  test('末尾是 ASCII → 完整，原样返回', () => {
    const buf = Buffer.from('hello world');
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed).toBe(buf);
    expect(trimmed.toString('utf-8')).toBe('hello world');
  });

  test('完整中文序列（3 字节）保留', () => {
    const buf = Buffer.from('中文测试');
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed.toString('utf-8')).toBe('中文测试');
  });

  test('末尾被切断的 3 字节序列被整体回退（不产生 U+FFFD）', () => {
    // '中' = E4 B8 AD；窗口只含前 2 字节 → 应整体回退
    const buf = Buffer.from([0x61, 0xe4, 0xb8]); // 'a' + 半个'中'
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed.toString('utf-8')).toBe('a');
  });

  test('整个窗口只剩半个多字节序列 → 回退为空', () => {
    const buf = Buffer.from([0xe4, 0xb8]); // 半个'中'
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed.length).toBe(0);
  });

  test('4 字节序列被切断 1 字节 → 回退该序列', () => {
    // U+1F600 😀 = F0 9F 98 80；窗口含前 3 字节 → 回退
    const buf = Buffer.from([0x66, 0xf0, 0x9f, 0x98]); // 'f' + 3/4 的 emoji
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed.toString('utf-8')).toBe('f');
  });

  test('多字节序列完整且在末尾 → 保留', () => {
    const buf = Buffer.from('测试');
    const trimmed = utf8TrimIncomplete(buf);
    expect(trimmed.toString('utf-8')).toBe('测试');
  });
});
