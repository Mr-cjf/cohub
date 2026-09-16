/**
 * Tests for readJsonFileSafe — 安全 JSON 文件读取工具。
 * 使用真实临时文件，不 mock fs，每个用例独立创建并清理。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFileSafe } from "./fs-json.js";

describe("readJsonFileSafe", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "fsjson-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function touch(dir: string, name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content, "utf-8");
    return p;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("文件不存在 → 返回 defaultValue", () => {
    const dir = makeTempDir();
    const result = readJsonFileSafe(join(dir, "nonexistent.json"), "fallback");
    expect(result).toBe("fallback");
  });

  it("有效 JSON → 返回解析结果", () => {
    const dir = makeTempDir();
    const path = touch(dir, "data.json", JSON.stringify({ x: 1 }));
    const result = readJsonFileSafe<{ x: number }>(path, { x: 0 });
    expect(result).toEqual({ x: 1 });
  });

  it("有效 JSON + validate 通过 → 返回解析结果", () => {
    const dir = makeTempDir();
    const path = touch(dir, "data.json", JSON.stringify({ x: 42 }));
    const result = readJsonFileSafe<{ x: number }>(
      path,
      { x: 0 },
      (v: unknown): v is { x: number } =>
        typeof v === "object" && v !== null && "x" in v && typeof (v as any).x === "number",
    );
    expect(result).toEqual({ x: 42 });
  });

  it("有效 JSON + validate 不通过 → 返回 defaultValue", () => {
    const dir = makeTempDir();
    const path = touch(dir, "data.json", JSON.stringify({ y: 99 }));
    const result = readJsonFileSafe<{ x: number }>(
      path,
      { x: -1 },
      (v: unknown): v is { x: number } => false,
    );
    expect(result).toEqual({ x: -1 });
  });

  it("有效 JSON + validate 返回 null/false → 返回 defaultValue", () => {
    const dir = makeTempDir();
    const path = touch(dir, "data.json", JSON.stringify({ a: 1 }));
    const result = readJsonFileSafe<Record<string, number>>(
      path,
      { fallback: true },
      () => null as unknown as boolean, // falsy → fail
    );
    // null is falsy but not a boolean — the code does `if (validate && !validate(parsed))`
    // null → !null → true → returns defaultValue
    expect(result).toEqual({ fallback: true });
  });

  it("内容不是合法 JSON → 返回 defaultValue", () => {
    const dir = makeTempDir();
    const path = touch(dir, "broken.json", "{broken");
    const result = readJsonFileSafe(path, { safe: true });
    expect(result).toEqual({ safe: true });
  });

  it("空文件 → 返回 defaultValue", () => {
    const dir = makeTempDir();
    const path = touch(dir, "empty.json", "");
    const result = readJsonFileSafe(path, { empty: true });
    expect(result).toEqual({ empty: true });
  });

  it("不传 validate 时正常返回", () => {
    const dir = makeTempDir();
    const path = touch(dir, "ok.json", JSON.stringify([1, 2, 3]));
    const result = readJsonFileSafe<number[]>(path, []);
    expect(result).toEqual([1, 2, 3]);
  });
});