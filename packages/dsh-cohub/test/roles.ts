// dsh-cohub/test/roles.ts —— src/roles.ts 的离线验证（纯数据表 + 纯函数，无副作用）
// 用法：node test/roles.ts（node >= 24 类型剥离）；由 scripts/test-all.mjs 自动发现。
//
// 被测对象：
//   - BUILTIN_ROLE_TIERS / TIER_TO_PRESET / TIER_TOOLS 三张表
//   - resolveTier（自定义 > 内置 > null）与 presetForTier（档位 → preset）
//
// 关注点：这张表是 delegate / delegate_batch 共用的唯一映射源，错一格就是「子代理挂着
// 只读 preset 却拿到 shell」或「自定义角色被内置表覆盖」这类静默错配，因此逐角色锁死，
// 而不是抽查。
import {
  ALL_TIERS,
  BUILTIN_ROLE_TIERS,
  SHELL_TOOL,
  TIER_TOOLS,
  TIER_TO_PRESET,
  applyRoleOverride,
  presetForTier,
  resolveRoleKind,
  resolveSkillSnapshot,
  resolveTier,
  type RoleOverride,
  type RoleSpec,
  type Tier,
} from "../src/roles.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** 期望的内置归类：改表必须同时改这里（等于把归类写进测试契约） */
const EXPECTED_BUILTIN: ReadonlyArray<readonly [string, Tier]> = [
  ["co-explorer", "ro"],
  ["co-oracle", "ro"],
  ["co-planner", "ro"],
  ["co-council", "ro"],
  ["co-observer", "ro"],
  ["co-rule-user", "ro"],
  ["co-rule-project", "ro"],
  ["co-rule-app", "ro"],
  ["co-librarian", "ro-net"],
  ["co-outliner", "ro-net"],
  ["co-designer", "rw"],
  ["co-writer", "rw"],
  ["co-fixer", "rw-shell"],
  ["co-cordis", "cordis"],
  ["co-editor", "ro"],
  ["co-team-lead", "rw"],
  ["co-team-member", "rw"],
];

// ── 用例 1：内置角色查档（逐角色锁死） ────────────────────────────────────
group("用例 1：内置角色查档（" + EXPECTED_BUILTIN.length + " 个角色逐一）");
for (const [name, tier] of EXPECTED_BUILTIN) {
  check(`resolveTier(${name}) = ${tier}`, resolveTier(name) === tier);
}
check("内置表条目数 = " + EXPECTED_BUILTIN.length + "（内置角色去掉主代理 co-orchestrator）",
  Object.keys(BUILTIN_ROLE_TIERS).length === EXPECTED_BUILTIN.length);
check("主代理 co-orchestrator 不在表内（查档返回 null）", resolveTier("co-orchestrator") === null);
check("表内无多余角色（与期望清单完全一致）",
  Object.keys(BUILTIN_ROLE_TIERS).every((name) => EXPECTED_BUILTIN.some(([n]) => n === name)));

// ── 用例 2：自定义角色覆盖内置 / 自定义新增 / 脏值回退 ────────────────────
group("用例 2：自定义角色优先级");
const overrides: readonly RoleSpec[] = [{ name: "co-fixer", tier: "ro" }];
check("自定义 tier 覆盖内置（co-fixer: rw-shell → ro）", resolveTier("co-fixer", overrides) === "ro");
check("覆盖只影响命中的角色（co-designer 仍是 rw）", resolveTier("co-designer", overrides) === "rw");
check("自定义新增角色可解析（my-helper → rw）", resolveTier("my-helper", [{ name: "my-helper", tier: "rw" }]) === "rw");
check("自定义角色名两侧空白被忽略", resolveTier("  co-fixer  ", overrides) === "ro");
check("自定义角色 tier 非法时回退内置表（脏值不拦截解析）",
  resolveTier("co-fixer", [{ name: "co-fixer", tier: "rwx" as unknown as Tier }]) === "rw-shell");
check("自定义角色 tier 非法且非内置 → null",
  resolveTier("my-helper", [{ name: "my-helper", tier: "rwx" as unknown as Tier }]) === null);
