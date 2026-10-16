// src/orchestration/engine.test.ts
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
import { describe, it, expect, beforeEach } from 'bun:test';
import { OrchestrationEngine } from './engine';
import { ContractManager } from './contract';
import { RetryManager } from './retry';

describe('OrchestrationEngine', () => {
  let engine: OrchestrationEngine;

  beforeEach(() => {
    engine = new OrchestrationEngine(new ContractManager(), new RetryManager());
  });

  it('should register a task with no deps as ready', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    expect(engine.getState('t1')).toBe('ready');
  });

  it('should register a task with deps as pending', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    expect(engine.getState('t2')).toBe('pending');
  });

  it('should transition pending to ready when dep completes', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    expect(engine.getState('t2')).toBe('ready');
  });

  it('should reject invalid transitions', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    expect(() => engine.transition('t1', 'failed')).toThrow();
  });

  it('should cascade cancel dependents', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.registerTask('t3', 'co-oracle', '审查', ['t2']);
    engine.transition('t1', 'cancelled');
    expect(engine.getState('t1')).toBe('cancelled');
    expect(engine.getState('t2')).toBe('cancelled');
    expect(engine.getState('t3')).toBe('cancelled');
  });

  it('should get ready tasks sorted by depth', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-explorer', '搜索2');
    engine.registerTask('t3', 'co-fixer', '实现', ['t1', 't2']);
    const ready = engine.getReadyTasks();
    expect(ready).toContain('t1');
    expect(ready).toContain('t2');
    expect(ready).not.toContain('t3');
  });

  it('should handle retry transition: failed → pending', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'running');
    engine.transition('t1', 'failed');
    engine.transition('t1', 'pending');  // 重试
    expect(engine.getState('t1')).toBe('pending');
  });

  it('should get DAG summary string', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    const summary = engine.getDAGSummary();
    expect(summary).toContain('t1');
    expect(summary).toContain('t2');
    expect(summary).toContain('completed');
    expect(summary).toContain('ready');
  });

  // ===== 生命周期状态回归（首期：内部引擎只诚实记录原生生命周期） =====

  it('should complete a task after legitimate start (ready → running → completed)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    expect(engine.getState('t1')).toBe('completed');
  });

  it('should mark a task failed after legitimate start and not touch dependents', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.transition('t1', 'running');
    engine.transition('t1', 'failed');
    expect(engine.getState('t1')).toBe('failed');
    // 失败与成功区分：失败不得把依赖任务标记为 completed，也不得级联取消
    expect(engine.getState('t2')).toBe('pending');
  });

  it('should cancel a running task and cascade to dependents', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.transition('t1', 'running');
    engine.transition('t1', 'cancelled');
    expect(engine.getState('t1')).toBe('cancelled');
    expect(engine.getState('t2')).toBe('cancelled');
  });

  it('should not mark a never-started task completed (ready → completed rejected)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    // 锁严格转换表：未经过 running 的任务不能被直接标记为终态成功
    expect(() => engine.transition('t1', 'completed')).toThrow();
    expect(engine.getState('t1')).toBe('ready');
  });

  it('should not mark a pending dep task completed without starting', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    expect(() => engine.transition('t2', 'completed')).toThrow();
    expect(() => engine.transition('t2', 'failed')).toThrow();
    expect(engine.getState('t2')).toBe('pending');
  });

  it('should treat repeated completed transitions as idempotent', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    // 原生生命周期事件可能重复到达：重复终态不应再次抛异常或改状态
    expect(() => engine.transition('t1', 'completed')).not.toThrow();
    expect(engine.getState('t1')).toBe('completed');
  });

  it('should treat repeated cancelled transitions as idempotent', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'cancelled');
    expect(() => engine.transition('t1', 'cancelled')).not.toThrow();
    expect(engine.getState('t1')).toBe('cancelled');
  });

  it('should not touch other tasks when transitioning an unknown alias', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    expect(() => engine.transition('unknown', 'completed')).toThrow();
    expect(engine.getState('t1')).toBe('ready');
    // 查询未知 alias 不产生任何副作用
    expect(engine.getState('unknown')).toBeUndefined();
  });

  it('should not auto-complete a running task on inactivity (no terminal evidence)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'running');
    // idle 不是成功证据：没有任何 API 会把"无活动"自动推进为 completed
    expect(engine.getState('t1')).toBe('running');
  });

  it('should only unlock dependents on success, not auto-complete them', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    // 成功只解锁依赖到 ready；子任务必须自己启动完成，不得传递自动成功
    expect(engine.getState('t2')).toBe('ready');
  });

  // ===== 生命周期事件安全适配入口（applyLifecycleEvent）：原生事件映射 =====

  it('applyLifecycleEvent: unknown task is safe no-op without touching others', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    const r = engine.applyLifecycleEvent('unknown', 'completed');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-task');
    expect(engine.getState('t1')).toBe('ready');
  });

  it('applyLifecycleEvent: repeated same terminal is idempotent', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.applyLifecycleEvent('t1', 'running');
    const first = engine.applyLifecycleEvent('t1', 'completed');
    expect(first.ok).toBe(true);
    expect(first.reason).toBe('applied');
    const second = engine.applyLifecycleEvent('t1', 'completed');
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('idempotent');
    expect(engine.getState('t1')).toBe('completed');
  });

  it('applyLifecycleEvent: contradictory terminal does not tamper state', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.applyLifecycleEvent('t1', 'running');
    engine.applyLifecycleEvent('t1', 'completed');
    // 已完成后再收到 failed：矛盾事件不篡改既有终态
    const r = engine.applyLifecycleEvent('t1', 'failed');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-transition');
    expect(engine.getState('t1')).toBe('completed');
  });

  it('applyLifecycleEvent: strict DAG semantics preserved (ready → completed rejected)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    // 安全入口同样不放宽：未经过 running 不允许直接成功
    const r = engine.applyLifecycleEvent('t1', 'completed');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-transition');
    expect(engine.getState('t1')).toBe('ready');
  });

  it('applyLifecycleEvent: applied running unlocks nothing; failure does not cascade cancel', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.registerTask('t2', 'co-fixer', '实现', ['t1']);
    expect(engine.applyLifecycleEvent('t1', 'running').reason).toBe('applied');
    expect(engine.applyLifecycleEvent('t1', 'failed').reason).toBe('applied');
    expect(engine.getState('t1')).toBe('failed');
    expect(engine.getState('t2')).toBe('pending');
  });

  it('transition: repeated same state is idempotent without throwing (strict path too)', () => {
    engine.registerTask('t1', 'co-explorer', '搜索');
    engine.transition('t1', 'running');
    engine.transition('t1', 'completed');
    expect(() => engine.transition('t1', 'completed')).not.toThrow();
    expect(engine.getState('t1')).toBe('completed');
  });
});