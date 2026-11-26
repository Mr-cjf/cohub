// dsh-cohub/test/builtin-teams.ts —— 内置团队（dev / writing）数据层回归
//
// 覆盖任务书要求的四条：
//   ① 空配置 → 注册 2 个内置团队预设（id = cohub-team-dev / cohub-team-writing，order 40/41）；
//   ② 用户建同名 id dev → 用户版本胜出（内置 dev 被跳过）；
//   ③ resolveSessionTeam(config, "cohub-team-dev") 返回开发团队，且限员对内置团队生效；
//   ④ 插件 dispose → 内置团队也被卸载。
// 另附：members 必须与 src/roles.ts 的 BUILTIN_ROLE_TIERS 逐字一致（不写死数字，按表推算）。
//
// 用法：bun run build && node test/builtin-teams.ts
import * as libBuild from "../lib/index.js";
import { BUILTIN_ROLE_TIERS, isRoleAllowed, resolveSessionTeam } from "../src/roles.ts";

const {
  BUILTIN_TEAMS,
  BUILTIN_TEAM_ORDER_BASE,
  buildTeamPresetDefs,
  syncTeamPresets,
  unregisterTeamPresets,
  listRegisteredTeamPresets,
}: any = libBuild;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}${cond || detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`);
  if (cond) pass++;
  else fail++;
}

/** mock agentPresets 注册表（与 test/team-presets.ts 同形，够用即可） */
function makeRegistry() {
  const calls: string[] = [];
  const registered = new Map<string, { unregister: () => void }>();
  return {
    calls,
    registered,
    get(id: string) {
      calls.push(`get:${id}`);
      return registered.get(id);
    },
    async register(def: any) {
      calls.push(`register:${def.id}`);
      const handle = () => {
        calls.push(`unregister:${def.id}`);
        registered.delete(def.id);
      };
      registered.set(def.id, { unregister: handle });
      return handle;
    },
  };
}
const makeCtx = (registry: any) => ({ reflect: { get: (name: string) => (name === "agentPresets" ? registry : undefined) } });
const makeLogger = () => ({ warn: () => {}, info: () => {} });

// ── ① 空配置 → 2 个内置团队预设 ──────────────────────────────────────────
console.log("===== ① 空配置 → 注册 2 个内置团队预设 =====");
const defsEmpty = buildTeamPresetDefs({});
check("空配置 → 2 个预设", defsEmpty.length === 2, defsEmpty.map((d: any) => d.id));
check("id = cohub-team-dev", defsEmpty[0]?.id === "cohub-team-dev", defsEmpty[0]?.id);
check("id = cohub-team-writing", defsEmpty[1]?.id === "cohub-team-writing", defsEmpty[1]?.id);
check("order = 40 / 41", defsEmpty[0]?.order === BUILTIN_TEAM_ORDER_BASE && defsEmpty[1]?.order === BUILTIN_TEAM_ORDER_BASE + 1);
check("name = 开发团队 / 写作团队", defsEmpty[0]?.name === "开发团队" && defsEmpty[1]?.name === "写作团队");

// members 必须与档位表的角色名逐字一致
const dev = BUILTIN_TEAMS.find((team: any) => team.id === "dev");
const writing = BUILTIN_TEAMS.find((team: any) => team.id === "writing");
const tierNames = Object.keys(BUILTIN_ROLE_TIERS);
const unknownDev = dev.members.filter((name: string) => !tierNames.includes(name));
const unknownWriting = writing.members.filter((name: string) => !tierNames.includes(name));
check("开发团队成员全部存在于 BUILTIN_ROLE_TIERS", unknownDev.length === 0, unknownDev);
check("写作团队成员全部存在于 BUILTIN_ROLE_TIERS", unknownWriting.length === 0, unknownWriting);
check("两团队成员并集 = 档位表全部角色（无遗漏 / 无重复）",
  new Set([...dev.members, ...writing.members]).size === tierNames.length
  && tierNames.every((name) => dev.members.includes(name) || writing.members.includes(name)),
  { dev: dev.members.length, writing: writing.members.length, tiers: tierNames.length });
check("开发团队 12 人、写作团队 3 人", dev.members.length === 12 && writing.members.length === 3);
check("内置团队标 builtin: true", BUILTIN_TEAMS.every((team: any) => team.builtin === true));

// persona 样例（任务书要求贴首行与成员行）
const devPersona: string = defsEmpty[0].plugins.find((line: any) => line.id === "persona").config.prefix;
const devLines = devPersona.split("\n");
console.log(`  persona 首行：${devLines[0]}`);
console.log(`  persona 成员行：${devLines[devLines.length - 1]}`);
check("persona 首行是团队身份", devLines[0].startsWith("你是 cohub 团队「开发团队」的主代理"));
check("persona 末尾附 12 个可派角色",
  devLines[devLines.length - 1] === `本团队可派角色：${dev.members.join("、")}`);

// 同步：空配置 → 注册这 2 个
const r0 = makeRegistry();
const s0 = await syncTeamPresets(makeCtx(r0), makeLogger(), {});
check("sync 空配置 → registered 2 个内置", s0.registered.length === 2 && s0.registered.includes("cohub-team-dev") && s0.registered.includes("cohub-team-writing"), s0);
check("注册表 live 2 个", r0.registered.size === 2);
check("归一后再 sync → unchanged（内置团队不重建）",
  (await syncTeamPresets(makeCtx(r0), makeLogger(), {})).unchanged.length === 2);
check("teams: [] 也不会注销内置团队", r0.registered.size === 2);
unregisterTeamPresets(makeCtx(r0), makeLogger());

// ── ② 用户同名 id dev → 用户版本胜出 ──────────────────────────────────────
console.log("===== ② 用户建同名 id dev → 用户版本胜出 =====");
const userDev = { id: "dev", name: "我的开发组", members: ["co-fixer", "co-oracle"] };
const defsOverride = buildTeamPresetDefs({ teams: [userDev] });
const devDefs = defsOverride.filter((def: any) => def.id === "cohub-team-dev");
check("id 冲突时只保留 1 个 cohub-team-dev", devDefs.length === 1, defsOverride.map((d: any) => d.id));
check("胜出的是用户版本（name）", devDefs[0]?.name === "我的开发组", devDefs[0]?.name);
check("胜出的是用户版本（成员 2 人）",
  String(devDefs[0]?.description).includes("co-fixer, co-oracle") && devDefs[0]?.order === 50);
check("内置写作团队不受影响", defsOverride.some((def: any) => def.id === "cohub-team-writing" && def.name === "写作团队"));
check("总数为 2（用户 dev + 内置 writing）", defsOverride.length === 2, defsOverride.map((d: any) => d.id));

// ── ③ resolveSessionTeam / 限员对内置团队生效 ─────────────────────────────
console.log("===== ③ resolveSessionTeam 认得内置团队预设 =====");
const devTeam = resolveSessionTeam(undefined, "cohub-team-dev");
check("空配置 + cohub-team-dev → 开发团队",
  devTeam !== null && devTeam.id === "dev" && devTeam.name === "开发团队", devTeam);
check("members 与 BUILTIN_TEAMS 一致", JSON.stringify(devTeam?.members) === JSON.stringify(dev.members));
check("lead = co-orchestrator", devTeam?.lead === "co-orchestrator");
check("配了别的用户团队也不影响内置匹配",
  resolveSessionTeam({ teams: [{ id: "review", name: "审查组", members: ["co-oracle"] }] }, "cohub-team-dev")?.id === "dev");
check("cohub-team-writing → 写作团队",
  resolveSessionTeam({}, "cohub-team-writing")?.id === "writing");
check("内置团队限员：co-fixer 允许 / co-writer 拒绝",
  isRoleAllowed("co-fixer", undefined, "cohub-team-dev") === true
  && isRoleAllowed("co-writer", undefined, "cohub-team-dev") === false);
check("写作团队限员：co-writer 允许 / co-fixer 拒绝",
  isRoleAllowed("co-writer", {}, "cohub-team-writing") === true
  && isRoleAllowed("co-fixer", {}, "cohub-team-writing") === false);
check("用户同名 dev 覆盖后限员按用户版本（co-oracle 允许 / co-designer 拒绝）",
  isRoleAllowed("co-oracle", { teams: [userDev] }, "cohub-team-dev") === true
  && isRoleAllowed("co-designer", { teams: [userDev] }, "cohub-team-dev") === false);

// ── ④ dispose → 内置团队也被卸载 ─────────────────────────────────────────
console.log("===== ④ dispose → 内置团队也被卸载 =====");
const r4 = makeRegistry();
const ctx4 = makeCtx(r4);
await syncTeamPresets(ctx4, makeLogger(), {});
check("dispose 前台账 2 个", listRegisteredTeamPresets(ctx4).length === 2);
const disposed = unregisterTeamPresets(ctx4, makeLogger());
check("dispose 卸载 2 个（含内置 dev / writing）",
  disposed.length === 2 && disposed.includes("cohub-team-dev") && disposed.includes("cohub-team-writing"), disposed);
check("注册表清空", r4.registered.size === 0);
check("重复 dispose 幂等", unregisterTeamPresets(ctx4, makeLogger()).length === 0);

console.log("");
console.log(`=== builtin-teams：PASS ${pass}，FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
