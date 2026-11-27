// dsh-cohub/test/roles-dispatch.ts —— 派发层接入「角色档位 + 自定义角色」的验证
// 用法：node test/roles-dispatch.ts（node >= 24 类型剥离）；由 scripts/test-all.mjs 自动发现。
//
// 被测对象（三条接入点，单发 delegate 与批量 delegate_batch 共用的导出函数）：
//   ① 技能查表：resolveSkillSnapshot（内置 ∪ config.customRoles）+ resolveSkillAndRoute
//   ② 工具裁剪 / preset：resolveSkillToolFilter / resolveSkillAgentPreset 按 resolveTier 派生
//   ③ 提示词注入：buildDelegatePrompt 对自定义角色注入其 prompt（内置角色逐字不变）
//   ④ 批量路径白名单：delegate_batch 的 assertKnownSkill（区分「不存在」与「存在但被禁用」）
//
// 核心关注点：**向后兼容**——13 个内置角色的 tier → preset → deny 列表必须与接线前
// （git HEAD 的 delegate.ts 手写表）逐项一致；差异只允许出现在「点钟有意的档位升级」三处。
import { COHUB_SKILLS } from "../src/skills.ts";
import {
  SHELL_TOOL,
  resolveSkillSnapshot,
  resolveTier,
  type CustomRoleConfig,
} from "../src/roles.ts";
import {
  buildDelegatePrompt,
  resolveSkillAgentPreset,
  resolveSkillAndRoute,
  resolveSkillToolFilter,
  startSubagentRun,
} from "../src/delegate.ts";
import { assertKnownSkill } from "../src/delegate_batch.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

// ── 接线前的旧值（逐字抄自 git HEAD=4eca559 的 src/delegate.ts:206-247 / :332-342） ──────────
const OLD_READ_ONLY_DENY: readonly string[] = [
  "write", "edit", SHELL_TOOL, "create_worktree", "workflow",
  "delegate", "delegate_batch", "subagent", "subagent_fork",
];
const OLD_WRITE_DENY: readonly string[] = [
  "create_worktree", "workflow", "delegate", "delegate_batch", "subagent", "subagent_fork",
];
const OLD_UNIVERSAL_DENY: readonly string[] = [
  "ask_user_question", "create_goal", "update_goal", "get_goal", "weather", "video_search",
];
const OLD_READ_ONLY_SKILLS = new Set([
  "co-explorer", "co-oracle", "co-planner", "co-council", "co-observer", "co-librarian",
  "co-rule-user", "co-rule-project", "co-rule-app",
]);
const OLD_WRITE_SKILLS = new Set(["co-fixer", "co-designer", "co-cordis"]);
const OLD_READONLY_PRESET = "cohub-subagent-readonly";
const OLD_WRITE_PRESET = "cohub-subagent-write";

/** 接线前的 resolveSkillToolFilter（原样复制旧实现，用作对比基准，不是被测代码） */
function oldToolFilter(skillName: string | undefined): string[] | undefined {
  const key = (skillName ?? "").trim();
  if (key === "co-orchestrator") return undefined;
  const base = OLD_READ_ONLY_SKILLS.has(key)
    ? OLD_READ_ONLY_DENY
    : OLD_WRITE_SKILLS.has(key) ? OLD_WRITE_DENY : OLD_UNIVERSAL_DENY;
  const deny = [...new Set<string>([...base, ...OLD_UNIVERSAL_DENY])];
  return deny.length > 0 ? deny : undefined;
}

/** 接线前的 resolveSkillAgentPreset（原样复制旧实现） */
function oldAgentPreset(skillName: string | undefined): string | undefined {
  const key = (skillName ?? "").trim();
  if (key === "co-orchestrator") return undefined;
  if (key.length === 0) return OLD_WRITE_PRESET;
  if (OLD_READ_ONLY_SKILLS.has(key)) return OLD_READONLY_PRESET;
  if (OLD_WRITE_SKILLS.has(key)) return OLD_WRITE_PRESET;
  return OLD_WRITE_PRESET;
}

