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

import { resolveSkillSnapshot } from "./roles.ts";
import type { CohubPresetDef } from "./preset-runtime";

/** 最小日志接口（cordis logger 与测试 mock 都能满足） */
interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** 团队预设的排序起点：排在包内档位预设（order < 50）之后 */
export const TEAM_PRESET_ORDER_BASE = 50;

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
 *   ① lead 非空且 ∈ members；② members 含 co-orchestrator；③ members[0]；④ ""。
 */
function resolveTeamLead(team: TeamPresetSource, members: readonly string[]): string {
  const declared = typeof team.lead === "string" ? team.lead.trim() : "";
  if (declared.length > 0 && members.includes(declared)) return declared;
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

/**
 * 遍历 `config.teams` 生成可注册的预设定义。
 *
 * 跳过规则（fail-soft，只 warn 不抛）：
 *   · 团队 id 为空 → 无法推断预设 id；
 *   · 预设 id 与前面团队重复（含 presetId 手工撞车）→ 保留第一个。
 * order：`TEAM_PRESET_ORDER_BASE + 序号`（稳定顺序，排在包内档位预设之后）。
 */
export function buildTeamPresetDefs(config?: TeamPresetConfig, logger?: Logger): CohubPresetDef[] {
  const teams = readList<TeamPresetSource>(config?.teams as never);
  const customRoles = readList<TeamPresetCustomRole>(config?.customRoles as never);
  const defs: CohubPresetDef[] = [];
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

    const members = cleanMembers(team);
    const lead = resolveTeamLead(team, members);
    const name = (typeof team.name === "string" && team.name.trim().length > 0 ? team.name.trim() : teamId);
    const description =
      `cohub 团队「${name}」：队长 ${lead || "（未指定）"}，成员 ${members.length > 0 ? members.join(", ") : "（无）"}`;

    defs.push({
      id,
      name,
      description,
      order: TEAM_PRESET_ORDER_BASE + index,
      plugins: buildTeamPresetPlugins(buildTeamPersona(team, members, lead, customRoles)),
    });
  }
  return defs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册表台账与幂等同步
// ─────────────────────────────────────────────────────────────────────────────

/** 单个 id 的台账：指纹 + 宿主返回的 unregister 句柄 */
interface TeamPresetEntry {
  fingerprint: string;
  handle?: () => unknown;
}

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

function stateOf(registry: object): Map<string, TeamPresetEntry> {
  let map = stateByRegistry.get(registry);
  if (map === undefined) {
    map = new Map<string, TeamPresetEntry>();
    stateByRegistry.set(registry, map);
  }
  return map;
}

/** 预设指纹：name / description / order / plugins 任一变化都算「需要重建」 */
function fingerprintOf(def: CohubPresetDef): string {
  return JSON.stringify([def.name, def.description ?? "", def.order ?? null, def.plugins]);
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
  if (typeof entry?.handle === "function") {
    try {
      entry.handle();
      return true;
    } catch {
      /* 句柄失效：继续走宿主接口 */
    }
  }
  let existing: any;
  try {
    existing = typeof registry.get === "function" ? registry.get(id) : undefined;
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && existing !== null) {
    if (typeof existing.unregister === "function") {
      existing.unregister();
      return true;
    }
    if (typeof registry.delete === "function") {
      registry.delete(id);
      return true;
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

  // ① 团队被删除 → 注销
  for (const [id, entry] of [...state.entries()]) {
    if (wanted.has(id)) continue;
    state.delete(id);
    try {
      releaseExisting(registry, id, entry);
      result.removed.push(id);
    } catch (error) {
      logger?.warn?.(`cohub: 注销团队预设 ${id} 失败（忽略）`, error);
    }
  }

  // ② 新增 / 更新 / 跳过
  for (const def of defs) {
    const fingerprint = fingerprintOf(def);
    const prev = state.get(def.id);
    if (prev !== undefined && prev.fingerprint === fingerprint) {
      result.unchanged.push(def.id);
      continue;
    }
    try {
      if (prev !== undefined) {
        releaseExisting(registry, def.id, prev);
        state.delete(def.id);
        result.updated.push(def.id);
      } else {
        // 非本模块登记的旧注册（如上一次 apply）也要先清掉，避免 Duplicate
        releaseExisting(registry, def.id);
        result.registered.push(def.id);
      }
      let handle: unknown;
      try {
        handle = await registry.register(def);
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        releaseExisting(registry, def.id);
        handle = await registry.register(def);
      }
      state.set(def.id, {
        fingerprint,
        ...(typeof handle === "function" ? { handle: handle as () => unknown } : {}),
      });
    } catch (error) {
      result.failed.push(def.id);
      result.registered = result.registered.filter((id) => id !== def.id);
      result.updated = result.updated.filter((id) => id !== def.id);
      logger?.warn?.(`cohub: 注册团队预设 ${def.id} 失败（其余团队继续）`, error);
    }
  }

  if (result.registered.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
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
