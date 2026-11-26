// dsh-cohub/src/team-presets.ts —— 把 Config.teams 的每个团队**运行时注册为一个 Agent 预设**
//
// 目标：团队不再只是「派发过滤」配置，而是直接出现在 DSH 原生「Agent 预设」选择器里——
//   用户在新建会话时选团队即等于选主代理人格 + 可派角色池，无需再去设置页切 activeTeam。
//
// 与 preset-runtime.ts 的分工：
//   · preset-runtime.ts = 包内 `presets/<id>/` 的**静态档位**预设（事实源是文件），一次性注册；
//   · 本文件          = 用户用 `Config.teams` 编组的**动态团队**预设（事实源是配置），需轮询对账。
//   两者共用同一个 `agentPresets` 注册表，id 命名空间不同（`cohub-team-<id>`），互不干扰。
//
// 幂等策略（核心）：每个 registry 各存一份 `id → { fingerprint, handle }` 台账。
//   · 新增团队 → register；
//   · 团队被删除 → 用台账里的 handle unregister；
//   · 改名 / 改成员 / 改 presetId → 指纹变化 → 先 unregister 再 register；
//   · 指纹不变 → 完全跳过（不 get、不 unregister、不 register），避免每次 1s 轮询都重建预设
//     （register 内部会 activate() → mountPreset()，无谓重建会让运行中的会话失配）。
//
// fail-soft：没有 agentPresets 服务、单个团队注册失败 → 只 warn，绝不抛（不阻断插件启动）。

import { BUILTIN_TEAMS } from "./builtin-teams.ts";
import { resolveSkillSnapshot } from "./roles.ts";
import type { CohubPresetDef } from "./preset-runtime";

/** 最小日志接口（cordis logger 与测试 mock 都能满足） */
interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** 团队预设的排序起点：排在包内档位预设（order < 50）之后 */
export const TEAM_PRESET_ORDER_BASE = 50;

/** 内置团队的排序起点：排在包内档位预设之后、用户团队（50 起）之前 */
export const BUILTIN_TEAM_ORDER_BASE = 40;

/** 团队配置的最小结构（与 index.ts 的 Team schema、roles.ts 的 TeamConfig 同形） */
export interface TeamPresetSource {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly members: readonly string[];
  readonly lead?: string;
  readonly presetId?: string;
}

/** 自定义角色（只用到取 persona 的两个字段） */
export interface TeamPresetCustomRole {
  readonly name: string;
  readonly prompt?: string;
}

/** buildTeamPresetDefs / syncTeamPresets 的输入（字段可能是 Volatile，内部降级读取） */
export interface TeamPresetConfig {
  /** Config.teams（可能被 schemastery 包成 Volatile 引用） */
  readonly teams?: readonly TeamPresetSource[] | { get(): readonly TeamPresetSource[] };
  /** Config.customRoles（用于取自定义队长的 persona 文本） */
  readonly customRoles?: readonly TeamPresetCustomRole[] | { get(): readonly TeamPresetCustomRole[] };
}

/** 同步结果（供日志与测试断言） */
export interface TeamPresetSyncResult {
  /** 本次新增注册的 id */
  registered: string[];
  /** 本次先 unregister 再 register 的 id（改名 / 改成员 / 改 presetId） */
  updated: string[];
  /** 本次因团队被删除而 unregister 的 id */
  removed: string[];
  /** 指纹未变、完全跳过的 id */
  unchanged: string[];
  /** 注册失败的 id（fail-soft，已 warn） */
  failed: string[];
}

const emptyResult = (): TeamPresetSyncResult => ({
  registered: [],
  updated: [],
  removed: [],
  unchanged: [],
  failed: [],
});

/** Volatile / 普通数组统一读法（旧 schemastery 降级为普通值） */
function readList<T>(value: T[] | { get(): T[] } | undefined): T[] {
  if (value === undefined || value === null) return [];
  const holder = value as { get?: () => T[] };
  const raw = typeof holder.get === "function" ? holder.get() : (value as T[]);
  return Array.isArray(raw) ? raw : [];
}

