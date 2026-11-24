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
  presetForTier,
  resolveTier,
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
  ["co-designer", "rw"],
  ["co-fixer", "rw-shell"],
  ["co-cordis", "cordis"],
];

// ── 用例 1：内置角色查档（逐角色锁死） ────────────────────────────────────
group("用例 1：内置角色查档（12 个角色逐一）");
for (const [name, tier] of EXPECTED_BUILTIN) {
  check(`resolveTier(${name}) = ${tier}`, resolveTier(name) === tier);
}
check("内置表条目数 = 12（13 个内置角色去掉主代理 co-orchestrator）", Object.keys(BUILTIN_ROLE_TIERS).length === 12);
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

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
