// dsh-cohub/src/roles.ts —— 角色 → 工具档位 → 子代理 preset 的唯一映射源
//
// 背景：档位此前散落在三处各写一份——delegate.ts 的 READ_ONLY_SKILLS / WRITE_SKILLS
// 两个 Set（决定除什么工具）、resolveSkillAgentPreset 里的 if 链（决定挂哪个 preset）、
// presets/*/preset.yml（真正的工具面）。任何新增角色都要改三处，漏一处就是「preset 挂了
// 但工具没裁」或「裁了但 preset 不对」的静默错配。
//
// 本文件把这条链收成纯数据表 + 两个纯函数，供 delegate / delegate_batch 共用：
//   roleName ──resolveTier──▶ Tier ──presetForTier──▶ preset id
//                                └──TIER_TOOLS[tier]──▶ 派发层工具裁剪
//
// 约束：本文件是**纯数据 + 纯函数**，不含日志、不读配置、不依赖 cordis 上下文；
// 平台相关的 shell 工具名在模块加载时求值一次（与原 delegate.ts 的 SHELL_TOOL 一致）。
//
// 批次 2（本批）：delegate.ts / delegate_batch.ts 接线——技能查表改为「内置 ∪ 自定义」
// 的统一快照 {@link resolveSkillSnapshot}，工具裁剪与 preset 都经 resolveTier / TIER_TOOLS
// / presetForTier 派生，内置角色与自定义角色走同一条路径。
import { BUILTIN_TEAMS } from "./builtin-teams.ts";
import { COHUB_SKILLS, type CoHubSkill } from "./skills.ts";

/** 工具档位：子代理能碰到的工具面分级 */
export type Tier = "ro" | "ro-net" | "rw" | "rw-shell" | "cordis";

/** 全部档位（顺序即文档顺序；测试据此遍历，新增档位必须同时补 preset 映射） */
export const ALL_TIERS: readonly Tier[] = ["ro", "ro-net", "rw", "rw-shell", "cordis"];

/**
 * 档位 → 子代理 preset id（随包安装在 ~/.dsh/.agent-presets/，见 src/preset-install.ts）。
 *
 * - ro      cohub-subagent-readonly      只读：read / grep / glob / read_image，无写、无 shell、无联网
 * - ro-net  cohub-subagent-readonly-net  只读 + 联网检索（librarian 这类要查官方文档的角色）
 * - rw      cohub-subagent-write         读写：write / edit，无 shell
 * - rw-shell cohub-subagent-write-shell  读写 + shell（能跑 build / test / git 的实施类）
 * - cordis  cohub-cordis                 Cordis 插件 / preset 组合专用（自带重建产物流程）
 */
export const TIER_TO_PRESET: Readonly<Record<Tier, string>> = {
  ro: "cohub-subagent-readonly",
  "ro-net": "cohub-subagent-readonly-net",
  rw: "cohub-subagent-write",
  "rw-shell": "cohub-subagent-write-shell",
  cordis: "cohub-cordis",
};

/**
 * 内置角色 → 档位（内置角色中除 co-orchestrator 外的全部专职代理）。
 * 数量以本表条目为准，不在注释里写死——新增角色只加行、不改这里的数字。
 *
 * co-orchestrator 不在此表：它是**主代理**本身（委派发起方），被委派时仍需要完整工具面，
 * 派发层对它的处理是「不走档位、继承父 preset」，用 resolveTier 返回 null 会把这两件事
 * 混为一谈，故由调用方先行短路。
 *
 * 归类依据 = 各技能自身声明的能力边界（skills.ts 的「只读 / 读写 / 读写+Bash」）：
 *   - 只读且不需要外网 → ro（explorer 在库内 grep/glob；oracle 审代码；planner 出方案；
 *     council 多模型共识；observer 看图；rule-* 读规则文件；editor 审校文本）
 *   - 只读但要联网 → ro-net（librarian 查官方文档 / GitHub / Web；outliner 选题需外部素材）
 *   - 读写但不需要 shell → rw（designer 只改样式与组件；writer 只写文本，两者都不跑构建）
 *   - 读写 + shell → rw-shell（fixer 要 build / test / git commit）
 *   - Cordis 专线 → cordis（自建 preset，含插件重建与安装链路）
 */
export const BUILTIN_ROLE_TIERS: Readonly<Record<string, Tier>> = {
  // 只读
  "co-explorer": "ro",
  "co-oracle": "ro",
  "co-planner": "ro",
  "co-council": "ro",
  "co-observer": "ro",
  "co-rule-user": "ro",
  "co-rule-project": "ro",
  "co-rule-app": "ro",
  "co-editor": "ro",
  // 只读 + 联网
  "co-librarian": "ro-net",
  "co-outliner": "ro-net",
  // 读写
  "co-designer": "rw",
  "co-writer": "rw",
  "co-team-lead": "rw",
  "co-team-member": "rw",
  // 读写 + shell
  "co-fixer": "rw-shell",
  // Cordis 专线
  "co-cordis": "cordis",
};