/**
 * 「接线前已存在」的内置角色（含主代理 co-orchestrator），逐项对比旧值的基准集。
 * 写作组（co-writer / co-editor / co-outliner）是接线后新增的，没有旧值可比，
 * 由下方「全部内置角色都能解析出 preset」一条覆盖，不计入本对比表。
 */
const POST_COMPAT_ADDITIONS: ReadonlySet<string> = new Set(["co-writer", "co-editor", "co-outliner", "co-team-lead", "co-team-member"]);
const BUILTIN_NAMES: readonly string[] = COHUB_SKILLS.map((skill) => skill.name)
  .filter((name) => !POST_COMPAT_ADDITIONS.has(name));

/**
 * 本批语义（每个档位子代理挂自己的预设）：preset 由 resolveTier → presetForTier 派生。
 * 子代理因此拿到「专职子代理」persona——继承父组合会继承 co-orchestrator / 队长的纯调度
 * persona（system prompt 优先于任务书），子代理会自认调度者而拒绝改文件。
 * 故这里逐档硬编码期望值，防止回归成「不传 agentPreset」。
 */
const EXPECTED_SUBAGENT_PRESET: Readonly<Record<string, string | undefined>> = {
  "co-orchestrator": undefined,
  "co-cordis": "cohub-cordis",
};
const TIER_EXPECTED_PRESET: Readonly<Record<string, string>> = {
  ro: "cohub-subagent-readonly",
  "ro-net": "cohub-subagent-readonly-net",
  rw: "cohub-subagent-write",
  "rw-shell": "cohub-subagent-write-shell",
};
/** 某角色应挂的 preset：co-orchestrator / co-cordis 走特例表，其余按档位表 */
function expectedPresetOf(name: string): string | undefined {
  if (name in EXPECTED_SUBAGENT_PRESET) return EXPECTED_SUBAGENT_PRESET[name];
  const tier = resolveTier(name);
  return tier === null ? undefined : TIER_EXPECTED_PRESET[tier];
}

// ── 用例 1：13 个内置角色的 tier → preset → deny 对比表 ─────────────────────
group("用例 1：内置角色向后兼容（13 个逐项对比接线前旧值）");
console.log("");
console.log("  角色          | tier    | 新 preset                    | 旧 preset               | preset | deny");
console.log("  ------------- | ------- | ---------------------------- | ----------------------- | ------ | ----");
let presetSame = 0;
let denySame = 0;
for (const name of BUILTIN_NAMES) {
  const tier = resolveTier(name);
  const newPreset = resolveSkillAgentPreset(name, true);
  const oldPreset = oldAgentPreset(name);
  const newDeny = resolveSkillToolFilter(name, true);
  const oldDeny = oldToolFilter(name);
  const denyEqual = JSON.stringify(newDeny?.deny) === JSON.stringify(oldDeny);
  const expectedPreset = expectedPresetOf(name);
  const presetOk = newPreset === expectedPreset;
  if (presetOk) presetSame++;
  if (denyEqual) denySame++;
  console.log(
    "  " + name.padEnd(13) + " | " + String(tier ?? "null").padEnd(7) + " | "
    + String(newPreset ?? "undefined").padEnd(28) + " | "
    + String(oldPreset ?? "undefined").padEnd(23) + " | "
    + (presetOk ? "  ==  " : "  !!  ") + " | " + (denyEqual ? "  ==" : "  !!"),
  );
}
console.log("");
check("13 个内置角色：preset 与档位表逐项相等（co-orchestrator 不挂）", presetSame === 13);
check("13 个内置角色 deny 列表全部与接线前逐项相等（含顺序）", denySame === 13);
check("内置角色 deny 里仍含 shell/write 裁剪差异（ro 裁、rw 不裁）",
  resolveSkillToolFilter("co-explorer", true)!.deny.includes(SHELL_TOOL)
  && !resolveSkillToolFilter("co-fixer", true)!.deny.includes("write"));
