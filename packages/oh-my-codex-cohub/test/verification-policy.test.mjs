// 验证策略契约回归测试。
//
// 只对稳定策略结构做静态断言（node:test 自动发现），不加载/模拟运行时引擎：
// 静态契约只证文字，不保证模型行为。避免整段快照，只锚定关键条款短语。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const planner = () => read("skills/co-planner/SKILL.md");
const fixer = () => read("skills/co-fixer/SKILL.md");
const orchestrator = () => read("skills/co-orchestrator/SKILL.md");
const oracle = () => read("skills/co-oracle/SKILL.md");
const batch = () => read("skills/cohub/references/batch-execution.md");

test("planner 分层验证条目逐项列明验证范围、负责人与扩大条件", () => {
  const p = planner();
  assert.match(p, /分层验证条目/);
  assert.match(p, /逐项列明验证范围、负责人与扩大条件/);
});

test("fixer 验证遵循委派范围，不自行扩大，扩大由主调度决策", () => {
  const f = fixer();
  assert.match(f, /验证遵循委派范围，不自行扩大为全量/);
  assert.match(f, /确需扩大时说明目的与范围，由主调度决策/);
});

test("fixer 保留成功只读证据复用条件与外部状态门槛", () => {
  const f = fixer();
  assert.match(f, /仅当成功的只读检查证据仍覆盖相同输入、范围和环境时复用/);
  assert.match(f, /外部状态或后台任务未结束时不得复用/);
});

test("fixer 保留合理复验例外，不设绝对一次上限", () => {
  const f = fixer();
  assert.match(f, /用户要求、TDD、竞态\/稳定性计划性重复、相关变更或明确诊断目的可合理复验/);
});

test("orchestrator 失败只阻断下游，只修复失败任务及受影响任务并复核受影响检查", () => {
  const o = orchestrator();
  assert.match(o, /失败只阻断下游/);
  assert.match(o, /只修复失败任务及受影响任务/);
  assert.match(o, /失败时提供具体证据和归属范围，完成后复核受影响检查/);
});

test("batch-execution 统一验证不逐项重复构建，失败后只重跑受影响检查", () => {
  const b = batch();
  assert.match(b, /通过后不因每项交付而重复同一整套构建/);
  assert.match(b, /修复完成后重跑受影响的检查/);
});

test("oracle 输入 diff 未变化且范围不变时不重复审查", () => {
  const o = oracle();
  assert.match(o, /输入 diff 未变化且审查范围不变时不重复审查/);
  assert.match(o, /新增修复或变更再复核受影响部分/);
});
