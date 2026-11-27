// dsh-cohub/test/builtin-teams.ts —— 内置团队（dev / writing）数据层回归
//
// 覆盖任务书要求的四条：
//   ① 空配置 → 注册 2 个内置团队预设（id = co-orchestrator / cohub-team-writing，order 40/41）；
//      dev 团队显式 presetId=co-orchestrator（复用调度者 id），不再产出 cohub-team-<dev>；
//   ② 用户自建 id=dev → 推导出的 cohub-team-<dev> 与内置 id 不冲突，二者并存（用户版本仍优先限员）；
//   ③ resolveSessionTeam(config, "co-orchestrator") 返回开发团队，且限员对内置团队生效；
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
check("id = co-orchestrator（dev 团队复用调度者 id）", defsEmpty[0]?.id === "co-orchestrator", defsEmpty[0]?.id);
check("id = cohub-team-writing", defsEmpty[1]?.id === "cohub-team-writing", defsEmpty[1]?.id);
check("dev 团队不产出独立 id（cohub-team- 前缀只剩写作团队）", defsEmpty.filter((d: any) => d.id.startsWith("cohub-team-")).length === 1, defsEmpty.map((d: any) => d.id));
check("order = 40 / 41", defsEmpty[0]?.order === BUILTIN_TEAM_ORDER_BASE && defsEmpty[1]?.order === BUILTIN_TEAM_ORDER_BASE + 1);
check("name = 开发团队 / 写作团队", defsEmpty[0]?.name === "开发团队" && defsEmpty[1]?.name === "写作团队");
check("description 表明是开发团队", String(defsEmpty[0]?.description).includes("开发团队"), defsEmpty[0]?.description);

// members 必须与档位表的角色名逐字一致
const dev = BUILTIN_TEAMS.find((team: any) => team.id === "dev");
const writing = BUILTIN_TEAMS.find((team: any) => team.id === "writing");
const tierNames = Object.keys(BUILTIN_ROLE_TIERS);
const unknownDev = dev.members.filter((name: string) => !tierNames.includes(name));
const unknownWriting = writing.members.filter((name: string) => !tierNames.includes(name));
check("开发团队成员全部存在于 BUILTIN_ROLE_TIERS", unknownDev.length === 0, unknownDev);
check("写作团队成员全部存在于 BUILTIN_ROLE_TIERS", unknownWriting.length === 0, unknownWriting);
// 通用角色（co-team-lead / co-team-member）不进内置团队：留给用户自己组队时勾选。
const GENERIC_ROLES: readonly string[] = ["co-team-lead", "co-team-member"];
check("两团队成员并集 + 通用角色 = 档位表全部角色（无遗漏 / 无重复）",
  new Set([...dev.members, ...writing.members, ...GENERIC_ROLES]).size === tierNames.length
  && tierNames.every((name) => dev.members.includes(name) || writing.members.includes(name)
    || GENERIC_ROLES.includes(name)),
  { dev: dev.members.length, writing: writing.members.length, tiers: tierNames.length });
check("开发团队 12 人、写作团队 3 人", dev.members.length === 12 && writing.members.length === 3);
check("内置团队标 builtin: true", BUILTIN_TEAMS.every((team: any) => team.builtin === true));
check("dev 团队显式 presetId=co-orchestrator", dev.presetId === "co-orchestrator", dev.presetId);

// persona 样例（团队版 persona：三段式 = 身份行 + 队长职责 + 成员清单）
const devPersona: string = defsEmpty[0].plugins.find((line: any) => line.id === "persona").config.prefix;
const devLines = devPersona.split("\n");
const devMemberLines = devLines.filter((line: string) => line.startsWith("- "));
console.log(`  persona 首行：${devLines[0]}`);
console.log(`  persona 首个成员行：${devMemberLines[0]}`);
check("persona 首行是团队身份", devLines[0].startsWith("你是 cohub 团队「开发团队」的主代理"));
check("persona 成员清单：12 人、逐条「- 名称：职责」、顺序同 members",
  devPersona.includes("团队成员（共 12 人）：")
  && devMemberLines.length === 12
  && dev.members.every((name: string, index: number) => devMemberLines[index]!.startsWith(`- ${name}：`)));

// 同步：空配置 → 注册这 2 个
const r0 = makeRegistry();
const s0 = await syncTeamPresets(makeCtx(r0), makeLogger(), {});
check("sync 空配置 → registered 2 个内置", s0.registered.length === 2 && s0.registered.includes("co-orchestrator") && s0.registered.includes("cohub-team-writing"), s0);
check("注册表 live 2 个", r0.registered.size === 2);
check("归一后再 sync → unchanged（内置团队不重建）",
  (await syncTeamPresets(makeCtx(r0), makeLogger(), {})).unchanged.length === 2);
check("teams: [] 也不会注销内置团队", r0.registered.size === 2);
unregisterTeamPresets(makeCtx(r0), makeLogger());

