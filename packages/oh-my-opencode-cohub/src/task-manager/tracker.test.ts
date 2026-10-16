// src/task-manager/tracker.test.ts
// 验证"关闭卡住子代理"相关能力：abortJob 定位/幂等/状态守卫、cleanupStaleJobs 超时清理

import type { JobRecord, TaskStatus } from './types';
import { TaskTracker } from './tracker';

// ---- 最小化 bun:test 全局声明 ----
// Bun 运行时在全局注入 describe/test/expect；项目未安装 @types/bun，
// 因此用局部声明替代整文件 @ts-nocheck，使其余代码仍受类型检查约束。
interface ExpectResult {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  readonly not: Omit<ExpectResult, 'not'>;
}
declare function describe(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void, timeout?: number): void;
declare function expect(actual: unknown): ExpectResult;

/** 访问 TaskTracker 私有字段 jobs（仅测试用，绕过 private 可见性检查） */
function getJobs(tracker: TaskTracker): Map<string, JobRecord> {
  return (tracker as unknown as { jobs: Map<string, JobRecord> }).jobs;
}

function registerBg(
  tracker: TaskTracker,
  opts: { sessionId?: string; parent?: string; ageMs?: number } = {},
): { alias: string; job: JobRecord } {
  const parent = opts.parent ?? 'parent-ses';
  const alias = tracker.registerBeforeTask(parent, {
    subagent_type: 'co-explorer',
    description: '测试背景任务',
    task_id: opts.sessionId ?? `ses_${Math.random().toString(36).slice(2, 10)}`,
    background: true,
  });
  const job = getJobs(tracker).get(alias);
  if (!job) throw new Error(`job ${alias} not found after registerBeforeTask`);
  if (opts.ageMs !== undefined) {
    job.createdAt = Date.now() - opts.ageMs;
  }
  return { alias, job };
}

describe('abortJob', () => {
  test('按 alias 定位：标记 cancelled、terminalReconciled=true、返回 sessionId', () => {
    const tracker = new TaskTracker();
    const { alias, job } = registerBg(tracker, { sessionId: 'ses_aaa', parent: 'p1' });

    const result = tracker.abortJob(alias);

    expect(result).toBeDefined();
    expect(result!.sessionId).toBe('ses_aaa');
    expect(result!.job).toBe(job);
    expect(job.status).toBe('cancelled');
    expect(job.terminalReconciled).toBe(true);
  });

  test('按 sessionId 匹配也生效', () => {
    const tracker = new TaskTracker();
    const { job } = registerBg(tracker, { sessionId: 'ses_bbb', parent: 'p1' });

    const result = tracker.abortJob('ses_bbb');

    expect(result).toBeDefined();
    expect(result!.sessionId).toBe('ses_bbb');
    expect(result!.job).toBe(job);
    expect(job.status).toBe('cancelled');
    expect(job.terminalReconciled).toBe(true);
  });

  test('未知 taskId：返回 undefined、不抛错', () => {
    const tracker = new TaskTracker();
    const { job } = registerBg(tracker, { sessionId: 'ses_ccc', parent: 'p1' });
    // 不干扰已有任务
    const before = job.status;

    const result = tracker.abortJob('no-such-alias');

    expect(result).toBeUndefined();
    expect(job.status).toBe(before);
  });

  test('pending 任务（无 sessionId）：返回 sessionId undefined、不抛错', () => {
    const tracker = new TaskTracker();
    // task_id 缺失 → JobRecord.sessionId 为 ''
    const alias = tracker.registerBeforeTask('p1', {
      subagent_type: 'co-fixer',
      description: '尚未拿到子 session 的任务',
      background: true,
    });
    const job = getJobs(tracker).get(alias);
    if (!job) throw new Error('job should exist');

    const result = tracker.abortJob(alias);

    expect(result).toBeDefined();
    expect(result!.sessionId).toBeUndefined();
    expect(result!.job).toBe(job);
    expect(job.status).toBe('cancelled');
  });

  test('重复 abort 幂等：已终态任务再次 abort 返回原状态、不重复改写', () => {
    const tracker = new TaskTracker();
    const { alias, job } = registerBg(tracker, { sessionId: 'ses_dup', parent: 'p1' });

    const first = tracker.abortJob(alias);
    expect(first).toBeDefined();
    expect(job.status).toBe('cancelled');

    // 第二次按 sessionId 再次 abort：守卫命中，返回同一 job 且状态保持 cancelled
    const second = tracker.abortJob('ses_dup');
    expect(second).toBeDefined();
    expect(second!.job).toBe(job);
    expect(second!.sessionId).toBe('ses_dup');
    expect(job.status).toBe('cancelled');
    expect(job.terminalReconciled).toBe(true);
  });

  test('状态守卫：completed 任务 abort 不改变状态', () => {
    const tracker = new TaskTracker();
    const { alias, job } = registerBg(tracker, { sessionId: 'ses_done', parent: 'p1' });
    job.status = 'completed';
    job.terminalReconciled = true;

    const result = tracker.abortJob(alias);

    expect(result).toBeDefined();
    expect(result!.job).toBe(job);
    expect(job.status).toBe('completed');
  });

  test('状态守卫：errored 任务 abort 不改变状态', () => {
    const tracker = new TaskTracker();
    const { alias, job } = registerBg(tracker, { sessionId: 'ses_err', parent: 'p1' });
    job.status = 'errored';

    const result = tracker.abortJob(alias);

    expect(result).toBeDefined();
    expect(result!.job).toBe(job);
    expect(job.status).toBe('errored');
  });
});

describe('cleanupStaleJobs', () => {
  test('过期的 background running job：返回其 sessionId、状态变为 errored', () => {
    const tracker = new TaskTracker();
    const stale = registerBg(tracker, { sessionId: 'ses_stale', parent: 'p1', ageMs: 100_000 });
    // 另一个未过期
    const fresh = registerBg(tracker, { sessionId: 'ses_fresh', parent: 'p1', ageMs: 1_000 });

    const staleSessions = tracker.cleanupStaleJobs(60_000);

    expect(staleSessions).toContain('ses_stale');
    expect(staleSessions).not.toContain('ses_fresh');
    expect(stale.job.status).toBe('errored');
  });

  test('未过期的 running job 不被标记', () => {
    const tracker = new TaskTracker();
    const alive = registerBg(tracker, { sessionId: 'ses_alive', parent: 'p1', ageMs: 10_000 });

    const staleSessions = tracker.cleanupStaleJobs(60_000);

    expect(staleSessions).toEqual([]);
    expect(alive.job.status).toBe('running');
  });

  test('非 background 的 running job 不被清理', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('p1', {
      subagent_type: 'co-fixer',
      description: '前台任务',
      background: false,
    });
    const job = getJobs(tracker).get(alias);
    if (!job) throw new Error('job should exist');
    job.createdAt = Date.now() - 100_000;

    const staleSessions = tracker.cleanupStaleJobs(60_000);

    expect(staleSessions).toEqual([]);
    expect(job.status).toBe('running');
  });
});

describe('getBoardText 折叠', () => {
  test('20 个活跃 job 只展示前 15 条 + 折叠提示', () => {
    const tracker = new TaskTracker();
    const parent = 'parent-fold';
    // 注册 20 个 running 背景任务
    for (let i = 0; i < 20; i++) {
      tracker.registerBeforeTask(parent, {
        subagent_type: 'co-explorer',
        description: `任务 ${i}`,
        task_id: `ses_fold_${i}`,
        background: true,
      });
    }

    const text = tracker.getBoardText(parent);

    // 包含前 15 条的任务条目
    expect(text).toContain('ses_fold_0');
    expect(text).toContain('ses_fold_14');
    // 不包含第 16 条之后的任务
    expect(text).not.toContain('ses_fold_15');
    expect(text).not.toContain('ses_fold_19');
    // 包含折叠提示
    expect(text).toContain('…及 5 个任务未显示');

    // 总行数验证：标题 + 条目 15 行 + 折叠 1 行 + 空行 = 18 行左右
    const lines = text.split('\n');
    const activeLines = lines.filter(l => l.startsWith('  - '));
    expect(activeLines.length).toBe(15);
  });

  test('少于 15 个活跃 job 不折叠', () => {
    const tracker = new TaskTracker();
    const parent = 'parent-no-fold';
    for (let i = 0; i < 10; i++) {
      tracker.registerBeforeTask(parent, {
        subagent_type: 'co-explorer',
        description: `任务 ${i}`,
        task_id: `ses_nofold_${i}`,
        background: true,
      });
    }

    const text = tracker.getBoardText(parent);

    expect(text).toContain('ses_nofold_0');
    expect(text).toContain('ses_nofold_9');
    expect(text).not.toContain('任务未显示');
  });
});