check("自定义角色未给 tier → 回退内置",
  resolveTier("co-fixer", [{ name: "co-fixer" }]) === "rw-shell");
check("空自定义表不影响内置解析", resolveTier("co-librarian", []) === "ro-net");

// ── 用例 3：未知角色返回 null（由调用方报错） ─────────────────────────────
group("用例 3：未知角色返回 null");
check("未知角色名 → null", resolveTier("co-unknown") === null);
check("空串 → null", resolveTier("") === null);
check("undefined → null", resolveTier(undefined) === null);
check("纯空白 → null", resolveTier("   ") === null);
check("大小写敏感（Co-Fixer ≠ co-fixer）→ null", resolveTier("Co-Fixer") === null);

// ── 用例 4：5 个档位都能解析出 preset ────────────────────────────────────
group("用例 4：档位 → preset");
check("ALL_TIERS 共 5 个档位", ALL_TIERS.length === 5);
const EXPECTED_PRESET: ReadonlyArray<readonly [Tier, string]> = [
  ["ro", "cohub-subagent-readonly"],
  ["ro-net", "cohub-subagent-readonly-net"],
  ["rw", "cohub-subagent-write"],
  ["rw-shell", "cohub-subagent-write-shell"],
  ["cordis", "cohub-cordis"],
];
for (const [tier, preset] of EXPECTED_PRESET) {
  check(`presetForTier(${tier}) = ${preset}`, presetForTier(tier) === preset);
}
check("TIER_TO_PRESET 覆盖 ALL_TIERS 全部档位",
  ALL_TIERS.every((tier) => typeof TIER_TO_PRESET[tier] === "string" && TIER_TO_PRESET[tier].length > 0));
check("5 个 preset 互不重复（无档位退化到同一个 preset）",
  new Set(ALL_TIERS.map((tier) => presetForTier(tier))).size === 5);
check("presetForTier 对脏值兜底为 rw-shell（不返回 undefined）",
  presetForTier("rwx" as unknown as Tier) === "cohub-subagent-write-shell");
check("每个内置角色都能解析出非空 preset（表内无孤档）",
  EXPECTED_BUILTIN.every(([name]) => {
    const tier = resolveTier(name);
    return tier !== null && presetForTier(tier).length > 0;
  }));

// ── 用例 5：TierTools 覆盖与裁剪差异 ─────────────────────────────────────
group("用例 5：档位工具裁剪数据");
check("TIER_TOOLS 覆盖 ALL_TIERS", ALL_TIERS.every((tier) => TIER_TOOLS[tier] !== undefined));
check("每档 deny 非空且无重复",
  ALL_TIERS.every((tier) => {
    const deny = TIER_TOOLS[tier].deny;
    return deny.length > 0 && new Set(deny).size === deny.length;
  }));
check("只读档位裁掉 write / edit / shell 与再委派",
  ["write", "edit", SHELL_TOOL, "delegate", "delegate_batch", "subagent", "subagent_fork"]
    .every((tool) => TIER_TOOLS.ro.deny.includes(tool) && TIER_TOOLS["ro-net"].deny.includes(tool)));
check("写类档位保留 write / edit，仅裁再委派与工作树",
  ["write", "edit"].every((tool) => !TIER_TOOLS["rw-shell"].deny.includes(tool))
  && ["delegate", "delegate_batch", "subagent", "subagent_fork", "create_worktree", "workflow"]
    .every((tool) => TIER_TOOLS["rw-shell"].deny.includes(tool)));
// 批次 2 修正：rw 档不裁 shell —— 以接线前 delegate.ts 的 WRITE_DENY 为基准（co-designer 旧行为
// 的 deny 列表里没有 shell），「无 shell」由 preset 层保证。因此这里断言的是「rw 与 rw-shell
// 裁剪表相同、差异只在 preset」。
check("rw 与 rw-shell 裁剪表相同（无 shell 由 preset 层保证，差异只在 preset）",
  JSON.stringify(TIER_TOOLS.rw.deny) === JSON.stringify(TIER_TOOLS["rw-shell"].deny)
  && presetForTier("rw") !== presetForTier("rw-shell"));
