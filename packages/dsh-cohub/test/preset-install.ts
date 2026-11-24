// dsh-port/test/preset-install.ts —— 内置 preset 安装/升级台账单测（无需 LLM）
//
// 覆盖（对应 A 的两条不变式）：
//   1. 升级不能丢修复：包内文件更新后，未被用户改动的文件必须被覆盖；
//   2. 升级不能踩用户：用户改过的文件必须跳过，且其改动被保留。
// 另覆盖：递归复制（子目录）、无台账降级为「仅新增」、installPresets=false 不触碰用户目录。
//
// 用法：bun run build && node test/preset-install.ts（node >= 24）
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// lib/ 是 bun 产物（无 .d.ts）。allowJs 的 JS 推断对这几个 API 过窄（如 never[] / 缺 degraded），
// 故在**产物边界**按 any 使用；这些 API 的类型正确性由 bun run typecheck:src（src 源）覆盖。
import * as libBuild from "../lib/index.js";
const { installShippedPresets, removeInstallRecord, hashTree, buildPresetPatchDeclarations, applyPresetPatchDeclarations, resolveProfilePatchPath }: any =
  libBuild;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}
const read = (p: string) => readFileSync(p, "utf8");

const sandbox = join(import.meta.dirname, "..", ".tmp", "preset-install-fixture");
const shipped = join(sandbox, "shipped");
const userRoot = join(sandbox, "user", ".agent-presets");

/** 构造包内 preset 目录：demo/（顶层两个文件 + 嵌套技能） */
function writeShipped(version: string) {
  rmSync(shipped, { recursive: true, force: true });
  mkdirSync(join(shipped, "demo", "skills", "creator"), { recursive: true });
  writeFileSync(join(shipped, "demo", "preset.yml"), `name: Demo\norder: 9\nversion: ${version}\n`, "utf8");
  writeFileSync(join(shipped, "demo", "agent.cordis.yml"), `# shipped ${version}\n`, "utf8");
  writeFileSync(join(shipped, "demo", "skills", "creator", "SKILL.md"), `# skill ${version}\n`, "utf8");
}

rmSync(sandbox, { recursive: true, force: true });

// ---- 场景 1：首次安装（无台账）→ 整目录复制（含子目录） + 写入台账 ----
console.log("===== 场景 1：首次安装 =====");
writeShipped("1.0.0");
let r = installShippedPresets(shipped, userRoot, "0.4.7");
check("installed 含 demo", r.installed.includes("demo"));
check("updated 为空", r.updated.length === 0);
check("顶层文件已装", existsSync(join(userRoot, "demo", "preset.yml")));
check("嵌套技能已装（递归复制）", existsSync(join(userRoot, "demo", "skills", "creator", "SKILL.md")));
check("内容与包内一致", read(join(userRoot, "demo", "preset.yml")) === read(join(shipped, "demo", "preset.yml")));
const recordFile = join(sandbox, "user", ".cohub-preset-install.json");
check("台账写在 preset root 的上一级", existsSync(recordFile));
check("台账不在 preset root 内（不会被 roster 当成 preset）", !existsSync(join(userRoot, ".cohub-preset-install.json")));

// ---- 场景 2：同版本再次加载 → 不动 ----
console.log("===== 场景 2：同版本重复加载（幂等） =====");
r = installShippedPresets(shipped, userRoot, "0.4.7");
check("installed 为空", r.installed.length === 0);
check("updated 为空", r.updated.length === 0);
check("skipped 为空", r.skipped.length === 0);

// ---- 场景 3：用户改动其中一个文件，包内发布新版本 → 改动保留、其余更新 ----
console.log("===== 场景 3：升级（用户改过 agent.cordis.yml） =====");
writeFileSync(join(userRoot, "demo", "agent.cordis.yml"), "# 用户本地魔改\n", "utf8");
writeShipped("2.0.0");
r = installShippedPresets(shipped, userRoot, "0.4.8");
check("updated 含 demo", r.updated.includes("demo"));
check("skipped 精确到文件", r.skipped.includes("demo/agent.cordis.yml"));
check("用户改动被保留", read(join(userRoot, "demo", "agent.cordis.yml")) === "# 用户本地魔改\n");
check("未改动文件被更新到 2.0.0", read(join(userRoot, "demo", "preset.yml")).includes("version: 2.0.0"));
check("嵌套技能也被更新", read(join(userRoot, "demo", "skills", "creator", "SKILL.md")).includes("skill 2.0.0"));

// ---- 场景 4：用户改动的文件在下次升级仍被识别（台账保留旧哈希） ----
console.log("===== 场景 4：再次升级，用户改动继续被保护 =====");
writeShipped("3.0.0");
r = installShippedPresets(shipped, userRoot, "0.4.9");
check("用户文件仍被跳过", r.skipped.includes("demo/agent.cordis.yml"));
check("用户改动仍在", read(join(userRoot, "demo", "agent.cordis.yml")) === "# 用户本地魔改\n");
check("其他文件跟进到 3.0.0", read(join(userRoot, "demo", "preset.yml")).includes("version: 3.0.0"));

