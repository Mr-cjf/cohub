// dsh-cohub/test/teams.ts —— 派发层按 Config.activeTeam 过滤可派角色的离线验证
// 用法：node test/teams.ts（node >= 24 类型剥离）；由 scripts/test-all.mjs 自动发现。
//
// 被测对象（src/roles.ts 的三个纯函数 + 一处文案）：
//   resolveActiveTeam / isRoleAllowed / listAllowedRoles / describeRoleNotAllowed
//
// 核心关注点：**向后兼容** —— activeTeam 为空时必须恒允许（与接线前逐字一致）；
// 团队生效时只有 members 内的角色可派，且错误文案要同时给出团队名与可用角色，
// 让主代理能自己改派而不是猜。
import { COHUB_SKILLS } from "../src/skills.ts";
import {
  describeRoleNotAllowed,
  isRoleAllowed,
  listAllowedRoles,
  resolveActiveTeam,
  type TeamConfig,
} from "../src/roles.ts";

/** 内置角色总数（skills.ts 的 COHUB_SKILLS 运行时值，不在测试里写死数字） */
const COHUB_SKILLS_COUNT = COHUB_SKILLS.length;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** 写作组：只允许写稿与审校 */
const WRITING: TeamConfig = { id: "writing", name: "写作组", members: ["co-writer", "co-editor"] };
const TEAMS: readonly TeamConfig[] = [WRITING];

// ── 用例 1：activeTeam 为空 → 全允许（向后兼容） ──────────────────────────
group("用例 1：activeTeam 为空 → 全部角色可用（与接线前逐字一致）");
check("resolveActiveTeam({}) = null（未设置 activeTeam）", resolveActiveTeam({}) === null);
check("resolveActiveTeam(undefined) = null", resolveActiveTeam(undefined) === null);
check("activeTeam 为纯空白同样视为不限制",
  resolveActiveTeam({ teams: TEAMS, activeTeam: "   " }) === null);
check("无 activeTeam → co-fixer 允许", isRoleAllowed("co-fixer", { teams: TEAMS }) === true);
check("无 activeTeam → co-writer 允许", isRoleAllowed("co-writer", { teams: TEAMS }) === true);
check("无 activeTeam → 未知角色名也放行（本函数只做团队维度，不做出名校验）",
  isRoleAllowed("co-unknown", { teams: TEAMS }) === true);
check("无 activeTeam → listAllowedRoles 含全部内置角色（" + COHUB_SKILLS_COUNT + " 个，含主代理）",
  listAllowedRoles({ teams: TEAMS }).length === COHUB_SKILLS_COUNT && listAllowedRoles({}).includes("co-orchestrator"));
check("无 activeTeam → 自定义角色也在名单里（内置 ∪ customRoles）",
  listAllowedRoles({ customRoles: [{ name: "my-writer", description: "x", prompt: "y", tier: "rw" }] })
    .includes("my-writer"));

// ── 用例 2：activeTeam=writing → 只有成员可派，错误文案含团队名与可用角色 ──
group("用例 2：activeTeam 指向 writing（members=[co-writer, co-editor]）");
const writingCfg = { teams: TEAMS, activeTeam: "writing" };
const resolved = resolveActiveTeam(writingCfg);
check("resolveActiveTeam 返回 { id, name, members }",
  resolved !== null && resolved.id === "writing" && resolved.name === "写作组"
  && resolved.members.length === 2 && resolved.members[0] === "co-writer");
check("co-writer 允许", isRoleAllowed("co-writer", writingCfg) === true);
check("co-editor 允许", isRoleAllowed("co-editor", writingCfg) === true);
check("co-fixer 拒绝", isRoleAllowed("co-fixer", writingCfg) === false);
check("主代理 co-orchestrator 不在 members → 拒绝", isRoleAllowed("co-orchestrator", writingCfg) === false);
const rejection = describeRoleNotAllowed("co-fixer", writingCfg);
check("错误文案含团队显示名「写作组」", rejection.includes("写作组"));
check("错误文案含团队 id「writing」", rejection.includes("writing"));
check("错误文案含被拒角色「co-fixer」", rejection.includes("co-fixer"));
check("错误文案含可用角色清单", rejection.includes("co-writer, co-editor"));
check("错误文案格式与任务书示例一致",
  rejection === '角色 "co-fixer" 不在当前团队 "写作组"(writing) 内；该团队可用角色：co-writer, co-editor');
check("listAllowedRoles 只返回团队成员（保留配置顺序）",
  JSON.stringify(listAllowedRoles(writingCfg)) === JSON.stringify(["co-writer", "co-editor"]));
check("members 两侧空白被 trim（脏配置不误伤）",
  isRoleAllowed("co-writer", { teams: [{ id: "t", name: "T", members: [" co-writer "] }], activeTeam: "t" }) === true);

// ── 用例 3：activeTeam 指向不存在的 id → 视为不限制（fail-soft） ──────────
group("用例 3：activeTeam 指向不存在的 id → 不限制");
// 理由（与 src/roles.ts 注释一致）：teams 与 activeTeam 都是热改的 volatile 配置，用户可能
// 先写 activeTeam 再补 teams 条目。若此处硬报错，整个编排会在每次派发时瘫痪；本插件既有
// 纪律是 fail-soft + 可诊断（调用方 warn），故把「配置暂时不一致」降级为「不限制」。
const ghostCfg = { teams: TEAMS, activeTeam: "no-such-team" };
check("resolveActiveTeam(不存在的 id) = null", resolveActiveTeam(ghostCfg) === null);
check("不存在的 id → co-fixer 与 co-writer 都允许",
  isRoleAllowed("co-fixer", ghostCfg) === true && isRoleAllowed("co-writer", ghostCfg) === true);
check("不存在的 id → 名单是全量（不是空数组）",
  listAllowedRoles(ghostCfg).includes("co-fixer") && listAllowedRoles(ghostCfg).includes("co-orchestrator"));

// ── 用例 4：自定义角色在 members 里 → 允许 ───────────────────────────────
group("用例 4：自定义角色进 members");
const customCfg = {
  teams: [{ id: "custom", name: "自定义组", members: ["my-writer"] }] as readonly TeamConfig[],
  activeTeam: "custom",
  customRoles: [{ name: "my-writer", description: "自定义写手", prompt: "按提纲写", tier: "rw" as const }],
};
check("自定义角色 my-writer 在 members → 允许", isRoleAllowed("my-writer", customCfg) === true);
check("自定义角色在 members → listAllowedRoles 原样返回它",
  JSON.stringify(listAllowedRoles(customCfg)) === JSON.stringify(["my-writer"]));
check("内置角色 co-writer 不在该团队 → 拒绝", isRoleAllowed("co-writer", customCfg) === false);
check("自定义角色未进 members 的另一团队 → 拒绝",
  isRoleAllowed("my-writer", { ...customCfg, activeTeam: "writing", teams: TEAMS }) === false);

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
