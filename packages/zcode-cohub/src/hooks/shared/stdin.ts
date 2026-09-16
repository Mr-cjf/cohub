/**
 * Hook 共享 stdin 读取工具。
 *
 * 原先在 src/hooks/agent-tracker.ts 与 src/hooks/grep-counter.ts 中各有逐字重复的
 * readStdinSync() 实现（含 TTY 检查、STDIN_TIMEOUT_MS 计时、fs.readSync 循环、
 * 异常容错、JSON.parse），唯一差异是 cast 到的本地 interface 名不同。
 * 抽取到此统一实现，避免 drift。
 */

import * as fs from "node:fs";
import { STDIN_TIMEOUT_MS } from "../../shared/constants.js";

/**
 * stdin JSON payload 公共接口（取 agent-tracker 与 grep-counter 的并集）。
 * 所有字段可选 + 索引签名，保证两个调用点原有的字段访问类型合法。
 */
export interface StdinPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

/**
 * 从 stdin 同步读取完整 JSON payload。
 * 通过 fs.readSync 循环读取全部可用字节，带超时保护。
 *
 * @returns 解析后的 payload，或 null（TTY / 无输入 / 解析失败）
 */
export function readStdinSync(): StdinPayload | null {
  const fd = process.stdin.fd;

  // TTY 说明无管道数据
  if (process.stdin.isTTY) return null;

  const start = Date.now();
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);

  try {
    let n: number;
    while (true) {
      if (Date.now() - start > STDIN_TIMEOUT_MS) break;
      n = fs.readSync(fd, buf, 0, 65536, null);
      if (n <= 0) break; // EOF
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // readSync 异常（如 EAGAIN）时尝试解析已读内容
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StdinPayload;
  } catch {
    return null;
  }
}