describe('pruneTerminalJobs', () => {
  test('删除超龄终态任务，保留活跃任务', () => {
    const tracker = new TaskTracker();
    const parent = 'parent-prune';
    const oldAge = 100_000; // 100秒前

    // 1. 创建超龄终态任务（completed + terminalReconciled + 旧时间）
    const oldAlias = tracker.registerBeforeTask(parent, {
      subagent_type: 'co-explorer',
      description: '超龄终态',
      task_id: 'ses_old_terminal',
      background: true,
    });
    const oldJob = getJobs(tracker).get(oldAlias)!;
    oldJob.status = 'completed';
    oldJob.terminalReconciled = true;
    oldJob.createdAt = Date.now() - oldAge;

    // 2. 创建活跃任务（running + 旧时间但不应被删）
    const runningAlias = tracker.registerBeforeTask(parent, {
      subagent_type: 'co-fixer',
      description: '活跃任务',
      task_id: 'ses_running_active',
      background: true,
    });
    const runningJob = getJobs(tracker).get(runningAlias)!;
    runningJob.createdAt = Date.now() - oldAge; // 虽然旧，但仍是 running

    // 3. 创建年轻终态任务（不应被删）
    const youngAlias = tracker.registerBeforeTask(parent, {
      subagent_type: 'co-planner',
      description: '年轻终态',
      task_id: 'ses_young_terminal',
      background: true,
    });
    const youngJob = getJobs(tracker).get(youngAlias)!;
    youngJob.status = 'completed';
    youngJob.terminalReconciled = true;
    // createdAt 保持默认（刚刚创建）

    const count = tracker.pruneTerminalJobs(60_000); // 60秒阈值

    expect(count).toBe(1); // 只删了超龄终态
    // 超龄终态已删除
    expect(getJobs(tracker).get(oldAlias)).toBeUndefined();
    // 活跃任务保留
    expect(getJobs(tracker).get(runningAlias)).toBeDefined();
    expect(runningJob.status).toBe('running');
    // 年轻终态保留
    expect(getJobs(tracker).get(youngAlias)).toBeDefined();
  });

  test('无超龄终态任务时返回 0', () => {
    const tracker = new TaskTracker();
    const parent = 'parent-none';
    tracker.registerBeforeTask(parent, {
      subagent_type: 'co-explorer',
      description: '活跃任务',
      task_id: 'ses_alive',
      background: true,
    });

    const count = tracker.pruneTerminalJobs(60_000);
    expect(count).toBe(0);
  });

  test('cancelled 终态任务也被清理', () => {
    const tracker = new TaskTracker();
    const parent = 'parent-cancelled';
    const oldAge = 100_000;

    const alias = tracker.registerBeforeTask(parent, {
      subagent_type: 'co-explorer',
      description: '已取消终态',
      task_id: 'ses_cancelled',
      background: true,
    });
    const job = getJobs(tracker).get(alias)!;
    job.status = 'cancelled';
    job.terminalReconciled = true;
    job.createdAt = Date.now() - oldAge;

    const count = tracker.pruneTerminalJobs(60_000);
    expect(count).toBe(1);
    expect(getJobs(tracker).get(alias)).toBeUndefined();
  });
});

describe('getBoardText 父会话隔离', () => {
  test('A/B 交错注册、B 最后更新全局后，getBoardText(A) 只含 A、getBoardText(B) 只含 B', () => {
    const tracker = new TaskTracker();
    // 交错注册：A → B → A → B，最后一次 registerBeforeTask 把全局父会话更新为 B
    registerBg(tracker, { sessionId: 'ses_a1', parent: 'A' });
    registerBg(tracker, { sessionId: 'ses_b1', parent: 'B' });
    registerBg(tracker, { sessionId: 'ses_a2', parent: 'A' });
    registerBg(tracker, { sessionId: 'ses_b2', parent: 'B' });

    const textA = tracker.getBoardText('A');
    expect(textA).toContain('ses_a1');
    expect(textA).toContain('ses_a2');
    expect(textA).not.toContain('ses_b1');
    expect(textA).not.toContain('ses_b2');

    const textB = tracker.getBoardText('B');
    expect(textB).toContain('ses_b1');
    expect(textB).toContain('ses_b2');
    expect(textB).not.toContain('ses_a1');
    expect(textB).not.toContain('ses_a2');
  });

  test('未知 parent 会话返回空字符串', () => {
    const tracker = new TaskTracker();
    registerBg(tracker, { sessionId: 'ses_a1', parent: 'A' });

    expect(tracker.getBoardText('no-such-session')).toBe('');
  });

  test('嵌套 A 派 C、C 派 D：各直接父会话互不聚合', () => {
    const tracker = new TaskTracker();
    // A 的直接子任务（C 会话），C 派 D，D 再派任务
    registerBg(tracker, { sessionId: 'ses_c', parent: 'A' });
    registerBg(tracker, { sessionId: 'ses_d1', parent: 'C' });
    registerBg(tracker, { sessionId: 'ses_d2', parent: 'D' });

    const textA = tracker.getBoardText('A');
    expect(textA).toContain('ses_c');
    expect(textA).not.toContain('ses_d1');
    expect(textA).not.toContain('ses_d2');

    const textC = tracker.getBoardText('C');
    expect(textC).toContain('ses_d1');
    expect(textC).not.toContain('ses_c');
    expect(textC).not.toContain('ses_d2');

    const textD = tracker.getBoardText('D');
    expect(textD).toContain('ses_d2');
    expect(textD).not.toContain('ses_c');
    expect(textD).not.toContain('ses_d1');
  });
});

describe('getBoardText 空值/非法值不回退全局（缺陷回归）', () => {
  // 目标行为：getBoardText 必须显式传父会话 ID；空值/非法值返回 ''，绝不回退
  // 最近一次 hook 收到的全局父会话 _currentParentSessionId（旧实现会跨会话泄漏）。
  // 无参/空字符串/null/0 在旧实现下会泄漏 B 的内容 → 预期失败（RED，缺陷回归）；
  // truthy 非字符串（123）旧实现本就不匹配任何 job → 返回 ''。
  // 修复（必传签名 + 空值/非法值返回 ''）后本组全部通过。
  function setupAB(tracker: TaskTracker): void {
    registerBg(tracker, { sessionId: 'ses_a1', parent: 'A' });
    // 最后一次注册把全局父会话停在 B
    registerBg(tracker, { sessionId: 'ses_b1', parent: 'B' });
  }

  test('无参调用不泄漏最近全局父会话（B），返回空', () => {
    const tracker = new TaskTracker();
    setupAB(tracker);
    // 函数类型断言（this 参数绑定 tracker）+ 立即 call：保留 this（提取成无绑定调用会 TypeError），
    // 且兼容后续签名改为必传（断言签名覆盖可选/必传两种情况）
    const noArgCall = tracker.getBoardText as unknown as (
      this: TaskTracker,
      parentSessionId?: string
    ) => string;

    expect(noArgCall.call(tracker)).toBe('');
  });

  test('空字符串 parent 不泄漏最近全局父会话（B），返回空', () => {
    const tracker = new TaskTracker();
    setupAB(tracker);

    expect(tracker.getBoardText('')).toBe('');
  });

  test('null parent 不泄漏最近全局父会话（B），返回空', () => {
    const tracker = new TaskTracker();
    setupAB(tracker);
    // 保持 receiver 的方法调用 + 类型断言模拟运行时传入 null
    expect(tracker.getBoardText(null as unknown as string)).toBe('');
  });

  test('falsy 非字符串 parent（0）不泄漏最近全局父会话（B），返回空', () => {
    const tracker = new TaskTracker();
    setupAB(tracker);
    // 保持 receiver 的方法调用 + 类型断言模拟运行时传入 0
    expect(tracker.getBoardText(0 as unknown as string)).toBe('');
  });

  test('truthy 非字符串 parent（123）不匹配任何会话，返回空', () => {
    const tracker = new TaskTracker();
    setupAB(tracker);
    // 保持 receiver 的方法调用 + 类型断言模拟运行时传入 123
    expect(tracker.getBoardText(123 as unknown as string)).toBe('');
  });
});

// ===== Wave1 回归补充：updateAfterTask / updateByChildSessionId 无匹配绝不改动 =====
// 背景：后续将改为 (parentSessionID, callID) 精确关联 alias 与 childSessionID。
// 当前公开签名 updateAfterTask(parent, status, sessionId?) 无法表达"更新哪一次调用"，
// callID 关联缺陷场景由 src/index.test.ts 的 hook 集成用例覆盖（RED，预期失败）。
// 本组用例聚焦当前签名可表达的防回归底线（既有通过 GREEN）：
//   无匹配（未知 parent / 无 running job / 未知 sessionId / 未知 id）绝不改动任何 job；
//   前台 after 终结 + 绑定 childSessionId；后台 after 仅绑定不终结；重复 after 幂等。