// ── ② 用户自建 id=dev → id 不冲突，二者并存 ───────────────────────────────
console.log("===== ② 用户自建 id=dev → 推导 id 与内置 co-orchestrator 并存 =====");
const userDev = { id: "dev", name: "我的开发组", members: ["co-fixer", "co-oracle"] };
const defsOverride = buildTeamPresetDefs({ teams: [userDev] });
const userDevId = "cohub-team-" + userDev.id;
const devDefs = defsOverride.filter((def: any) => def.id === userDevId);
check("用户 dev 推导出独立预设 id", devDefs.length === 1, defsOverride.map((d: any) => d.id));
check("用户版本 name", devDefs[0]?.name === "我的开发组", devDefs[0]?.name);
check("用户版本成员 2 人 / order 50",
  String(devDefs[0]?.description).includes("co-fixer, co-oracle") && devDefs[0]?.order === 50);
check("内置开发团队仍在（id=co-orchestrator）", defsOverride.some((def: any) => def.id === "co-orchestrator" && def.name === "开发团队"));
check("内置写作团队不受影响", defsOverride.some((def: any) => def.id === "cohub-team-writing" && def.name === "写作团队"));
check("总数为 3（2 内置 + 用户 dev）", defsOverride.length === 3, defsOverride.map((d: any) => d.id));

// 用户团队显式用同一 id（presetId=co-orchestrator）时仍用户优先，内置该条跳过
const clash = buildTeamPresetDefs({ teams: [{ id: "dev2", name: "抢占组", members: ["co-oracle"], presetId: "co-orchestrator" }] });
check("显式同 id → 只保留 1 个 co-orchestrator 且为用户版",
  clash.filter((def: any) => def.id === "co-orchestrator").length === 1
  && clash.find((def: any) => def.id === "co-orchestrator")?.name === "抢占组", clash.map((d: any) => `${d.id}/${d.name}`));

// ── ③ resolveSessionTeam / 限员对内置团队生效 ─────────────────────────────
console.log("===== ③ resolveSessionTeam 认得内置团队预设 =====");
const devTeam = resolveSessionTeam(undefined, "co-orchestrator");
check("空配置 + co-orchestrator → 开发团队",
  devTeam !== null && devTeam.id === "dev" && devTeam.name === "开发团队", devTeam);
check("members 与 BUILTIN_TEAMS 一致", JSON.stringify(devTeam?.members) === JSON.stringify(dev.members));
check("lead = co-orchestrator", devTeam?.lead === "co-orchestrator");
check("配了别的用户团队也不影响内置匹配",
  resolveSessionTeam({ teams: [{ id: "review", name: "审查组", members: ["co-oracle"] }] }, "co-orchestrator")?.id === "dev");
check("cohub-team-writing → 写作团队",
  resolveSessionTeam({}, "cohub-team-writing")?.id === "writing");
check("内置团队限员：co-fixer 允许 / co-writer 拒绝",
  isRoleAllowed("co-fixer", undefined, "co-orchestrator") === true
  && isRoleAllowed("co-writer", undefined, "co-orchestrator") === false);
check("写作团队限员：co-writer 允许 / co-fixer 拒绝",
  isRoleAllowed("co-writer", {}, "cohub-team-writing") === true
  && isRoleAllowed("co-fixer", {}, "cohub-team-writing") === false);
check("用户 dev 版本限员按用户版本（co-oracle 允许 / co-designer 拒绝）",
  isRoleAllowed("co-oracle", { teams: [userDev] }, userDevId) === true
  && isRoleAllowed("co-designer", { teams: [userDev] }, userDevId) === false);
check("co-orchestrator 仍按内置开发团队限员（co-cordis 允许 / co-writer 拒绝）",
  isRoleAllowed("co-cordis", { teams: [userDev] }, "co-orchestrator") === true
  && isRoleAllowed("co-writer", { teams: [userDev] }, "co-orchestrator") === false);

// ── ④ dispose → 内置团队也被卸载 ─────────────────────────────────────────
console.log("===== ④ dispose → 内置团队也被卸载 =====");
const r4 = makeRegistry();
const ctx4 = makeCtx(r4);
await syncTeamPresets(ctx4, makeLogger(), {});
check("dispose 前台账 2 个", listRegisteredTeamPresets(ctx4).length === 2);
const disposed = unregisterTeamPresets(ctx4, makeLogger());
check("dispose 卸载 2 个（含内置 co-orchestrator / writing）",
  disposed.length === 2 && disposed.includes("co-orchestrator") && disposed.includes("cohub-team-writing"), disposed);
check("注册表清空", r4.registered.size === 0);
check("重复 dispose 幂等", unregisterTeamPresets(ctx4, makeLogger()).length === 0);

console.log("");
console.log(`=== builtin-teams：PASS ${pass}，FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
