// dsh-cohub/test/team-presets.ts —— Config.teams → Agent 预设 的运行时注册单测（mock ctx，无需 LLM）
//
// 覆盖（任务书要求的五条）：
//   ① 两个团队 → 注册两个预设，id 符合 `cohub-team-<id>` 约定；
//   ② 删除一个团队 → 注销对应的预设；
//   ③ 改成员 → 先 unregister 再 register（不是原地覆盖）；
//   ④ 无 agentPresets 服务 → 不抛（fail-soft）；
//   ⑤ presetId 缺省推导正确（显式 presetId 优先）。
// 另覆盖：指纹不变 → 完全跳过（轮询不产生多余注册调用）；dispose → 全部注销。
//
// 用法：bun run build && node test/team-presets.ts
import * as libBuild from "../lib/index.js";
const {
  syncTeamPresets,
  unregisterTeamPresets,
  buildTeamPresetDefs,
  buildTeamPersona,
  teamPresetId,
  BUILTIN_TEAM_ORDER_BASE,
  TEAM_PRESET_ORDER_BASE,
  listRegisteredTeamPresets,
}: any = libBuild;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++;
  else fail++;
}

/** mock agentPresets 注册表：记录调用序列，可注入「注册抛错」 */
function makeRegistry(options: { failOn?: string[] } = {}) {
  const calls: string[] = [];
  const registered = new Map<string, { unregister: () => void }>();
  const failOn = new Set(options.failOn ?? []);
  return {
    calls,
    registered,
    get(id: string) {
      calls.push(`get:${id}`);
      return registered.get(id);
    },
    async register(def: any) {
      calls.push(`register:${def.id}`);
      if (failOn.has(def.id)) throw new Error(`mock register failure: ${def.id}`);
      const handle = () => {
        calls.push(`unregister:${def.id}`);
        registered.delete(def.id);
      };
      registered.set(def.id, { unregister: handle });
      return handle;
    },
  };
}

function makeCtx(registry: any) {
  return {
    // 走 reflect.get 的非强校验通道（插件 inject 里没有 agentPresets）
    reflect: { get: (name: string) => (name === "agentPresets" ? registry : undefined) },
  };
}

function makeLogger() {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    warn: (...args: any[]) => warns.push(String(args[0] ?? "")),
    info: (...args: any[]) => infos.push(String(args[0] ?? "")),
  };
}

const writing = { id: "writing-user", name: "写作团队", members: ["co-orchestrator", "co-fixer", "co-editor"] };
const review = { id: "review", name: "审查团队", members: ["co-oracle", "co-explorer"] };

// ── ① 两个团队 → 两个预设 + 参数样例 ───────────────────────────────────────
console.log("===== ① 两个团队 → 注册两个预设（id 按约定推导） =====");
const r1 = makeRegistry();
const logger1 = makeLogger();
const ctx1 = makeCtx(r1);
const s1 = await syncTeamPresets(ctx1, logger1, { teams: [writing, review] });
check("registered 共 4 个（2 内置 + 2 用户）", s1.registered.length === 4);
check("id = cohub-team-writing-user", s1.registered.includes("cohub-team-writing-user"));
check("id = cohub-team-review", s1.registered.includes("cohub-team-review"));
check("注册表里有 4 个", r1.registered.size === 4);
check("failed 为空", s1.failed.length === 0);
check("首轮无 unregister（无旧注册）", r1.calls.every((c) => !c.startsWith("unregister:")));
const defs1: any[] = buildTeamPresetDefs({ teams: [writing, review] });
const sample = defs1.find((def: any) => def.id === "cohub-team-writing-user")!;
const pluginIds = sample.plugins.map((line: any) => line.id);
/** 递归收集 id：delegation 是 cordis:group，subagent 行在它的 config 子序列里 */
function collectIds(lines: any[]): string[] {
  return lines.flatMap((line) => [line.id, ...(Array.isArray(line.config) ? collectIds(line.config) : [])]);
}
const allPluginIds = collectIds(sample.plugins);
console.log("  样例 register 参数：", JSON.stringify({
  id: sample.id,
  name: sample.name,
  description: sample.description,
  order: sample.order,
  plugins: sample.plugins.length,
  pluginIds,
  personaFirstLine: sample.plugins.find((l: any) => l.id === "persona").config.prefix.split("\n")[0],
}));
check("order 在档位 preset 之后（≥ " + TEAM_PRESET_ORDER_BASE + "）", sample.order >= TEAM_PRESET_ORDER_BASE);
check("内置团队 order 40/41、用户团队 50/51", defs1[0]!.order === BUILTIN_TEAM_ORDER_BASE && defs1[1]!.order === BUILTIN_TEAM_ORDER_BASE + 1 && defs1[2]!.order === TEAM_PRESET_ORDER_BASE && defs1[3]!.order === TEAM_PRESET_ORDER_BASE + 1);
check("description 含队长与成员", sample.description.includes("队长 co-orchestrator") && sample.description.includes("co-fixer"));
check("persona 首行是团队身份", sample.plugins[0].id === "persona" && sample.plugins[0].config.prefix.startsWith("你是 cohub 团队「写作团队」的主代理"));
check("persona 末尾附可派角色", sample.plugins[0].config.prefix.includes("本团队可派角色：co-orchestrator、co-fixer、co-editor"));
check("persona 取队长 brief（co-orchestrator 纯调度者）", sample.plugins[0].config.prefix.includes("纯调度"));
check("含委派 / 待办 / 追问 / 目标 / 后台任务 / 技能行",
  ["tool-subagent", "tool-todo", "tool-ask-user", "tool-goal", "tool-jobs", "tool-skill"].every((id) => allPluginIds.includes(id)));
check("不挂 tool-cordis（全进程单例）", !pluginIds.includes("tool-cordis"));

