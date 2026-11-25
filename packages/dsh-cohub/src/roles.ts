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
  // 读写 + shell
  "co-fixer": "rw-shell",
  // Cordis 专线
  "co-cordis": "cordis",
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

/** 自定义角色（用户配置里的 role 定义）；只声明档位解析需要的最小字段 */
export interface RoleSpec {
  /** 角色名（与内置角色同名即覆盖内置） */
  readonly name: string;
  /** 档位；缺省时回退到内置表 */
  readonly tier?: Tier;
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
}

/** 解析后的活动团队（{@link resolveActiveTeam} 的返回值） */
export interface ActiveTeam {
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
}

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
 * @returns `{ id, name, members }`（members 已去空白 / 去空项，保留原顺序）；null = 不限制
 */
export function resolveActiveTeam(config?: TeamFilterConfig): ActiveTeam | null {
  const id = (config?.activeTeam ?? "").trim();
  if (id.length === 0) return null;
  const matched = (config?.teams ?? []).find((team) => (team?.id ?? "").trim() === id);
  if (matched === undefined) return null;
  const members = (matched.members ?? [])
    .map((member) => (typeof member === "string" ? member.trim() : ""))
    .filter((member) => member.length > 0);
  const name = (matched.name ?? "").trim();
  return { id, name: name.length > 0 ? name : id, members };
}

/**
 * 角色是否允许被派发。
 *
 * @param roleName - 角色名（空白会被 trim；空名的判定结果是「不允许」——空名本来就不可派发）
 * @param config - 团队过滤配置（缺省 / activeTeam 为空 / 团队不存在 → 恒 true）
 * @returns 允许与否
 */
export function isRoleAllowed(roleName: string | undefined, config?: TeamFilterConfig): boolean {
  const team = resolveActiveTeam(config);
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
 * @returns 错误文案（调用方据此构造 Error / task error）
 */
export function describeRoleNotAllowed(roleName: string, config?: TeamFilterConfig): string {
  const team = resolveActiveTeam(config);
  if (team === null) return `角色 "${roleName}" 允许派发（当前未设置 activeTeam）`;
  const available = team.members.length > 0 ? team.members.join(", ") : "（该团队没有任何可用角色）";
  return `角色 "${roleName}" 不在当前团队 "${team.name}"(${team.id}) 内；该团队可用角色：${available}`;
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
