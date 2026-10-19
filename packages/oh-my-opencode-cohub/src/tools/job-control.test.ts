// src/tools/job-control.test.ts
// 验证 close_job 精确取消语义（Wave5）：
// - 旧 alias 关闭不发 SDK abort / 不取消复用中的新 job；
// - session 有旧 completed + 新 running：取消只命中新；
// - 两个 active 共享 child：拒绝且不发 SDK abort；
// - 真实 SDK abort 成功才落 cancelled 并回调 onCancelled 一次；
// - SDK error / throw：不标取消、不假成功；
// - 重复调用不二次 abort；未绑定 child 本地取消报告 session_aborted=false；
// - onCancelled 回调异常不引发二次 abort；
// - 取消竞态（SDK abort pending 期间任务被其他路径终结/取消）：
//   返回实际保留状态（completed/errored）而非虚报 cancelled、不重复回调；
//   两个 close 并发：SDK abort 可能多次，取消状态回调总 1 次。
//
// ⚠️ 隔离（Wave5 硬约束：本测试本身不得写真实 stats / 日志）：
// mock.module('node:os') 将 os.homedir() 指向临时 HOME（在 mock 之前捕获全部真实
// os 导出值，避免 live namespace 递归），使 TaskTracker 的 STATS_FILE 与 utils/log
// 的 LOG_DIR 顶层常量都落在临时目录内；测试用 mock SDK client（无真实网络/服务），
// 不触碰真实 ~/.local stats 与真实会话。
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供

import { mock, describe, test, expect, afterAll } from 'bun:test';
import * as realFs from 'node:fs';
import * as realOs from 'node:os';
import * as path from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// 隔离 HOME：mock os.homedir → 临时目录。捕获全部真实 os 导出值（mock 前执行，
// 无 live namespace 引用、无递归）；动态 import 保证 tracker/job-control 的
// 模块顶层常量（STATS_FILE / LOG_DIR）在 homedir 重定向后求值。
// ───────────────────────────────────────────────────────────────────────────
const osExports = { ...realOs };
let tempHome = '';
mock.module('node:os', () => ({
  ...osExports,
  homedir: () => tempHome,
}));

const tmpRoot = osExports.tmpdir();
tempHome = realFs.mkdtempSync(path.join(tmpRoot, 'cohub-jc-home-'));

const { TaskTracker } = await import('../task-manager/tracker');
const { createCloseJobTool } = await import('./job-control');

afterAll(() => {
  try {
    realFs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // 临时 HOME 清理失败：由系统临时目录回收
  }
});

// ===========================================================================
// Helpers
// ===========================================================================

/** mock SDK client：仅提供 session.abort（ThrowOnError=false 形状：{ data?, error? }） */
function makeCtx(abort: () => Promise<{ data?: unknown; error?: unknown }>) {
  return { client: { session: { abort } } };
}

function makeToolContext(agent = 'co-orchestrator') {
  return { sessionID: 'ses_parent', agent };
}

/** 执行 close_job 并解析 JSON 返回 */
async function runClose(jobTools: ReturnType<typeof createCloseJobTool>, taskId: string, agent = 'co-orchestrator') {
  return JSON.parse(await jobTools.close_job.execute({ task_id: taskId }, makeToolContext(agent)));
}

/** 注册一个后台任务（携带 sessionId 与 callID） */
function registerBg(
  tracker: TaskTracker,
  sessionId: string,
  opts: { parent?: string; description?: string } = {},
): string {
  const parent = opts.parent ?? 'P';
  return tracker.registerBeforeTask(
    parent,
    {
      subagent_type: 'co-fixer',
      description: opts.description ?? 'bg',
      task_id: sessionId,
      background: true,
    },
    'c-' + Math.random().toString(36).slice(2, 8),
  );
}

/** 追踪 onCancelled / onClosed 调用记录 */
function makeCallbacks() {
  const calls: { kind: 'cancelled' | 'closed'; alias?: string }[] = [];
  return {
    calls,
    onCancelled: (alias: string) => {
      calls.push({ kind: 'cancelled', alias });
    },
    onClosed: () => {
      calls.push({ kind: 'closed' });
    },
  };
}

/**
 * 可控 SDK abort gate：每次 abort() 调用返回一个挂起的 promise，resolver 存入数组，
 * resolveAll 由测试显式放行——**不依赖 sleep**，用于精确构造「SDK abort pending 期间
 * 任务被其他路径终结 / 并发 close」的竞态时序。
 */
function makeAbortGate() {
  const resolvers: Array<(v: { data?: unknown; error?: unknown }) => void> = [];
  return {
    abort: () => new Promise<{ data?: unknown; error?: unknown }>((r) => resolvers.push(r)),
    resolvers,
    resolveAll: (v: { data?: unknown; error?: unknown }) => {
      for (const r of resolvers) r(v);
    },
  };
}

