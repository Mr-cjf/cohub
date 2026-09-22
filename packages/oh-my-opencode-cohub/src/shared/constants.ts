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
 */
export const WALL_CLOCK_BUDGET_MS = 600_000;

/**
 * 非终态任务（pending/running）过期阈值：30 分钟。
 * 使用位置：oh-my-opencode-cohub `STALE_TIMEOUT_MS`（src/index.ts）。
 */
export const STALE_TASK_MS = 30 * 60 * 1000;