/**
 * 团队 → 预设 id：`team.presetId` 优先，缺省按 `cohub-team-<id>` 推导。
 *
 * 空串 / 纯空白视为「未配置」（与 schema 里「省略即推导」的语义一致）。
 */
export function teamPresetId(team: TeamPresetSource): string {
  const declared = typeof team?.presetId === "string" ? team.presetId.trim() : "";
  if (declared.length > 0) return declared;
  return `cohub-team-${(team?.id ?? "").trim()}`;
}

/**
 * 队长回退规则（与 roles.ts 的 resolveTeamLead 同义，此处不导出该函数故就地实现）：
 *   ① lead 非空且 ∈ members **或就是 co-orchestrator**；② members 含 co-orchestrator；
 *   ③ members[0]；④ ""。
 *
 * ① 里的 co-orchestrator 例外是为内置团队服务的：它们的 members 只列专职子代理，lead 写主代理，
 * 不放宽就会把内置团队的队长静默回退成 members[0]（见 builtin-teams.ts）。
 */
function resolveTeamLead(team: TeamPresetSource, members: readonly string[]): string {
  const declared = typeof team.lead === "string" ? team.lead.trim() : "";
  if (declared.length > 0 && (members.includes(declared) || declared === "co-orchestrator")) return declared;
  if (members.includes("co-orchestrator")) return "co-orchestrator";
  return members[0] ?? "";
}

/** 干净成员名单（去空白 / 去空项 / 去重，保留原顺序） */
function cleanMembers(team: TeamPresetSource): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of team?.members ?? []) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 组装团队主代理的 persona 文本。
 *
 * 事实源：队长角色的 **brief**（内置取 COHUB_SKILLS 的 brief、自定义取 customRoles[].prompt，
 * 两者都由 {@link resolveSkillSnapshot} 统一成 `role.skill.brief`）。取 brief 而非全文 content，
 * 理由与 roles.ts 的队长人格注入一致：preset persona 每轮都在系统提示词里，全文太贵。
 *
 * 末尾必须附「本团队可派角色：…」，让主代理知道团队边界（派发层还会再硬过滤一次）。
 */
export function buildTeamPersona(team: TeamPresetSource, members: readonly string[], lead: string, customRoles: readonly TeamPresetCustomRole[]): string {
  const snapshot = resolveSkillSnapshot({ customRoles: customRoles as never });
  const lookup = snapshot.resolve(lead);
  const brief = (lookup.ok ? (lookup.role.skill.brief ?? "") : "").trim();

  const head = `你是 cohub 团队「${team.name}」的主代理（团队 id ${team.id}；队长 ${lead || "（未指定）"}）。`;
  const body = brief.length > 0
    ? brief
    : `你的职责：分析需求 → 委派给本团队的专职子代理 → 审核并汇总结果；绝不亲自操作文件（除非你本身是执行型角色）。`;
  const discipline =
    "团队纪律：能用 delegate / delegate_batch 派发的一律派发；需要并行时单批 ≤ 5 个执行单元；" +
    "每次派发都要给出自包含任务书（目标、路径、约束、输出格式）。";
  const roster = `本团队可派角色：${members.length > 0 ? members.join("、") : "（无）"}`;
  return [head, body, discipline, roster].join("\n");
}

/**
 * 团队预设的 plugins 行。
 *
 * 抄自 `presets/co-orchestrator/agent.cordis.yml` 的主代理工具面：
 *   persona / 委派（subagent + fork + control）/ 待办 / 后台任务 / 追问用户 / 目标 / 技能，
 *   外加文件、Shell、外网、文件系统技能行——它们不是给主代理自用的（persona 禁止），
 *   而是**给子代理继承**的：宿主 rc.6 里子代理继承父 preset 的工具表且只能收窄，
 *   父 preset 不挂则子代理无从放宽（与 co-orchestrator 的既有注释同因）。
 *
 * **不挂 tool-cordis**：它是全进程单例（改 Cordis 组合本身），团队主代理不该持有。
 */