/**
 * 角色类型：队长（lead）/ 队员（member）。
 *
 * 语义边界：kind **只**用于「这个角色能否被团队指定为 lead（主代理人格）」这一条判定，
 * 与档位、工具面、派发权限都无关——队员照样可以被派发，队长也不会自动获得派发豁免
 * （派发豁免仍只看 team.members，见 {@link isRoleAllowed}）。
 */
export type RoleKind = "lead" | "member";

/**
 * 内置角色 → 类型（队长 / 队员）。
 *
 * 只有两个内置角色是队长：
 *   - `co-orchestrator`：主代理本身（默认调度者，团队 lead 的天然回退目标）；
 *   - `co-team-lead`：通用队长（用户自建团队时的可复用队长角色）。
 *
 * 其余内置角色一律是队员。这里**显式列出全部成员而不只写队长**：新增内置角色时，
 * 忘记想清它是哪一类会让 test/lead-persona.ts 的「表覆盖全部内置角色」用例直接失败，
 * 而不是静默按默认值 member 混过去。
 */
export const BUILTIN_ROLE_KINDS: Readonly<Record<string, RoleKind>> = {
  // 队长
  "co-orchestrator": "lead",
  "co-team-lead": "lead",
  // 队员（只读）
  "co-explorer": "member",
  "co-oracle": "member",
  "co-planner": "member",
  "co-council": "member",
  "co-observer": "member",
  "co-rule-user": "member",
  "co-rule-project": "member",
  "co-rule-app": "member",
  "co-editor": "member",
  // 队员（只读 + 联网）
  "co-librarian": "member",
  "co-outliner": "member",
  // 队员（读写）
  "co-designer": "member",
  "co-writer": "member",
  "co-team-member": "member",
  // 队员（读写 + shell）/ Cordis 专线
  "co-fixer": "member",
  "co-cordis": "member",
};

/**
 * 本平台实际挂载的 shell 工具名。
 * preset 里 tool-bash 与 tool-pwsh 互斥挂载，restrict() 对未挂载的名字是 loud 报错，
 * 所以裁剪表只能写当前平台那一个名字。
 */
export const SHELL_TOOL: string = process.platform === "win32" ? "pwsh" : "bash";

/** 通用裁剪（所有档位都加）：与子代理本职无关的交互 / 目标循环 / 多媒体工具 */
const UNIVERSAL_DENY: readonly string[] = [
  "ask_user_question",
  "create_goal",
  "update_goal",
  "get_goal",
  "weather",
  "video_search",
];

/** 只读档位裁剪：写入 / 执行 / 再委派全部裁掉（read、grep、glob、read_image 保留） */
const READ_ONLY_DENY: readonly string[] = [
  "write",
  "edit",
  SHELL_TOOL,
  "create_worktree",
  "workflow",
  "delegate",
  "delegate_batch",
  "subagent",
  "subagent_fork",
];

/** 写类档位裁剪：能干活的工具都留，只裁「再往下委派」与建工作树（避免无限套娃） */
const WRITE_DENY: readonly string[] = [
  "create_worktree",
  "workflow",
  "delegate",
  "delegate_batch",
  "subagent",
  "subagent_fork",
];

/** 一个档位的工具裁剪数据 */
export interface TierTools {
  /**
   * 白名单：一旦非空即「只留这些」。
   * 当前所有档位都为空（= 全量挂载后做减法），保留字段是为了将来给极窄角色（如 observer）
   * 收口时不改接口。
   */
  readonly allow?: readonly string[];
  /** 黑名单：在这些档位下筛掉的工具名（deny 减法，精确全局工具名） */
  readonly deny: readonly string[];
}

/** 档位 → 工具裁剪（从 delegate.ts 的 READ_ONLY_DENY / WRITE_DENY / UNIVERSAL_DENY 提炼） */
export const TIER_TOOLS: Readonly<Record<Tier, TierTools>> = {
  ro: { deny: [...READ_ONLY_DENY, ...UNIVERSAL_DENY] },
  // ro-net 的工具面与 ro 相同：联网能力由 preset（cohub-subagent-readonly-net 挂 web 工具）提供，
  // 裁剪表只做减法，无需再 deny 网络工具。
  "ro-net": { deny: [...READ_ONLY_DENY, ...UNIVERSAL_DENY] },
  // rw 与 rw-shell 的 **deny 层完全相同**，差异全部由 preset 层决定
  // （cohub-subagent-write vs cohub-subagent-write-shell）。注意「读写有无 shell」并不构成区别：
  // **当前 write preset 也挂了 shell** —— presets/cohub-subagent-write/agent.cordis.yml 同时声明
  // tool-bash（win32 禁用）与 tool-pwsh（非 win32 禁用），即按平台互斥地挂了一个 shell 工具，
  // 所以 rw 角色（co-designer / co-writer）实际也能跑命令。
  //
  // 为什么不在这里 deny shell（批次 2 修正）：接线前 delegate.ts 的旧表把 co-designer / co-fixer /
  // co-cordis 统一归入 WRITE_SKILLS → base = WRITE_DENY（**不含** SHELL_TOOL）。若 rw 档 deny 里
  // 加上 shell，co-designer 的最终 deny 列表就会比改动前多一项（违反「内置角色工具集逐字不变」）。
  // 按任务约束「以现有行为为基准修正 roles.ts」，这里以旧表为准：rw 不裁 shell。
  //
  // ⚠️ 待收决策（本批不动）：preset 层既已给 write 挂 shell，「rw 无 shell」这个档位语义已不成立。
  // 要么去掉 write preset 的 shell（回到原意，designer / writer 随之失去跑命令能力），要么承认
  // rw 与 rw-shell 的实质差异不在工具面。两条路都改行为，故本批只把事实写进注释。
  rw: { deny: [...WRITE_DENY, ...UNIVERSAL_DENY] },
  "rw-shell": { deny: [...WRITE_DENY, ...UNIVERSAL_DENY] },
  // cordis 与 rw-shell 工具面一致，差异在 preset（插件重建 / 安装链路）。
  cordis: { deny: [...WRITE_DENY, ...UNIVERSAL_DENY] },
};

