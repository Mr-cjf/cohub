// ⚠️ 本文件由 cohub-shared/src/log.ts 自动同步生成，请勿直接编辑。
// 修改请改 cohub-shared/src/log.ts，然后运行 bun cohub-shared/sync.ts
/**
 * 跨包共享诊断日志工具。
 *
 * 以 oh-my-opencode-cohub 版为基（功能超集），将平台差异参数化：
 * - 日志目录（opencode vs dsh vs 其它）
 * - 文件前缀 / tag
 * - 是否按天轮转 + 保留天数
 * - 同步 / 异步写入
 *
 * 纯 node:fs / node:path 实现，零平台 API 依赖。
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ============================================================
// 类型
// ============================================================

export interface LogConfig {
  /** 日志目录（必填） */
  logDir: string;
  /** 日志文件前缀（必填，如 "oh-my-opencode-cohub" 或 "dsh-cohub"） */
  prefix: string;
  /**
   * 标签前缀，写入行内 `[prefix]` 段（默认同 prefix）。
   * 用于日志行内标识，与文件名前缀可不同。
   */
  linePrefix?: string;
  /** 按天轮转：文件名后缀 YYYYMMDD（默认 true） */
  dailyRotate?: boolean;
  /** 旧日志保留天数（默认 7；dailyRotate=false 时忽略） */
  keepDays?: number;
  /** true = 异步 fs.promises.appendFile，false = 同步 fs.appendFileSync（默认 true） */
  async?: boolean;
}

export interface LogFn {
  /**
   * @param tag     标签（如 hook 名称、函数名）
   * @param message 描述信息
   * @param err     可选，错误对象，存在时自动追加 err.stack
   */
  (tag: string, message: string, err?: unknown): void | Promise<void>;
}

// ============================================================
// 工厂
// ============================================================

export function createLogger(cfg: LogConfig): LogFn {
  const logDir = cfg.logDir;
  const prefix = cfg.prefix;
  const linePrefix = cfg.linePrefix ?? cfg.prefix;
  const dailyRotate = cfg.dailyRotate ?? true;
  const keepDays = cfg.keepDays ?? 7;
  const useAsync = cfg.async ?? true;

  // 运行时缓存当天日期（仅 dailyRotate 模式有效）
  let today = "";
  let logPath = "";
  let cleanedToday = false;

  function getLogPath(): string {
    if (!dailyRotate) {
      return path.join(logDir, `${prefix}.log`);
    }
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (d !== today) {
      today = d;
      logPath = path.join(logDir, `${prefix}.${d}.log`);
      cleanedToday = false;
    }
    return logPath;
  }

  /** 清理 keepDays 天前的旧日志文件（每天仅执行一次） */
  function cleanOldLogsOnce(): void {
    if (!dailyRotate) return;
    // 先触发 getLogPath() 以更新 today（确保跨天时 cleanedToday 被重置）
    getLogPath();
    if (cleanedToday) return;
    cleanedToday = true;

    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, "");

      const files = fs.readdirSync(logDir);
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped}\\.(\\d{8})\\.log$`);
      for (const file of files) {
        const match = file.match(re);
        if (!match) continue;
        if (match[1] < cutoffStr) {
          try { fs.unlinkSync(path.join(logDir, file)); } catch { /* ignore */ }
        }
      }
    } catch {
      // 清理失败静默忽略（如目录不存在）
    }
  }

  function formatLine(tag: string, message: string, err?: unknown): string {
    const now = new Date().toISOString();
    let line = `[${now}] [${linePrefix}] [${tag}] ${message}`;
    if (err instanceof Error) {
      line += `\n  stack: ${err.stack ?? err.message}`;
    } else if (err !== undefined) {
      line += `\n  detail: ${String(err)}`;
    }
    line += "\n";
    return line;
  }

  // 异步版
  if (useAsync) {
    async function appendLogAsync(
      tag: string,
      message: string,
      err?: unknown,
    ): Promise<void> {
      try {
        const lp = getLogPath();
        await fsp.mkdir(logDir, { recursive: true });
        const line = formatLine(tag, message, err);
        await fsp.appendFile(lp, line, "utf-8");
        if (dailyRotate) cleanOldLogsOnce();
      } catch {
        // 日志写入自身失败，静默忽略
      }
    }
    return appendLogAsync;
  }

  // 同步版
  function appendLogSync(tag: string, message: string, err?: unknown): void {
    try {
      const lp = getLogPath();
      fs.mkdirSync(logDir, { recursive: true });
      const line = formatLine(tag, message, err);
      fs.appendFileSync(lp, line, "utf-8");
      if (dailyRotate) cleanOldLogsOnce();
    } catch {
      // 日志写入自身失败，静默忽略
    }
  }
  return appendLogSync;
}