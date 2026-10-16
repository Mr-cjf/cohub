import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JobRecord, TaskStatus, TaskArgs, UpdateResult } from './types';
import { writeJsonFileAtomic } from '../shared/fs-atomic';
import { type ContextStrategy, DEFAULT_CONTEXT_CONFIG } from '../context/types';

// ===== 性能指标统计（T9）=====

/** 统计窗口默认大小：最近 N 条任务 */
export const DEFAULT_STATS_WINDOW = 50;

/** 统计持久化文件（CLI stats 子命令读取同一路径） */
export const STATS_FILE = path.join(
  os.homedir(),
  '.local',
  'share',
  'opencode',
  'storage',
  'oh-my-opencode-cohub',
  'stats.json',
);

/** 按代理推断默认上下文策略（直接读 DEFAULT_CONTEXT_CONFIG.strategy，`?? 'none'` 兜底） */
export function defaultStrategyFor(agent: string): ContextStrategy {
  return DEFAULT_CONTEXT_CONFIG.strategy[agent] ?? 'none';
}

/** 参与统计的指标记录（从 JobRecord 抽取） */
export interface StatsRecord {
  agent: string;
  strategy: string;
  status: TaskStatus;
  latencyMs?: number;
  tokens?: { input: number; output: number };
}

/** 按 (strategy, agent) 聚合的统计桶 */
export interface StatsBucket {
  strategy: string;
  agent: string;
  count: number;
  successCount: number;
  successRate: number; // 0-100，无样本时为 0
  avgLatencyMs: number; // 仅有 latencyMs 样本的均值
  latencySamples: number;
  avgTokens: number; // input+output 总和均值，仅统计有 tokens 的样本
  tokenSamples: number;
}

/**
 * 滑动窗口聚合统计（纯函数）：
 * - records 需按时间升序传入，仅取最近 window 条
 * - 按 (strategy, agent) 分组，输出成功率 / 平均延迟 / 平均 token
 * - 缺少 latencyMs / tokens 的样本不影响对应均值，仅不计入样本数
 */
export function computeStats(records: StatsRecord[], window: number = DEFAULT_STATS_WINDOW): StatsBucket[] {
  const recent = records.slice(-Math.max(1, window));
  const buckets = new Map<string, StatsBucket>();
  for (const r of recent) {
    const key = r.strategy + '\u0000' + r.agent;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        strategy: r.strategy,
        agent: r.agent,
        count: 0,
        successCount: 0,
        successRate: 0,
        avgLatencyMs: 0,
        latencySamples: 0,
        avgTokens: 0,
        tokenSamples: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (r.status === 'completed') bucket.successCount += 1;
    if (typeof r.latencyMs === 'number') {
      bucket.avgLatencyMs = (bucket.avgLatencyMs * bucket.latencySamples + r.latencyMs) / (bucket.latencySamples + 1);
      bucket.latencySamples += 1;
    }
    if (r.tokens && typeof r.tokens.input === 'number' && typeof r.tokens.output === 'number') {
      const total = r.tokens.input + r.tokens.output;
      bucket.avgTokens = (bucket.avgTokens * bucket.tokenSamples + total) / (bucket.tokenSamples + 1);
      bucket.tokenSamples += 1;
    }
  }
  const result = Array.from(buckets.values());
  for (const b of result) {
    b.successRate = b.count > 0 ? (b.successCount / b.count) * 100 : 0;
  }
  result.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.agent.localeCompare(b.agent));
  return result;
}

export class TaskTracker {
  private jobs = new Map<string, JobRecord>();
  /** (parentSessionId, callID) → alias 精确索引：同 parent 下 callID 唯一，跨 parent 同名不串 */
  private callIndex = new Map<string, string>();
  private counters = new Map<string, number>();
  /** 最近一次 tool hook 收到的 parentSessionId */
  private _currentParentSessionId = '';
  /** 已 reconcile 的父 session ID，避免同一轮重复 reconcile */
  private _reconciledForParent = '';

  get currentParentSessionId(): string {
    return this._currentParentSessionId;
  }

