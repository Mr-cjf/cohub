/**
 * 包内共享路径工具（getStateDir / getTrackerFilePath）。
 *
 * 原先在 src/tracker.ts 与 src/hooks/grep-counter.ts 中各有重复实现，
 * 抽取到此避免 drift。
 */

import * as os from "node:os";
import * as path from "node:path";

/** 插件状态目录路径 */
export function getStateDir(): string {
  const zcodeHome = process.env.ZCODE_HOME
    ? path.resolve(process.env.ZCODE_HOME)
    : path.join(os.homedir(), ".zcode");
  return path.join(zcodeHome, "cli", "plugins", "data", "zcode-cohub@local");
}

/** Tracker 状态文件路径 */
export function getTrackerFilePath(): string {
  return path.join(getStateDir(), "tracker-state.json");
}