/** 自定义角色（用户配置里的 role 定义）；只声明档位 / 类型解析需要的最小字段 */
export interface RoleSpec {
  /** 角色名（与内置角色同名即覆盖内置） */
  readonly name: string;
  /** 档位；缺省时回退到内置表 */
  readonly tier?: Tier;
  /**
   * 角色类型（队长 / 队员）；缺省时先查内置表、再回落 member。
   *
   * **可选**是有意的向后兼容：老配置里的 customRoles 没有该字段，schema 不能因此拒绝加载，
   * 解析层也不能崩（见 {@link resolveRoleKind}）。
   */
  readonly kind?: RoleKind;
}

/** 运行时判定一个值是否是合法档位（自定义角色来自用户配置，可能写出脏值） */
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (ALL_TIERS as readonly string[]).includes(value);
}

/**
 * 解析角色应走的档位。
 *
 * 优先级：自定义角色自身 tier > 内置表 > null。
 * 返回 null 表示「不知道该给什么档位」（未知角色名 / 空名 / 自定义角色 tier 非法且非内置），
 * 由调用方决定报错还是兜底——本函数不猜、不静默降级。
 *
 * @param roleName - 角色名（如 co-fixer）；undefined / 空串 / 纯空白一律视为未知。
 * @param customRoles - 自定义角色表（可选）；同名时其 tier 覆盖内置。
 * @returns 档位；null 表示未知。
 */
export function resolveTier(
  roleName: string | undefined,
  customRoles?: readonly RoleSpec[],
): Tier | null {
  const key = (roleName ?? "").trim();
  if (key.length === 0) return null;

  const custom = customRoles?.find((role) => (role?.name ?? "").trim() === key);
  // 脏 tier（拼错 / 老配置）不拦截整个解析：忽略它继续查内置表，仍未知才返回 null。
  if (custom && isTier(custom.tier)) return custom.tier;

  const builtin = BUILTIN_ROLE_TIERS[key];
  return builtin ?? null;
}

/**
 * 运行时判定一个值是否是合法角色类型（自定义角色来自用户配置，可能写出脏值）
 */
export function isRoleKind(value: unknown): value is RoleKind {
  return value === "lead" || value === "member";
}

/**
 * 解析角色类型（队长 / 队员）。
 *
 * 优先级（任一档命中即返回，永不抛错）：
 *   ① 自定义角色的 `kind`（同名覆盖内置时以用户配置为准）；
 *   ② 内置表 {@link BUILTIN_ROLE_KINDS}；
 *   ③ 默认 `"member"`（未知角色 / 空名 / 老配置缺 kind / 脏值全部落到这里）。
 *
 * 为什么 ① 缺 kind 时不径直返回 member：自定义角色与内置同名时会**覆盖**内置条目
 * （见 {@link resolveSkillSnapshot}）。用户只改 prompt 没写 kind 时，`co-team-lead`
 * 不该因此从队长降级成队员——那样的「覆盖」副作用太隐蔽。
 *
 * @param roleName - 角色名（undefined / 空串 / 纯空白一律视为未知 → member）
 * @param customRoles - 自定义角色表（可选）
 * @returns `"lead" | "member"`（永不返回 undefined）
 */
export function resolveRoleKind(
  roleName: string | undefined,
  customRoles?: readonly RoleSpec[],
): RoleKind {
  const key = (roleName ?? "").trim();
  if (key.length === 0) return "member";

  const custom = customRoles?.find((role) => (role?.name ?? "").trim() === key);
  if (custom && isRoleKind(custom.kind)) return custom.kind;

  return BUILTIN_ROLE_KINDS[key] ?? "member";
}

/**
 * 档位 → preset id。
 *
 * 类型上 tier 已是合法档位；这里仍做一次运行时兜底，避免老配置 / 手写 JSON 的脏值让
 * 子代理「不挂 preset」（= 继承父的 co-orchestrator 全量工具面，白烧 persona 且有写权限），
 * 与 delegate.ts 现有「未知 skill → write preset」的兜底方向保持一致。
 *
 * @param tier - 档位。
 * @returns preset id（永不返回 undefined）。
 */
export function presetForTier(tier: Tier): string {
  const preset = TIER_TO_PRESET[tier];
  return typeof preset === "string" && preset.length > 0 ? preset : TIER_TO_PRESET["rw-shell"];
}

