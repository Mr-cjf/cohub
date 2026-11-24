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
// 本批只建表与单测，delegate.ts / delegate_batch.ts 的接线留到下一批。

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
 * 内置角色 → 档位（13 个内置角色中除 co-orchestrator 外的 12 个）。
 *
 * co-orchestrator 不在此表：它是**主代理**本身（委派发起方），被委派时仍需要完整工具面，
 * 派发层对它的处理是「不走档位、继承父 preset」，用 resolveTier 返回 null 会把这两件事
 * 混为一谈，故由调用方先行短路。
 *
 * 归类依据 = 各技能自身声明的能力边界（skills.ts 的「只读 / 读写 / 读写+Bash」）：
 *   - 只读且不需要外网 → ro（explorer 在库内 grep/glob；oracle 审代码；planner 出方案；
 *     council 多模型共识；observer 看图；rule-* 读规则文件）
 *   - 只读但要联网 → ro-net（librarian 查官方文档 / GitHub / Web）
 *   - 读写但不需要 shell → rw（designer 只改样式与组件，不跑构建）
 *   - 读写 + shell → rw-shell（fixer 要 build / test / git commit）
 *   - Cordis 专线 → cordis（自建 preset，含插件重建与安装链路）
 */
export const BUILTIN_ROLE_TIERS: Readonly<Record<string, Tier>> = {
  // 只读（8）
  "co-explorer": "ro",
  "co-oracle": "ro",
  "co-planner": "ro",
  "co-council": "ro",
  "co-observer": "ro",
  "co-rule-user": "ro",
  "co-rule-project": "ro",
  "co-rule-app": "ro",
  // 只读 + 联网（1）
  "co-librarian": "ro-net",
  // 读写（1）
  "co-designer": "rw",
  // 读写 + shell（1）
  "co-fixer": "rw-shell",
  // Cordis 专线（1）
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
  // rw 没有 shell：把本平台 shell 工具一并裁掉，与 rw-shell 的唯一数据差异就在这里。
  rw: { deny: [...WRITE_DENY, SHELL_TOOL, ...UNIVERSAL_DENY] },
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