check("co-orchestrator 仍不裁剪、不挂 preset（继承父）",
  resolveSkillToolFilter("co-orchestrator", true) === undefined
  && resolveSkillAgentPreset("co-orchestrator", true) === undefined);
check("空 skill 按 rw-shell 兜底挂 write-shell preset + 通用 deny",
  resolveSkillAgentPreset("", true) === "cohub-subagent-write-shell"
  && JSON.stringify(resolveSkillToolFilter("", true)!.deny) === JSON.stringify(OLD_UNIVERSAL_DENY));
check("未知 skill 按 rw-shell 兜底挂 write-shell preset + 通用 deny",
  resolveSkillAgentPreset("co-nonexistent", true) === "cohub-subagent-write-shell"
  && JSON.stringify(resolveSkillToolFilter("co-nonexistent", true)!.deny)
    === JSON.stringify(OLD_UNIVERSAL_DENY));
check("关闭总开关时两者都返回 undefined（旧行为）",
  resolveSkillToolFilter("co-fixer", false) === undefined
  && resolveSkillAgentPreset("co-fixer", false) === undefined);

// ── 用例 2：自定义角色（tier:'ro-net'）——技能 / preset / 白名单 ────────────
group("用例 2：自定义角色 ro-net 接入断言");
const CUSTOM: readonly CustomRoleConfig[] = [{
  name: "my-researcher",
  description: "外部资料研究（只读 + 联网）",
  prompt: "你是研究员：只用 web 检索与读取，产出带引用的证据清单，不修改任何文件。",
  tier: "ro-net",
}];
const snapshotWithCustom = resolveSkillSnapshot({ customRoles: CUSTOM });
const customLookup = snapshotWithCustom.resolve("my-researcher");
check("自定义角色可被技能查表命中", customLookup.ok === true);
check("自定义角色出现在快照名单里（全部内置角色 + 1）",
  snapshotWithCustom.names.includes("my-researcher") && snapshotWithCustom.names.length === COHUB_SKILLS.length + 1);
check("自定义角色档位 = ro-net", resolveTier("my-researcher", CUSTOM) === "ro-net");
check("自定义角色按自身 tier（ro-net）挂 readonly-net preset",
  resolveSkillAgentPreset("my-researcher", true, CUSTOM) === "cohub-subagent-readonly-net");

const customDeny = resolveSkillToolFilter("my-researcher", true, undefined, CUSTOM)!.deny;
check("自定义角色工具白名单含 web 检索/抓取（web 工具不在 deny 里）",
  !customDeny.includes("web_search") && !customDeny.includes("web_fetch"));
check("自定义角色工具白名单**不含 shell**（本平台 shell 工具在 deny 里）",
  customDeny.includes(SHELL_TOOL));
check("自定义角色工具白名单**不含写**（write / edit 在 deny 里，read / grep 保留）",
  customDeny.includes("write") && customDeny.includes("edit")
  && !customDeny.includes("read") && !customDeny.includes("grep"));
check("自定义角色仍裁掉再委派工具（不套娃）",
  customDeny.includes("delegate") && customDeny.includes("delegate_batch"));

// ── 用例 3：单发路径（resolveSkillAndRoute + buildDelegatePrompt） ──────────
group("用例 3：单发 delegate 路径");
const ctx = { logger: { warn: () => {}, info: () => {} } };
const getRoutes = () => [];
const single = resolveSkillAndRoute("my-researcher", getRoutes, ctx, ctx.logger, snapshotWithCustom);
check("单发：自定义角色命中（不兜底 co-fixer）",
  single.skill.name === "my-researcher" && single.fallback === false && single.note === undefined);
check("单发：命中角色的 tier / builtin 标记正确",
  single.role?.tier === "ro-net" && single.role?.builtin === false);
const customPromptText = buildDelegatePrompt({
  skill: single.skill,
  ...(single.role !== undefined && !single.role.builtin && single.role.skill.brief.length > 0
    ? { customPrompt: single.role.skill.brief }
    : {}),
  contractText: "",
  userPrompt: "查一下 Bun 的 workspace 语义",
});
check("单发：提示词以自定义角色 prompt 开头（brief 注入）",
  customPromptText.startsWith("你是研究员：") && customPromptText.includes("--- 你的具体任务 ---"));