describe('updateAfterTask 基础行为与无匹配守卫（既有通过）', () => {
  test('前台任务 after：状态终结、绑定 childSessionId、标记 reconciled', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '前台任务',
      background: false,
    });

    tracker.updateAfterTask('A', 'completed', 'ses_x');

    const job = getJobs(tracker).get(alias)!;
    expect(job.status).toBe('completed');
    expect(job.sessionId).toBe('ses_x');
    expect(job.terminalReconciled).toBe(true);
  });

  test('后台任务 after：仅绑定 childSessionId、保持 running 待 event 终结', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '后台任务',
      background: true,
    });

    tracker.updateAfterTask('A', 'completed', 'ses_x');

    const job = getJobs(tracker).get(alias)!;
    expect(job.status).toBe('running');
    expect(job.sessionId).toBe('ses_x');
  });

  test('未知 parent 的 after：不修改任何 job', () => {
    const tracker = new TaskTracker();
    const aliasA = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: 'A 任务',
      background: false,
    });
    const jobA = getJobs(tracker).get(aliasA)!;

    tracker.updateAfterTask('no-such-parent', 'completed', 'ses_x');

    expect(jobA.status).toBe('running');
    expect(jobA.sessionId).toBe('');
  });

  test('parent 下无 running job 的 after：不修改任何 job（含其他 parent 的活跃任务）', () => {
    const tracker = new TaskTracker();
    // A 的 job 已终结；B 的 job 仍运行
    const aliasA = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: 'A 前台',
      background: false,
    });
    const aliasB = tracker.registerBeforeTask('B', {
      subagent_type: 'co-fixer',
      description: 'B 后台',
      background: true,
    });
    tracker.updateAfterTask('A', 'completed', 'ses_a');
    const jobA = getJobs(tracker).get(aliasA)!;
    const jobB = getJobs(tracker).get(aliasB)!;
    const bBefore = { status: jobB.status, sessionId: jobB.sessionId };

    // A 已无 running：再次 after(A) 不得误伤 A 的终态 job，也不得触碰 B 的活跃 job
    tracker.updateAfterTask('A', 'completed', 'ses_a2');

    expect(jobA.status).toBe('completed');
    expect(jobA.sessionId).toBe('ses_a');
    expect(jobB.status).toBe(bBefore.status);
    expect(jobB.sessionId).toBe(bBefore.sessionId);
  });

  test('重复 after 幂等：已终结前台任务二次 after 不改写状态与 sessionId', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '前台任务',
      background: false,
    });
    tracker.updateAfterTask('A', 'completed', 'ses_x');
    const job = getJobs(tracker).get(alias)!;

    tracker.updateAfterTask('A', 'completed', 'ses_y');

    expect(job.status).toBe('completed');
    expect(job.sessionId).toBe('ses_x');
  });
});

describe('updateByChildSessionId 精确匹配守卫（既有通过）', () => {
  test('未知 sessionId：不修改任何 job', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '后台任务',
      task_id: 'ses_known',
      background: true,
    });
    const job = getJobs(tracker).get(alias)!;

    tracker.updateByChildSessionId('ses_unknown', 'completed');

    expect(job.status).toBe('running');
    expect(job.terminalReconciled).toBe(false);
  });

  test('前台 job（非 background）即使 sessionId 命中也不被 event 终结', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '前台任务',
      task_id: 'ses_fg',
      background: false,
    });
    const job = getJobs(tracker).get(alias)!;

    tracker.updateByChildSessionId('ses_fg', 'completed');

    // 守卫要求 background && running：前台任务不经 event 终结
    expect(job.status).toBe('running');
  });
});

describe('固定种子随机事件序列：无匹配调用绝不改动任何 job（隔离/幂等不变式）', () => {
  // 用固定种子（mulberry32，seed=20241016）生成 1000 组事件序列，每组在独立
  // TaskTracker 上执行。对每步"可能改写"的调用做调用前后快照对比，断言不变式：
  //   I1 updateAfterTask：变化的 job ⊆ 该 parent 下 running 集合（无 running → 零变化）
  //   I2 updateByChildSessionId：变化的 job ⊆ sessionId 精确匹配的 background running 集合
  //   I3 abortJob / markCancelled：变化的 job ⊆ alias/sessionId 精确匹配集合；未知 → 零变化
  // 这些不变式是 (parentSessionID, callID) 精确关联改造后也必须保持的防回归底线。
  // 低开销：每序列 5-15 步、job 数个，1000 组纯内存运行，不启动模型/网络/宿主任务。
  // ⚠️ 与既有 tracker.test.ts 一致：终态路径会触发 persistStats() 写 STATS_FILE
  //（真实 home，既有 abortJob/cleanupStaleJobs 用例已建立该行为），本组不新增路径。
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  interface JobSnap {
    status: TaskStatus;
    sessionId: string;
    terminalReconciled: boolean;
  }

  function snapshot(tracker: TaskTracker): Map<string, JobSnap> {
    const out = new Map<string, JobSnap>();
    for (const [alias, job] of getJobs(tracker)) {
      out.set(alias, { status: job.status, sessionId: job.sessionId, terminalReconciled: job.terminalReconciled });
    }
    return out;
  }

  function changedAliases(before: Map<string, JobSnap>, after: Map<string, JobSnap>): string[] {
    const out: string[] = [];
    for (const [alias, st] of after) {
      const prev = before.get(alias);
      if (!prev || prev.status !== st.status || prev.sessionId !== st.sessionId || prev.terminalReconciled !== st.terminalReconciled) {
        out.push(alias);
      }
    }
    for (const alias of before.keys()) {
      if (!after.has(alias)) out.push(alias);
    }
    return out;
  }

  test('1000 组固定种子序列全部满足无匹配不改不变式', () => {
    const rand = mulberry32(20241016);
    const parents = ['A', 'B', 'C'];
    const knownSessions: string[] = [];
    let executed = 0;

    for (let seq = 0; seq < 1000; seq++) {
      const tracker = new TaskTracker();
      const steps = 5 + Math.floor(rand() * 11); // 5-15 步
      const log: string[] = [];

      for (let s = 0; s < steps; s++) {
        const parent = parents[Math.floor(rand() * parents.length)];
        const op = Math.floor(rand() * 5);

        if (op === 0) {
          // registerBeforeTask：只新增 job，不做快照对比（允许新建/同 parent reconcile）
          const bg = rand() < 0.5;
          const taskId = rand() < 0.5 ? 'ses_r' + seq + '_' + s : undefined;
          tracker.registerBeforeTask(parent, {
            subagent_type: 'co-fixer',
            description: '任务' + seq + '-' + s,
            ...(taskId ? { task_id: taskId } : {}),
            background: bg,
          });
          if (taskId) knownSessions.push(taskId);
          log.push('register(' + parent + ',bg=' + bg + ')');
          continue;
        }

        if (op === 1) {
          // I1 updateAfterTask
          const allowed = new Set<string>();
          for (const job of getJobs(tracker).values()) {
            if (job.parentSessionId === parent && job.status === 'running') allowed.add(job.alias);
          }
          const before = snapshot(tracker);
          tracker.updateAfterTask(parent, 'completed', rand() < 0.5 ? 'ses_e' + seq + '_' + s : undefined);
          const diff = changedAliases(before, snapshot(tracker));
          if (!diff.every((a) => allowed.has(a))) {
            throw new Error(
              'I1 违反（seq=' + seq + ' step=' + s + '）: diff=' + JSON.stringify(diff) +
              ' allowed=' + JSON.stringify([...allowed]) + '\n序列: ' + log.join(' | ') + ' | afterTask(' + parent + ')',
            );
          }
          log.push('afterTask(' + parent + ')');
          continue;
        }

        if (op === 2) {
          // I2 updateByChildSessionId：优先命中已知 session，其余未知
          const sid = knownSessions.length > 0 && rand() < 0.6
            ? knownSessions[Math.floor(rand() * knownSessions.length)]
            : 'ses_unknown_' + seq + '_' + s;
          const allowed = new Set<string>();
          for (const job of getJobs(tracker).values()) {
            if (job.sessionId === sid && job.background && job.status === 'running') allowed.add(job.alias);
          }
          const before = snapshot(tracker);
          tracker.updateByChildSessionId(sid, 'completed');
          const diff = changedAliases(before, snapshot(tracker));
          if (!diff.every((a) => allowed.has(a))) {
            throw new Error(
              'I2 违反（seq=' + seq + ' step=' + s + '）: diff=' + JSON.stringify(diff) +
              ' allowed=' + JSON.stringify([...allowed]) + ' sid=' + sid + '\n序列: ' + log.join(' | ') + ' | childIdle(' + sid + ')',
            );
          }
          log.push('childIdle(' + sid + ')');
          continue;
        }

        // op 3/4：I3 abortJob / markCancelled
        const aliasList = [...getJobs(tracker).keys()];
        const knownIds = [...knownSessions, ...aliasList];
        const id = knownIds.length > 0 && rand() < 0.6
          ? knownIds[Math.floor(rand() * knownIds.length)]
          : 'no-such-id_' + seq + '_' + s;
        const allowed = new Set<string>();
        for (const [alias, job] of getJobs(tracker)) {
          if (alias === id || job.sessionId === id) allowed.add(alias);
        }
        const before = snapshot(tracker);
        if (op === 3) tracker.abortJob(id);
        else tracker.markCancelled(id);
        const diff = changedAliases(before, snapshot(tracker));
        if (!diff.every((a) => allowed.has(a))) {
          throw new Error(
            (op === 3 ? 'I3a' : 'I3b') + ' 违反（seq=' + seq + ' step=' + s + '）: diff=' + JSON.stringify(diff) +
            ' allowed=' + JSON.stringify([...allowed]) + ' id=' + id + '\n序列: ' + log.join(' | ') + ' | ' + (op === 3 ? 'abort(' : 'cancel(') + id + ')',
          );
        }
        log.push((op === 3 ? 'abort(' : 'cancel(') + id + ')');
      }
      executed++;
    }

    expect(executed).toBe(1000);
  }, 20_000); // 重型 1000 组固定种子用例：显式合理 timeout（同步 stats 写盘 + 大序列），不全局放宽
});

