// src/orchestration/scheduler.test.ts
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
// TDD: Scheduler — 按 maxConcurrency + per-agent 限流调度

import { describe, it, expect, beforeEach } from 'bun:test';
import { Scheduler } from './scheduler';
import { OrchestrationEngine } from './engine';
import { ContractManager } from './contract';
import { RetryManager } from './retry';

describe('Scheduler', () => {
  let engine: OrchestrationEngine;
  let scheduler: Scheduler;

  beforeEach(() => {
    engine = new OrchestrationEngine(new ContractManager(), new RetryManager());
    scheduler = new Scheduler(engine, 3);  // maxConcurrency=3
  });

  it('should dispatch at most maxConcurrency tasks', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-explorer', '搜索2');
    engine.registerTask('t3', 'co-explorer', '搜索3');
    engine.registerTask('t4', 'co-explorer', '搜索4');
    const dispatched = scheduler.dispatch(0);
    expect(dispatched.length).toBe(3);
  });

  it('should not dispatch more than available slots', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-explorer', '搜索2');
    const d1 = scheduler.dispatch(0);
    expect(d1.length).toBe(2);
    const d2 = scheduler.dispatch(2);  // 2 正在运行，可用=1
    expect(d2.length).toBe(0);
  });

  it('should not dispatch a task that was already dispatched', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    const d1 = scheduler.dispatch(0);
    expect(d1).toContain('t1');
    const d2 = scheduler.dispatch(0);
    expect(d2).not.toContain('t1');
  });

  // ===== 生命周期状态回归（首期：生产不自动 dispatch，派发/释放均为显式） =====

  it('should not advance task lifecycle when dispatching (no terminal evidence)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    scheduler.dispatch(0);
    // 派发不等于启动也不等于成功：无终态证据时任务保持 ready
    expect(engine.getState('t1')).toBe('ready');
  });

  it('should not re-dispatch a failed task unless explicitly released', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    const d1 = scheduler.dispatch(0);
    expect(d1).toContain('t1');
    engine.transition('t1', 'running');
    engine.transition('t1', 'failed');
    // 引擎状态变化不自动释放派发记录：失败后不触发第二次 dispatch
    const d2 = scheduler.dispatch(0);
    expect(d2).not.toContain('t1');
  });

  it('should re-dispatch after explicit markFailed (release is explicit)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    scheduler.dispatch(0);
    scheduler.markFailed('t1');
    const d2 = scheduler.dispatch(0);
    expect(d2).toContain('t1');
  });

  it('should not re-dispatch a task retried to pending (native retry is observation)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    const d1 = scheduler.dispatch(0);
    expect(d1).toContain('t1');
    engine.transition('t1', 'running');
    engine.transition('t1', 'failed');
    scheduler.markFailed('t1');
    engine.transition('t1', 'pending');  // 重试决策的观测结果
    // 引擎不会把 pending 自动推进到 ready：重试只被记录，不会自动触发第二次 dispatch
    const d2 = scheduler.dispatch(0);
    expect(d2).not.toContain('t1');
  });

  it('engine lifecycle event on failure does not trigger automatic re-dispatch', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    scheduler.dispatch(0);
    // 原生事件经安全适配入口映射：running → failed 只反映宿主演进
    expect(engine.applyLifecycleEvent('t1', 'running').reason).toBe('applied');
    expect(engine.applyLifecycleEvent('t1', 'failed').reason).toBe('applied');
    // 失败不激活任何自动重派：dispatched 记录保持持有，下一次 dispatch 不含 t1
    const d2 = scheduler.dispatch(0);
    expect(d2).not.toContain('t1');
  });

  it('contradictory terminal event does not tamper engine or scheduler state', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    scheduler.dispatch(0);
    engine.applyLifecycleEvent('t1', 'running');
    engine.applyLifecycleEvent('t1', 'completed');
    const r = engine.applyLifecycleEvent('t1', 'failed');  // 矛盾事件
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-transition');
    expect(engine.getState('t1')).toBe('completed');
    // dispatched 记录不受矛盾事件影响
    const d2 = scheduler.dispatch(0);
    expect(d2).not.toContain('t1');
  });
});