export function buildTeamPresetPlugins(persona: string): unknown[] {
  return [
    { id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix: persona } },
    {
      id: "delegation-subagents",
      name: "cordis:group",
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: "tool-subagent-control", name: "@deepseek-ai/dsh-tool-subagent-control" },
        { id: "tool-subagent", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "spawn", toolName: "subagent" } },
        { id: "tool-subagent-fork", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "fork", toolName: "subagent_fork" } },
      ],
    },
    { id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } },
    { id: "tool-jobs", name: "@deepseek-ai/dsh-tool-jobs" },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
    { id: "tool-goal", name: "@deepseek-ai/dsh-tool-goal" },
    { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
    // ── 子代理继承使用（主代理 persona 禁止自用）────────────────────────────
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash", disabled: process.platform === "win32" },
    { id: "tool-pwsh", name: "@deepseek-ai/dsh-tool-pwsh", disabled: process.platform !== "win32" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search", config: { sampleOverCapGlobResults: false } },
    { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: false } },
    { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
  ];
}

/** 单个团队 → 预设定义（内置团队与用户团队共用同一组装逻辑，避免两套分支漂移） */
function buildTeamDef(team: TeamPresetSource, order: number, customRoles: readonly TeamPresetCustomRole[]): CohubPresetDef {
  const teamId = typeof team.id === "string" ? team.id.trim() : "";
  const members = cleanMembers(team);
  const lead = resolveTeamLead(team, members);
  const name = (typeof team.name === "string" && team.name.trim().length > 0 ? team.name.trim() : teamId);
  const description =
    `cohub 团队「${name}」：队长 ${lead || "（未指定）"}，成员 ${members.length > 0 ? members.join(", ") : "（无）"}`;
  return {
    id: teamPresetId(team),
    name,
    description,
    order,
    plugins: buildTeamPresetPlugins(buildTeamPersona(team, members, lead, customRoles)),
  };
}

/**
 * 生成可注册的预设定义：**内置团队 ∪ config.teams**（内置在前）。
 *
 * 合并规则：
 *   · 内置团队先产出，order = `BUILTIN_TEAM_ORDER_BASE + 序号`（40 / 41）；
 *   · 用户团队在后，order = `TEAM_PRESET_ORDER_BASE + 序号`（50 起）；
 *   · **id 冲突时用户优先**：用户团队的预设 id 一旦与内置团队相同（如用户自建 id=dev），
 *     内置该条整体跳过——用户可用同名 id 覆盖内置团队（成员 / 名称 / presetId 全按用户版）；
 *   · 用户团队之间的 id 重复仍按「保留第一个」处理（与改动前一致）。
 *
 * 跳过规则（fail-soft，只 warn 不抛）：团队 id 为空 → 无法推断预设 id。
 * 内置团队不读配置，故「Config.teams 清空」不会让它们消失，只有插件 dispose 才统一卸载。
 */
