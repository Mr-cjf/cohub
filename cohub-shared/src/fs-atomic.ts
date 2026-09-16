/**
 * 原子写：先写临时文件再 rename，避免读端拿到撕裂的 JSON。
 *
 * 采用 src/tracker.ts 的完整版语义：出错 re-throw、finally 清理。
 * 调用方（如 tracker.ts persist、grep-counter.ts writeGrepCounterState）外层
 * 均有 try/catch 兜底，re-throw 不会改变外部可观测行为。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // rename 失败时尽力清理临时文件
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    // 确保成功路径下 .tmp 已被 rename 消耗、失败路径下也已尽力删除
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/** 将 data 序列化为 JSON 后原子写入文件。 */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}