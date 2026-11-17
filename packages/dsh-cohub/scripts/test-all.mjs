#!/usr/bin/env node
// scripts/test-all.mjs —— dsh-cohub 统一测试入口
//
// 用法：node scripts/test-all.mjs [名字过滤子串]
//
// 行为：
//   1. 列出 test/ 顶层所有 *.ts 测试脚本（天然排除 test/types/ 与 tsconfig）；
//   2. 串行逐个用当前 node 原生剥离类型运行（node >= 24 默认支持，无需 loader）；
//   3. 每文件记录 PASS / FAIL 与耗时，失败时打印其输出末尾；
//   4. 汇总并让退出码真实反映结果（任一失败即 exit 1）。
//
// 依赖：测试脚本 import ../lib/index.js，因此需先 `bun run build`。

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(pkgRoot, "test");
const filter = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "";

const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".ts"))
  .filter((name) => !name.startsWith("tsconfig"))
  .filter((name) => name.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`❌ test/ 下未找到匹配的测试脚本${filter ? `（过滤：${filter}）` : ""}`);
  process.exit(1);
}

console.log(`=== test:all —— 共 ${files.length} 个测试脚本（node ${process.version}）===`);

const failed = [];
for (const [index, name] of files.entries()) {
  const rel = `test/${name}`;
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ["--no-warnings", path.join(testDir, name)], {
    cwd: pkgRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - startedAt;
  const code = result.status === null ? `signal:${result.signal ?? "unknown"}` : result.status;
  const ok = result.status === 0;

  console.log(`${String(index + 1).padStart(2)}/${files.length} ${ok ? "PASS" : "FAIL"} ${rel} (${ms}ms)`);

  if (!ok) {
    failed.push({ rel, code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  }
}

console.log("");
console.log(`=== 汇总：PASS ${files.length - failed.length}/${files.length}，FAIL ${failed.length} ===`);

if (failed.length > 0) {
  for (const item of failed) {
    console.log("");
    console.log(`----- FAIL ${item.rel} (exit ${item.code}) 输出末尾 -----`);
    const tail = (item.stdout + item.stderr).trimEnd().split("\n").slice(-25).join("\n");
    console.log(tail || "(无输出)");
  }
  process.exit(1);
}