// ── 统一技能快照（内置 ∪ 自定义角色，同一解析路径） ─────────────────────────
//
// 接线前：delegate.ts 只查 COHUB_SKILLS（内置 13 个），delegate_batch.ts 的白名单再从它派生；
// config.customRoles 在配置层存在却无法被 delegate({ skill }) 引用。本批把两者折算成同一份
// 快照：自定义角色被包装成与内置同形的 CoHubSkill（brief = 其 prompt），从而复用同一条
// 「解析 → 档位 → preset → 工具裁剪 → 提示词注入」链路，不新增分支。

/** 自定义角色运行时配置（Config.customRoles 的元素；schema 已保证 name/description/prompt/tier 必填） */
export interface CustomRoleConfig extends RoleSpec {
  /** 一句话职责（进技能目录 / 工具 description；缺省用兜底文案） */
  readonly description?: string;
  /** 该角色的任务指令：作为子代理 brief 注入（替代内置技能的 brief） */
  readonly prompt?: string;
}

/** 解析后的角色快照条目 */
export interface ResolvedRole {
  /** 统一形状的技能（自定义角色由 prompt 构造，与内置角色同走 buildDelegatePrompt） */
  readonly skill: CoHubSkill;
  /** 档位；null = 无法由档位决定（co-orchestrator 主代理 / 名字本身不在表内） */
  readonly tier: Tier | null;
  /** true = 内置角色（提示词取 skill.brief）；false = 自定义角色（提示词取其 prompt） */
  readonly builtin: boolean;
}

/** 技能查找结果：命中 / 不存在 / 存在但被禁用（错误文案必须能区分后两者） */
export type SkillLookup =
  | { readonly ok: true; readonly role: ResolvedRole }
  | { readonly ok: false; readonly reason: "unknown" | "disabled" };

/** 快照的输入配置（只读最小集合；缺省即「仅内置角色、无禁用」） */
export interface SkillSnapshotConfig {
  /** 用户自定义角色表 */
  readonly customRoles?: readonly CustomRoleConfig[];
  /** 被禁用的角色名（配置层渠道；缺省 = 无禁用） */
  readonly disabledSkills?: readonly string[];
}

// ── 团队过滤（Config.teams / Config.activeTeam） ─────────────────────────────
//
// 背景：配置层早已有 teams（角色池编组）与 activeTeam（当前启用哪一组），但派发层从不读它们，
// 于是「设置当前团队后仍能派任何角色」= 团队只是摆设。本段是这条约束的唯一判定源：
//   activeTeam 空串 / 找不到对应团队 → null（**不限制**，全部角色可用，与旧行为逐字一致）；
//   activeTeam 命中团队 → 只有 members 内的角色可派发。
//
// 为什么「找不到对应团队」视为不限制而不是硬报错：teams 与 activeTeam 都是 volatile 字段，
// 用户在设置页里可能先把 activeTeam 写成新 id、再补 teams 条目（或反向删除）；此时硬失败会让
// 整个编排立刻瘫痪，且错误出现在每次派发。本插件既有的处置纪律是 fail-soft + 可诊断文案
// （见 delegate 的 preset / toolFilter 降级），故这里同样取「不限制 + 由调用方 warn」。

/** 团队配置（Config.teams 的元素；schema 在 index.ts，这里只声明判定需要的字段） */
export interface TeamConfig {
  /** 团队 id（kebab-case；Config.activeTeam 的取值） */
  readonly id: string;
  /** 显示名（进错误文案给人看） */
  readonly name: string;
  /** 可选说明：这组角色适合什么任务 */
  readonly description?: string;
  /** 成员角色名（内置角色或 customRoles 的 name） */
  readonly members: readonly string[];
  /**
   * 该团队注册成的 Agent 预设 id（schema 在 index.ts）：省略时按 {@link teamPresetId} 推导为
   * `cohub-team-<id>`。派发层据此把「当前会话预设」映射回团队，见 {@link resolveSessionTeam}。
   */
  readonly presetId?: string;
  /**
   * 队长角色名（可省略）：决定**主代理**运行时人格（见 {@link resolveLeadPersona}）。
   *
   * 与「派发过滤」无关——lead 不自动获得派发豁免：若 lead 不在 members 里，它只是不能被派发，
   * 仍可担任主代理（回退规则见 {@link resolveActiveTeam}）。
   */
  readonly lead?: string;
}

/** 解析后的活动团队（{@link resolveActiveTeam} 的返回值） */
export interface ActiveTeam {
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
  /** 队长角色名（已按回退规则确定；members 为空时为 ""） */
  readonly lead: string;
}

/** 主代理自身的角色名（团队队长回退目标；其人格由 preset 自带，无需注入） */
export const PRIMARY_AGENT_ROLE = "co-orchestrator";

/**
 * 团队过滤的配置视图：teams / activeTeam 决定「能派谁」，customRoles 只影响
 * {@link listAllowedRoles} 在**不限制**时回显的完整名单（内置 ∪ 自定义）。
 */
export interface TeamFilterConfig extends SkillSnapshotConfig {
  /** 全部团队（Config.teams） */
  readonly teams?: readonly TeamConfig[];
  /** 当前团队 id；空串 = 不限制 */
  readonly activeTeam?: string;
}