export function buildTeamPresetDefs(config?: TeamPresetConfig, logger?: Logger): CohubPresetDef[] {
  const teams = readList<TeamPresetSource>(config?.teams as never);
  const customRoles = readList<TeamPresetCustomRole>(config?.customRoles as never);

  // ① 用户团队（先算出 id 集合，供 ② 判冲突）
  const userDefs: CohubPresetDef[] = [];
  const used = new Set<string>();
  for (const [index, team] of teams.entries()) {
    const teamId = typeof team?.id === "string" ? team.id.trim() : "";
    if (teamId === "") {
      logger?.warn?.("cohub: teams 中存在缺少 id 的条目，已跳过该团队的预设注册");
      continue;
    }
    const id = teamPresetId(team);
    if (used.has(id)) {
      logger?.warn?.(`cohub: 团队预设 id 重复（${id}），保留第一个团队，跳过团队 ${teamId}`);
      continue;
    }
    used.add(id);
    userDefs.push(buildTeamDef(team, TEAM_PRESET_ORDER_BASE + index, customRoles));
  }

  // ② 内置团队（用户优先：id 已被用户占用 → 跳过该条内置团队）
  const builtinDefs: CohubPresetDef[] = [];
  for (const [index, team] of BUILTIN_TEAMS.entries()) {
    const id = teamPresetId(team);
    if (used.has(id)) {
      logger?.info?.(`cohub: 团队 ${team.id} 已被用户配置的同名团队覆盖（预设 id ${id}），跳过内置版本`);
      continue;
    }
    builtinDefs.push(buildTeamDef(team, BUILTIN_TEAM_ORDER_BASE + index, customRoles));
  }

  return [...builtinDefs, ...userDefs];
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册表台账与幂等同步
// ─────────────────────────────────────────────────────────────────────────────

/** 单个 id 的台账：指纹 + 宿主 register() 的原始返回值（释放时才用 handleOf 解析形态） */
interface TeamPresetEntry {
  fingerprint: string;
  handle?: unknown;
}

/** 台账挂载键：优先挂在 registry 本体上（跨插件重载 / 包装对象存活），WeakMap 只做只读对象的备份 */
const LEDGER_KEY = Symbol.for("cohub.team-presets.ledger.v1");

/** 每个 agentPresets 注册表各自一份台账（按 registry 隔离，避免多实例串味） */
const stateByRegistry = new WeakMap<object, Map<string, TeamPresetEntry>>();

/** 已经 warn 过「服务不可用」的注册表（1s 轮询下避免刷屏） */
const warnedRegistries = new WeakSet<object>();

/**
 * 取 agentPresets 注册表：走 `reflect.get('agentPresets', false)` 非强校验通道
 * （本插件 inject 里没有该服务，直接读 ctx.agentPresets 在 cordis proxy 下会抛），缺失返回 undefined。
 */
function resolveRegistry(ctx: any): any {
  try {
    const fromReflect = ctx?.reflect?.get?.("agentPresets", false);
    if (fromReflect) return fromReflect;
  } catch {
    /* 老宿主无 reflect：继续走属性直读 */
  }
  try {
    return ctx?.agentPresets;
  } catch {
    return undefined;
  }
}

/**
 * 取该 registry 的台账。
 *
 * 先读 registry 本体上的 Symbol 槽（宿主若每次 reflect.get 都返回新包装对象，
 * 或插件被热重载导致模块计时器重建，台账都不会丢），再回退 WeakMap（只读 / 冷冻对象）。
 */
function stateOf(registry: object): Map<string, TeamPresetEntry> {
  const holder = registry as unknown as Record<symbol, unknown>;
  try {
    const attached = holder[LEDGER_KEY];
    if (attached instanceof Map) return attached as Map<string, TeamPresetEntry>;
  } catch {
    /* 只读 proxy：落到 WeakMap */
  }
  let map = stateByRegistry.get(registry);
  if (map === undefined) {
    map = new Map<string, TeamPresetEntry>();
    stateByRegistry.set(registry, map);
    try {
      holder[LEDGER_KEY] = map;
    } catch {
      /* 不可写：只靠本进程 WeakMap */
    }
  }
  return map;
}

/** 团队预设的 id 命名空间前缀（孤儿对账时只清自己这一族，绝不误伤别人的预设） */
const TEAM_PRESET_PREFIX = "cohub-team-";

/**
 * 观测日志（**必须走 console.log**）。
 *
 * 为什么不走 `ctx.logger.info`：宿主在 info 级别默认不把插件日志下发到实例日志文件，
 * 上一版只有 logger.info/warn → 真机「完全没有任何团队对账痕迹」，删不删、
 * 改不改名都无从判断。console.log 直落 stdout，任何宿主版本都看得见。
 */
function log(message: string, ...rest: unknown[]): void {
  try {
    console.log(`[cohub/team-preset] ${message}`, ...rest);
  } catch {
    /* stdout 被关：忽略 */
  }
}

/** 指纹的显式输入（任一字段变化都必须重建；显式列全，防止靠间接字段漏判） */
interface FingerprintMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly members: readonly string[];
  readonly lead: string;
  readonly presetId: string;
}