const builtinPromptText = buildDelegatePrompt({
  skill: COHUB_SKILLS.find((s) => s.name === "co-fixer")!,
  contractText: "",
  userPrompt: "改一个文件",
});
check("单发：内置角色提示词逐字不变（brief 原样 + 任务分隔）",
  builtinPromptText === COHUB_SKILLS.find((s) => s.name === "co-fixer")!.brief
    + "\n\n--- 你的具体任务 ---\n\n改一个文件");

// ── 用例 4：批量路径（白名单 assertKnownSkill + 同一档位派生） ──────────────
group("用例 4：批量 delegate_batch 路径");
check("批量：自定义角色通过白名单校验",
  assertKnownSkill("my-researcher", snapshotWithCustom).ok === true);
check("批量：内置角色仍通过白名单校验", assertKnownSkill("co-fixer", snapshotWithCustom).ok === true);
const unknownCheck = assertKnownSkill("co-typo", snapshotWithCustom);
check("批量：不存在的名字报错且文案含「不存在」并回显可用名单",
  unknownCheck.ok === false && unknownCheck.error.includes("不存在")
  && unknownCheck.error.includes("my-researcher") && !unknownCheck.error.includes("已被禁用"));
const disabledSnapshot = resolveSkillSnapshot({ customRoles: CUSTOM, disabledSkills: ["my-researcher"] });
const disabledCheck = assertKnownSkill("my-researcher", disabledSnapshot);
check("批量：存在但被禁用的名字报错，文案区分于「不存在」",
  disabledCheck.ok === false && disabledCheck.error.includes("已被禁用")
  && disabledCheck.error.includes("config.disabledSkills") && !disabledCheck.error.includes("不存在"));
check("批量：同一份快照下的 preset / 裁剪与单发一致（同一条解析路径）",
  resolveSkillAgentPreset("my-researcher", true, CUSTOM) === "cohub-subagent-readonly-net"
  && JSON.stringify(resolveSkillToolFilter("my-researcher", true, undefined, CUSTOM))
    === JSON.stringify({ deny: customDeny }));
const batchPrompt = buildDelegatePrompt({
  skill: snapshotWithCustom.resolve("my-researcher").ok
    ? (snapshotWithCustom.resolve("my-researcher") as { ok: true; role: { skill: typeof single.skill } }).role.skill
    : single.skill,
  customPrompt: CUSTOM[0]!.prompt,
  contractText: "",
  userPrompt: "批量任务",
});
check("批量：自定义角色提示词同样以 prompt 开头",
  batchPrompt.startsWith("你是研究员：") && batchPrompt.includes("批量任务"));

// ── 用例 5：禁用 channel 在单发路径的降级文案 ────────────────────────────
group("用例 5：单发路径的禁用降级文案");
const disabledSingle = resolveSkillAndRoute(
  "my-researcher", getRoutes, ctx, ctx.logger, disabledSnapshot,
);
check("单发：被禁用 → 兜底 co-fixer 且 note 说明「已被禁用」",
  disabledSingle.skill.name === "co-fixer"
  && (disabledSingle.note ?? "").includes("已被禁用"));
const unknownSingle = resolveSkillAndRoute("co-typo", getRoutes, ctx, ctx.logger, snapshotWithCustom);
check("单发：不存在 → 兜底 co-fixer 且 note 说明「未匹配任何角色」",
  unknownSingle.skill.name === "co-fixer"
  && (unknownSingle.note ?? "").includes("未匹配任何角色"));

// ── 汇总 ────────────────────────────────────────────────────────────────
// ── 用例 6：档位子代理改为「继承父组合 + restrict 裁剪」的四条硬断言 ─────────
group("用例 6：spawn spec 挂档位预设 + restrict 覆盖 + fail-closed");