/**
 * 解析当前活动团队。
 *
 * 返回 null 的两种情形等价处理（= 不限制）：
 *   ① activeTeam 为空 / 纯空白（缺省配置）；
 *   ② activeTeam 非空但在 teams 中找不到同 id 的团队。
 *
 * ② 是**有意的 fail-soft**：teams 与 activeTeam 都是热改的 volatile 配置，写入顺序不受控，
 * 把「配置暂时不一致」变成每次派发都失败会直接瘫痪编排；调用方仍会 warn，用户可自行修配置。
 *
 * @param config - 团队过滤配置（可缺省）
 * @returns `{ id, name, members, lead }`（members 已去空白 / 去空项，保留原顺序；lead 见
 *          {@link resolveLeadPersona} 的回退规则）；null = 不限制
 */
export function resolveActiveTeam(config?: TeamFilterConfig): ActiveTeam | null {
  const id = (config?.activeTeam ?? "").trim();
  if (id.length === 0) return null;
  const matched = (config?.teams ?? []).find((team) => (team?.id ?? "").trim() === id);
  if (matched === undefined) return null;
  return buildActiveTeam(matched, id, config?.customRoles);
}

/**
 * 团队 → Agent 预设 id（唯一推导规则）：`team.presetId` 显式非空时优先，否则 `cohub-team-<id>`。
 *
 * 与 index.ts 的团队 preset 注册保持同一约定；显式字段的存在意义是用户可以把团队挂在
 * 自己的预设 id 上（例如与 cohub-subagent-write 共用一个预设）。
 *
 * @param team - 团队配置
 * @returns 预设 id（团队 id 为空时返回 `cohub-team-`，由调用方按「无匹配」处理）
 */
export function teamPresetId(team: TeamConfig): string {
  const explicit = (team.presetId ?? "").trim();
  return explicit.length > 0 ? explicit : "cohub-team-" + (team.id ?? "").trim();
}

/** 把一条团队配置规范化成 {@link ActiveTeam}（members 去空白、lead 走回退规则） */
function buildActiveTeam(
  matched: TeamConfig,
  id: string,
  customRoles?: readonly RoleSpec[],
): ActiveTeam {
  const members = (matched.members ?? [])
    .map((member) => (typeof member === "string" ? member.trim() : ""))
    .filter((member) => member.length > 0);
  const name = (matched.name ?? "").trim();
  return {
    id,
    name: name.length > 0 ? name : id,
    members,
    lead: resolveTeamLead(matched, members, customRoles),
  };
}

/**
 * 按**当前会话的 Agent 预设 id** 解析所属团队（团队限员的唯一入口）。
 *
 * 约定：预设 id 与团队通过 {@link teamPresetId} 对齐（`presetId` 优先，否则 `cohub-team-<id>`）。
 * 返回 null 的两种情形（= 不是团队预设，由 {@link resolveTeamFilter} 决定是否回退旧行为）：
 *   ① presetId 为空 / 纯空白（取不到当前预设，例如旧宿主或服务缺失）；
 *   ② presetId 非空但没有任何团队的预设 id 与之匹配（如 `standard`、`cohub-subagent-write`）。
 *
 * @param config - 团队过滤配置（可缺省）
 * @param presetId - 当前会话的 Agent 预设 id（可缺省）
 * @returns `{ id, name, members, lead }`；null = 不是团队预设
 */
export function resolveSessionTeam(
  config: TeamFilterConfig | undefined,
  presetId: string | undefined,
): ActiveTeam | null {
  const preset = (presetId ?? "").trim();
  if (preset.length === 0) return null;
  // 用户团队优先：用户用同名 id 覆盖内置团队时，限员按用户版本执行（与 team-presets.ts 的
  // 「id 冲突时用户优先」同一规则）。内置团队没有 presetId 字段，故一律按 cohub-team-<id> 推导。
  const matched = (config?.teams ?? []).find((team) => teamPresetId(team) === preset)
    ?? BUILTIN_TEAMS.find((team) => teamPresetId(team) === preset);
  if (matched === undefined) return null;
  return buildActiveTeam(matched, (matched.id ?? "").trim(), config?.customRoles);
}

/** {@link resolveTeamFilter} 的返回值：生效团队 + 来源（便于调用方按需留痕） */
export interface SessionTeamFilter {
  /** 生效团队；null = 不限制（全部角色可用） */
  readonly team: ActiveTeam | null;
  /**
   * 团队来源：
   *   - `preset`：当前会话预设命中某个团队（新语义，主路径）；
   *   - `legacy`：预设不是团队 → 回退旧的 activeTeam 行为（兼容尚未迁移的配置）；
   *   - `none`：两路都没命中 → 不限制。
   */
  readonly source: "preset" | "legacy" | "none";
  /** 解析所用的预设 id（trim 后；空串 = 未提供） */
  readonly presetId: string;
}