  /** 生成 (parentSessionId, callID) 索引键（\u0000 分隔，防拼接歧义） */
  private callKey(parentSessionId: string, callID: string): string {
    return parentSessionId + '\u0000' + callID;
  }

  /** 生成代理别名，如 fixer → "fix-1", explorer → "exp-2" */
  private alias(agentType: string): string {
    const short = agentType.slice(0, 4).replace(/[^a-z]/gi, '');
    const n = (this.counters.get(agentType) ?? 0) + 1;
    this.counters.set(agentType, n);
    return `${short}-${n}`;
  }

  /**
   * 在 tool.execute.before 中调用，注册即将执行的任务。
   *
   * 传入 callID 时建立 (parentSessionId, callID) → alias 的精确关联（推荐入口路径）：
   * 同一 (parent, callID) 重复注册幂等——返回原 alias、不新建 job、不覆盖已有状态。
   * 不传 callID 为 legacy 路径：仅注册无精确关联的 job（更新端不得用"最近匹配"）。
   */
  registerBeforeTask(parentSessionId: string, args: TaskArgs, callID?: string): string {
    this._currentParentSessionId = parentSessionId;
    if (callID) {
      const existing = this.getJobByCall(parentSessionId, callID);
      if (existing) return existing.alias;
    }
    // 每轮自动 reconcile 旧任务（只执行一次）
    if (this._reconciledForParent !== parentSessionId) {
      this._reconciledForParent = parentSessionId;
      for (const job of this.jobs.values()) {
        if (job.parentSessionId === parentSessionId && job.status !== 'running') {
          job.terminalReconciled = true;
        }
      }
    }
    const agent = args.subagent_type ?? 'unknown';
    const alias = this.alias(agent);
    const label = typeof args.description === 'string' && args.description ? args.description : alias;

    const job: JobRecord = {
      alias,
      sessionId: args.task_id ?? '',  // 背景任务：task_id 即为子 session ID
      parentSessionId,
      agent,
      contextStrategy: defaultStrategyFor(agent),
      label,
      status: 'running',
      background: args.background ?? false,
      terminalReconciled: false,
      createdAt: Date.now(),
    };
    if (callID) job.callID = callID;

    this.jobs.set(alias, job);
    if (callID) this.callIndex.set(this.callKey(parentSessionId, callID), alias);

    return alias;
  }

  /**
   * 按 (parentSessionId, callID) 精确查找任务（不跨 parent、不猜最近）。
   */
  getJobByCall(parentSessionId: string, callID: string): JobRecord | undefined {
    const alias = this.callIndex.get(this.callKey(parentSessionId, callID));
    return alias ? this.jobs.get(alias) : undefined;
  }

  /**
   * 按 (parentSessionId, callID) 精确更新任务（tool.execute.after / 明确终态入口）。
   * 未知 callID：安全 no-op（reason='no-match'），绝不回退到"最近 running job"。
   */
  updateAfterTaskByCall(parentSessionId: string, callID: string, status: TaskStatus, sessionId?: string): UpdateResult {
    const job = this.getJobByCall(parentSessionId, callID);
    if (!job) return { ok: false, reason: 'no-match' };
    return this.applyCallUpdate(job, status, sessionId);
  }

  /**
   * 精确更新活动任务的 background 标记（前台 → 后台 promotion，Wave5 入口使用）。
   *
   * 守卫：
   * - 按 (parentSessionId, callID) 精确定位；未知 → no-match（绝不回退最近 job）；
   * - 仅 running 可更新；已终态（completed/errored/cancelled）→ idempotent 零副作用
   *   （不复活、不把历史任务当活动任务修改）；
   * - 不触碰其他 parent 同 callID 的 job（键含 parentSessionId）。
   */
  setBackgroundByCall(parentSessionId: string, callID: string, bg: boolean): UpdateResult {
    const job = this.getJobByCall(parentSessionId, callID);
    if (!job) return { ok: false, reason: 'no-match' };
    if (job.status !== 'running') {
      // 已终态：幂等 no-op，不复活/变更历史
      return { ok: true, reason: 'idempotent', alias: job.alias };
    }
    job.background = bg;
    return { ok: true, reason: 'ok', alias: job.alias };
  }