// ===== Wave3 回归补充：精确关联 (parentSessionID, callID) =====
// registerBeforeTask 第三参 callID 建立 (parent, callID) → alias 精确索引；
// updateAfterTaskByCall / updateByAlias 按调用精确更新；noteChildSessionIdle 观测不终结；
// legacy updateAfterTask 只允许无歧义单一匹配；updateByChildSessionId 复用歧义 no-op。
// 本组测试全部为既有实现应满足的目标行为（Wave4 接线后 index 集成用例转绿）。

describe('精确关联 (parentSessionID, callID)：命中具体 alias、不串任务', () => {
  function snapJob(job: JobRecord) {
    return { status: job.status, sessionId: job.sessionId, terminalReconciled: job.terminalReconciled };
  }

  test('注册带 callID：getJobByCall 精确命中；重复注册同 (parent,callID) 幂等返回原 alias', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '任务X',
      background: true,
    }, 'call-1');
    expect(tracker.getJobByCall('A', 'call-1')?.alias).toBe(alias);
    // 跨 parent 同名 callID 不命中
    expect(tracker.getJobByCall('B', 'call-1')).toBeUndefined();
    expect(tracker.getJobByCall('A', 'call-other')).toBeUndefined();

    // 重复注册同 (parent, callID)：返回原 alias、不新建 job、不覆盖状态
    const alias2 = tracker.registerBeforeTask('A', {
      subagent_type: 'co-fixer',
      description: '任务X2',
      background: true,
    }, 'call-1');
    expect(alias2).toBe(alias);
    expect(getJobs(tracker).size).toBe(1);
  });

  test('同 parent 并发乱序：updateAfterTaskByCall 各自命中具体 alias、互不串扰', () => {
    const tracker = new TaskTracker();
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务X', background: true }, 'call-1');
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务Y', background: true }, 'call-2');
    // 乱序结束：先 call2 后 call1
    const r2 = tracker.updateAfterTaskByCall('A', 'call-2', 'completed', 'ses_y');
    expect(r2.ok).toBe(true);
    expect(r2.alias).toBe(alias2);
    const r1 = tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_x');
    expect(r1.ok).toBe(true);
    expect(r1.alias).toBe(alias1);

    const j1 = getJobs(tracker).get(alias1)!;
    const j2 = getJobs(tracker).get(alias2)!;
    expect(j1.sessionId).toBe('ses_x');
    expect(j2.sessionId).toBe('ses_y');
    // 后台 after 只绑定不终结
    expect(j1.status).toBe('running');
    expect(j2.status).toBe('running');
  });

  test('跨 parent 同 callID：更新 A 的调用不触碰 B 的 job', () => {
    const tracker = new TaskTracker();
    const aliasA = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'A', background: true }, 'shared');
    const aliasB = tracker.registerBeforeTask('B', { subagent_type: 'co-fixer', description: 'B', background: true }, 'shared');
    const r = tracker.updateAfterTaskByCall('A', 'shared', 'completed', 'ses_a');
    expect(r.alias).toBe(aliasA);
    expect(getJobs(tracker).get(aliasA)!.sessionId).toBe('ses_a');
    expect(getJobs(tracker).get(aliasB)!.sessionId).toBe('');
    expect(getJobs(tracker).get(aliasB)!.status).toBe('running');
  });

  test('未知 callID：updateAfterTaskByCall 安全 no-op、不猜最近任务', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务X', background: true }, 'call-1');
    const before = snapJob(getJobs(tracker).get(alias)!);

    const r = tracker.updateAfterTaskByCall('A', 'call-never-registered', 'completed', 'ses_unk');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
    const after = snapJob(getJobs(tracker).get(alias)!);
    expect(after.status).toBe(before.status);
    expect(after.sessionId).toBe(before.sessionId);
  });

  test('前台 after 终结 + 重复 after 幂等：终态不回归、sessionId 不覆盖', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务X', background: false }, 'call-1');

    const r1 = tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_f');
    expect(r1.ok).toBe(true);
    expect(r1.alias).toBe(alias);
    const job = getJobs(tracker).get(alias)!;
    expect(job.status).toBe('completed');
    expect(job.sessionId).toBe('ses_f');

    // 重复 after：幂等 no-op，不覆盖原终态/原 sessionId
    const r2 = tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_f2');
    expect(r2.ok).toBe(true);
    expect(r2.reason).toBe('idempotent');
    expect(job.status).toBe('completed');
    expect(job.sessionId).toBe('ses_f');
  });

  test('后台 after 只绑定不终结；同调用重复 after 幂等不重复改写', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务X', background: true }, 'call-1');

    tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_b');
    const job = getJobs(tracker).get(alias)!;
    expect(job.status).toBe('running');
    expect(job.sessionId).toBe('ses_b');

    tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_b');
    expect(job.status).toBe('running');
    expect(job.sessionId).toBe('ses_b');
  });

  test('legacy updateAfterTask 歧义守卫：同 parent 多个 running 时 no-op、不猜最近', () => {
    const tracker = new TaskTracker();
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true });
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'Y', background: true });

    const r = tracker.updateAfterTask('A', 'completed', 'ses_x');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(getJobs(tracker).get(alias1)!.sessionId).toBe('');
    expect(getJobs(tracker).get(alias2)!.sessionId).toBe('');
    expect(getJobs(tracker).get(alias1)!.status).toBe('running');
    expect(getJobs(tracker).get(alias2)!.status).toBe('running');
  });

  test('child 会话复用：同一 sessionId 关联多个调用时 idle 归属不明 → no-op 不批量终结', () => {
    const tracker = new TaskTracker();
    // 旧调用完成：后台 after 只绑定 childID（updateAfterTaskByCall 对后台仅绑定不终结，
    // 已批准契约），明确收尾必须经 finalizeByCall（Wave4.1 专用 API）落真实终态
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '旧调用', task_id: 'ses_reuse', background: true }, 'call-1');
    tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_reuse'); // 仅绑定 ses_reuse
    tracker.finalizeByCall('A', 'call-1', 'ses_reuse', 'completed'); // 旧调用落真实终态（成为历史）
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '新调用', task_id: 'ses_reuse', background: true }, 'call-2');
    const j2 = getJobs(tracker).get(alias2)!;

    // session.idle(ses_reuse)：复用历史归属不明 → 安全 no-op
    const idle = tracker.noteChildSessionIdle('ses_reuse');

    expect(idle.ok).toBe(false);
    expect(idle.reason).toBe('ambiguous');
    expect(j2.status).toBe('running'); // 新调用不被旧 idle 终结
    expect(getJobs(tracker).get(alias1)!.status).toBe('completed'); // 旧终态不回归
  });

  test('noteChildSessionIdle：唯一运行关联时仅观测不终结（idle 不是成功证据）', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '任务X', task_id: 'ses_b1', background: true }, 'call-1');
    tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_b1');

    const r = tracker.noteChildSessionIdle('ses_b1');

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('observed');
    expect(r.alias).toBe(alias);
    expect(getJobs(tracker).get(alias)!.status).toBe('running'); // 不终结
  });

  test('updateByAlias 未知 alias 安全 no-op', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true }, 'call-1');
    const before = snapJob(getJobs(tracker).get(alias)!);

    const r = tracker.updateByAlias('no-such-alias', 'completed', 'ses_x');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
    expect(getJobs(tracker).get(alias)!.status).toBe(before.status);
  });

  test('pruneTerminalJobs 同步移除 callIndex 关联', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: false }, 'call-1');
    tracker.updateAfterTaskByCall('A', 'call-1', 'completed', 'ses_x');
    const job = getJobs(tracker).get(alias)!;
    job.terminalReconciled = true;
    job.createdAt = Date.now() - 100_000;

    const count = tracker.pruneTerminalJobs(60_000);

    expect(count).toBe(1);
    expect(tracker.getJobByCall('A', 'call-1')).toBeUndefined();
  });
});