/**
 * 会话团队过滤：**预设优先、activeTeam 兜底**。
 *
 * 规则（fail-soft，任何一路失败都不会让派发瘫痪）：
 *   ① 预设 id 为空 → 不限制（source=none）。取不到预设就无法判断，按最宽松处理；
 *   ② 预设命中团队（{@link resolveSessionTeam}）→ 按该团队 members 限员；
 *   ③ 预设非空但不是团队 → 回退 {@link resolveActiveTeam}（旧的 activeTeam 行为，
 *      activeTeam 已废弃且默认空串 → 实际仍是不限制）。
 *
 * @param config - 团队过滤配置（可缺省）
 * @param presetId - 当前会话的 Agent 预设 id（可缺省）
 * @returns 生效团队与来源
 */
export function resolveTeamFilter(
  config: TeamFilterConfig | undefined,
  presetId: string | undefined,
): SessionTeamFilter {
  const preset = (presetId ?? "").trim();
  if (preset.length === 0) return { team: null, source: "none", presetId: "" };
  const byPreset = resolveSessionTeam(config, preset);
  if (byPreset !== null) return { team: byPreset, source: "preset", presetId: preset };
  const legacy = resolveActiveTeam(config);
  return { team: legacy, source: legacy === null ? "none" : "legacy", presetId: preset };
}

/**
 * 队长回退规则（唯一判定源）：
 *   ① `team.lead` 非空、∈ members **或就是 co-orchestrator**、且类型是队长
 *      （{@link resolveRoleKind} === "lead"）→ 用它（显式指定优先）；
 *   ② 否则 members 含 `co-orchestrator` → 用它（默认主代理仍在团队里，不加人格注入）；
 *   ③ 否则 members[0]（没指定就把第一成员当队长）；
 *   ④ members 为空 → ""（叫不出队长，调用方按「无队长」处理）。
 *
 * 为什么 ① 要求 ∈ members：配置里 lead 可能指向一个已从团队删掉的角色（热改配置的常见残留形态），
 * 此时按「没指定」处理、走回退，比让一个不在团队的幽灵角色当队长更可诊断。
 * 唯一的例外是 `co-orchestrator`：它是主代理本身，内置团队（builtin-teams.ts 的 dev / writing）
 * 的 members 只列专职子代理、不列主代理，而其 lead 明确写 `co-orchestrator`——若不放宽，
 * 内置团队的队长会被静默回退成 members[0]（例如 co-fixer），人格与团队语义就错位了。
 *
 * 为什么还要 kind === "lead"：角色分「队长 / 队员」两类后，把队员写成团队 lead 是**配置错误**
 * （队员的 brief 是「执行一份任务」，直接拿来当主代理人格会得到自我矛盾的提示词）。让它走回退
 * （co-orchestrator → members[0]），比静默接受更可诊断；老配置里自定义角色没有 kind 时按
 * member 处理，因此此前「任意自定义角色都能当 lead」的写法会退化为回退——这是有意的收紧，
 * 用户显式写 `kind: lead` 即可恢复。
 *
 * @param team - 团队配置
 * @param members - 已规范化的成员名（trim + 去空）
 * @param customRoles - 自定义角色表（决定自定义角色的 kind；缺省 = 只用内置表）
 * @returns 队长角色名；"" = 叫不出队长
 */
function resolveTeamLead(
  team: TeamConfig,
  members: readonly string[],
  customRoles?: readonly RoleSpec[],
): string {
  const declared = (team.lead ?? "").trim();
  const declaredLead = declared.length > 0
    && (members.includes(declared) || declared === PRIMARY_AGENT_ROLE)
    && resolveRoleKind(declared, customRoles) === "lead";
  if (declaredLead) return declared;
  if (members.includes(PRIMARY_AGENT_ROLE)) return PRIMARY_AGENT_ROLE;
  return members[0] ?? "";
}

/**
 * 解析队长的人格（主代理运行时身份）。
 *
 * 来源统一走 {@link resolveSkillSnapshot}：
 *   - 内置角色 → 取其 `brief`（一句话职责，**不是全文 content**，避免把整篇技能正文塞进
 *     每一轮系统提示词）；
 *   - 自定义角色 → 取其 `prompt`（快照已把 prompt 同时写进 brief/content）。
 *
 * 返回 null 的四种情形（调用方据此**不注入**、保持原行为）：
 *   ① 无活动团队；② 队长为空（members 为空）；③ 队长名查不到（未知 / 已禁用）；
 *   ④ 该角色的 brief 为空。
 *
 * @param config - 团队过滤配置（可缺省）
 * @returns `{ name, title, persona }`；null = 没有可用的队长人格
 */
export function resolveLeadPersona(config?: TeamFilterConfig): LeadPersona | null {
  const team = resolveActiveTeam(config);
  if (team === null || team.lead.length === 0) return null;
  const found = resolveSkillSnapshot(config).resolve(team.lead);
  if (!found.ok) return null;
  const persona = (found.role.skill.brief ?? "").trim();
  if (persona.length === 0) return null;
  const title = (found.role.skill.description ?? "").trim();
  return { name: team.lead, title: title.length > 0 ? title : team.lead, persona };
}

/** 队长人格快照（{@link resolveLeadPersona} 的返回值） */
export interface LeadPersona {
  /** 角色名（如 co-writer） */
  readonly name: string;
  /** 一句话职责（内置角色的 description / 自定义角色的 description） */
  readonly title: string;
  /** 人格正文：内置角色的 brief / 自定义角色的 prompt */
  readonly persona: string;
}

