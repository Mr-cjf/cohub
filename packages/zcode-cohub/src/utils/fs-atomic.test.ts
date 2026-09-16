/**
 * Tests for writeFileAtomic — 原子写工具。
 * 使用真实临时文件，验证 .tmp 无残留、mkdir 自动创建、正常写入。
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, readFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./fs-atomic.js";

describe("writeFileAtomic", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "fsatomic-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("正常写入 → 目标文件存在且内容正确", () => {
    const dir = makeTempDir();
    const target = join(dir, "output.json");
    const data = JSON.stringify({ hello: "world" });

    writeFileAtomic(target, data);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(data);
  });

  it("写入后无 .tmp 残留文件", () => {
    const dir = makeTempDir();
    const target = join(dir, "data.txt");
    const data = "hello atomic";

    writeFileAtomic(target, data);

    const tmpFile = target + ".tmp";
    expect(existsSync(tmpFile)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("父目录不存在时自动创建", () => {
    const dir = makeTempDir();
    const target = join(dir, "deep", "nested", "file.json");
    const data = JSON.stringify({ deep: true });

    writeFileAtomic(target, data);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(data);
  });

  it("覆盖已有文件时内容被替换", () => {
    const dir = makeTempDir();
    const target = join(dir, "config.json");

    // 先写入旧内容
    writeFileAtomic(target, JSON.stringify({ version: 1 }));
    // 再写入新内容覆盖
    writeFileAtomic(target, JSON.stringify({ version: 2 }));

    const content = JSON.parse(readFileSync(target, "utf-8"));
    expect(content).toEqual({ version: 2 });
  });
});