describe('固定种子随机事件序列（精确 callID）：命中必须落在具体 alias', () => {
  // 通过新精确 API（registerBeforeTask 带 callID + updateAfterTaskByCall + updateByAlias +
  // noteChildSessionIdle）验证 1000 组固定种子（seed=20241017）事件序列。断言强度高于
  // 旧的"⊆ 同 parent running 集合"不变量——每次命中必须精确等于注册时返回的 alias：
  //   P1  updateAfterTaskByCall 命中：变更集合 === {该 call 的 alias}（或零变更幂等）；
  //       未命中：零变更、返回 no-match（绝不猜最近）。
  //   P2  updateByAlias：只影响自身 alias。
  //   P3  noteChildSessionIdle：永不终结任何 job（零变更）、观测返回具体 alias。
  //   P4  重复注册同 (parent, callID)：幂等返回原 alias、不新建 job。
  // 低开销：每序列 8-20 步、job 数个，1000 组纯内存运行，不启动模型/网络/宿主任务。
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  interface JobSnap {
    status: TaskStatus;
    sessionId: string;
    terminalReconciled: boolean;
  }

  function snapshot(tracker: TaskTracker): Map<string, JobSnap> {
    const out = new Map<string, JobSnap>();
    for (const [alias, job] of getJobs(tracker)) {
      out.set(alias, { status: job.status, sessionId: job.sessionId, terminalReconciled: job.terminalReconciled });
    }
    return out;
  }

  function changedAliases(before: Map<string, JobSnap>, after: Map<string, JobSnap>): string[] {
    const out: string[] = [];
    for (const [alias, st] of after) {
      const prev = before.get(alias);
      if (!prev || prev.status !== st.status || prev.sessionId !== st.sessionId || prev.terminalReconciled !== st.terminalReconciled) {
        out.push(alias);
      }
    }
    for (const alias of before.keys()) {
      if (!after.has(alias)) out.push(alias);
    }
    return out;
  }

  test('1000 组固定种子序列：精确 callID 命中不落错 alias、未知零变更', () => {
    const rand = mulberry32(20241017);
    const parents = ['A', 'B', 'C'];
    interface Call { parent: string; callID: string; alias: string }
    const localSessions: string[] = [];
    let executed = 0;

    for (let seq = 0; seq < 1000; seq++) {
      const tracker = new TaskTracker();
      const steps = 8 + Math.floor(rand() * 13); // 8-20 步
      const log: string[] = [];
      const localCalls: Call[] = [];

      for (let s = 0; s < steps; s++) {
        const parent = parents[Math.floor(rand() * parents.length)];
        const op = Math.floor(rand() * 4);

        if (op === 0) {
          // register：20% 复用同 (parent, callID) 测幂等（P4），否则新 callID
          let callID: string;
          let reused = false;
          if (localCalls.length > 0 && rand() < 0.2) {
            const pick = localCalls[Math.floor(rand() * localCalls.length)];
            callID = pick.callID;
            reused = true;
          } else {
            callID = 'call-' + seq + '-' + s;
          }
          const bg = rand() < 0.5;
          const taskId = rand() < 0.5 ? 'ses_c' + seq + '_' + s : undefined;
          const alias = tracker.registerBeforeTask(parent, {
            subagent_type: 'co-fixer',
            description: '任务' + seq + '-' + s,
            ...(taskId ? { task_id: taskId } : {}),
            background: bg,
          }, callID);
          if (reused) {
            const orig = localCalls.find((c) => c.parent === parent && c.callID === callID);
            if (orig && alias !== orig.alias) {
              throw new Error('P4 违反（seq=' + seq + ' step=' + s + '）: 重复注册返回新 alias ' + alias + ' ≠ ' + orig.alias + '\n序列: ' + log.join(' | '));
            }
          } else {
            localCalls.push({ parent, callID, alias });
            if (taskId) localSessions.push(taskId);
          }
          log.push('register(' + parent + ',' + callID + ')');
          continue;
        }

        if (op === 1) {
          // P1 updateAfterTaskByCall：60% 命中本地注册，40% 未知
          const hit = localCalls.length > 0 && rand() < 0.6;
          const call = hit
            ? localCalls[Math.floor(rand() * localCalls.length)]
            : { parent, callID: 'no-such-' + seq + '-' + s, alias: '' };
          const sid = rand() < 0.5 ? 'ses_e' + seq + '_' + s : undefined;
          const before = snapshot(tracker);
          const r = tracker.updateAfterTaskByCall(call.parent, call.callID, 'completed', sid);
          const diff = changedAliases(before, snapshot(tracker));

          if (!hit) {
            if (diff.length !== 0) {
              throw new Error('P1a 违反（seq=' + seq + ' step=' + s + '）: 未知 call 变更了 ' + JSON.stringify(diff) + '\n序列: ' + log.join(' | '));
            }
            if (r.ok) {
              throw new Error('P1b 违反（seq=' + seq + ' step=' + s + '）: 未知 call 应 no-match，实际 ' + r.reason + '\n序列: ' + log.join(' | '));
            }
          } else {
            if (diff.length === 1) {
              if (diff[0] !== call.alias) {
                throw new Error('P1c 违反（seq=' + seq + ' step=' + s + '）: 命中落错 alias ' + diff[0] + ' ≠ ' + call.alias + '\n序列: ' + log.join(' | '));
              }
              if (r.alias !== call.alias) {
                throw new Error('P1d 违反（seq=' + seq + ' step=' + s + '）: 返回值 alias ' + r.alias + ' ≠ ' + call.alias + '\n序列: ' + log.join(' | '));
              }
              if (!r.ok) {
                throw new Error('P1e 违反（seq=' + seq + ' step=' + s + '）: 命中应 ok，实际 ' + r.reason + '\n序列: ' + log.join(' | '));
              }
            } else if (diff.length !== 0) {
              throw new Error('P1f 违反（seq=' + seq + ' step=' + s + '）: 命中变更了多个 job ' + JSON.stringify(diff) + '\n序列: ' + log.join(' | '));
            }
            const byCall = tracker.getJobByCall(call.parent, call.callID);
            if (!byCall || byCall.alias !== call.alias) {
              throw new Error('P1g 违反（seq=' + seq + ' step=' + s + '）: getJobByCall 未命中注册 alias\n序列: ' + log.join(' | '));
            }
          }
          log.push('afterByCall(' + call.parent + ',' + call.callID + ')');
          continue;
        }

        if (op === 2) {
          // P2 updateByAlias：只影响自身 alias
          if (localCalls.length === 0) { log.push('(skip byAlias)'); continue; }
          const call = localCalls[Math.floor(rand() * localCalls.length)];
          const before = snapshot(tracker);
          const r = tracker.updateByAlias(call.alias, 'completed', rand() < 0.5 ? 'ses_a' + seq + '_' + s : undefined);
          const diff = changedAliases(before, snapshot(tracker));
          if (diff.length === 1) {
            if (diff[0] !== call.alias) {
              throw new Error('P2a 违反（seq=' + seq + ' step=' + s + '）: updateByAlias 落错 alias ' + diff[0] + '\n序列: ' + log.join(' | '));
            }
            if (!r.ok) {
              throw new Error('P2b 违反（seq=' + seq + ' step=' + s + '）: 命中应 ok，实际 ' + r.reason + '\n序列: ' + log.join(' | '));
            }
          } else if (diff.length !== 0) {
            throw new Error('P2c 违反（seq=' + seq + ' step=' + s + '）: updateByAlias 影响多个 job ' + JSON.stringify(diff) + '\n序列: ' + log.join(' | '));
          }
          log.push('byAlias(' + call.alias + ')');
          continue;
        }

        // op 3：P3 noteChildSessionIdle —— 永不终结（零变更）、观测返回具体 alias
        const sid = localSessions.length > 0 && rand() < 0.6
          ? localSessions[Math.floor(rand() * localSessions.length)]
          : 'ses_noidle_' + seq + '_' + s;
        const before = snapshot(tracker);
        const r = tracker.noteChildSessionIdle(sid);
        const diff = changedAliases(before, snapshot(tracker));
        if (diff.length !== 0) {
          throw new Error('P3a 违反（seq=' + seq + ' step=' + s + '）: idle 观测变更了 ' + JSON.stringify(diff) + '\n序列: ' + log.join(' | '));
        }
        if (r.ok && r.reason !== 'observed') {
          throw new Error('P3b 违反（seq=' + seq + ' step=' + s + '）: 观测 reason 应为 observed，实际 ' + r.reason + '\n序列: ' + log.join(' | '));
        }
        if (!r.ok && r.reason !== 'no-match' && r.reason !== 'ambiguous') {
          throw new Error('P3c 违反（seq=' + seq + ' step=' + s + '）: 未观测 reason 异常 ' + r.reason + '\n序列: ' + log.join(' | '));
        }
        log.push('childIdle(' + sid + ')');
      }
      executed++;
    }

    expect(executed).toBe(1000);
  }, 20_000); // 重型 1000 组固定种子（精确 callID）用例：显式合理 timeout，不全局放宽、不去掉精确 alias 断言
});