/**
 * 渲染「队长人格」系统提示词段。
 *
 * 返回空串的三个条件（宿主会丢弃空 section，故系统提示词与改动前**逐字一致**）：
 *   ① 无活动团队；② 队长为空；③ 队长就是 `co-orchestrator`（它的人格由 preset persona 自带，
 *      再注入一遍等于把同一段话写两遍）。
 *
 * 注入内容包含四块，缺一不可：
 *   - 队长人格本体（brief，不是全文）；
 *   - 一句边界声明：**你仍是本会话的调度者**；
 *   - 本团队可派发的队员名单（与派发过滤同源，避免主代理去派一个必被拒的角色）；
 *   - 调度纪律段（原样复用 co-orchestrator 的 brief）——换队长**不允许**丢掉调度本职。
 *
 * @param config - 团队过滤配置（可缺省）
 * @returns 提示词段文本；"" = 不注入
 */
export function renderLeadSection(config?: TeamFilterConfig): string {
  const team = resolveActiveTeam(config);
  if (team === null) return "";
  const lead = resolveLeadPersona(config);
  if (lead === null || lead.name === PRIMARY_AGENT_ROLE) return "";
  const members = team.members.length > 0 ? team.members.join("、") : "（该团队没有可用队员）";
  return [
    `<主代理人格：团队队长 ${lead.name}>`,
    `本会话的主代理由团队「${team.name}」(${team.id}) 的队长 ${lead.name}（${lead.title}）担任。你的主代理职责：`,
    lead.persona,
    "",
    `边界：你仍是本会话的调度者，可派发的队员见下；调度纪律仍适用。`,
    `可派发的队员：${members}`,
    "",
    "调度纪律（不因换队长而失效）：",
    orchestratorBrief(),
    "</主代理人格>",
  ].join("\n");
}

/** co-orchestrator 的 brief（调度纪律正文；内置表为准，不被自定义角色覆盖） */
function orchestratorBrief(): string {
  const skill = COHUB_SKILLS.find((item) => item.name === PRIMARY_AGENT_ROLE);
  const brief = (skill?.brief ?? "").trim();
  return brief.length > 0 ? brief : "你是纯调度者：只委派，不亲自操作；并行批次与执行时长受调度纪律约束。";
}

/**
 * 角色是否允许被派发（团队限员的唯一判据）。
 *
 * 团队来源取决于是否传入 `presetId`：
 *   - 传入（含空串，新路径）→ {@link resolveTeamFilter}：当前会话预设命中团队则按 members 限员，
 *     非团队预设回退 activeTeam，都未命中 → 不限制；
 *   - 未传（undefined，旧调用 / 单测）→ {@link resolveActiveTeam} 的旧行为，逐字不变。
 *
 * @param roleName - 角色名（空白会被 trim；空名的判定结果是「不允许」——空名本来就不可派发）
 * @param config - 团队过滤配置（缺省 / 不限制 → 恒 true）
 * @param presetId - 当前会话的 Agent 预设 id（缺省 = 沿用旧 activeTeam 行为）
 * @returns 允许与否
 */
export function isRoleAllowed(
  roleName: string | undefined,
  config?: TeamFilterConfig,
  presetId?: string,
): boolean {
  const team = presetId === undefined
    ? resolveActiveTeam(config)
    : resolveTeamFilter(config, presetId).team;
  if (team === null) return true;
  const key = (roleName ?? "").trim();
  return key.length > 0 && team.members.includes(key);
}

/**
 * 当前允许派发的角色名单（用于错误提示与 orchestrator 名单）。
 *
 * - 无活动团队 → 统一快照的全部角色名（内置 ∪ config.customRoles，顺序同快照）；
 * - 有活动团队 → 该团队 members（保留配置顺序；成员名可能是尚未注册的角色，调用方按名使用）。
 *
 * @param config - 团队过滤配置（可缺省）
 * @returns 角色名数组（每次新建，调用方可安全修改）
 */
export function listAllowedRoles(config?: TeamFilterConfig): string[] {
  const team = resolveActiveTeam(config);
  if (team !== null) return [...team.members];
  return [...resolveSkillSnapshot(config).names];
}

/**
 * 生成「角色不在当前团队内」的错误文案（delegate / delegate_batch 共用同一措辞）。
 *
 * 形如：`角色 "co-writer" 不在当前团队 "写作组"(writing) 内；该团队可用角色：co-writer, co-editor`
 * 团队可用角色为空时如实说明「该团队没有任何可用角色」，而不是留一个空清单。
 *
 * @param roleName - 被拒的角色名
 * @param config - 团队过滤配置
 * @param presetId - 当前会话的 Agent 预设 id（缺省 = 沿用旧 activeTeam 行为）
 * @returns 错误文案（调用方据此构造 Error / task error）
 */
