// src/orchestration/retry.test.ts
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
import { describe, it, expect } from 'bun:test';
import { RetryManager } from './retry';
import type { OrchestrationTask } from './types';

function makeTask(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    alias: 'test-1', agent: 'co-explorer', label: '测试',
    state: 'failed', deps: [], dependents: [],
    retryCount: 0, maxRetries: 2, createdAt: Date.now(),
    ...overrides,
  };
}

describe('RetryManager', () => {
  it('should retry when error is retryable and retries remain', () => {
    const mgr = new RetryManager();
    const task = makeTask({ retryCount: 0, maxRetries: 2 });
    expect(mgr.decide(task, 'rate limit exceeded')).toBe('retry');
  });

  it('should abort when error is non-retryable', () => {
    const mgr = new RetryManager();
    const task = makeTask();
    expect(mgr.decide(task, 'not found: file missing')).toBe('abort');
  });

  it('should abort when retries exhausted', () => {
    const mgr = new RetryManager();
    const task = makeTask({ retryCount: 2, maxRetries: 2 });
    expect(mgr.decide(task, 'timeout')).toBe('abort');
  });

  it('should fallback when retries exhausted and fallback agents exist', () => {
    const mgr = new RetryManager({
      'co-fixer': { maxRetries: 1, backoff: 'fixed', backoffMs: 1000,
        retryableErrors: ['timeout'], nonRetryableErrors: [],
        fallbackAgents: ['co-oracle'] },
    });
    const task = makeTask({ agent: 'co-fixer', retryCount: 1, maxRetries: 1 });
    expect(mgr.decide(task, 'timeout')).toBe('fallback');
  });

  it('should use exponential backoff', () => {
    const mgr = new RetryManager();
    expect(mgr.getBackoffMs(makeTask({ retryCount: 0 }), 'exponential', 2000)).toBe(2000);
    expect(mgr.getBackoffMs(makeTask({ retryCount: 1 }), 'exponential', 2000)).toBe(4000);
    expect(mgr.getBackoffMs(makeTask({ retryCount: 2 }), 'exponential', 2000)).toBe(8000);
  });

  it('should use fixed backoff', () => {
    const mgr = new RetryManager();
    expect(mgr.getBackoffMs(makeTask({ retryCount: 0 }), 'fixed', 1000)).toBe(1000);
    expect(mgr.getBackoffMs(makeTask({ retryCount: 3 }), 'fixed', 1000)).toBe(1000);
  });

  it('should track and retrieve fallback agent', () => {
    const mgr = new RetryManager({
      'co-fixer': { maxRetries: 1, backoff: 'fixed', backoffMs: 1000,
        retryableErrors: ['timeout'], nonRetryableErrors: [],
        fallbackAgents: ['co-oracle', 'co-designer'] },
    });
    const task = makeTask({ agent: 'co-fixer', retryCount: 1, maxRetries: 1 });
    mgr.recordFailure('co-fixer', 'timeout');
    expect(mgr.getFallbackAgent('co-fixer')).toBe('co-oracle');
    mgr.recordFallbackUsed('co-fixer', 'co-oracle');
    expect(mgr.getFallbackAgent('co-fixer')).toBe('co-designer');
  });

  it('should reject non-retryable errors immediately', () => {
    const mgr = new RetryManager();
    const task = makeTask({ retryCount: 0, maxRetries: 5 });
    expect(mgr.decide(task, 'permission denied')).toBe('abort');
  });

  // ===== 生命周期状态回归（首期：原生 retry 只是观测，不接管执行） =====

  it('should abort on unknown errors (no match → conservative default)', () => {
    const mgr = new RetryManager();
    const task = makeTask();
    // 无法分类的错误不自动重试——保守默认，与"retry 仅作观测"一致
    expect(mgr.decide(task, 'unexpected crash: segfault')).toBe('abort');
  });

  it('should prefer retry over fallback while retries remain', () => {
    const mgr = new RetryManager({
      'co-fixer': { maxRetries: 2, backoff: 'fixed', backoffMs: 1000,
        retryableErrors: ['timeout'], nonRetryableErrors: [],
        fallbackAgents: ['co-oracle'] },
    });
    const task = makeTask({ agent: 'co-fixer', retryCount: 0, maxRetries: 2 });
    expect(mgr.decide(task, 'timeout')).toBe('retry');
  });

  it('should not mutate task state when deciding (retry is observation only)', () => {
    const mgr = new RetryManager();
    const task = makeTask({ retryCount: 1, maxRetries: 2 });
    const stateBefore = task.state;
    const retryCountBefore = task.retryCount;
    mgr.decide(task, 'rate limit exceeded');
    // decide 是纯策略：返回建议，不自行把任务转回 pending/running，不推进重试计数
    expect(task.state).toBe(stateBefore);
    expect(task.retryCount).toBe(retryCountBefore);
  });

  it('decide returning retry does not auto-advance task (no plugin auto-retry)', () => {
    const mgr = new RetryManager();
    const task = makeTask({ state: 'failed', retryCount: 0, maxRetries: 2 });
    const decision = mgr.decide(task, 'timeout');
    expect(decision).toBe('retry');
    // 自动重试不激活：任务不会自行回到 pending/running，重试计数不推进
    expect(task.state).toBe('failed');
    expect(task.retryCount).toBe(0);
  });

  it('decide is pure: consumes no fallback candidates and records no failure stats', () => {
    const mgr = new RetryManager({
      'co-fixer': { maxRetries: 1, backoff: 'fixed', backoffMs: 1000,
        retryableErrors: ['timeout'], nonRetryableErrors: [],
        fallbackAgents: ['co-oracle', 'co-designer'] },
    });
    const task = makeTask({ agent: 'co-fixer', state: 'failed', retryCount: 0, maxRetries: 1 });
    // 宿主 retry 仅观测：decide 是纯策略，不消费 fallback 候选、不写失败统计
    const fallbackBefore = mgr.getFallbackAgent('co-fixer');
    expect(mgr.decide(task, 'timeout')).toBe('retry');
    expect(mgr.getFallbackAgent('co-fixer')).toBe(fallbackBefore);
    expect(task.retryCount).toBe(0);
  });
});