// ===== Wave4.1 回归补充：复用后台任务安全收尾 =====
// 阻塞修复：sessionId 一对多历史不再让唯一活动任务永远 ambiguous、永不收尾。
// finalizeByCall 按 (parent, callID)+预期 childID 精确终结唯一 running job；
// findActiveByChildSessionId 以"running 数"为唯一活动判定依据，已结束历史不计数。

describe('findActiveByChildSessionId：唯一活动归属（历史不计数）', () => {
  test('唯一 running → ok；含 completed 历史仍唯一 → ok（历史不影响）', () => {
    const tracker = new TaskTracker();
    // 旧调用已终结（completed 历史），共享同一 childID
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '旧调用', task_id: 'ses_reuse', background: true }, 'call-1');
    getJobs(tracker).get(alias1)!.status = 'completed';
    getJobs(tracker).get(alias1)!.terminalReconciled = true;
    // 新调用唯一 active
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '新调用', task_id: 'ses_reuse', background: true }, 'call-2');

    const r = tracker.findActiveByChildSessionId('ses_reuse');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.job.alias).toBe(alias2);
    expect(getJobs(tracker).get(alias1)!.status).toBe('completed');
  });

  test('两个 running 共享 childID → ambiguous（保守不选、零副作用）', () => {
    const tracker = new TaskTracker();
    tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', task_id: 'ses_dup', background: true }, 'call-1');
    tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'Y', task_id: 'ses_dup', background: true }, 'call-2');

    const r = tracker.findActiveByChildSessionId('ses_dup');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  test('无 running（未知或全部已终态）→ no-match', () => {
    const tracker = new TaskTracker();
    expect(tracker.findActiveByChildSessionId('ses_unknown').ok).toBe(false);

    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', task_id: 'ses_done', background: true }, 'call-1');
    getJobs(tracker).get(alias)!.status = 'cancelled';
    const r = tracker.findActiveByChildSessionId('ses_done');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-match');
  });
});

describe('finalizeByCall：精确终结唯一活动 job（复用收尾）', () => {
  test('旧 completed 历史 + 唯一 active 复用：新鲜 stop 可收尾（历史不影响唯一活动）', () => {
    const tracker = new TaskTracker();
    // 旧调用已 completed（历史），共享 ses_reuse
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '旧调用', task_id: 'ses_reuse', background: true }, 'call-1');
    getJobs(tracker).get(alias1)!.status = 'completed';
    getJobs(tracker).get(alias1)!.terminalReconciled = true;
    // 新调用唯一 active
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: '新调用', task_id: 'ses_reuse', background: true }, 'call-2');

    const r = tracker.finalizeByCall('A', 'call-2', 'ses_reuse', 'completed');

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.alias).toBe(alias2);
    const j2 = getJobs(tracker).get(alias2)!;
    expect(j2.status).toBe('completed');
    expect(j2.terminalReconciled).toBe(true);
    // 旧历史不被改写
    expect(getJobs(tracker).get(alias1)!.status).toBe('completed');
  });

  test('两个 running 共享 childID → ambiguous no-op，不批量终结', () => {
    const tracker = new TaskTracker();
    const alias1 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', task_id: 'ses_dup', background: true }, 'call-1');
    const alias2 = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'Y', task_id: 'ses_dup', background: true }, 'call-2');

    const r = tracker.finalizeByCall('A', 'call-1', 'ses_dup', 'completed');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(getJobs(tracker).get(alias1)!.status).toBe('running');
    expect(getJobs(tracker).get(alias2)!.status).toBe('running');
  });

  test('绑定对象已变更（expectedChildId 与 job.sessionId 不一致）→ no-match，旧候选不更新新调用', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true }, 'call-1');
    getJobs(tracker).get(alias)!.sessionId = 'ses_bound_old';

    const r = tracker.finalizeByCall('A', 'call-1', 'ses_new_candidate', 'completed');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
    expect(getJobs(tracker).get(alias)!.status).toBe('running');
    expect(getJobs(tracker).get(alias)!.sessionId).toBe('ses_bound_old');
  });

  test('job 未绑定时 expectedChildId 允许首次绑定并终结', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true }, 'call-1');
    // sessionId 未绑定（''）

    const r = tracker.finalizeByCall('A', 'call-1', 'ses_first', 'completed');

    expect(r.ok).toBe(true);
    const j = getJobs(tracker).get(alias)!;
    expect(j.sessionId).toBe('ses_first');
    expect(j.status).toBe('completed');
  });

  test('已终态 job → idempotent，不重复改写、terminal stats 只写一次', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', task_id: 'ses_done', background: true }, 'call-1');
    // 第一次终结：ok
    const first = tracker.finalizeByCall('A', 'call-1', 'ses_done', 'completed');
    expect(first.ok).toBe(true);
    const j = getJobs(tracker).get(alias)!;
    expect(j.status).toBe('completed');

    // 重复终结：idempotent、状态不变（隐含 stats 不重复写——第二次未走落终态路径）
    const second = tracker.finalizeByCall('A', 'call-1', 'ses_done', 'completed');
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('idempotent');
    expect(j.status).toBe('completed');
    expect(j.sessionId).toBe('ses_done');
  });

  test('未知 callID → no-match，不回退最近任务', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true }, 'call-1');
    const before = getJobs(tracker).get(alias)!.status;

    const r = tracker.finalizeByCall('A', 'call-never-registered', 'ses_x', 'completed');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
    expect(getJobs(tracker).get(alias)!.status).toBe(before);
  });

  test('拒绝 status=running（非终态写入）', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', background: true }, 'call-1');

    const r = tracker.finalizeByCall('A', 'call-1', undefined, 'running');

    expect(r.ok).toBe(false);
    expect(getJobs(tracker).get(alias)!.status).toBe('running');
  });

  test('跨 parent 同 callID 不串：finalize(A) 不触碰 B', () => {
    const tracker = new TaskTracker();
    const aliasA = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'A', task_id: 'ses_a', background: true }, 'shared');
    const aliasB = tracker.registerBeforeTask('B', { subagent_type: 'co-fixer', description: 'B', task_id: 'ses_b', background: true }, 'shared');

    const r = tracker.finalizeByCall('A', 'shared', 'ses_a', 'completed');

    expect(r.ok).toBe(true);
    expect(r.alias).toBe(aliasA);
    expect(getJobs(tracker).get(aliasB)!.status).toBe('running');
  });

  test('expectedChildId 未传：按 (parent,callID) 精确定位直接终结', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'X', task_id: 'ses_x', background: true }, 'call-1');

    const r = tracker.finalizeByCall('A', 'call-1', undefined, 'errored');

    expect(r.ok).toBe(true);
    expect(getJobs(tracker).get(alias)!.status).toBe('errored');
  });
});

// ===========================================================================
// Wave5：精确取消与质量写回
//   setBackgroundByCall（promotion 精确更新）/ updateQualityByAlias /
//   legacy updateQuality 收紧（多匹配歧义 no-op）/ abortJob session 收紧 /
//   resolveCancelTarget（只读解析，供 close_job 使用）/
//   markCancelledByAlias（真实 abort 成功后落状态）/ getJobByAlias
// ===========================================================================
describe('setBackgroundByCall：promotion 精确更新', () => {
  test('前台 → 后台 promotion：精确更新目标，其他 parent 同 callID 不串', () => {
    const tracker = new TaskTracker();
    const aliasA = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'A', background: false }, 'c1');
    const aliasB = tracker.registerBeforeTask('B', { subagent_type: 'co-fixer', description: 'B', background: false }, 'c1');

    const r = tracker.setBackgroundByCall('A', 'c1', true);

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.alias).toBe(aliasA);
    expect(getJobs(tracker).get(aliasA)!.background).toBe(true);
    // 其他 parent 同 callID 不受影响
    expect(getJobs(tracker).get(aliasB)!.background).toBe(false);
  });

  test('未知 (parent,callID) → no-match，不回退最近 job', () => {
    const tracker = new TaskTracker();
    tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'A' }, 'c1');
    const r = tracker.setBackgroundByCall('A', 'never-registered', true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
  });

  test('已终态任务 → idempotent，不复活不修改历史', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('A', { subagent_type: 'co-fixer', description: 'A', background: false }, 'c1');
    tracker.updateAfterTaskByCall('A', 'c1', 'completed');

    const r = tracker.setBackgroundByCall('A', 'c1', true);

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('idempotent');
    expect(getJobs(tracker).get(alias)!.status).toBe('completed');
    expect(getJobs(tracker).get(alias)!.background).toBe(false); // 历史不变
  });
});

