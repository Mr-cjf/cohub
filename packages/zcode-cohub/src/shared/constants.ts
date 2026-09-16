/**
 * 包内共享常量。
 *
 * 原先在 src/tracker.ts、src/hooks/job-board.ts、src/hooks/agent-tracker.ts、
 * src/hooks/grep-counter.ts 中各有重复定义，抽取到此避免值漂移。
 */

/**
 * 非终态任务（pending/running）的过期阈值：30 分钟。
 * MCP 进程收不到子代理的结束回调，超时任务只能视同已结束；
 * tracker 落盘前与 job-board 读侧共用此阈值做时间衰减。
 */
export const STALE_TASK_MS = 30 * 60 * 1000;

/** stdin 同步读取超时：3 秒（agent-tracker / grep-counter 共用）。 */
export const STDIN_TIMEOUT_MS = 3000;