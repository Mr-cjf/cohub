// ContextGuard 默认策略回归测试。
//
// 只对稳定策略结构、引用关系与关键不变量做静态断言（node:test 自动发现），
// 不做全文快照或大量逐句匹配，也不加载/模拟运行时引擎——
// 静态测试不能冒充模型真实遵循测试，这里只防止规范回退到旧的按角色默认附材料方案。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const contextGuard = () => read("skills/cohub/references/context-guard.md");
const efficiency = () => read("skills/cohub/references/efficiency.md");
const orchestrator = () => read("skills/co-orchestrator/SKILL.md");
const cohub = () => read("skills/cohub/SKILL.md");
const fixer = () => read("skills/co-fixer/SKILL.md");
const readme = () => read("README.md");

test("默认策略：全部角色默认 none，不按角色默认附材料", () => {
  const cg = contextGuard();
  // 默认表：全部代理角色 → none
  assert.match(cg, /^\| 全部代理角色 \|\s*`none`\s*\|/m);
  // 明确声明所有角色默认 none 且不按角色默认附加
  assert.match(cg, /所有角色均为 `none`/);
  assert.match(cg, /不按角色默认附加历史文件、决策、错误或依赖摘要/);
  // none 不是零任务信息
  assert.match(cg, /不是零任务信息/);
  // 旧的“策略列 + 角色枚举”默认映射行不得复现
  assert.doesNotMatch(cg, /^\|\s*`(none|relevant|summary)`\s*\|\s*co-/m);
});

test("relevant/summary 仅在显式选择时启用且保留软预算", () => {
  const cg = contextGuard();
  assert.match(cg, /仅当委派方在任务包中\*\*明确选择 `relevant` 或 `summary`\*\*/);
  assert.match(cg, /默认均为 `none`，仅在委派方明确选择时启用/);
  // 显式启用时仍保留既有数量与字符软预算
  for (const budget of [
    /相关文件片段 ≤5/,
    /已做决定 ≤10/,
    /报错 ≤5/,
    /依赖结论\s*≤\s*8/,
    /6000 Unicode 字符/,
    /软预算/,
  ]) {
    assert.match(cg, budget);
  }
});

test("dependsOn 只表达调度依赖；关键结论经任务指令必要输入交接，不依赖附加上下文", () => {
  const eff = efficiency();
  const cg = contextGuard();
  assert.match(eff, /`dependsOn` 只表达调度依赖，不自动传播摘要/);
  assert.match(cg, /`dependsOn` 只表达调度依赖，不自动传播摘要/);
  // 消费前序结果时，关键结论及来源写入任务指令的必要输入/约束（始终交接，与策略无关）
  assert.match(eff, /把关键结论及来源写入任务指令/);
  assert.match(cg, /把关键结论及来源写入任务指令/);
  // 默认 none 不阻断关键事实交接，也不因此自动切换策略
  assert.match(eff, /`none` 下同样完成关键事实交接/);
  assert.match(cg, /`none` 下同样完成关键事实交接/);
  assert.match(cg, /不因此自动切换策略/);
  // relevant/summary 只补充材料，不取代必要输入
  assert.match(cg, /`relevant`\/`summary` 仅补充材料/);
  // 任务模板的必要输入字段承载关键依赖结论及来源
  assert.match(cg, /必要输入 \/ 自行收集范围（确实消费前序结果时，承载关键依赖结论及来源）/);
});

test("目标只表达一次，必要输入/真实约束/验收明确，不填空壳字段", () => {
  const cg = contextGuard();
  const eff = efficiency();
  assert.match(cg, /目标（只表达一次）/);
  assert.match(eff, /目标（只表达一次）/);
  assert.match(eff, /任务指令与附加上下文分开/);
  assert.match(eff, /简单任务不生成仅重复目标的空壳契约，不填空字段/);
  assert.match(cg, /决策与验收必须来自真实输入或前序产出/);
  assert.match(fixer(), /目标只表达一次、必要输入、真实约束、验收/);
});

test("任务状态、回传字段与状态机保留完整", () => {
  const eff = efficiency();
  for (const key of ["goal", "decisions", "contracts", "writeOwners", "tasks", "checks", "blockers"]) {
    assert.match(eff, new RegExp(`"${key}"`), `状态结构字段 ${key}`);
  }
  for (const key of ["changedFiles", "checkEvidence", "artifactPaths", "status"]) {
    assert.match(eff, new RegExp(`"${key}"`), `回传字段 ${key}`);
  }
  assert.match(eff, /pending \/ running \/ implemented \/ completed \/ failed \/ blocked \/ cancelled/);
});

test("fork 规则与宿主边界保留：none ≠ fork_turns=none", () => {
  const eff = efficiency();
  assert.match(eff, /ContextGuard 的 `none` 与宿主 `fork_turns=none` 无关/);
  assert.match(eff, /`fork_turns=all` 继承原模型与推理设置/);
  assert.match(eff, /fork_turns=none/);
  assert.match(eff, /绝不修改主会话模型或 `ultra` 设置/);
  assert.match(eff, /插件不承诺宿主不继承历史/);
});

test("入口技能无旧默认映射冲突并引用共享真源", () => {
  const orc = orchestrator();
  const hub = cohub();
  const fx = fixer();
  // 旧的“必要摘要/片段默认附带”措辞不得复现
  assert.doesNotMatch(orc, /必要 ContextGuard 摘要\/片段/);
  // 引用共享真源而不是复制整套规则
  assert.match(orc, /\.\.\/cohub\/references\/(efficiency|context-guard)\.md/);
  assert.match(hub, /references\/context-guard\.md/);
  assert.match(fx, /\.\.\/cohub\/references\/context-guard\.md/);
  // none 仍是完整任务信息
  assert.match(orc, /`none` 仍是完整任务信息/);
  assert.match(fx, /`none` 不是零任务信息/);
  // 保留信息不足时反馈
  assert.match(fx, /明确向 Orchestrator 反馈/);
});

test("README 说明默认 none 行为与宿主边界", () => {
  const r = readme();
  assert.match(r, /所有角色 ContextGuard 默认 `none`/);
  assert.match(r, /不按角色默认附加历史文件、决策、错误或依赖摘要/);
  assert.match(r, /不等于 `fork_turns=none`/);
  assert.match(r, /`ultra` 设置保持不变/);
});