describe('updateQualityByAlias / legacy updateQuality 收紧', () => {
  test('两 job 共享 child：质量只改目标 alias，不扩散到复用历史', () => {
    const tracker = new TaskTracker();
    const oldAlias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_shared', background: true }, 'c-old');
    const newAlias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'new', task_id: 'ses_shared', background: true }, 'c-new');
    // 旧历史已终态（复用场景）
    tracker.finalizeByCall('P', 'c-old', 'ses_shared', 'completed');

    const q = { score: 0.9, latencyMs: 100 };
    const r = tracker.updateQualityByAlias(newAlias, q);

    expect(r.ok).toBe(true);
    expect(r.alias).toBe(newAlias);
    expect(getJobs(tracker).get(newAlias)!.quality).toEqual(q);
    // 旧 alias 质量不被扩散
    expect(getJobs(tracker).get(oldAlias)!.quality).toBeUndefined();
  });

  test('updateQualityByAlias 未知 alias → no-match', () => {
    const tracker = new TaskTracker();
    const r = tracker.updateQualityByAlias('no-such-alias', { score: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-match');
  });

  test('legacy updateQuality：多匹配（复用历史）歧义 no-op 不猜', () => {
    const tracker = new TaskTracker();
    tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_shared', background: true }, 'c-old');
    tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'new', task_id: 'ses_shared', background: true }, 'c-new');

    tracker.updateQuality('ses_shared', { score: 0.5 });

    const jobs = Array.from(getJobs(tracker).values());
    for (const j of jobs) expect(j.quality).toBeUndefined();
  });

  test('legacy updateQuality：唯一匹配时写回', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'only', task_id: 'ses_only', background: true }, 'c1');

    tracker.updateQuality('ses_only', { score: 0.7 });

    expect(getJobs(tracker).get(alias)!.quality?.score).toBe(0.7);
  });
});

describe('abortJob / resolveCancelTarget：取消只命中唯一活动', () => {
  test('session 有旧 completed + 新 running：abortJob(sessionId) 只命中新', () => {
    const tracker = new TaskTracker();
    // 真实复用顺序：旧调用先登记并在其唯一 running 时终结为历史，然后才登记复用同 session 的新调用
    const oldAlias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_reuse', background: true }, 'c-old');
    tracker.finalizeByCall('P', 'c-old', 'ses_reuse', 'completed'); // 旧历史终态（此时唯一 running）
    const newAlias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'new', task_id: 'ses_reuse', background: true }, 'c-new');

    const hit = tracker.abortJob('ses_reuse');

    expect(hit?.job.alias).toBe(newAlias);
    expect(getJobs(tracker).get(newAlias)!.status).toBe('cancelled');
    expect(getJobs(tracker).get(oldAlias)!.status).toBe('completed'); // 旧不抢当前
  });

  test('session 仅一条终态历史（无 running）→ abortJob 幂等返回原状态（不据此中止真实复用 session）', () => {
    const tracker = new TaskTracker();
    const oldAlias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_hist', background: true }, 'c-old');
    tracker.finalizeByCall('P', 'c-old', 'ses_hist', 'completed');

    // 安全兼容契约：恰好一条匹配历史 → 幂等返回原状态（调用方仍须守卫 active；
    // job-control 走 resolveCancelTarget 只认 running，不会对历史发 SDK abort）
    const hit = tracker.abortJob('ses_hist');

    expect(hit).toBeDefined();
    expect(hit!.job.alias).toBe(oldAlias);
    expect(getJobs(tracker).get(oldAlias)!.status).toBe('completed'); // 状态不变
  });

  test('session 多条终态历史（无 running）→ abortJob 歧义 no-op，不任取一条', () => {
    const tracker = new TaskTracker();
    const h1 = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'h1', task_id: 'ses_multi', background: true }, 'c-1');
    tracker.finalizeByCall('P', 'c-1', 'ses_multi', 'completed');
    const h2 = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'h2', task_id: 'ses_multi', background: true }, 'c-2');
    tracker.finalizeByCall('P', 'c-2', 'ses_multi', 'completed');

    // 多条历史：归属不明，绝不任取一条（undefined），两条历史均保持不变
    expect(tracker.abortJob('ses_multi')).toBeUndefined();
    expect(getJobs(tracker).get(h1)!.status).toBe('completed');
    expect(getJobs(tracker).get(h2)!.status).toBe('completed');
  });

  test('两个 running 共享 child：abortJob / resolveCancelTarget 拒绝', () => {
    const tracker = new TaskTracker();
    tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'a', task_id: 'ses_amb', background: true }, 'c-a');
    tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'b', task_id: 'ses_amb', background: true }, 'c-b');

    expect(tracker.abortJob('ses_amb')).toBeUndefined();
    const t = tracker.resolveCancelTarget('ses_amb');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toBe('ambiguous');
  });

  test('resolveCancelTarget：alias 命中（含已终态历史，供调用方守卫）', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_a', background: true }, 'c1');
    tracker.finalizeByCall('P', 'c1', 'ses_a', 'completed');

    const t = tracker.resolveCancelTarget(alias);
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.job.alias).toBe(alias);
      expect(t.job.status).toBe('completed'); // 已终态仍返回，调用方必须守卫 status==='running'
    }
  });

  test('resolveCancelTarget：sessionId 唯一 running 命中；无 running → no-match', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'x', task_id: 'ses_r', background: true }, 'c1');
    const t = tracker.resolveCancelTarget('ses_r');
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.job.alias).toBe(alias);
    expect(tracker.resolveCancelTarget('ses_absent').ok).toBe(false);
  });

  test('旧 alias 命中已终态：abortJob(alias) 幂等返回原状态，不改写', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'old', task_id: 'ses_a', background: true }, 'c1');
    tracker.finalizeByCall('P', 'c1', 'ses_a', 'completed');

    const hit = tracker.abortJob(alias);
    expect(hit?.job.alias).toBe(alias);
    expect(getJobs(tracker).get(alias)!.status).toBe('completed');
  });
});

describe('markCancelledByAlias / getJobByAlias', () => {
  test('markCancelledByAlias：running → cancelled；重复调用 idempotent', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'x', task_id: 'ses_c', background: true }, 'c1');

    const r = tracker.markCancelledByAlias(alias);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(getJobs(tracker).get(alias)!.status).toBe('cancelled');

    const r2 = tracker.markCancelledByAlias(alias);
    expect(r2.ok).toBe(true);
    expect(r2.reason).toBe('idempotent');
    expect(getJobs(tracker).get(alias)!.status).toBe('cancelled');
  });

  test('markCancelledByAlias：已终态不改回 cancelled；未知 no-match', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'x', task_id: 'ses_d', background: true }, 'c1');
    tracker.finalizeByCall('P', 'c1', 'ses_d', 'completed');

    const r = tracker.markCancelledByAlias(alias);
    expect(r.reason).toBe('idempotent');
    expect(getJobs(tracker).get(alias)!.status).toBe('completed'); // 不把 completed 改回 cancelled

    expect(tracker.markCancelledByAlias('nope').reason).toBe('no-match');
  });

  test('getJobByAlias：命中与未知', () => {
    const tracker = new TaskTracker();
    const alias = tracker.registerBeforeTask('P', { subagent_type: 'co-fixer', description: 'x' }, 'c1');
    expect(tracker.getJobByAlias(alias)?.alias).toBe(alias);
    expect(tracker.getJobByAlias('nope')).toBeUndefined();
  });
});

