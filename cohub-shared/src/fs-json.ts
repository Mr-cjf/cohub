/**
 * 泛型安全 JSON 文件读取。
 *
 * 统一 try { existsSync → readFileSync → JSON.parse → 结构校验 → return }
 * catch { return defaultValue } 模式，原先在 src/tracker.ts 与
 * src/hooks/grep-counter.ts 中各有重复。
 *
 * 注意：TaskTracker.load() 的恢复逻辑包含 aliasCounters 特殊处理，不改动。
 */

import * as fs from "node:fs";

/**
 * 安全读取 JSON 文件，失败时返回默认值。
 *
 * @param filePath    JSON 文件路径
 * @param defaultValue  文件不存在 / 解析失败 / 校验不通过时的回退值
 * @param validate   可选：通过 JSON.parse 后进一步校验结构，返回 false 则视作失败
 * @returns 解析后的对象或 defaultValue
 */
export function readJsonFileSafe<T>(
  filePath: string,
  defaultValue: T,
  validate?: (parsed: unknown) => parsed is T,
): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) {
      return defaultValue;
    }
    return parsed as T;
  } catch {
    return defaultValue;
  }
}