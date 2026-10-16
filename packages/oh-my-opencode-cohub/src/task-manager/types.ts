import type { ContextStrategy } from '../context/types';
import type { FailureCategory } from './quality';

export type TaskStatus = 'running' | 'completed' | 'errored' | 'cancelled';

export interface JobRecord {
  alias: string;            // 如 "fix-1", "exp-2"
  sessionId: string;        // 子代理 session ID（如有）
  parentSessionId: string;
  /** 精确关联：tool.execute 调用的 callID（registerBeforeTask 第三参传入）。缺省表示 legacy 无 callID 注册 */
  callID?: string;
  agent: string;            // 子代理类型（fixer/explorer/...）
  label: string;            // 任务描述
  status: TaskStatus;
  background: boolean;      // 是否是后台任务
  terminalReconciled: boolean;
  createdAt: number;        // Date.now()
  /** 此子代理的上下文策略 */
  contextStrategy?: ContextStrategy;
  /** 依赖的前置任务别名列表 */
  dependencies?: string[];
  /** 任务质量回送（负反馈闭环，见 quality.ts）；低分仅标记不改变成败判定 */
  quality?: {
    /** 0-1 质量评分；undefined 表示未执行 assessQuality（与 score:0 的"质量最差"语义区分） */
    score?: number;
    failureCategory?: FailureCategory;
    latencyMs?: number;                                 // 任务耗时
    tokens?: { input: number; output: number };
  };
}

export interface TaskArgs {
  description?: string;
  subagent_type?: string;
  task_id?: string;
  background?: boolean;
}

/**
 * 任务更新/关联操作的结果，供入口（index hook / 事件适配）观测原因。
 * - ok=true 且 reason='ok'：正常应用；reason='idempotent'：目标已达成、零副作用；
 *   reason='observed'：仅观测记录（不落终态）。
 * - ok=false：reason='no-match'（无对应任务）或 'ambiguous'（归属不明，安全 no-op）。
 */
export type UpdateReason = 'ok' | 'no-match' | 'ambiguous' | 'idempotent' | 'observed';

export interface UpdateResult {
  ok: boolean;
  reason: UpdateReason;
  /** 命中时返回具体 job 的 alias，供入口/测试精确断言 */
  alias?: string;
}