// ---- 场景 5：删除台账（模拟旧版本升级上来）→ 只新增，不覆盖既有目录 ----
console.log("===== 场景 5：无台账降级为「仅新增」 =====");
removeInstallRecord(userRoot);
writeShipped("4.0.0");
r = installShippedPresets(shipped, userRoot, "0.5.0");
check("降级首次调用不动已存在目录", r.installed.length === 0 && r.updated.length === 0);
check("既有目录内容保持 3.0.0", read(join(userRoot, "demo", "preset.yml")).includes("version: 3.0.0"));
check("用户改动仍未被踩", read(join(userRoot, "demo", "agent.cordis.yml")) === "# 用户本地魔改\n");
mkdirSync(join(shipped, "brand-new"), { recursive: true });
writeFileSync(join(shipped, "brand-new", "preset.yml"), "name: New\n", "utf8");
r = installShippedPresets(shipped, userRoot, "0.5.0");
check("新增 preset 被安装", r.installed.includes("brand-new") && existsSync(join(userRoot, "brand-new", "preset.yml")));
// 回归：降级安装**不得**把「已存在但非本插件安装」的目录记入台账 ——
// 否则下一次加载会把它当「未记录 = 首次安装」而覆盖用户/旧版内容。
check("降级不把既有目录记入台账（不被误当首次安装）", !r.installed.includes("demo"));
check("降级后既有目录内容仍未被覆盖", read(join(userRoot, "demo", "preset.yml")).includes("version: 3.0.0"));

// ---- 场景 6：台账损坏 → 不崩，退化为「仅新增」 ----
console.log("===== 场景 6：台账损坏降级 =====");
writeFileSync(recordFile, "{ 这不是合法 JSON", "utf8");
let threw = false;
try {
  r = installShippedPresets(shipped, userRoot, "0.6.0");
} catch (e) {
  threw = true;
  console.log("    异常:", (e as Error).message);
}
check("损坏台账不抛错", !threw);
check("降级后既有目录仍未被覆盖", read(join(userRoot, "demo", "preset.yml")).includes("version: 3.0.0"));
check("降级原因被上报", typeof r.degraded === "string" && r.degraded.length > 0);

// ---- 场景 7：真实包内 preset 的哈希可计算（防 preset 目录被误判为空） ----
console.log("===== 场景 7：真实 presets 目录 =====");
const realPresets = join(import.meta.dirname, "..", "presets");
const realHashes = hashTree(join(realPresets, "cohub-cordis"));
check("cohub-cordis 哈希含 agent.cordis.yml", Object.keys(realHashes).some((k) => k === "agent.cordis.yml"));
check("cohub-cordis 哈希含嵌套技能", Object.keys(realHashes).some((k) => k.endsWith("SKILL.md")));
check("两个内置 preset 目录都在（cohub-standard 已被 cohub-cordis 取代）", ["co-orchestrator", "cohub-cordis"].every((n) => existsSync(join(realPresets, n))));

// ---- 场景 8：孤儿清理（包内删除 preset → 移除已安装目录；但不碰用户自建目录） ----
console.log("===== 场景 8：孤儿清理 =====");
const sandbox2 = join(import.meta.dirname, "..", ".tmp", "preset-orphan-fixture");
const shipped2 = join(sandbox2, "shipped");
const userRoot2 = join(sandbox2, "user", ".agent-presets");
rmSync(sandbox2, { recursive: true, force: true });
for (const n of ["legacy", "keep"]) {
  mkdirSync(join(shipped2, n), { recursive: true });
  writeFileSync(join(shipped2, n, "preset.yml"), `name: ${n}\n`, "utf8");
}
installShippedPresets(shipped2, userRoot2, "0.4.7");
check("两个 preset 均已安装", existsSync(join(userRoot2, "legacy")) && existsSync(join(userRoot2, "keep")));
// 用户自建目录（不在台账里）绝不能被清理
mkdirSync(join(userRoot2, "my-own"), { recursive: true });
writeFileSync(join(userRoot2, "my-own", "preset.yml"), "name: 用户自建\n", "utf8");
rmSync(join(shipped2, "legacy"), { recursive: true, force: true }); // 新版包内删掉 legacy
let r8 = installShippedPresets(shipped2, userRoot2, "0.4.8");
check("孤儿（不再随包发布）被移除", r8.removed.includes("legacy") && !existsSync(join(userRoot2, "legacy")));
check("仍在包内的 preset 保留", existsSync(join(userRoot2, "keep")));
check("用户自建目录不被误删", existsSync(join(userRoot2, "my-own", "preset.yml")));
r8 = installShippedPresets(shipped2, userRoot2, "0.4.8");
check("孤儿清理幂等", r8.removed.length === 0);
rmSync(sandbox2, { recursive: true, force: true });

