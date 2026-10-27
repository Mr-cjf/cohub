// dsh-cohub/test/skills-contract.ts —— 技能正文契约验证（无需 LLM、与 cwd 无关）
// 覆盖：orchestrator / planner / fixer / oracle 四角色验证纪律、成功证据复用安全条件 /
//       失败不当通过、先定向收敛/扩大理由/合理例外/不重复审查，并保留原有规则。
// 定位：用 import.meta.url 相对解析到 skills/*.md 磁盘正文（源文件），不依赖生成物 src/skills.ts，
//       因此 build 前后均可运行；运行结果与调用时的 cwd 无关。
// 用法：node test/skills-contract.ts（node >= 24 类型剥离）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));
const read = (name: string) => readFileSync(SKILLS_DIR + name + ".md", "utf-8");

const orchestrator = read("orchestrator");
const planner = read("planner");
const fixer = read("fixer");
const oracle = read("oracle");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}
function group(title: string) {
  console.log(`===== ${title} =====`);
}

// ---- 用例 1：orchestrator 验证节（范围 / 负责人 / 扩大条件） ----
group("用例 1：orchestrator 验证节（范围 / 负责人 / 扩大条件）");
check("验证节存在", orchestrator.includes("## 5. 验证"));
check("验证范围由委派 prompt 明确", orchestrator.includes("验证范围由委派 prompt 明确"));
check("负责人明确：T1/T2 由 co-fixer 自验（build + 相关测试）即完成", orchestrator.includes("co-fixer 自验") && orchestrator.includes("不追加 co-oracle 全量审查"));
check("追加条件：T3 / 公共导出等 → co-oracle；仅 UI 改动 → co-designer", orchestrator.includes("公共导出") && orchestrator.includes("权限与路径边界") && orchestrator.includes("只有 UI 改动的 T1/T2 才需 co-designer"));
check("修改 Wave 不自测", orchestrator.includes("不自测"));
check("批量修改后统一验证", orchestrator.includes("批量修改全部完成后统一验证"));
check("失败先集中归因", orchestrator.includes("集中归因"));
check("先定向修复最小范围", orchestrator.includes("定向修复") && orchestrator.includes("最小范围"));
check("通过后再按影响面扩大", orchestrator.includes("按影响面扩大"));
check("诊断/交互问题说明理由例外、不绝对禁止扩大", orchestrator.includes("例外") && orchestrator.includes("不绝对禁止扩大"));
check("保留原一次性编译验证", orchestrator.includes("多文件修改全部完成后一次性编译验证") && orchestrator.includes("不要每改一个文件跑一次"));

// ---- 用例 2：planner 验证步骤（范围 / 负责人 / 扩大条件） ----
group("用例 2：planner 验证步骤（范围 / 负责人 / 扩大条件）");
check("输出验证步骤条目存在", planner.includes("验证步骤"));
check("验证步骤列验证范围", planner.includes("验证范围"));
check("验证步骤列验证负责人", planner.includes("验证负责人"));
check("验证步骤列扩大条件", planner.includes("扩大条件"));
check("扩大条件含先定向收敛语义", planner.includes("定向修复") && planner.includes("按影响面扩大"));
check("扩大条件含合理例外", planner.includes("例外"));
check("保留并行化策略章节要求", planner.includes("并行化策略"));
// 迁移自 test/unit.ts：专责审查与并行判据的措辞现在只存在于 planner.md（orchestrator 只留分档与派发纪律），
// 故把「代码审查/UI 审查必须由专责代理执行」「并行按可独立验收而非文件数」这两条守卫迁到这里断言。
check("专责代码审查指向 co-oracle", planner.includes("co-oracle 代码审查"));
check("专责 UI 审查指向 co-designer", planner.includes("co-designer UI 审查"));
check("并行判据：可独立验收且无实依赖/写冲突", planner.includes("可独立执行验收") && planner.includes("无实依赖/写冲突"));
check("并行判据：不按文件数/复杂度拆任务", planner.includes("不按文件数"));
check("写冲突串行、独立只读可并行", planner.includes("同文件写冲突必须串行") && planner.includes("独立只读同文件可并行"));

// ---- 用例 3：fixer 委派范围纪律 ----
group("用例 3：fixer 委派范围纪律");
check("按委派范围执行", fixer.includes("按委派范围执行"));
check("不自行扩大为全量", fixer.includes("不自行扩大为全量"));
check("需扩大时回报目的/范围由主调度决定", fixer.includes("回报目的") && fixer.includes("扩大范围") && fixer.includes("主调度"));
check("报告真实退出码/日志位置/失败归因", fixer.includes("退出码") && fixer.includes("日志位置") && fixer.includes("失败归因"));
check("不截断错误信息", fixer.includes("不截断错误信息"));
check("保留被要求时编写/更新测试", fixer.includes("编写或更新测试"));
check("保留跳过验证须注明原因", fixer.includes("注明跳过及原因"));

// ---- 用例 4：oracle 不重复审查约束 ----
group("用例 4：oracle 不重复审查约束");
check("输入/审查范围/标准未变不重复全审", oracle.includes("不重复") && oracle.includes("全量审查"));
check("已有修复仅复核受影响部分", oracle.includes("仅复核") && oracle.includes("受影响部分"));
check("保留只读约束", oracle.includes("你提出建议，不实施"));
check("保留并行分析所有文件要求", oracle.includes("并行分析所有文件"));

// ---- 用例 5：成功证据复用安全条件 ----
group("用例 5：成功证据复用安全条件（orchestrator）");
check("仅复用成功完成的只读检查", orchestrator.includes("仅复用成功完成的只读检查"));
check("仍覆盖当前输入/源码与测试/配置", orchestrator.includes("仍覆盖当前输入/源码") && orchestrator.includes("测试/配置"));
check("仍覆盖完整范围/环境及外部状态", orchestrator.includes("完整范围") && orchestrator.includes("外部状态"));
check("证据不足就必要重验", orchestrator.includes("必要重验"));
check("不用 git diff 文件名未变判定同状态", orchestrator.includes("git diff 文件名未变判定同状态"));
check("不自动忽略 docs/config 影响", orchestrator.includes("docs/config"));

// ---- 用例 6：失败不当通过 / 重跑纪律 ----
group("用例 6：失败不当通过 / 重跑纪律（orchestrator）");
check("失败不是通过证据", orchestrator.includes("失败不是通过证据"));
check("无新变更/目标不机械重跑已知失败", orchestrator.includes("无新变更") && orchestrator.includes("机械重跑"));
check("先分析而非直接重跑", orchestrator.includes("先分析"));
check("保留 TDD/竞态/稳定性计划性重复", orchestrator.includes("TDD") && orchestrator.includes("竞态"));
check("不设永远全量一次硬上限", orchestrator.includes("硬上限"));
check("不引入测试缓存/helper/强制模型保证", orchestrator.includes("测试缓存") && orchestrator.includes("强制模型保证"));

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
