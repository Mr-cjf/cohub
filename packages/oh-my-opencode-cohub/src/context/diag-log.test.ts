// src/context/diag-log.test.ts
// 任务生命周期诊断（diag-log 扩展：TaskDiagRecord 白名单 + appendTaskDiag）单元测试。
//
// 原则：
//   - 不依赖全局 node:fs mock（Wave1 context 组 mock 递归问题在另一组修复）；
//   - 使用真实临时目录最小 fixture（mkdtemp），不触碰真实 HOME / 网络；
//   - 保持原有 ctxDiag 格式/调用兼容：appendCtxDiag 行为不变，task 记录复用同一串行队列。

// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  appendTaskDiag,
  appendCtxDiag,
  flushCtxDiag,
  sanitizeTaskDiagRecord,
  __resetCtxDiagState,
} = await import('./diag-log');

let tmpDir = '';
let logFile = '';

beforeEach(async () => {
  __resetCtxDiagState();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cohub-diag-test-'));
  logFile = path.join(tmpDir, 'task-diag.log');
});

afterAll(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('sanitizeTaskDiagRecord（白名单收窄）', () => {
  it('保留白名单字段，丢弃未知/敏感字段', () => {
    const safe = sanitizeTaskDiagRecord({
      t: 'task',
      callID: 'c1',
      session: 'ses_abc',
      alias: 't1',
      event: 'rate_limit_detected',
      status: 'running',
      retryAttempt: 2,
      retryAfterMs: 5000,
      rateLimitKind: 'rate_limit',
      apiKey: 'sk-secret',
      responseBody: 'secret body',
      headers: { authorization: 'Bearer x' },
    });
    expect(safe).toEqual({
      t: 'task',
      callID: 'c1',
      session: 'ses_abc',
      alias: 't1',
      event: 'rate_limit_detected',
      status: 'running',
      retryAttempt: 2,
      retryAfterMs: 5000,
      rateLimitKind: 'rate_limit',
    });
    const json = JSON.stringify(safe);
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('secret body');
    expect(json).not.toContain('authorization');
  });

  it('超长字符串截断到 64 字符', () => {
    const safe = sanitizeTaskDiagRecord({ t: 'task', alias: 'a'.repeat(200) });
    expect(safe?.alias?.length).toBe(64);
  });

  it('非有限数值与非法枚举被丢弃', () => {
    const safe = sanitizeTaskDiagRecord({
      t: 'task',
      durationMs: 'abc',
      retryAttempt: NaN,
      rateLimitKind: 'weird',
    });
    expect(safe).toEqual({ t: 'task' });
  });

  it('非对象输入返回 null', () => {
    expect(sanitizeTaskDiagRecord('str')).toBeNull();
    expect(sanitizeTaskDiagRecord(null)).toBeNull();
    expect(sanitizeTaskDiagRecord([1, 2])).toBeNull();
  });
});

describe('appendTaskDiag（复用 ctxDiag 串行队列，临时目录落盘）', () => {
  it('写入 JSON 行：白名单字段齐全且无敏感字段', async () => {
    appendTaskDiag(
      {
        t: 'task',
        callID: 'c-1',
        session: 'ses_abc',
        alias: 't1',
        event: 'rate_limit_detected',
        status: 'running',
        retryAttempt: 1,
        retryNextMs: 3000,
        retryAfterMs: 5000,
        rateLimitKind: 'rate_limit',
        lastActivityAt: 123456,
        durationMs: 1000,
        apiKey: 'sk-secret-x',
      },
      logFile,
    );
    await flushCtxDiag();

    const content = await fsp.readFile(logFile, 'utf-8');
    const rec = JSON.parse(content.trim().split('\n')[0]);
    expect(rec.t).toBe('task');
    expect(rec.callID).toBe('c-1');
    expect(rec.rateLimitKind).toBe('rate_limit');
    expect(rec.retryAfterMs).toBe(5000);
    expect(rec.retryAttempt).toBe(1);
    expect(JSON.stringify(rec)).not.toContain('sk-secret-x');
  });

  it('无效输入不产生任何 I/O', async () => {
    appendTaskDiag('garbage', logFile);
    appendTaskDiag(null, logFile);
    await flushCtxDiag();
    await expect(fsp.access(logFile)).rejects.toThrow();
  });

  it('与 ctx 注入诊断共用同一文件同一队列，互不覆盖', async () => {
    appendCtxDiag({ t: 'ctx', session: 's1' }, logFile);
    appendTaskDiag({ t: 'task', callID: 'c-2', event: 'task_started' }, logFile);
    await flushCtxDiag();

    const content = await fsp.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).t).toBe('ctx');
    expect(JSON.parse(lines[1]).t).toBe('task');
  });
});