  /**
   * 按 alias 精确查找任务（关闭/收尾回调按 alias 定位 parent 等场景使用）。
   * 未知 alias 返回 undefined；不改写任何状态。
   */
  getJobByAlias(alias: string): JobRecord | undefined {
    return this.jobs.get(alias);
  }

  /**
   * 按 alias 精确更新任务（入口在已知 alias 时使用；未知 alias 安全 no-op）。
   */
  updateByAlias(alias: string, status: TaskStatus, sessionId?: string): UpdateResult {
    const job = this.jobs.get(alias);
    if (!job) return { ok: false, reason: 'no-match' };
    return this.applyCallUpdate(job, status, sessionId);
  }

  /**
   * 前台/后台统一的单任务更新语义：
   * - 前台任务：写入终态 + terminalReconciled + finalize；已终态再次更新为幂等（不覆盖原终态）。
   * - 后台任务：仅绑定 childSessionId、保持 running（终态由入口依据真实 output 确认）。
   */
  private applyCallUpdate(job: JobRecord, status: TaskStatus, sessionId?: string): UpdateResult {
    if (!job.background) {
      if (job.status !== 'running') {
        return { ok: true, reason: 'idempotent', alias: job.alias };
      }
      job.status = status;
      job.terminalReconciled = true;
      if (sessionId) job.sessionId = sessionId;
      this.finalize(job);
      this.persistStats();
      return { ok: true, reason: 'ok', alias: job.alias };
    }
    // 背景任务：after 只绑定 childSessionId，不终结（等入口确认终态）
    if (sessionId) job.sessionId = sessionId;
    return { ok: true, reason: 'ok', alias: job.alias };
  }

