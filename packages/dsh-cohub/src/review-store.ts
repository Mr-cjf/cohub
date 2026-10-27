// A2 复盘存储层：把「按轮统计」原子落盘到 <dshHome>/cohub/reviews/<cwdHash>/<sessionHash>/stats.json
//
// 设计事实依据：
//   · 路径根一律走 dshHomePath（与 src/env-signatures.ts:83 同一用法），不自己拼 ~/.dsh；
//   · cwd 为 null 时用固定目录名 "nocwd"，**不猜工作目录**（报告里的 project.cwd 保持可追溯）；
//   · sessionId 用 sha256 定长十六进制做目录名，避免路径穿越/非法字符；原始 sessionId 另存文件内互校；
//   · 写入原子替换（写 .tmp → rename），损坏文件改名 .corrupt 隔离 —— 绝不静默覆盖成默认值；
//   · 任何读写失败静默返回 false/null（同 env-signatures.ts:176-178 的容错风格），不影响主流程。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type { TurnSummary } from "./review-types.ts";

/** 落盘结构版本（结构不兼容时整体作废，不静默迁移） */
export const REVIEW_STATS_VERSION = 1;

/** stats.json 落盘结构：会话身份 + 按 turn 升序的轮次统计 + 采集缺口 */
export interface ReviewStatsFile {
  version: number;
  /** 原始 sessionId（目录名是其 hash，此处留原文便于人工互校） */
  sessionId: string;
  /** 原始 header.cwd；null 表示会话无 cwd（目录名为 "nocwd"） */
  cwd: string | null;
  /** 归属的根会话 id（子会话折叠到根；根会话即自身） */
  rootSessionId: string;
  /** 采集缺口说明（如 "subagent events not received for session X"） */
  gaps: string[];
  updatedAt: string;
  /** 按 turn 升序的轮次摘要（同一 turn 重放时以后到者覆盖） */
  turns: TurnSummary[];
}

/** cwd 目录名：sha256 前 16 位；cwd 缺失 → "nocwd"（不猜工作目录） */
export function cwdDirName(cwd: string | null | undefined): string {
  if (typeof cwd !== "string" || cwd.length === 0) return "nocwd";
  return createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
}

/** session 目录名：sha256 前 32 位（定长、无路径穿越字符） */
export function sessionDirName(sessionId: string): string {
  return createHash("sha256").update(String(sessionId), "utf8").digest("hex").slice(0, 32);
}

/** 复盘统计文件路径：<dshHome>/cohub/reviews/<cwdHash>/<sessionHash>/<fileName> */
export function reviewStorePath(
  cwd: string | null | undefined,
  sessionId: string,
  fileName = "stats.json",
): string {
  return dshHomePath("cohub", "reviews", cwdDirName(cwd), sessionDirName(sessionId), fileName);
}

/**
 * 读 stats：文件缺失 / 解析失败 / 版本或身份不符 → null（静默降级，不抛错）。
 * 解析失败（内容损坏）时把文件改名为 <file>.corrupt 隔离，保留证据不覆盖。
 */
export function loadStats(cwd: string | null | undefined, sessionId: string): ReviewStatsFile | null {
  const file = reviewStorePath(cwd, sessionId);
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text) as ReviewStatsFile;
    if (!parsed || typeof parsed !== "object") throw new Error("stats.json 结构不合法");
    if (parsed.version !== REVIEW_STATS_VERSION) throw new Error("stats.json 版本不符");
    // 身份互校：目录 hash 冲突或文件被换时拒绝使用（不把别人的统计当自己的）
    if (typeof parsed.sessionId !== "string" || parsed.sessionId !== sessionId) {
      throw new Error("stats.json sessionId 不匹配");
    }
    if (!Array.isArray(parsed.turns)) throw new Error("stats.json turns 不是数组");
    return parsed;
  } catch {
    isolateCorrupt(file);
    return null;
  }
}

/** 损坏文件改名隔离（.corrupt）；失败静默忽略 —— 隔离成功与否都不覆盖原内容 */
function isolateCorrupt(file: string): void {
  try {
    if (!existsSync(file)) return;
    renameSync(file, file + ".corrupt");
  } catch {
    /* 隔离失败也不抛：宁可不写，也不静默覆盖成默认值 */
  }
}

/**
 * 原子写 stats：mkdir -p → 写 <file>.tmp → rename 覆盖。
 * 失败返回 false（静默），绝不抛错影响 turn/end 主流程。
 */
export async function saveStats(
  cwd: string | null | undefined,
  sessionId: string,
  stats: ReviewStatsFile,
): Promise<boolean> {
  const file = reviewStorePath(cwd, sessionId);
  const tmp = file + ".tmp";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
    renameSync(tmp, file); // 同目录 rename：POSIX/Windows 均为替换语义，读端要么旧要么新
    return true;
  } catch {
    try {
      if (existsSync(tmp)) renameSync(tmp, tmp + ".failed");
    } catch { /* 清理失败不影响主流程 */ }
    return false;
  }
}