/** 与 test/delegate-p1.ts 同构的 0.2.1 桩：startActivation(spec) → { childId, result, dispose } */
function makeSpawnCtx(restrictImpl: (filter: any) => void) {
  const specs: any[] = [];
  const disposed: number[] = [];
  const ctx: any = {
    logger: { warn: () => {}, info: () => {} },
    subagents: {
      async startActivation(spec: any) {
        specs.push(spec);
        const n = specs.length;
        return { childId: "child-" + n, result: Promise.resolve({ text: "ok" }), dispose: () => disposed.push(n) };
      },
    },
    agents: { get: () => ({ ctx: { tools: { restrict: restrictImpl } } }) },
  };
  return { ctx, specs, disposed };
}

async function spawnWith(skill: string, restrictImpl: (filter: any) => void = () => {}) {
  const made = makeSpawnCtx(restrictImpl);
  await startSubagentRun(made.ctx, "spawn", {
    label: "t:" + skill,
    prompt: [{ type: "text", text: "任务正文" }],
    parent: { id: "parent-1" },
    toolFilter: resolveSkillToolFilter(skill, true),
    agentPreset: resolveSkillAgentPreset(skill, true),
  });
  return made;
}

// ① 四个档位各取一个代表角色：spec 必带对应档位预设（顶层 + request 双写）
const TIER_REPS: ReadonlyArray<readonly [string, string]> = [
  ["ro", "co-explorer"],
  ["ro-net", "co-librarian"],
  ["rw", "co-designer"],
  ["rw-shell", "co-fixer"],
];
for (const [tier, skill] of TIER_REPS) {
  const { specs } = await spawnWith(skill);
  const spec = specs[0];
  const expected = TIER_EXPECTED_PRESET[tier];
  check(tier + " 档（" + skill + "）spawn spec 带 agentPreset = " + expected,
    spec?.agentPreset === expected && spec?.request?.agentPreset === expected);
}

// ② co-cordis 仍挂 cohub-cordis（tool-cordis 无法由 restrict 补出）
const cordisSpawn = await spawnWith("co-cordis");
const cordisSpec = cordisSpawn.specs[0];
check("co-cordis 仍带 agentPreset = cohub-cordis（顶层 + request 双写）",
  cordisSpec?.agentPreset === "cohub-cordis" && cordisSpec?.request?.agentPreset === "cohub-cordis");

// ③ 只读两档的 deny 覆盖 write / edit / shell（裁剪是唯一权限边界）
for (const skill of ["co-explorer", "co-librarian"]) {
  const deny = resolveSkillToolFilter(skill, true)!.deny;
  check(skill + " 的 deny 同时含 write / edit / shell（" + SHELL_TOOL + "）",
    deny.includes("write") && deny.includes("edit") && deny.includes(SHELL_TOOL));
}
// 写类两档：保留 write/edit，不需要 shell 裁（preset 层按平台挂一个 shell，档位表不裁）
for (const skill of ["co-designer", "co-fixer"]) {
  const deny = resolveSkillToolFilter(skill, true)!.deny;
  check(skill + " 的 deny 不含 write / edit（写类保留）",
    !deny.includes("write") && !deny.includes("edit"));
}

// ④ fail-closed：restrict 抛错 → 本次派发失败（不再放行为全量工具）
const { ctx: boomCtx } = makeSpawnCtx(() => { throw new Error("restrict exploded"); });
let enforced: any;
try {
  await startSubagentRun(boomCtx, "spawn", {
    label: "t:co-fixer",
    prompt: [{ type: "text", text: "任务正文" }],
    parent: { id: "parent-1" },
    toolFilter: resolveSkillToolFilter("co-fixer", true),
    agentPreset: resolveSkillAgentPreset("co-fixer", true),
  });
} catch (error) {
  enforced = error;
}
check("restrict 抛错时派发失败（fail-closed，不放行全量工具）", enforced !== undefined);
check("派发失败的错误文案点名 fail-closed 与裁剪未施加",
  String(enforced?.message ?? "").includes("fail-closed")
  && String(enforced?.message ?? "").includes("子代理工具裁剪未能施加"));

console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