// ===========================================================================
// Wave6：getBoardText 复用建议（200K 软复用预算）
//   复用建议三态：「最近输入 N / 超预算，不建议复用 / 输入未知」；
//   预算不是硬限制（低于阈值仅显示用量，不宣称保证安全）；严格超过才警告；
//   不传 reuse 参数（策略关闭/未配置）→ 输出与旧版完全一致，不影响既有追踪。
// ===========================================================================
describe('getBoardText 复用建议（Wave6 软复用预算）', () => {
  /**
   * 注册一个 completed 可复用背景任务（真实生命周期：registerBeforeTask → finalizeByCall 落终态，
   * 与 index.ts idle 收尾路径一致——旧测试手动置 status/terminalReconciled=false 掩盖了真实
   * finalize 路径，导致「正常完成 job 因 terminalReconciled=true 从 Board 消失」缺陷未被发现）。
   */
  function addReusable(tracker: TaskTracker, sessionId: string, quality?: NonNullable<JobRecord['quality']>): void {
    // 真实生命周期：registerBeforeTask → finalizeByCall 落终态（与 index.ts idle 收尾路径一致），
    // 旧测试手动置 status/terminalReconciled=false 掩盖了真实 finalize 路径缺陷。
    // 角色保持 registerBg 原 fixture（co-explorer）→ 单行模式缩写仍为 co-exp，兼容断言不漂移。
    const callID = 'call-' + sessionId;
    const alias = tracker.registerBeforeTask('P', {
      subagent_type: 'co-explorer',
      description: '测试可复用任务',
      task_id: sessionId,
      background: true,
    }, callID);
    const r = tracker.finalizeByCall('P', callID, sessionId, 'completed');
    if (!r.ok) throw new Error('addReusable finalizeByCall 失败: ' + r.reason);
    const job = getJobs(tracker).get(alias);
    if (job && quality) job.quality = quality;
  }
  /** 注册一个 running 背景任务（使 Board 走完整表格模式） */
  function addActive(tracker: TaskTracker, sessionId: string): void {
    registerBg(tracker, { sessionId, parent: 'P' });
  }
  /** 构造带复用采样 quality（输入量 inputTokens） */
  function reuseQuality(inputTokens: number): NonNullable<JobRecord['quality']> {
    return { reuseInput: { inputTokens, sampledAt: 1, messageId: 'm1' } };
  }

  test('不传 reuse：表格模式无「复用建议」列、不显示任何建议（输出与旧版一致）', () => {
    const tracker = new TaskTracker();
    addActive(tracker, 'ses_active');
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    const text = tracker.getBoardText('P');
    expect(text).toContain('ses_r1');
    expect(text).not.toContain('复用建议');
    expect(text).not.toContain('最近输入');
    expect(text).not.toContain('输入未知');
    expect(text).not.toContain('超预算');
  });

  test('不传 reuse：单行模式不带 hint（与旧版一致）', () => {
    const tracker = new TaskTracker();
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    const text = tracker.getBoardText('P');
    expect(text).toContain('ses_r1(co-exp)');
    expect(text).not.toContain('/最近输入');
    expect(text).not.toContain('/输入未知');
  });

  test('边界：199999/200000 不超（严格超过才警告）、200001/480000 超预算', () => {
    const cases = [
      { n: 199999, label: '最近输入 199999' },
      { n: 200000, label: '最近输入 200000' },
      { n: 200001, label: '超预算，不建议复用' },
      { n: 480000, label: '超预算，不建议复用' },
    ];
    for (const c of cases) {
      const tracker = new TaskTracker();
      addActive(tracker, 'ses_active');
      addReusable(tracker, 'ses_r' + c.n, reuseQuality(c.n));
      const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
      expect(text).toContain(c.label);
    }
  });

  test('未采样（无 reuseInput）→ 显示「输入未知」（未知而非 0）', () => {
    const tracker = new TaskTracker();
    addActive(tracker, 'ses_active');
    addReusable(tracker, 'ses_unk'); // 无 quality
    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    expect(text).toContain('输入未知');
    expect(text).not.toContain('最近输入 0');
  });

  test('关闭策略（不传 reuse）：任务仍列出、无建议（可关不影响原有追踪）', () => {
    const tracker = new TaskTracker();
    addActive(tracker, 'ses_active');
    addReusable(tracker, 'ses_r1', reuseQuality(999999));
    const text = tracker.getBoardText('P');
    expect(text).toContain('ses_r1');
    expect(text).toContain('ses_active');
    expect(text).not.toContain('超预算');
    expect(text).not.toContain('最近输入');
  });

  test('预算非硬限制：低于阈值只显示用量，不宣称「保证安全」', () => {
    const tracker = new TaskTracker();
    addActive(tracker, 'ses_active');
    addReusable(tracker, 'ses_r1', reuseQuality(199999));
    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    expect(text).toContain('最近输入 199999');
    expect(text).not.toContain('安全');
    expect(text).not.toContain('建议复用');
  });

  test('真实 finalize 路径回归：finalizeByCall 完成的背景任务出现在 Reusable Sessions（不再为空）', () => {
    const tracker = new TaskTracker();
    // 300K 用量 job 走真实生命周期完成（finalize 会设 terminalReconciled=true）
    addReusable(tracker, 'ses_300k', reuseQuality(300000));
    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // terminalReconciled 只供 prune 回收，不再决定复用可见性
    expect(text).toContain('ses_300k');
    expect(text).toContain('超预算，不建议复用');
    const alias = getJobs(tracker).values().next().value?.alias ?? '';
    expect(getJobs(tracker).get(alias)!.terminalReconciled).toBe(true);
  });

  test('同 session 多次复用：Board 只展示最新 job，不重复旧记录', () => {
    const tracker = new TaskTracker();
    // 第一次复用记录（旧）：12345 输入
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    // 第二次复用同一 session 并完成（新）：200001 输入
    const callID2 = 'call-r1-again';
    const alias2 = tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '再次复用',
      task_id: 'ses_r1',
      background: true,
    }, callID2);
    const r2 = tracker.finalizeByCall('P', callID2, 'ses_r1', 'completed');
    expect(r2.ok).toBe(true);
    getJobs(tracker).get(alias2)!.quality = reuseQuality(200001);

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // session 只出现一次（不重复），建议用最新 job 的采样（超预算而非 12345）
    expect((text.match(/ses_r1/g) ?? []).length).toBe(1);
    expect(text).toContain('超预算，不建议复用');
  });

  test('正在被复用的 session：running 绑定后历史 completed 不展示为可复用', () => {
    const tracker = new TaskTracker();
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    // 复用该 session 的新调用仍 running
    tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '活动中',
      task_id: 'ses_r1',
      background: true,
    }, 'call-r1-active');

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // active 区显示 running；Reusable 区不显示 ses_r1（活动中不可再复用）
    expect(text).toContain('co-fixer / running / ses_r1');
    expect(text).not.toContain('#### Reusable Sessions');
  });

  test('同 session 第二轮失败（errored）：遮住旧 completed，不回退展示第一轮低 token', () => {
    const tracker = new TaskTracker();
    // 第一轮复用完成（低 token 12345）
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    // 第二轮复用同一 session 并失败（errored，真实生命周期：register → finalizeByCall 落终态）
    tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '再次复用但失败',
      task_id: 'ses_r1',
      background: true,
    }, 'call-r1-fail');
    const r2 = tracker.finalizeByCall('P', 'call-r1-fail', 'ses_r1', 'errored');
    expect(r2.ok).toBe(true);

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // 最新注册调用是 errored → 不得展示旧 completed 记录（也不能回退显示第一轮低 token）
    expect(text).toBe('');
    expect(text).not.toContain('ses_r1');
    expect(text).not.toContain('最近输入 12345');
  });

  test('同 session 第二轮取消（cancelled）：遮住旧 completed 记录', () => {
    const tracker = new TaskTracker();
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '再次复用但取消',
      task_id: 'ses_r1',
      background: true,
    }, 'call-r1-cancel');
    const r2 = tracker.finalizeByCall('P', 'call-r1-cancel', 'ses_r1', 'cancelled');
    expect(r2.ok).toBe(true);

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    expect(text).toBe('');
    expect(text).not.toContain('ses_r1');
  });

  test('同毫秒 createdAt：后注册调用优先（Map 插入序，>= 覆盖）', () => {
    const tracker = new TaskTracker();
    // 先注册：co-explorer（co-exp）第一轮完成，采样 12345
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    // 后注册：co-fixer 复用同一 session，拉平到与第一轮相同的 createdAt（模拟同毫秒连续注册）
    const alias2 = tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '同毫秒复用',
      task_id: 'ses_r1',
      background: true,
    }, 'call-r1-same-ms');
    const firstAlias = getJobs(tracker).values().next().value!.alias;
    const sameMs = Date.now();
    getJobs(tracker).get(firstAlias)!.createdAt = sameMs;
    getJobs(tracker).get(alias2)!.createdAt = sameMs;
    const r2 = tracker.finalizeByCall('P', 'call-r1-same-ms', 'ses_r1', 'completed');
    expect(r2.ok).toBe(true);
    getJobs(tracker).get(alias2)!.quality = reuseQuality(200001);

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // 同毫秒时后注册优先：展示后注册调用的采样（超预算），而非第一轮 12345
    expect(text).toContain('超预算，不建议复用');
    expect(text).not.toContain('最近输入 12345');
  });

  test('前台调用较新：复用同一 session 的 running 前台调用遮住旧 completed（活动中不可再复用）', () => {
    const tracker = new TaskTracker();
    addReusable(tracker, 'ses_r1', reuseQuality(12345));
    // 新调用复用该 session 且为前台（background=false）仍 running
    tracker.registerBeforeTask('P', {
      subagent_type: 'co-fixer',
      description: '前台复用',
      task_id: 'ses_r1',
      background: false,
    }, 'call-r1-fg');

    const text = tracker.getBoardText('P', { maxInputTokens: 200000 });
    // Active 区显示前台 running；Reusable 区不显示 ses_r1（前台复用中也不可再复用）
    expect(text).toContain('co-fixer / running / ses_r1');
    expect(text).not.toContain('#### Reusable Sessions');
    expect(text).not.toContain('最近输入');
  });
});