export function describeRoleNotAllowed(
  roleName: string,
  config?: TeamFilterConfig,
  presetId?: string,
): string {
  const team = presetId === undefined
    ? resolveActiveTeam(config)
    : resolveTeamFilter(config, presetId).team;
  if (team === null) {
    const preset = (presetId ?? "").trim();
    return preset.length > 0
      ? `角色 "${roleName}" 允许派发（当前预设 "${preset}" 不是团队预设）`
      : `角色 "${roleName}" 允许派发（当前未设置 activeTeam）`;
  }
  const available = team.members.length > 0 ? team.members.join(", ") : "（该团队没有任何可用角色）";
  return `角色 "${roleName}" 不在当前团队 "${team.name}"(${team.id}) 内；该团队可用角色：${available}`;
}

/**
 * 当前会话团队限员的角色名单（用于错误提示与 orchestrator 名单）。
 *
 * 与 {@link isRoleAllowed} 同源：传 presetId 走 {@link resolveTeamFilter}，不传走旧 activeTeam。
 *
 * @param config - 团队过滤配置（可缺省）
 * @param presetId - 当前会话的 Agent 预设 id（缺省 = 沿用旧 activeTeam 行为）
 * @returns 角色名数组（每次新建，调用方可安全修改）
 */
export function listSessionRoles(config?: TeamFilterConfig, presetId?: string): string[] {
  if (presetId === undefined) return listAllowedRoles(config);
  const team = resolveTeamFilter(config, presetId).team;
  if (team !== null) return [...team.members];
  return [...resolveSkillSnapshot(config).names];
}

/** 统一技能快照：一次解析，派发层各处共用同一份名单与档位 */
export interface SkillSnapshot {
  /** 全部角色（内置在前、顺序与 COHUB_SKILLS 一致；自定义在后；同名覆盖原位） */
  readonly roles: readonly ResolvedRole[];
  /** 全部角色名（用于错误文案与工具 description） */
  readonly names: readonly string[];
  /** 按名查找：区分 unknown / disabled */
  resolve(roleName: string | undefined): SkillLookup;
}

/** 自定义角色被包装成 CoHubSkill 时写入的 source 标记（便于事后排查来源） */
export const CUSTOM_ROLE_SOURCE = "dsh-cohub:customRole";

/**
 * 构造统一技能快照：**内置 COHUB_SKILLS ∪ config.customRoles**。
 *
 * 语义：
 *   - 内置角色：skill 原样取 COHUB_SKILLS（brief/content 逐字不变），tier 取内置档位表，
 *     co-orchestrator 不在档位表内 → tier=null（派发层据此短路为「继承父」）。
 *   - 自定义角色：包装成同形 CoHubSkill（brief = prompt，content = prompt），tier 取其自身
 *     tier；与内置角色同名时**原位覆盖**（保留内置的 content 作为 prompt 缺省兜底），
 *     因此「自定义覆盖内置」与「自定义新增」走同一分支。
 *   - 禁用：config.disabledSkills 里的名字在 resolve() 里返回 reason="disabled"，
 *     与「根本不存在」（reason="unknown"）分开，错误文案才能提示用户改配置而非改名字。
 *
 * @param config - 运行时配置（可缺省；缺省 = 仅内置角色、无禁用）
 * @returns 不可变快照（每次调用新建；配置热改后重新构造即可生效）
 */
export function resolveSkillSnapshot(config?: SkillSnapshotConfig): SkillSnapshot {
  const roles: ResolvedRole[] = COHUB_SKILLS.map((skill) => ({
    skill,
    tier: BUILTIN_ROLE_TIERS[skill.name] ?? null,
    builtin: true,
  }));
  const position = new Map<string, number>(roles.map((role, index) => [role.skill.name, index]));

  for (const raw of config?.customRoles ?? []) {
    const name = (raw?.name ?? "").trim();
    if (name.length === 0) continue;
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    const description = typeof raw.description === "string" && raw.description.trim().length > 0
      ? raw.description
      : "用户自定义角色 " + name;
    const tier = isTier(raw.tier) ? raw.tier : BUILTIN_ROLE_TIERS[name] ?? null;
    const at = position.get(name);
    if (at === undefined) {
      position.set(name, roles.length);
      roles.push({
        skill: { name, description, brief: prompt, source: CUSTOM_ROLE_SOURCE, content: prompt },
        tier,
        builtin: false,
      });
    } else {
      const prev = roles[at]!;
      // 同名覆盖：用户给的 prompt 为空时回落内置 brief/content，绝不把角色指令清空
      roles[at] = {
        skill: {
          ...prev.skill,
          description,
          brief: prompt.length > 0 ? prompt : prev.skill.brief,
          content: prompt.length > 0 ? prompt : prev.skill.content,
        },
        tier,
        builtin: false,
      };
    }
  }

  const disabled = new Set<string>(
    (config?.disabledSkills ?? []).map((name) => (name ?? "").trim()).filter((name) => name.length > 0),
  );
  const byName = new Map<string, ResolvedRole>(roles.map((role) => [role.skill.name, role]));

  return {
    roles,
    names: roles.map((role) => role.skill.name),
    resolve(roleName: string | undefined): SkillLookup {
      const key = (roleName ?? "").trim();
      if (key.length === 0) return { ok: false, reason: "unknown" };
      if (disabled.has(key)) return { ok: false, reason: "disabled" };
      const role = byName.get(key);
      return role === undefined ? { ok: false, reason: "unknown" } : { ok: true, role };
    },
  };
}
