// dsh-port/test/preset-copy.ts —— 内置 preset 安装的递归复制单测（无需 LLM）
//
// 背景：installAgentPresets 原先只复制顶层文件，漏掉 preset 目录里的子目录；
// 而 cohub-cordis 自带 skills/（组合创作技能，由 skill-filesystem 的
// customSkillDirs 指向 preset 自身目录解析），漏复制会让该 preset 缺少技能。
// 本测覆盖 copyTree 的嵌套复制、内容一致性与幂等友好性（目标已存在时可写入）。
//
// 用法：bun run build && node test/preset-copy.ts（node >= 24）
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { copyTree } from "../lib/index.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}

const sandbox = join(import.meta.dirname, "..", ".tmp", "preset-copy-fixture");
const src = join(sandbox, "src-preset");
const dst = join(sandbox, "dst-preset");

// 构造带嵌套子目录的 preset 夹具（模拟 cohub-cordis：顶层文件 + skills/<name>/SKILL.md）
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(src, "skills", "editing-cordis-compositions"), { recursive: true });
mkdirSync(join(src, "skills", "cordis-plugin-development"), { recursive: true });
writeFileSync(join(src, "preset.yml"), "name: 夹具\norder: 9\n", "utf8");
writeFileSync(join(src, "agent.cordis.yml"), "- id: persona\n", "utf8");
writeFileSync(join(src, "skills", "editing-cordis-compositions", "SKILL.md"), "# editing\n嵌套内容A\n", "utf8");
writeFileSync(join(src, "skills", "cordis-plugin-development", "SKILL.md"), "# plugin dev\n嵌套内容B\n", "utf8");

copyTree(src, dst);

console.log("===== copyTree 递归复制 =====");
check("顶层 preset.yml 已复制", existsSync(join(dst, "preset.yml")));
check("顶层 agent.cordis.yml 已复制", existsSync(join(dst, "agent.cordis.yml")));
check("一层子目录文件已复制", existsSync(join(dst, "skills", "editing-cordis-compositions", "SKILL.md")));
check("第二个子目录文件已复制", existsSync(join(dst, "skills", "cordis-plugin-development", "SKILL.md")));
check("顶层文件内容一致",
  readFileSync(join(dst, "preset.yml"), "utf8") === readFileSync(join(src, "preset.yml"), "utf8"));
check("嵌套文件内容一致",
  readFileSync(join(dst, "skills", "editing-cordis-compositions", "SKILL.md"), "utf8")
    === readFileSync(join(src, "skills", "editing-cordis-compositions", "SKILL.md"), "utf8"));

console.log("===== 目标已存在时可写入（installAgentPresets 幂等路径不调用，但需不抛错） =====");
let threw = false;
try {
  copyTree(src, dst); // 覆盖同一目标：应成功而非抛 EEXIST
} catch (e) {
  threw = true;
  console.log("    异常:", (e as Error).message);
}
check("重复复制不抛错", !threw);
check("重复复制后内容仍一致",
  readFileSync(join(dst, "skills", "cordis-plugin-development", "SKILL.md"), "utf8") === "# plugin dev\n嵌套内容B\n");

console.log("===== 真实 preset 目录结构（cohub-cordis） =====");
const realPreset = join(import.meta.dirname, "..", "presets", "cohub-cordis");
check("presets/cohub-cordis 存在", existsSync(realPreset));
check("preset.yml 存在", existsSync(join(realPreset, "preset.yml")));
check("agent.cordis.yml 存在", existsSync(join(realPreset, "agent.cordis.yml")));
check("自带 editing-cordis-compositions 技能", existsSync(join(realPreset, "skills", "editing-cordis-compositions", "SKILL.md")));
check("自带 cordis-plugin-development 技能", existsSync(join(realPreset, "skills", "cordis-plugin-development", "SKILL.md")));

// 清理夹具（保留真实目录不动）
rmSync(sandbox, { recursive: true, force: true });

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
