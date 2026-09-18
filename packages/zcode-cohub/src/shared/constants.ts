// ⚠️ 本文件由 cohub-shared/src/constants.ts 自动同步生成，请勿直接编辑。
// 修改请改 cohub-shared/src/constants.ts，然后运行 bun cohub-shared/sync.ts
/**
 * 跨包共享常量。
 *
 * 原先在各包的多个源文件中存在相同魔数的重复定义，此处统一为单一权威源。
 * 各包消费者后续从 `cohub-shared` 导入以消除值漂移风险。
 */

/**
 * Council（多模型共识）单次超时：3 分钟。
 * 使用位置：dsh-cohub（council 执行超时 / councilTimeoutMs 配置默认值）、
 * oh-my-opencode-cohub（council + adaptive-params default）。
 *
 * ⚠️ dsh-cohub `delegate.ts` 的 `idleMs`（约 L151 / L455）数值同为 180_000，
 * 但它是**停滞检测的空闲阈值**（StallDetector S2），语义与本常量无关，勿并入。
 */
export const COUNCIL_TIMEOUT_MS = 180_000;

/**
 * 单次执行单元墙钟预算：10 分钟。
 * 使用位置：dsh-cohub（schedule wallClockBudgetMs / env-signatures wallClockLimitMs）。
 *
 * ⚠️ zcode-cohub `tracker.ts` 的 `cleanupStaleJobs(timeoutMs)` / `pruneTerminalJobs(maxAgeMs)`
 * 默认值数值同为 600_000，但那是**任务生命周期阈值**（非终态过期 / 终态超龄删除），
 * 语义与本常量无关，勿并入。
 */
export const WALL_CLOCK_BUDGET_MS = 600_000;

/**
 * 非终态任务（pending/running）过期阈值：30 分钟。
 * 使用位置：
 * - oh-my-opencode-cohub `STALE_TIMEOUT_MS`（src/index.ts）
 * - zcode-cohub `src/shared/constants.ts`（由 sync 从本文件生成，消费方为
 *   src/tracker.ts 与 src/hooks/job-board.ts）
 */
export const STALE_TASK_MS = 30 * 60 * 1000;

/**
 * stdin 同步读取超时：3 秒。
 * 使用位置：zcode-cohub `src/hooks/shared/stdin.ts`（同步读取循环），
 * 由 agent-tracker / grep-counter 两个 hook 共用该模块。
 *
 * 说明：此常量**目前仅 zcode 使用**；纳入共享层是因为其消费者
 * `src/hooks/shared/stdin.ts` 需与 zcode 的常量同源，故一并统一维护。
 */
export const STDIN_TIMEOUT_MS = 3000;