/**
 * 预设指纹：**id / name / description / members / lead / presetId** + order / plugins 全量参与。
 *
 * 上一版只哈希 `[name, description, order, plugins]`——改名能命中，但 members / lead /
 * presetId 靠 description / persona 间接体现，一旦组装逻辑调整就可能同哈希不同语义；
 * 这里显式列出，改名 / 换队长 / 改成员 / 改 presetId 一律触发「先 unregister 再 register」。
 */
function fingerprintOf(def: CohubPresetDef, meta?: FingerprintMeta): string {
  return JSON.stringify([
    meta?.id ?? def.id,
    meta?.name ?? def.name,
    meta?.description ?? def.description ?? "",
    meta?.members ?? [],
    meta?.lead ?? "",
    meta?.presetId ?? "",
    def.order ?? null,
    def.plugins,
  ]);
}

/**
 * 把 `register()` 的返回值统一成「可调用的释放函数」。
 *
 * 宿主版本间返回值不一致：函数式 unregister 句柄 / `{ unregister() }` / `{ dispose() }` / void。
 * 上一版只认 `typeof handle === "function"`，非函数形态就**什么都没存**，
 * 于是删除团队时无句柄可调、改名时旧注册也释放不掉。
 */
function handleOf(value: unknown): (() => unknown) | undefined {
  if (typeof value === "function") return value as () => unknown;
  const obj = value as { unregister?: unknown; dispose?: unknown } | null | undefined;
  if (obj && typeof obj.unregister === "function") return () => (obj.unregister as () => unknown)();
  if (obj && typeof obj.dispose === "function") return () => (obj.dispose as () => unknown)();
  return undefined;
}

/** 枚举注册表里现有的预设 id（宿主 API 未知，尽力而为；拿不到就返回空） */
function enumeratePresetIds(registry: any): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) out.add(value);
    else if (value && typeof (value as { id?: unknown }).id === "string") out.add((value as { id: string }).id);
  };
  try {
    if (registry instanceof Map) for (const key of registry.keys()) push(key);
  } catch {
    /* 忽略 */
  }
  for (const method of ["ids", "list", "keys", "values", "entries"]) {
    try {
      const fn = registry?.[method];
      if (typeof fn !== "function") continue;
      const returned = fn.call(registry);
      if (returned && typeof returned[Symbol.iterator] === "function") {
        for (const item of returned) {
          if (Array.isArray(item)) push(item[0]);
          else push(item);
        }
      }
    } catch {
      /* 宿主该方法签名不同：换下一个 */
    }
  }
  try {
    const presets = registry?.presets;
    if (presets instanceof Map) for (const key of presets.keys()) push(key);
    else if (Array.isArray(presets)) for (const item of presets) push(item);
    else if (presets && typeof presets === "object") for (const key of Object.keys(presets)) push(key);
  } catch {
    /* 忽略 */
  }
  return [...out];
}

/** 是否是「id 重复」错误（宿主文案：Duplicate agent preset） */
function isDuplicateError(error: unknown): boolean {
  return /duplicate/i.test(String((error as { message?: unknown })?.message ?? error ?? ""));
}

/**
 * 释放该 id 的既有注册：优先用台账句柄，其次 registry.get(id).unregister，最后 registry.delete。
 * @returns 是否真的释放了某个东西
 */