check("rw / rw-shell / cordis 都不裁 shell（以旧 WRITE_DENY 为基准）",
  !TIER_TOOLS.rw.deny.includes(SHELL_TOOL)
  && !TIER_TOOLS["rw-shell"].deny.includes(SHELL_TOOL)
  && !TIER_TOOLS.cordis.deny.includes(SHELL_TOOL));
check("通用裁剪对所有档位生效（ask_user_question / weather）",
  ALL_TIERS.every((tier) => TIER_TOOLS[tier].deny.includes("ask_user_question")
    && TIER_TOOLS[tier].deny.includes("weather")));
check("SHELL_TOOL 是 pwsh / bash 之一（与平台互斥挂载一致）",
  SHELL_TOOL === "pwsh" || SHELL_TOOL === "bash");

// ── 用例 6：roleOverrides —— 内置角色的字段级覆盖（四组） ──────────────────
group("用例 6：roleOverrides 覆盖内置角色");

const builtinSnapshot = resolveSkillSnapshot();
const builtinFixer = builtinSnapshot.resolve("co-fixer");
const builtinFixerBrief = builtinFixer.ok ? builtinFixer.role.skill.brief : "";
const builtinFixerDesc = builtinFixer.ok ? builtinFixer.role.skill.description : "";
check("基线：co-fixer 可解析且 brief 非空", builtinFixer.ok && builtinFixerBrief.length > 0);

// ① 覆盖 prompt → brief / content 变新值；未提供的 description 沿用内置
const FIXER_PROMPT = "你是修复专员：改前先 read，改完跑构建与测试，报告改动与验证。";
const promptOverride: readonly RoleOverride[] = [{ name: "co-fixer", prompt: FIXER_PROMPT }];
const promptSnapshot = resolveSkillSnapshot({ roleOverrides: promptOverride });
const promptFixer = promptSnapshot.resolve("co-fixer");
check("① 覆盖 prompt → brief 为新值", promptFixer.ok && promptFixer.role.skill.brief === FIXER_PROMPT);
check("① 覆盖 prompt → content 同步为新值", promptFixer.ok && promptFixer.role.skill.content === FIXER_PROMPT);
check("① 未提供 description → 沿用内置", promptFixer.ok && promptFixer.role.skill.description === builtinFixerDesc);
check("① 纯函数 applyRoleOverride 返回新对象、不改入参", builtinFixer.ok && (() => {
  const out = applyRoleOverride(builtinFixer.role.skill, { name: "co-fixer", prompt: FIXER_PROMPT });
  return out.brief === FIXER_PROMPT && out.content === FIXER_PROMPT
    && builtinFixer.role.skill.brief !== FIXER_PROMPT;
})());
check("① override 未给 tier → 沿用内置档位 rw-shell", promptFixer.ok && promptFixer.role.tier === "rw-shell");
const builtinWriter = builtinSnapshot.resolve("co-writer");
const promptWriter = promptSnapshot.resolve("co-writer");
check("① 只影响命中的角色（co-writer brief 不变）",
  builtinWriter.ok && promptWriter.ok && builtinWriter.role.skill.brief === promptWriter.role.skill.brief);

// ② 覆盖 tier 为 ro → resolveTier / 快照 / preset 全部跟随
const roOverride: readonly RoleOverride[] = [{ name: "co-fixer", tier: "ro" }];
check("② resolveTier(co-fixer, undefined, tier=ro) = ro", resolveTier("co-fixer", undefined, roOverride) === "ro");
const roSnapshot = resolveSkillSnapshot({ roleOverrides: roOverride });
const roFixer = roSnapshot.resolve("co-fixer");
check("② 快照条目 tier 同步为 ro", roFixer.ok && roFixer.role.tier === "ro");
check("② preset 随档位变为只读",
  presetForTier(resolveTier("co-fixer", undefined, roOverride) ?? "rw-shell") === "cohub-subagent-readonly");