// 自定义队长 → persona 取 customRoles[].prompt
const customLead = buildTeamPersona(
  { id: "t", name: "自定义队", members: ["my-lead"] },
  ["my-lead"],
  "my-lead",
  [{ name: "my-lead", prompt: "我是自定义队长职责" }],
);
check("自定义队长 persona 取其 prompt", customLead.includes("我是自定义队长职责"));

// ── ② 删除一个团队 → 注销对应预设 ─────────────────────────────────────────
console.log("===== ② 删除一个团队 → 注销对应的预设 =====");
const s2 = await syncTeamPresets(ctx1, logger1, { teams: [writing] });
check("unchanged 含 cohub-team-writing-user（指纹未变，跳过）", s2.unchanged.includes("cohub-team-writing-user"));
check("removed = [cohub-team-review]", JSON.stringify(s2.removed) === JSON.stringify(["cohub-team-review"]));
check("注册表只剩 3 个（2 内置 + writing-user）", r1.registered.size === 3 && r1.registered.has("cohub-team-writing-user"));
check("review 的 unregister 被调用", r1.calls.includes("unregister:cohub-team-review"));
const registerCountBefore = r1.calls.filter((c) => c === "register:cohub-team-writing-user").length;
check("指纹未变不重复 register writing", registerCountBefore === 1);

// ── ③ 改成员 → 先 unregister 再 register ───────────────────────────────────
console.log("===== ③ 改成员 → 先 unregister 再 register =====");
const changed = { ...writing, members: ["co-orchestrator", "co-fixer", "co-designer"] };
const s3 = await syncTeamPresets(ctx1, logger1, { teams: [changed] });
check("updated = [cohub-team-writing-user]", JSON.stringify(s3.updated) === JSON.stringify(["cohub-team-writing-user"]));
check("unchanged 只含 2 个内置团队（用户团队已更新）", s3.unchanged.length === 2 && s3.unchanged.includes("co-orchestrator"));
const seq = r1.calls.filter((c) => c === "register:cohub-team-writing-user" || c === "unregister:cohub-team-writing-user");
check("序列 = unregister → register", JSON.stringify(seq.slice(-2)) === JSON.stringify(["unregister:cohub-team-writing-user", "register:cohub-team-writing-user"]));
check("注册表仍是 3 个（重建后含 2 内置）", r1.registered.size === 3);
const persona3 = buildTeamPresetDefs({ teams: [changed] })[0]!.plugins[0].config.prefix;
check("新 persona 反映新成员", persona3.includes("co-designer") && !persona3.includes("co-editor"));

// ── ④ 无 agentPresets 服务 → 不抛 ─────────────────────────────────────────
console.log("===== ④ 无 agentPresets 服务 → 不抛（fail-soft） =====");
const logger4 = makeLogger();
let threw = false;
let s4: any;
try {
  s4 = await syncTeamPresets({}, logger4, { teams: [writing] });
} catch {
  threw = true;
}
check("不抛", threw === false);
check("registered 为空", s4.registered.length === 0);
check("failed 为空（不算失败）", s4.failed.length === 0);
check("有 warn 提示服务不可用", logger4.warns.some((line) => line.includes("agentPresets")));

// 单个团队注册失败 → 其余继续 + warn
const r5 = makeRegistry({ failOn: ["cohub-team-review"] });
const logger5 = makeLogger();
const s5 = await syncTeamPresets(makeCtx(r5), logger5, { teams: [writing, review] });
check("单团队失败记入 failed", s5.failed.includes("cohub-team-review"));
check("其余团队仍注册", s5.registered.includes("cohub-team-writing-user") && r5.registered.has("cohub-team-writing-user"));
check("失败产生 warn", logger5.warns.some((line) => line.includes("cohub-team-review")));

// ── ⑤ presetId 缺省推导 / 显式优先 ────────────────────────────────────────
console.log("===== ⑤ presetId 缺省推导 =====");
check("缺省 = cohub-team-<id>", teamPresetId({ id: "writing-user", name: "w", members: ["a"] }) === "cohub-team-writing-user");
check("显式 presetId 优先", teamPresetId({ id: "writing-user", name: "w", members: ["a"], presetId: "team-w" }) === "team-w");
check("空白 presetId 视为未配置", teamPresetId({ id: "writing-user", name: "w", members: ["a"], presetId: "  " }) === "cohub-team-writing-user");
const explicit = buildTeamPresetDefs({ teams: [{ ...writing, presetId: "team-w" }] });
check("buildTeamPresetDefs 用显式 id", explicit.length === 3 && explicit.some((def: any) => def.id === "team-w"));
check("无 teams → 只有 2 个内置团队", buildTeamPresetDefs({}).length === 2);
check("teams 缺省 → 只有 2 个内置团队", buildTeamPresetDefs().length === 2);
// Volatile 形状（{ get() }）也能读
check("支持 Volatile 形状的 teams", buildTeamPresetDefs({ teams: { get: () => [writing] } as any }).length === 3);

// ── ⑥ dispose → 全部注销 ──────────────────────────────────────────────────
console.log("===== ⑥ 插件卸载 → 全部注销 =====");
check("台账里 3 个", listRegisteredTeamPresets(ctx1).length === 3);
const removed = unregisterTeamPresets(ctx1, logger1);
check("卸载 3 个（含内置团队）", removed.length === 3 && removed.includes("co-orchestrator") && removed.includes("cohub-team-writing") && removed.includes("cohub-team-writing-user"));
check("注册表回空", r1.registered.size === 0);
check("重复卸载幂等（第二次为空）", unregisterTeamPresets(ctx1, logger1).length === 0);

console.log("");
console.log(`=== team-presets：PASS ${pass}，FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