function releaseExisting(registry: any, id: string, entry?: TeamPresetEntry): boolean {
  // ① 台账里的原始返回值（函数 / {unregister} / {dispose} 三种形态统一解析）
  const fromLedger = handleOf(entry?.handle);
  if (typeof fromLedger === "function") {
    try {
      fromLedger();
      return true;
    } catch {
      /* 句柄失效：继续走宿主接口 */
    }
  }
  // ② registry.get(id) 返回的条目
  let existing: any;
  try {
    existing = typeof registry?.get === "function" ? registry.get(id) : undefined;
  } catch {
    existing = undefined;
  }
  const fromEntry = handleOf(existing);
  if (typeof fromEntry === "function") {
    try {
      fromEntry();
      return true;
    } catch {
      /* 继续走 ③ */
    }
  }
  // ③ 宿主注册表自身的顶层卸载入口（版本间命名不一：unregister / remove / delete）
  for (const method of ["unregister", "remove", "delete"]) {
    try {
      const fn = registry?.[method];
      if (typeof fn === "function") {
        fn.call(registry, id);
        return true;
      }
    } catch {
      /* 换下一个 */
    }
  }
  return false;
}

/**
 * 团队预设的**幂等同步**（设置页热改配置后由轮询对账调用）。
 *
 * 语义：
 *   · 无 agentPresets 服务 → 同一个 registry 只 warn 一次并返回（不抛）；
 *   · 台账里已注册但本次配置中不存在的 id → unregister（removed）；
 *   · 指纹未变 → 完全跳过（unchanged，不产生任何注册表调用）；
 *   · 新增 → register；指纹变化 → 先 unregister 再 register（updated）；
 *   · 单个团队失败只 warn 并把 id 记到 failed（其余团队继续，且失败不会伪造台账）。
 */