check("② 覆盖只影响命中角色（co-writer 仍 rw）", resolveTier("co-writer", undefined, roOverride) === "rw");
check("② 脏 tier 回退内置（rwx → rw-shell）",
  resolveTier("co-fixer", undefined, [{ name: "co-fixer", tier: "rwx" as unknown as Tier }]) === "rw-shell");
check("② override 不可覆盖 kind（co-fixer 仍 member、co-team-lead 仍 lead）",
  resolveRoleKind("co-fixer", undefined, roOverride) === "member"
  && resolveRoleKind("co-team-lead", undefined, [{ name: "co-team-lead", tier: "ro" }]) === "lead");

// ③ 覆盖不存在的 name → 忽略 + 日志，其余不变
const logged: string[] = [];
const originalLog = console.log;
let unknownSnapshot: ReturnType<typeof resolveSkillSnapshot> | undefined;
try {
  console.log = ((...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.log;
  unknownSnapshot = resolveSkillSnapshot({
    roleOverrides: [{ name: "co-unknown-role", prompt: "不该生效的覆盖", tier: "ro" }],
  });
} finally {
  console.log = originalLog;
}
check("③ 未知 name 不新增角色（名单与内置一致）",
  unknownSnapshot !== undefined
  && JSON.stringify(unknownSnapshot.names) === JSON.stringify(builtinSnapshot.names));
check("③ 未知 name 留痕：日志含 skip unknown name=co-unknown-role",
  logged.some((line) => line.includes("[cohub/role-override] skip unknown name=co-unknown-role")));
const unknownFixer = unknownSnapshot?.resolve("co-fixer");
check("③ 其余角色不变（co-fixer brief 仍是内置）",
  unknownFixer !== undefined && unknownFixer.ok && unknownFixer.role.skill.brief === builtinFixerBrief);
check("③ 未知 name 不报错（查它仍是 unknown）", unknownSnapshot?.resolve("co-unknown-role").ok === false);

// ④ customRoles 与 override 同名 → customRoles 胜
const customVsOverride = resolveSkillSnapshot({
  customRoles: [{ name: "co-fixer", description: "自定义职责", prompt: "自定义 brief" }],
  roleOverrides: [{ name: "co-fixer", prompt: "覆盖 brief", description: "覆盖职责", tier: "ro" }],
});
const wins = customVsOverride.resolve("co-fixer");
check("④ customRoles 胜：brief 来自 customRoles", wins.ok && wins.role.skill.brief === "自定义 brief");
check("④ customRoles 胜：description 来自 customRoles", wins.ok && wins.role.skill.description === "自定义职责");
check("④ customRoles 胜：builtin=false（快照标记为自定义）", wins.ok && wins.role.builtin === false);
check("④ customRoles 未给 tier → 回退 override 的 tier（ro）",
  resolveTier("co-fixer", [{ name: "co-fixer" }], [{ name: "co-fixer", tier: "ro" }]) === "ro");
check("④ customRoles 给了 tier → customRoles 胜（rw）",
  resolveTier("co-fixer", [{ name: "co-fixer", tier: "rw" }], [{ name: "co-fixer", tier: "ro" }]) === "rw");

// ⑤ tools 覆盖随快照条目下传（留空 = 档位推导）
const toolsSnapshot = resolveSkillSnapshot({ roleOverrides: [{ name: "co-fixer", tools: ["tool-fs", "tool-pwsh"] }] });
const toolsFixer = toolsSnapshot.resolve("co-fixer");
check("⑤ tools 覆盖进快照条目",
  toolsFixer.ok && JSON.stringify(toolsFixer.role.tools) === JSON.stringify(["tool-fs", "tool-pwsh"]));
check("⑤ 未给 tools 的角色不带 tools 字段（沿用档位推导）", builtinFixer.ok && builtinFixer.role.tools === undefined);

if (promptFixer.ok) {
  const firstSentence = promptFixer.role.skill.brief.split(/[。\n]/)[0];
  console.log("覆盖后 co-fixer 的 brief 首句：" + firstSentence);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