// ===========================================================================
// close_job 精确取消语义
// ===========================================================================
describe('close_job：精确取消（不中止真实复用 session / 不假成功）', () => {
  test('旧 alias 命中已终态：不发 SDK abort、不取消复用中的新 job、不触发 onCancelled', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const oldAlias = registerBg(tracker, 'ses_shared');
    // 真实复用顺序：先登记旧调用并在其唯一 running 时终结为历史，然后才登记复用同 session 的新调用
    tracker.finalizeByCall('P', tracker.getJobByAlias(oldAlias)!.callID, 'ses_shared', 'completed');
    const newAlias = registerBg(tracker, 'ses_shared');

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('ses_shared'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, oldAlias);

    // 幂等返回：不 abort 真实复用 session、不取消新 job
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('idempotent');
    expect(result.session_aborted).toBe(false);
    expect(abortCalls).toHaveLength(0);
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
    expect(tracker.getJobByAlias(newAlias)!.status).toBe('running');
  });

  test('session 有旧 completed + 新 running：取消只命中新（旧历史不抢当前）', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const oldAlias = registerBg(tracker, 'ses_reuse');
    // 真实复用顺序：先登记旧调用并在其唯一 running 时终结为历史，然后才登记复用同 session 的新调用
    tracker.finalizeByCall('P', tracker.getJobByAlias(oldAlias)!.callID, 'ses_reuse', 'completed');
    const newAlias = registerBg(tracker, 'ses_reuse');

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('ses_reuse'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, 'ses_reuse');

    // 命中唯一 active（新 job），真实 abort 该 session，新 job 落 cancelled
    expect(result.ok).toBe(true);
    expect(result.alias).toBe(newAlias);
    expect(result.session_aborted).toBe(true);
    expect(abortCalls).toEqual(['ses_reuse']);
    expect(tracker.getJobByAlias(newAlias)!.status).toBe('cancelled');
    expect(tracker.getJobByAlias(oldAlias)!.status).toBe('completed'); // 旧不变
    // 首次真实取消落地 → onCancelled 以捕获 alias 回调一次
    expect(cb.calls).toEqual([{ kind: 'cancelled', alias: newAlias }, { kind: 'closed' }]);
  });

  test('两个 active 共享 child：拒绝且不发 SDK abort、不批量取消', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const aliasA = registerBg(tracker, 'ses_amb');
    const aliasB = registerBg(tracker, 'ses_amb');

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('ses_amb'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, 'ses_amb');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous');
    expect(abortCalls).toHaveLength(0);
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
    expect(tracker.getJobByAlias(aliasA)!.status).toBe('running');
    expect(tracker.getJobByAlias(aliasB)!.status).toBe('running');
  });

  test('真实 abort 成功：落 cancelled、回调 alias 一次、onClosed 兼容', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_ok');

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('ses_ok'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, alias);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.session_aborted).toBe(true);
    expect(result.alias).toBe(alias);
    expect(abortCalls).toEqual(['ses_ok']);
    expect(tracker.getJobByAlias(alias)!.status).toBe('cancelled');
    expect(cb.calls).toEqual([{ kind: 'cancelled', alias }, { kind: 'closed' }]);
  });

  test('SDK abort 返回 error：不落 cancelled、不触发 onCancelled、不假成功', async () => {
    const tracker = new TaskTracker();
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_err');

    const jobTools = createCloseJobTool(makeCtx(async () => ({ data: {}, error: { message: 'abort rejected' } })), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, alias);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('abort_failed');
    expect(result.session_aborted).toBe(false);
    expect(tracker.getJobByAlias(alias)!.status).toBe('running'); // 未标取消
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
  });

  test('SDK abort 抛出网络异常：不落 cancelled、不触发 onCancelled', async () => {
    const tracker = new TaskTracker();
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_throw');

    const jobTools = createCloseJobTool(makeCtx(async () => { throw new Error('network down'); }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, alias);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('abort_failed');
    expect(result.session_aborted).toBe(false);
    expect(tracker.getJobByAlias(alias)!.status).toBe('running');
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
  });

  test('重复调用：不二次 abort、不重复回调', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_dup');

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('ses_dup'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const first = await runClose(jobTools, alias);
    expect(first.ok).toBe(true);
    const second = await runClose(jobTools, alias);

    expect(second.ok).toBe(true);
    expect(second.reason).toBe('idempotent');
    expect(second.session_aborted).toBe(false); // 已终态：不再 abort
    expect(abortCalls).toHaveLength(1); // 只 abort 一次
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(1); // 只回调一次
  });

  test('未绑定 child：本地取消成功但报告 session_aborted=false，不 abort 任意会话', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    // 无 task_id 注册 → sessionId 为空
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'no-child', background: true });

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('should-not'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, alias);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.session_aborted).toBe(false);
    expect(abortCalls).toHaveLength(0); // 未绑定 child：不发 SDK abort
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(1); // 本地取消落地回调一次
  });

  test('未知 taskId：no-match，不 abort 不回调', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();

    const jobTools = createCloseJobTool(makeCtx(async () => { abortCalls.push('x'); return { data: {}, error: undefined }; }), tracker, cb.onClosed, cb.onCancelled);

    const result = await runClose(jobTools, 'no-such-alias');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-match');
    expect(abortCalls).toHaveLength(0);
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
  });

  test('权限守卫：非 co-orchestrator 抛错拒绝', async () => {
    const tracker = new TaskTracker();
    const alias = registerBg(tracker, 'ses_perm');
    const jobTools = createCloseJobTool(makeCtx(async () => ({ data: {}, error: undefined })), tracker);

    await expect(jobTools.close_job.execute({ task_id: alias }, { sessionID: 'ses_parent', agent: 'co-council' })).rejects.toThrow();
  });

  test('权限放行：co-orchestrator-gpt 调用 close_job 不被权限拒绝', async () => {
    const tracker = new TaskTracker();
    const alias = registerBg(tracker, 'ses_perm_gpt');
    const jobTools = createCloseJobTool(makeCtx(async () => ({ data: {}, error: undefined })), tracker);

    const result = await runClose(jobTools, alias, 'co-orchestrator-gpt');

    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.session_aborted).toBe(true);
    expect(tracker.getJobByAlias(alias)!.status).toBe('cancelled');
  });

  test('onCancelled 回调抛错：不影响取消结果、不引发二次 abort', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const alias = registerBg(tracker, 'ses_cb');

    const jobTools = createCloseJobTool(
      makeCtx(async () => { abortCalls.push('ses_cb'); return { data: {}, error: undefined }; }),
      tracker,
      undefined,
      () => { throw new Error('callback boom'); },
    );

    const result = await runClose(jobTools, alias);

    // 取消成功返回（回调异常被吞），abort 只发生一次（回调异常不引发二次 abort）
    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(abortCalls).toEqual(['ses_cb']);
  });

  test('竞态：SDK abort pending 期间 job 被 idle 完成 → 返回实际 completed、不虚报 cancelled、不回调', async () => {
    const tracker = new TaskTracker();
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_gate_c');
    const gate = makeAbortGate();

    const jobTools = createCloseJobTool(makeCtx(gate.abort), tracker, cb.onClosed, cb.onCancelled);
    const pendingRun = runClose(jobTools, alias); // 不 await：execute 挂起在 abort gate

    // abort pending 期间：任务被其他路径（idle 收尾）终结为 completed
    tracker.finalizeByCall('P', tracker.getJobByAlias(alias)!.callID, 'ses_gate_c', 'completed');
    gate.resolveAll({ data: {}, error: undefined });

    const result = await pendingRun;

    // 任务结局真实：completed（不虚报 cancelled）；SDK abort 成功事实字段保留
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.reason).toBe('idempotent');
    expect(result.session_aborted).toBe(true);
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0); // 不重复回调
  });

  test('竞态：SDK abort pending 期间 job 被终结为 errored → 返回实际 errored、不回调', async () => {
    const tracker = new TaskTracker();
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_gate_e');
    const gate = makeAbortGate();

    const jobTools = createCloseJobTool(makeCtx(gate.abort), tracker, cb.onClosed, cb.onCancelled);
    const pendingRun = runClose(jobTools, alias);

    // abort pending 期间：任务被其他路径终结为 errored
    tracker.finalizeByCall('P', tracker.getJobByAlias(alias)!.callID, 'ses_gate_e', 'errored');
    gate.resolveAll({ data: {}, error: undefined });

    const result = await pendingRun;

    expect(result.ok).toBe(true);
    expect(result.status).toBe('errored'); // 实际保留状态
    expect(result.reason).toBe('idempotent');
    expect(result.session_aborted).toBe(true);
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(0);
  });

  test('两个 close 并发同一 job：SDK abort 可能两次，取消状态回调总 1 次、返回实际 cancelled', async () => {
    const tracker = new TaskTracker();
    const abortCalls: string[] = [];
    const cb = makeCallbacks();
    const alias = registerBg(tracker, 'ses_concurrent');
    const gate = makeAbortGate();

    const jobTools = createCloseJobTool(
      makeCtx(() => { abortCalls.push('ses_concurrent'); return gate.abort(); }),
      tracker,
      cb.onClosed,
      cb.onCancelled,
    );

    const p1 = runClose(jobTools, alias);
    const p2 = runClose(jobTools, alias);
    // 两个 execute 都已同步挂起在各自 abort gate（resolve 时机由测试控制，不依赖 sleep）
    gate.resolveAll({ data: {}, error: undefined });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // 双方结局一致 cancelled（一方完成本次 running→cancelled，另一方幂等读取同一 cancelled）
    expect([r1.status, r2.status]).toEqual(['cancelled', 'cancelled']);
    expect([r1.reason, r2.reason].sort()).toEqual(['idempotent', 'ok']);
    expect(abortCalls.length).toBeGreaterThanOrEqual(1); // SDK abort 至少一次（不强行承诺单次）
    expect(tracker.getJobByAlias(alias)!.status).toBe('cancelled');
    expect(cb.calls.filter((c) => c.kind === 'cancelled')).toHaveLength(1); // 取消状态回调总 1 次
  });
});