  /**
   * 在 tool.execute.after 中调用，更新任务完成状态（legacy 无 callID 路径）。
   *
   * ⚠️ 仅允许无歧义的单一匹配：该 parent 下 running job 恰好 1 个时才更新；
   * 多个 running（并发）返回 reason='ambiguous' 并 no-op——绝不用"最近创建"猜测，
   * 防止并发乱序错配。精确更新请使用 updateAfterTaskByCall(parent, callID, ...)。
   *
   * 非背景任务：立即标终态；背景任务：仅绑定 sessionId（等 event hook 处理）。
   */
  updateAfterTask(parentSessionId: string, status: TaskStatus, sessionId?: string): UpdateResult {
    this._currentParentSessionId = parentSessionId;
    const running: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.parentSessionId === parentSessionId && job.status === 'running') {
        running.push(job);
      }
    }
    if (running.length === 0) return { ok: false, reason: 'no-match' };
    if (running.length > 1) return { ok: false, reason: 'ambiguous' };
    return this.applyCallUpdate(running[0], status, sessionId);
  }

  /**
   * 根据子 session ID 更新任务状态（legacy 供 event hook 使用）。
   *
   * 守卫：
   * - sessionId 关联多个 job（复用历史/并发）→ 归属不明，安全 no-op（reason='ambiguous'），
   *   绝不批量终结歧义活动任务，旧调用终态不覆盖新调用；
   * - 唯一关联但非 background running（前台或已终结）→ no-match，不操作。
   * 精确语义请优先使用 updateAfterTaskByCall / updateByAlias。
   */
  updateByChildSessionId(sessionId: string, status: TaskStatus): UpdateResult {
    let allWithSession = 0;
    let runningBg: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        allWithSession++;
        if (job.background && job.status === 'running') runningBg = job;
      }
    }
    if (allWithSession === 0) return { ok: false, reason: 'no-match' };
    if (allWithSession > 1) return { ok: false, reason: 'ambiguous' };
    if (!runningBg) return { ok: false, reason: 'no-match' };

    runningBg.status = status;
    this.finalize(runningBg);
    this.persistStats();
    return { ok: true, reason: 'ok', alias: runningBg.alias };
  }

  /**
   * 观测子会话 idle 事件（会话级 idle 不是成功证据：只记录观测，不终结任务）。
   *
   * 入口（Wave4 接线）应结合 tool.execute.after 的真实 output 确认终态后，
   * 再调用 updateAfterTaskByCall / updateByAlias 落终态。
   * 同 child session 关联多个调用（复用历史/并发）→ 归属不明，安全 no-op。
   */
  noteChildSessionIdle(sessionId: string): UpdateResult {
    let allWithSession = 0;
    let runningBg: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        allWithSession++;
        if (job.background && job.status === 'running') runningBg = job;
      }
    }
    if (allWithSession === 0) return { ok: false, reason: 'no-match' };
    if (allWithSession > 1) return { ok: false, reason: 'ambiguous' };
    if (!runningBg) return { ok: false, reason: 'no-match' };
    return { ok: true, reason: 'observed', alias: runningBg.alias };
  }

  /**
   * 按子会话 ID 查找唯一活动（running）任务，用于 idle 收尾前的精确定位（Wave4.1）。
   * 已结束历史（completed/errored/cancelled）不参与计数——判断依据是"running 数"，
   * 不是"关联总数"，修复复用场景下旧历史导致新活动任务永远歧义、永不收尾的问题。
   *
   * @returns ok=true 返回唯一 running job；ok=false 且 reason='no-match'（无 running）
   *          或 'ambiguous'（多个 running 共享该 childID，保守不选，绝不批量终结）。
   */
  findActiveByChildSessionId(sessionId: string): { ok: true; job: JobRecord } | { ok: false; reason: 'no-match' | 'ambiguous' } {
    let active: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId && job.status === 'running') {
        if (active) return { ok: false, reason: 'ambiguous' };
        active = job;
      }
    }
    return active ? { ok: true, job: active } : { ok: false, reason: 'no-match' };
  }

  /**
   * 明确终结指定活动任务（复用场景安全收尾专用，Wave4.1）。
   *
   * 不复用 applyCallUpdate（后台分支只绑定不终结），直接从 running 落真实终态。
   * 全部守卫命中才落终态，任何一项不满足即安全 no-op：
   * 1. 精确定位：按 (parentSessionId, callID) 精确关联；未知 → no-match（绝不回退最近）。
   * 2. 状态：仅 running 可落真实终态；已终态 → idempotent（零副作用，stats 不重复写）。
   * 3. 拒绝非终态写入：status 传 'running' → no-match（本 API 只用于收尾）。
   * 4. 预期 childID：传入时必须与 job.sessionId 一致（job 未绑定时允许首次绑定）；
   *    已绑定且不一致 → 绑定对象已变更（await 竞态/新调用复用），旧候选不得更新新调用 → no-match。
   * 5. 唯一活动归属：预期 childID 下共享该 ID 的 running job 多于 1 → ambiguous no-op
   *    （绝不批量终结多个 active；已结束历史不参与计数）。
   * 6. 父会话隔离：callID 键含 parentSessionId，跨 parent 同名不串。
   * 7. terminal stats 只写一次：仅在 running → terminal 转换时 finalize + persistStats。
   */
  finalizeByCall(
    parentSessionId: string,
    callID: string,
    expectedChildId: string | undefined,
    status: TaskStatus,
  ): UpdateResult {
    const job = this.getJobByCall(parentSessionId, callID);
    if (!job) return { ok: false, reason: 'no-match' };
    if (job.status !== 'running') {
      // 已终态（重复终态事件/历史记录）：幂等 no-op，不重复改写、stats 不重复写
      return { ok: true, reason: 'idempotent', alias: job.alias };
    }
    if (status === 'running') {
      // 拒绝非终态写入：本 API 只用于收尾
      return { ok: false, reason: 'no-match' };
    }
    if (expectedChildId !== undefined) {
      if (job.sessionId !== '' && job.sessionId !== expectedChildId) {
        // 绑定对象已变更（await 竞态/新调用复用）：旧候选不得更新新调用
        return { ok: false, reason: 'no-match' };
      }
      if (job.sessionId === '') job.sessionId = expectedChildId; // 首次绑定
      // 唯一活动归属：共享该 childID 的 running job 数（已结束历史不计数）
      let runningShare = 0;
      for (const j of this.jobs.values()) {
        if (j.sessionId === expectedChildId && j.status === 'running') runningShare++;
      }
      if (runningShare === 0) return { ok: false, reason: 'no-match' }; // 理论上 job 自身已计入
      if (runningShare > 1) return { ok: false, reason: 'ambiguous' };
    }
    job.status = status;
    this.finalize(job);
    this.persistStats();
    return { ok: true, reason: 'ok', alias: job.alias };
  }

  /**
   * 生成 Background Job Board 文本。
   *
   * 必须显式传入父会话 ID，按 job.parentSessionId 精确过滤，不做任何全局回退：
   * 非 string（undefined / null / 数字等）或空串一律返回 ''。
   */
  getBoardText(parentSessionId: string): string {
    if (typeof parentSessionId !== 'string' || parentSessionId === '') return '';
    const activeJobs: JobRecord[] = [];
    const reusableJobs: JobRecord[] = [];

    for (const job of this.jobs.values()) {
      if (job.parentSessionId !== parentSessionId) continue;
      if (job.status === 'running') {
        activeJobs.push(job);
      } else if (job.background && job.status === 'completed' && !job.terminalReconciled) {
        reusableJobs.push(job);
      }
    }

    // 完全空态：什么都不注入
    if (activeJobs.length === 0 && reusableJobs.length === 0) return '';

    // 只有可复用 session，无活跃任务：返回极简一行文本
    if (activeJobs.length === 0) {
      const abbrMap: Record<string, string> = {
        'co-explorer': 'co-exp',
        'co-oracle': 'co-ora',
        'co-fixer': 'co-fix',
        'co-planner': 'co-pln',
        'co-designer': 'co-des',
        'co-librarian': 'co-lib',
        'co-observer': 'co-obs',
        'co-council': 'co-cnl',
      };
      const abbreviate = (agent: string): string =>
        abbrMap[agent] ?? (agent.startsWith('co-rule-') ? 'co-rul' : agent);

      const maxShow = 8;
      const shown = reusableJobs.slice(0, maxShow);
      const extra = reusableJobs.length - maxShow;

      const parts = shown.map(j => `${j.sessionId}(${abbreviate(j.agent)})`);
      let text = '复用: ' + parts.join(' ');
      if (extra > 0) {
        text += ` …及 ${extra} 个`;
      }
      return text;
    }

    // 有活跃任务：保持现有完整格式
    const lines: string[] = [];
    lines.push('### Background Job Board');
    lines.push('SENTINEL: background-job-board-v2');
    lines.push('Do not poll running jobs. Wait for hook-driven completion, or use cancel_task only for explicit cancellation. Reconcile terminal jobs before final response.');
    lines.push('To reuse a completed session, use its Session ID from the table below as task_id (e.g. `ses_xxx`). Passing an alias instead is silently ignored — OpenCode creates a new session instead of reusing.');
    lines.push('Cancelled or errored sessions are not reusable.');
    lines.push('');

    if (activeJobs.length > 0) {
      lines.push('#### Active / Unreconciled');
      const maxShow = 15;
      const shown = activeJobs.slice(0, maxShow);
      for (const j of shown) {
        lines.push(`  - ${j.agent} / ${j.status} / ${j.sessionId || 'pending'} / alias=${j.alias}`);
      }
      const extra = activeJobs.length - maxShow;
      if (extra > 0) {
        lines.push(`  …及 ${extra} 个任务未显示`);
      }
      lines.push('');
    }

    if (reusableJobs.length > 0) {
      lines.push('#### Reusable Sessions');
      lines.push('  Session ID                            | Agent        | Alias');
      lines.push('  ---------------------------------------|--------------|-------');
      const maxShow = 15;
      const shown = reusableJobs.slice(0, maxShow);
      for (const j of shown) {
        lines.push(`  \`${j.sessionId}\`  | ${j.agent}  | _${j.alias}_`);
      }
      const extra = reusableJobs.length - maxShow;
      if (extra > 0) {
        lines.push(`  …及 ${extra} 个任务未显示`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 标记任务已调和（不再显示在 Unreconciled 中）
   */
  reconcileJob(alias: string): void {
    const job = this.jobs.get(alias);
    if (job) {
      job.terminalReconciled = true;
    }
  }

  /**
   * 清理超时的背景任务（超过 timeoutMs 仍 running 的标为 errored）。
   *
   * 额外收集并返回这些超时任务的 sessionId 列表，供调用方真正执行 session.abort()。
   *
   * @returns 被标为 errored 的超时任务的 sessionId 列表（无 sessionId 的任务不包含）
   */
  cleanupStaleJobs(timeoutMs: number): string[] {
    const now = Date.now();
    const staleSessions: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.background && job.status === 'running' && (now - job.createdAt) > timeoutMs) {
        job.status = 'errored';
        this.finalize(job);
        if (job.sessionId) staleSessions.push(job.sessionId);
      }
    }
    this.persistStats();
    return staleSessions;
  }

  /**
   * 清理超龄终态任务：删除 terminalReconciled 且超过 olderThanMs 未更新的终态 job。
   * 绝不会删除 running/pending 的活跃任务。
   *
   * @param olderThanMs 超龄阈值（毫秒），超过此时间的终态任务会被删除
   * @returns 实际删除的任务数量
   */
  pruneTerminalJobs(olderThanMs: number): number {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [alias, job] of this.jobs) {
      if (job.terminalReconciled && job.status !== 'running' && (now - job.createdAt) > olderThanMs) {
        toDelete.push(alias);
      }
    }
    for (const alias of toDelete) {
      const job = this.jobs.get(alias);
      // 同步移除精确关联索引，避免残留悬空 callID（活动关联不受 TTL 影响）
      if (job?.callID) {
        this.callIndex.delete(this.callKey(job.parentSessionId, job.callID));
      }
      this.jobs.delete(alias);
    }
    return toDelete.length;
  }

  /**
   * 检查任务是否可复用
   */
  isReusable(alias: string): boolean {
    const job = this.jobs.get(alias);
    return job?.status === 'completed' && job.terminalReconciled;
  }

  /** 获取所有正在运行的 agent 类型列表 */
  getRunningAgents(parentSessionId: string): string[] {
    const agents = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.parentSessionId === parentSessionId && job.status === 'running') {
        agents.add(job.agent);
      }
    }
    return Array.from(agents);
  }

  /** 获取父会话下所有运行中的任务数量 */
  getRunningCount(parentSessionId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.parentSessionId === parentSessionId && job.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /** 根据子 session ID 查找完整 JobRecord */
  getJobBySessionId(sessionId: string): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        return job;
      }
    }
    return undefined;
  }

  /**
   * 质量回送：把任务质量度量写回 JobRecord（负反馈闭环）
   * 由 event hook 在 session.idle 时调用
   *
   * legacy 签名保留：按 sessionId 匹配，但**只允许安全单一匹配**——
   * 同一 sessionId 关联多个 job（复用历史/并发）时归属不明，安全 no-op 不猜。
   * 精确写回请使用 updateQualityByAlias（入口异步回调已持有捕获的 job.alias）。
   */
  updateQuality(sessionId: string, quality: NonNullable<JobRecord['quality']>): void {
    let hit: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        if (hit) return; // 多匹配：歧义不猜，no-op
        hit = job;
      }
    }
    if (hit) {
      hit.quality = quality;
      this.finalize(hit);
      this.persistStats();
    }
  }

  /**
   * 按 alias 精确写回质量（capture 质量异步回调已持有 job.alias 时使用）。
   * 未知 alias → no-match（不以 sessionId 首条匹配，绝不扩散到复用会话的新 alias）。
   */
  updateQualityByAlias(alias: string, quality: NonNullable<JobRecord['quality']>): UpdateResult {
    const job = this.jobs.get(alias);
    if (!job) return { ok: false, reason: 'no-match' };
    job.quality = quality;
    this.finalize(job);
    this.persistStats();
    return { ok: true, reason: 'ok', alias };
  }

  /**
   * 终态收尾：写入终态即视为「已与父会话核对」——两种语义在此对齐。
   *
   * `terminalReconciled` 有两处语义：
   * (a) Board 语义：终态任务不再出现在 `Reusable Sessions`（getBoardText 用它过滤）；
   * (b) prune 语义：允许 `pruneTerminalJobs()` 回收。
   *
   * 背景任务的完成路径是 `session.idle` → `updateByChildSessionId()` → `finalize()`，
   * 该路径原先不设本标记，而唯一的补设点是 `registerBeforeTask()` 的 `_reconciledForParent`
   * 分支（要求同一 parent **再次**注册任务）。会话切换/结束后旧 parent 不再注册，
   * 旧背景任务便永不满足 prune 条件 → 永久留在 jobs Map，且每轮 `getBoardText()` 都被遍历。
   *
   * 语义判断：finalize 只在这些终态写入路径上被调用（updateAfterTask 前台完成、
   * updateByChildSessionId、cleanupStaleJobs、updateQuality、markCancelled、abortJob），
   * 其中 markCancelled/abortJob 已经显式设过标记——即「进入终态」在本模块内本就
   * 等价于「已核对」，因此在 finalize 内统一补设语义是正确的，不是权宜之计。
   */
  private finalize(job: JobRecord): void {
    // 终态即视为已核对：保证任何终态路径都能被 pruneTerminalJobs 回收
    if (job.status !== 'running') {
      job.terminalReconciled = true;
    }
    const latencyMs = Date.now() - job.createdAt;
    if (!job.quality) {
      job.quality = { latencyMs };
    } else if (job.quality.latencyMs === undefined) {
      job.quality.latencyMs = latencyMs;
    }
  }

  /** 收集全部终态任务为统计记录（按创建时间升序） */
  private collectStatsRecords(): StatsRecord[] {
    const jobs = Array.from(this.jobs.values())
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.createdAt - b.createdAt);
    return jobs.map((job) => ({
      agent: job.agent,
      strategy: job.contextStrategy ?? defaultStrategyFor(job.agent),
      status: job.status,
      ...(job.quality?.latencyMs !== undefined ? { latencyMs: job.quality.latencyMs } : {}),
      ...(job.quality?.tokens ? { tokens: job.quality.tokens } : {}),
    }));
  }

  /** 当前统计（内存态，按 (strategy, agent) 聚合；window 为滑动窗口条数） */
  getStats(window: number = DEFAULT_STATS_WINDOW): StatsBucket[] {
    return computeStats(this.collectStatsRecords(), window);
  }

  /** 把最近 window 条统计记录持久化到 STATS_FILE，供 CLI stats 子命令读取 */
  persistStats(window: number = DEFAULT_STATS_WINDOW): void {
    try {
      const recent = this.collectStatsRecords().slice(-Math.max(1, window));
      writeJsonFileAtomic(STATS_FILE, recent);
    } catch {
      // 统计持久化失败不影响任务追踪主流程
    }
  }
  /** cancel_task 集成：根据别名或 sessionId 标记任务为已取消并 reconcile */
  markCancelled(taskId: string): void {
    let job = this.jobs.get(taskId);
    if (!job) {
      for (const j of this.jobs.values()) {
        if (j.sessionId === taskId) { job = j; break; }
      }
    }
    if (job) {
      job.status = 'cancelled';
      job.terminalReconciled = true;
      this.finalize(job);
      this.persistStats();
    }
  }

  /**
   * 只读解析取消目标（close_job 底层内部使用，不修改任何状态）。
   *
   * 取消语义（与 abortJob 的 session 收紧一致）：
   * - taskId 为 alias：直接命中该 job（**可能已终态**——调用方必须检查 job.status==='running'
   *   才执行真实 session.abort，旧 alias 命中已终态绝不得中止真实复用 session）；
   * - taskId 为 sessionId：只认**唯一活动 running**（已结束历史不抢当前）；
   *   多个 running 共享该 child → ambiguous（保守拒绝，绝不批量取消）；
   *   无 running → no-match（不返回历史，避免调用方 abort 复用中的真实 session）。
   *
   * @returns ok=true 返回目标 job；ok=false 且 reason='no-match' | 'ambiguous'
   */
  resolveCancelTarget(taskId: string): { ok: true; job: JobRecord } | { ok: false; reason: 'no-match' | 'ambiguous' } {
    const byAlias = this.jobs.get(taskId);
    if (byAlias) return { ok: true, job: byAlias };

    let active: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionId === taskId && job.status === 'running') {
        if (active) return { ok: false, reason: 'ambiguous' };
        active = job;
      }
    }
    return active ? { ok: true, job: active } : { ok: false, reason: 'no-match' };
  }

  /**
   * 按 alias 将仍 running 的任务落 cancelled（close_job 在真实 SDK abort 成功后调用）。
   * 未知 alias → no-match；已终态（竞态：abort 期间被其他路径终结）→ idempotent 零副作用，
   * 绝不把 completed/errored 改回 cancelled（不复活/变更历史）。
   */
  markCancelledByAlias(alias: string): UpdateResult {
    const job = this.jobs.get(alias);
    if (!job) return { ok: false, reason: 'no-match' };
    if (job.status !== 'running') {
      return { ok: true, reason: 'idempotent', alias };
    }
    job.status = 'cancelled';
    job.terminalReconciled = true;
    this.finalize(job);
    this.persistStats();
    return { ok: true, reason: 'ok', alias };
  }

  /**
   * 关闭（中止）一个卡住/不必要的子代理后台任务。
   *
   * 按 taskId 定位任务（安全兼容契约）：
   * - alias 直接命中 this.jobs（保持既有幂等守卫：已终态返回原状态不改写）；
   * - sessionId 路径：
   *   · 恰好 1 个 running → 命中该 active（已结束历史不抢当前）；
   *   · 多个 running 共享该 child → undefined（歧义拒绝，绝不批量取消）；
   *   · 无 running 且恰好 1 条匹配历史 → **幂等返回原状态**（旧调用方兼容——
   *     注意这不等于允许中止真实复用 session：job-control 走 resolveCancelTarget
   *     只认活动 running，不会据此对历史发 SDK abort）；
   *   · 无 running 且多条匹配历史 → undefined（歧义 no-op，绝不任取一条）；
   *   · 无任何匹配 → undefined。
   * 只做状态同步（running → cancelled 并 finalize/persist；已终态零副作用），
   * 返回真正的 sessionId 供调用方执行 session.abort()——本方法保持无 IO 依赖，便于单测。
   *
   * @param taskId 子 session ID（ses_xxx）或任务 alias（如 coe-1）
   * @returns 找到任务时返回 { sessionId, job }；歧义/未找到返回 undefined
   */
  abortJob(taskId: string): { sessionId?: string; job: JobRecord } | undefined {
    // alias 直接命中（已终态幂等守卫走 abortFound 原状态返回）
    const byAlias = this.jobs.get(taskId);
    if (byAlias) return this.abortFound(byAlias);

    // sessionId 路径：唯一 active 优先；无 running 时仅恰好一条匹配历史可幂等返回
    let active: JobRecord | undefined;
    let firstHistory: JobRecord | undefined;
    let historyCount = 0;
    for (const j of this.jobs.values()) {
      if (j.sessionId !== taskId) continue;
      if (j.status === 'running') {
        if (active) return undefined; // 多个 running：歧义拒绝
        active = j;
      } else {
        if (!firstHistory) firstHistory = j;
        historyCount++;
      }
    }
    if (active) return this.abortFound(active);
    if (historyCount === 1) return this.abortFound(firstHistory!); // 恰好一条历史：幂等原状态
    return undefined; // 多条历史歧义 / 无匹配
  }

  /** abortJob 共用落状态逻辑（保持既有幂等语义） */
  private abortFound(job: JobRecord): { sessionId?: string; job: JobRecord } {
    // 幂等守卫：已是终态的任务不再重复改写状态/统计（重复 abort 直接返回原状态）
    if (job.status !== 'running') {
      return { sessionId: job.sessionId || undefined, job };
    }

    job.status = 'cancelled';
    job.terminalReconciled = true;
    this.finalize(job);
    this.persistStats();

    return { sessionId: job.sessionId || undefined, job };
  }
}