// ---- 场景 9：preset 声明幂等写入 profile 的 cordis.patch.yml（① 空 patch ② 幂等 ③ 冲突 ④ 备份/开关） ----
// 全部在仓库 .tmp 沙箱里模拟 profile，绝不触碰真实的 ~/.dsh。
console.log("===== 场景 9：profile patch 声明写入 =====");
const homeDir = join(sandbox, "home");
const profileRoot = join(homeDir, "profiles", "test-profile");
const patchPath = join(profileRoot, "cordis.patch.yml");
const decls = buildPresetPatchDeclarations(realPresets);
check("声明可从包内 presets 目录生成（4 档位 + 2 主代理 = 6 条）", decls.length === 6);
check("每条声明都带 config.id", decls.every((d: any) => d.text.includes(`        id: ${d.id}`)));
check("声明插件行来自 agent.cordis.yml（含 persona）", decls.every((d: any) => d.text.includes("@deepseek-ai/dsh-persona")));

// ① 空 patch（文件不存在）：追加全部声明
mkdirSync(profileRoot, { recursive: true });
let pr = applyPresetPatchDeclarations(realPresets, patchPath, { warn() {}, info() {} });
const t1 = read(patchPath);
check("① 空 patch 追加全部声明", pr.appended.length === decls.length && existsSync(patchPath));
check("① 每条 - id: preset-<id> 都落盘", decls.every((d: any) => t1.includes(`    - id: preset-${d.id}`)));
check("① 原文件不存在 → 不产生备份", pr.backup === undefined);

// ② 已存在同 id 同内容 → 不重复、字节不变
pr = applyPresetPatchDeclarations(realPresets, patchPath, { warn() {} });
check("② 第二次不追加", pr.appended.length === 0);
check("② 全部判定为 unchanged", pr.unchanged.length === decls.length);
check("② 文件字节完全不变", read(patchPath) === t1);
check("② 无改动不写盘 → 无备份", pr.backup === undefined);

// ③ 已存在但内容不同 → 保留用户版 + warning，不覆盖
const edited = t1.replace("fetch: true", "fetch: false");
writeFileSync(patchPath, edited, "utf8");
const warnings: string[] = [];
pr = applyPresetPatchDeclarations(realPresets, patchPath, { warn: (...a: any[]) => warnings.push(a.map(String).join(" ")) });
check("③ 仅 1 条判定冲突", pr.conflicts.length === 1);
check("③ 其余条仍 unchanged", pr.unchanged.length === decls.length - 1);
check("③ 用户版本被保留（文件未变）", read(patchPath) === edited);
check("③ 记录了 warning", warnings.some((w) => w.includes("保留你的版本")));
check("③ 冲突不写盘 → 无备份", pr.backup === undefined);

// ④ 既有 patch 上追加缺失声明 → 先备份，且原有注释/声明保留
const patch2Dir = join(sandbox, "profile2", "profiles", "p2");
mkdirSync(patch2Dir, { recursive: true });
const patch2 = join(patch2Dir, "cordis.patch.yml");
writeFileSync(patch2, "# 占位注释\n# 用户自己的注释\n" + decls[0].text + "\n", "utf8");
const p2 = applyPresetPatchDeclarations(realPresets, patch2, { warn() {} });
check("④ 已声明的那条不重复追加", !p2.appended.includes(decls[0].id));
check("④ 其余声明被追加", p2.appended.length === decls.length - 1);
check("④ 生成 .bak-<时间戳> 备份且内容为原文", typeof p2.backup === "string" && existsSync(p2.backup) && read(p2.backup).startsWith("# 占位注释"));
check("④ 原有注释与既有声明保留", read(patch2).includes("# 用户自己的注释") && read(patch2).includes(`    - id: preset-${decls[0].id}`));

// ④' installPresets:false 由 index.ts 的守卫整块跳过（声明写入也在该守卫内）
const srcText = read(join(import.meta.dirname, "..", "src", "index.ts"));
const guarded = /if \(config\.installPresets !== false\) \{[\s\S]*installAgentPresets\([\s\S]*?\n {2}\}/.test(srcText);
const insideInstaller = /function installAgentPresets[\s\S]*?applyPresetPatchDeclarations\(/.test(srcText);
check("④ installPresets:false 时声明写入同样被跳过", guarded && insideInstaller);

// ⑤ 默认 profile 解析：$DSH_PROFILE 优先；未设置时唯一 profile 自动取用；多个则不猜
check("⑤ $DSH_PROFILE 优先", resolveProfilePatchPath(homeDir, { DSH_PROFILE: "mobile" }) === join(homeDir, "profiles", "mobile", "cordis.patch.yml"));
check("⑤ 唯一 profile 时自动取用", resolveProfilePatchPath(homeDir, {}) === patchPath);
mkdirSync(join(homeDir, "profiles", "second"), { recursive: true });
check("⑤ 多个 profile 且未指定 → null（不猜）", resolveProfilePatchPath(homeDir, {}) === null);

rmSync(sandbox, { recursive: true, force: true });

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