export async function syncTeamPresets(ctx: any, logger: Logger | undefined, config?: TeamPresetConfig): Promise<TeamPresetSyncResult> {
  const result = emptyResult();
  const registry = resolveRegistry(ctx);
  if (!registry || typeof registry.register !== "function") {
    const notice = "cohub: agentPresets 服务不可用，团队预设暂不注册（不影响插件其余能力）";
    if (registry && typeof registry === "object") {
      // 1s 轮询下同一 registry 只提一次，避免刷屏
      if (!warnedRegistries.has(registry)) {
        warnedRegistries.add(registry);
        logger?.info?.(notice);
      }
    } else {
      logger?.warn?.(notice);
    }
    return result;
  }

  const state = stateOf(registry);
  const defs = buildTeamPresetDefs(config, logger);
  const wanted = new Set(defs.map((def) => def.id));
  const sources = new Map<string, TeamPresetSource>();
  for (const team of readList<TeamPresetSource>(config?.teams as never)) {
    if (typeof team?.id !== "string" || team.id.trim().length === 0) continue;
    sources.set(teamPresetId(team), team);
  }
  // 内置团队没有配置来源：成员数从内置表取（日志用）；用户同名覆盖时以 sources 为准。
  const builtinById = new Map<string, TeamPresetSource>(BUILTIN_TEAMS.map((team) => [teamPresetId(team), team]));
  const membersOf = (id: string) => {
    const team = sources.get(id) ?? builtinById.get(id);
    return team === undefined ? 0 : cleanMembers(team).length;
  };

  // ① 团队被删除 → 必须真的调 unregister（优先台账句柄，其次宿主接口）
  for (const [id, entry] of [...state.entries()]) {
    if (wanted.has(id)) continue;
    state.delete(id);
    const released = releaseExisting(registry, id, entry);
    result.removed.push(id);
    log(`unregistered id=${id} reason=removed${released ? "" : " released=false"}`);
  }
  // ①b 台账丢失兜底：注册表里本命名空间内、本次配置里已不存在的孤儿预设也要清掉
  for (const id of enumeratePresetIds(registry)) {
    if (wanted.has(id) || state.has(id) || result.removed.includes(id)) continue;
    if (!id.startsWith(TEAM_PRESET_PREFIX)) continue;
    if (releaseExisting(registry, id)) {
      result.removed.push(id);
      log(`unregistered id=${id} reason=removed(orphan)`);
    }
  }

  // ② 新增 / 更新（改名 / 改成员 / 换队长 / 改 presetId → 先 unregister 再 register）
  for (const def of defs) {
    const meta = sources.get(def.id);
    const fingerprint = fingerprintOf(
      def,
      meta === undefined
        ? undefined
        : {
            id: def.id,
            name: def.name,
            description: def.description ?? "",
            members: cleanMembers(meta),
            lead: resolveTeamLead(meta, cleanMembers(meta)),
            presetId: teamPresetId(meta),
          },
    );
    const prev = state.get(def.id);
    if (prev !== undefined && prev.fingerprint === fingerprint) {
      result.unchanged.push(def.id);
      continue;
    }
    const updating = prev !== undefined;
    if (updating) {
      state.delete(def.id);
      if (releaseExisting(registry, def.id, prev)) log(`unregistered id=${def.id} reason=renamed`);
    } else {
      // 非本模块登记的旧注册（如上一次 apply）也要先清掉，避免 Duplicate
      releaseExisting(registry, def.id);
    }
    try {
      let registered: unknown;
      try {
        registered = await registry.register(def);
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        // Duplicate 且释放不掉：说明宿主另有登记，无法保证新 def 生效 → 记 failed，不伪造台账
        if (!releaseExisting(registry, def.id)) throw error;
        registered = await registry.register(def);
      }
      // 存原始返回值（形态解析留到释放时），保证删除 / 改名时一定有东西可调
      state.set(def.id, { fingerprint, handle: registered });
      (updating ? result.updated : result.registered).push(def.id);
      log(`registered id=${def.id} name=${def.name} members=${membersOf(def.id)}`);
    } catch (error) {
      result.failed.push(def.id);
      logger?.warn?.(`cohub: 注册团队预设 ${def.id} 失败（其余团队继续）`, error);
      log(`failed id=${def.id} reason=register-error`);
    }
  }

  if (result.registered.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
    log(`sync changed added=${result.registered.length} removed=${result.removed.length} updated=${result.updated.length}`);
    logger?.info?.(
      `cohub: 团队预设同步 — 新增 ${result.registered.length}（${result.registered.join(", ") || "-"}）` +
        `，更新 ${result.updated.length}（${result.updated.join(", ") || "-"}）` +
        `，注销 ${result.removed.length}（${result.removed.join(", ") || "-"}）`,
    );
  }
  return result;
}

/**
 * 注销本模块注册的全部团队预设（插件 dispose 时调用）。幂等：没有台账直接返回。
 * @returns 实际被 unregister 的 id
 */
export function unregisterTeamPresets(ctx: any, logger?: Logger): string[] {
  const registry = resolveRegistry(ctx);
  if (!registry || typeof registry !== "object") return [];
  const state = stateByRegistry.get(registry);
  if (state === undefined || state.size === 0) return [];
  const removed: string[] = [];
  for (const [id, entry] of [...state.entries()]) {
    state.delete(id);
    try {
      releaseExisting(registry, id, entry);
      removed.push(id);
      log(`unregistered id=${id} reason=disposed`);
    } catch (error) {
      logger?.warn?.(`cohub: 注销团队预设 ${id} 失败（忽略）`, error);
    }
  }
  if (removed.length > 0) logger?.info?.(`cohub: 已注销 ${removed.length} 个团队预设（${removed.join(", ")}）`);
  return removed;
}

/** 当前已登记的团队预设 id（运维排查 / 测试用） */
export function listRegisteredTeamPresets(ctx: any): string[] {
  const registry = resolveRegistry(ctx);
  if (!registry || typeof registry !== "object") return [];
  return [...(stateByRegistry.get(registry)?.keys() ?? [])];
}
