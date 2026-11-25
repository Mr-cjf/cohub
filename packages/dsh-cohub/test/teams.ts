// dsh-cohub/test/teams.ts —— 派发层团队限员的离线验证
// 用法：node test/teams.ts（node >= 24 类型剥离）；由 scripts/test-all.mjs 自动发现。
//
// 被测对象（src/roles.ts 的纯函数 + 一处文案 + src/delegate.ts 的预设 id 取法）：
//   teamPresetId / resolveSessionTeam / resolveTeamFilter / isRoleAllowed /
//   listAllowedRoles / resolveActiveTeam / describeRoleNotAllowed / resolveAgentPresetId
//
// 两条路径都要锁死：
//   - 新语义（主路径）：当前会话的 Agent 预设 id → 团队 → members 限员（用例 5/6）；
//   - 旧语义（兼容）：Config.activeTeam（已废弃，仅作旧配置兼容）→ 同一条判定链（用例 1-4）。
// 核心关注点：**向后兼容** —— 取不到预设 / 非团队预设时必须回退为「不限制」，不能把
// 「配置还没迁移」变成每次派发都失败；团队生效时只有 members 内的角色可派，且错误文案要
// 同时给出团队名与可用角色，让主代理能自己改派而不是猜。
import { COHUB_SKILLS } from "../src/skills.ts";
import { resolveAgentPresetId } from "../src/delegate.ts";
import {
  describeRoleNotAllowed,
  isRoleAllowed,
  listAllowedRoles,
  resolveActiveTeam,
  resolveSessionTeam,
  resolveTeamFilter,
  teamPresetId,
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

// ── 用例 5：当前会话预设 → 团队（新语义主路径） ───────────────────────────
group("用例 5：当前会话预设判定团队（推导 id / 显式 presetId / 非团队预设）");
const presetCfg = { teams: TEAMS };
check("teamPresetId 推导 = cohub-team-<id>", teamPresetId(WRITING) === "cohub-team-writing");
check("teamPresetId 显式 presetId 优先",
  teamPresetId({ ...WRITING, presetId: "my-writing-preset" }) === "my-writing-preset");
check("teamPresetId 显式值为空白 → 回退推导",
  teamPresetId({ ...WRITING, presetId: "   " }) === "cohub-team-writing");
const sessionTeam = resolveSessionTeam(presetCfg, "cohub-team-writing");
check("① presetId=cohub-team-writing → 命中写作组（id / name / members）",
  sessionTeam !== null && sessionTeam.id === "writing" && sessionTeam.name === "写作组"
  && JSON.stringify(sessionTeam.members) === JSON.stringify(["co-writer", "co-editor"]));
check("① co-writer 允许", isRoleAllowed("co-writer", presetCfg, "cohub-team-writing") === true);
check("① co-editor 允许", isRoleAllowed("co-editor", presetCfg, "cohub-team-writing") === true);
check("① co-fixer 拒绝", isRoleAllowed("co-fixer", presetCfg, "cohub-team-writing") === false);
check("① 错误文案与任务书示例逐字一致",
  describeRoleNotAllowed("co-fixer", presetCfg, "cohub-team-writing")
    === '角色 "co-fixer" 不在当前团队 "写作组"(writing) 内；该团队可用角色：co-writer, co-editor');
check("① resolveTeamFilter source=preset（命中预设路径）",
  resolveTeamFilter(presetCfg, "cohub-team-writing").source === "preset");
check("② presetId=standard（非团队预设）→ 不限制",
  isRoleAllowed("co-fixer", presetCfg, "standard") === true
  && resolveTeamFilter(presetCfg, "standard").team === null);
check("② 非团队预设 + activeTeam 仍配置 → 回退旧行为（兼容未迁移配置）",
  isRoleAllowed("co-fixer", writingCfg, "standard") === false
  && resolveTeamFilter(writingCfg, "standard").source === "legacy");
check("③ presetId 为空串 → 不限制", isRoleAllowed("co-fixer", writingCfg, "") === true);
check("③ presetId 为纯空白 → 不限制",
  isRoleAllowed("co-fixer", writingCfg, "   ") === true
  && resolveSessionTeam(writingCfg, "   ") === null);
check("③ presetId 未传（undefined）→ 沿用旧 activeTeam 判定（不等于不限制）",
  isRoleAllowed("co-fixer", writingCfg) === false);
check("④ 团队显式 presetId 生效：命中自定义预设 id",
  isRoleAllowed("co-fixer", { teams: [{ ...WRITING, presetId: "my-writing-preset" }] }, "my-writing-preset") === false
  && resolveSessionTeam({ teams: [{ ...WRITING, presetId: "my-writing-preset" }] }, "my-writing-preset")?.id === "writing");
check("④ 显式 presetId 时推导 id 不再命中（回退不限制）",
  resolveSessionTeam({ teams: [{ ...WRITING, presetId: "my-writing-preset" }] }, "cohub-team-writing") === null);

// ── 用例 6：取不到 agentPresets 服务 → 不抛且不限制（fail-soft） ──────────
group("用例 6：预设解析 fail-soft");
const warns: string[] = [];
const fakeLogger = { warn: (msg: string) => { warns.push(msg); } };
const noReflectCtx = {};
const emptyReflectCtx = { reflect: { get: () => undefined }, logger: fakeLogger };
check("⑤ agentPresets 服务缺失 → 返回 \"\" 且 warn 一次",
  resolveAgentPresetId(emptyReflectCtx, { ctx: {}, session: {} }) === "" && warns.length === 1);
check("⑤ warn 文案含 [cohub team-filter] 前缀", (warns[0] ?? "").includes("[cohub team-filter]"));
check("⑤ ctx 无 reflect → 返回 \"\" 且不抛", resolveAgentPresetId(noReflectCtx, {}) === "");
check("⑤ 预设为空 → 不限制（co-fixer 放行）",
  isRoleAllowed("co-fixer", writingCfg, resolveAgentPresetId(emptyReflectCtx, {})) === true);
const throwingCtx = {
  reflect: { get: () => ({ composedPreset: () => { throw new Error("boom"); } }) },
  logger: fakeLogger,
};
check("⑤ composedPreset 抛错 → 不抛且回落（无 session → 返回 \"\"）",
  resolveAgentPresetId(throwingCtx, { ctx: {} }) === "");
const sessionCtx = {
  reflect: {
    get: () => ({
      composedPreset: () => { throw new Error("boom"); },
      presetForSession: () => "cohub-team-writing",
    }),
  },
  logger: fakeLogger,
};
check("⑤ composedPreset 失败 → 用 presetForSession 兜底（命中团队预设）",
  resolveAgentPresetId(sessionCtx, { ctx: {}, session: { id: "s1" } }) === "cohub-team-writing");
const composedCtx = {
  reflect: {
    get: () => ({
      composedPreset: () => "cohub-team-writing",
      presetForSession: () => "standard",
    }),
  },
  logger: fakeLogger,
};
check("⑤ composedPreset 优先于 presetForSession",
  resolveAgentPresetId(composedCtx, { ctx: {}, session: { id: "s1" } }) === "cohub-team-writing");

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
