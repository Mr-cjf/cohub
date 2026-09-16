/**
 * Tests for readStdinSync — Hook 共享 stdin 读取工具。
 *
 * 约束：进程内的 stdin readSync 在无管道数据时会阻塞，测试不得阻塞等待。
 *
 * 覆盖：
 * - TTY → 返回 null
 *
 * 未覆盖（需要子进程管道注入，超出本任务范围）：
 * - 正常管道 JSON 输入路径
 * - 管道空数据（isTTY=false + chunks.length=0 → null）
 * - JSON 解析失败 → null
 */

import { describe, it, expect } from "bun:test";
import { readStdinSync } from "./stdin.js";

describe("readStdinSync", () => {
  it("isTTY 为 true 时返回 null", () => {
    const saved = process.stdin.isTTY;
    try {
      // 模拟 TTY 环境（无管道数据）
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
        writable: true,
      });
      const result = readStdinSync();
      expect(result).toBeNull();
    } finally {
      // 恢复原始值
      Object.defineProperty(process.stdin, "isTTY", {
        value: saved,
        configurable: true,
        writable: true,
      });
    }
  });
});