// dsh-cohub/src/custom-skills.ts —— 用户自定义角色（Config.customRoles）→ runtime skill
//
// 定位：内置 13 个技能由 src/skills.ts（skills/*.md 生成物）提供，注册即结束；
// 自定义角色来自**用户可改的 volatile 配置**，因此除了「注册」还要处理三件内置技能不需要的事：
//   ① 冲突与脏值（schema 管不到的运行时重名 / 非法 tier / 非法名）——跳过 + warn，绝不让插件启动失败；
//   ② tier 信息外露（技能 metadata.tier）——派发层改用 roles.ts 的 resolveTier 直读 config，
//      与 delegate/delegate_batch 已有的「唯一映射源」保持一致，metadata 只作可观测性；
//   ③ 热生效——Volatile<T> 只暴露 get()，宿主不提供变更回调，故采用「轮询对账 + 差量同步」。
//
// 本文件不依赖 cordis 上下文（只吃 skills.register 与 logger 两个能力），因此可用 mock ctx 单测。
import { COHUB_SKILLS } from "./skills.ts";
import { isTier, type Tier } from "./roles.ts";

/** 自定义技能在技能目录里显示的来源桶（SkillSummary.source） */
export const CUSTOM_SKILL_SOURCE = "runtime" as const;

/** 自定义技能 metadata 里承载档位的键（供目录展示 / 调试 / 测试断言） */
export const CUSTOM_SKILL_TIER_KEY = "tier";

/** 与 CustomRole schema 一致的 kebab-case 名字文法（用户可能绕过 schema 直接改 yml） */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 默认对账间隔（毫秒）：一次 JSON.stringify 小数组的代价，够快且可忽略 */
export const CUSTOM_ROLE_POLL_MS = 1000;

/** 一条自定义角色配置（字段全部按 unknown 收，运行时逐项校验） */
export interface CustomRoleInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly prompt?: unknown;
  readonly tier?: unknown;
}

/** 规划产物：一条可直接交给 ctx.skills.register() 的 runtime 技能 */
export interface CustomSkillRegistration {
  readonly name: string;
  readonly description: string;
  /** 技能正文 = 角色的 prompt */
  readonly content: string;
  readonly source: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 一轮规划的完整结果 */
export interface CustomSkillPlan {
  /** 通过校验、可注册的技能（顺序 = 配置顺序） */
  readonly registrations: readonly CustomSkillRegistration[];
  /** 跳过原因（已含被跳过的角色名），供调用方 warn */
  readonly warnings: readonly string[];
}

/** 内置 13 个技能名（重名检查的基准，取自生成物而非写死） */
export const BUILTIN_SKILL_NAMES: readonly string[] = COHUB_SKILLS.map((skill) => skill.name);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 把 customRoles 规划成技能列表：校验 + 冲突消解，纯函数、无副作用（不注册、不打印）。
 *
 * 跳过规则（任何一条命中即跳过并记 warning，绝不抛错）：
 *   - name 非字符串 / 空 / 不符合 kebab-case；
 *   - name 与内置 13 个技能重名（内置优先，用户不能覆盖内置人设）；
 *   - 同一批 customRoles 内重名（保留**第一条**）；
 *   - tier 不是 5 个合法档位之一（`isTier`）。
 * description / prompt 为空串时退回一个可读占位（schema 已 `.min(1)`，此处只做运行时兜底）。
 */
export function planCustomSkills(
  roles: readonly CustomRoleInput[] | undefined,
  builtinNames: readonly string[] = BUILTIN_SKILL_NAMES,
): CustomSkillPlan {
  const registrations: CustomSkillRegistration[] = [];
  const warnings: string[] = [];
  const builtin = new Set(builtinNames);
  const seen = new Set<string>();

  for (const [index, role] of (Array.isArray(roles) ? roles : []).entries()) {
    const name = text(role?.name).trim();
    const where = `customRoles[${index}]` + (name.length > 0 ? `（${name}）` : "");

    if (name.length === 0) {
      warnings.push(`cohub: ${where} 缺少角色名，已跳过`);
      continue;
    }
    if (!NAME_PATTERN.test(name)) {
      warnings.push(`cohub: ${where} 角色名不是 kebab-case（只允许 a-z0-9 与单个连字符），已跳过`);
      continue;
    }
    if (builtin.has(name)) {
      warnings.push(`cohub: ${where} 与内置角色重名，已跳过（内置角色优先）`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`cohub: ${where} 与此前自定义角色重名，已跳过（保留第一条）`);
      continue;
    }
    if (!isTier(role?.tier)) {
      warnings.push(
        `cohub: ${where} tier 非法（${String(role?.tier)}），已跳过；合法值：ro / ro-net / rw / rw-shell / cordis`,
      );
      continue;
    }

    seen.add(name);
    const description = text(role?.description).trim();
    registrations.push({
      name,
      description: description.length > 0 ? description : `${name}（用户自定义角色）`,
      content: text(role?.prompt),
      source: CUSTOM_SKILL_SOURCE,
      metadata: { [CUSTOM_SKILL_TIER_KEY]: role.tier as Tier, custom: true },
    });
  }

  return { registrations, warnings };
}

/** 一条技能的内容签名：内容不变就不重注册（差量同步的判据） */
function fingerprint(skill: CustomSkillRegistration): string {
  return [skill.name, skill.description, skill.content, String(skill.metadata[CUSTOM_SKILL_TIER_KEY])].join("\u0000");
}

/** 最小技能服务契约（真实实现是 @deepseek-ai/dsh-skill 的 SkillRegistry） */
export interface SkillRegisterHost {
  register(skill: CustomSkillRegistration): (() => void) | void;
}

/** 最小日志契约（cordis 的 ctx.logger 满足，测试可传收集器） */
export interface CustomSkillLogger {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

export interface CustomSkillRegistryOptions {
  /** 技能注册服务（apply 期间取到的 ctx.skills） */
  readonly skills: SkillRegisterHost;
  /** 读取当前 customRoles 快照（volatile 配置每次对账都重新 get） */
  readonly getRoles: () => readonly CustomRoleInput[] | undefined;
  /** 内置技能名（缺省 BUILTIN_SKILL_NAMES） */
  readonly builtinNames?: readonly string[];
  readonly logger?: CustomSkillLogger;
  /** 定时器实现（测试可注入假定时器） */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface CustomSkillRegistry {
  /** 立即对账一次：注销被删除/改动的，注册新增/改动的（幂等，无变化时是空操作） */
  sync(): void;
  /** 启动轮询对账（热更新入口）；返回停止函数 */
  start(intervalMs?: number): () => void;
  /** 停轮询 + 注销全部自定义技能（插件卸载时调用） */
  dispose(): void;
  /** 当前已注册的自定义技能名（测试/调试用） */
  active(): readonly string[];
}

/**
 * 创建自定义角色技能注册器。
 *
 * **热更新机制的选择理由**：`Config.customRoles` 是 schemastery `.volatile()` 字段，DSH 0.2 的
 * Loader 在 `loader/volatile-update` 时把新值**提交到同一引用**（见 index.ts 对 skills 字段的注释），
 * 且 `Volatile<T>` 只暴露 `get()`——宿主既无 `onChange` 也无配置变更事件可订阅。因此这里采用
 * **轮询对账**：每 `CUSTOM_ROLE_POLL_MS` 读一次 `get()`，先比签名（字符串相等即返回，代价可忽略），
 * 签名变了才做差量同步。它不依赖任何未公开 API，跨宿主机版本稳定，也不会因 apply 只跑一次而失效。
 */
export function createCustomSkillRegistry(options: CustomSkillRegistryOptions): CustomSkillRegistry {
  const { skills, getRoles, logger } = options;
  const builtinNames = options.builtinNames ?? BUILTIN_SKILL_NAMES;
  const setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  /** 已注册技能：name → { disposer, fingerprint } */
  const active = new Map<string, { dispose: () => void; print: string }>();
  /** 已输出过的 warning（去重：轮询每轮都会重算规划，不能每轮重复刷同一条告警） */
  const warned = new Set<string>();
  /** 上一轮规划签名（只有变化才进入差量逻辑） */
  let lastSignature: string | null = null;
  let timer: unknown = null;
  let disposed = false;

  function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    logger?.warn?.(message);
  }

  function sync(): void {
    if (disposed) return;

    const plan = planCustomSkills(getRoles(), builtinNames);
    // 告警与「技能集合是否变化」解耦：退出再登录同一角色时不重复刷屏
    for (const message of plan.warnings) warnOnce(message);

    const signature = plan.registrations.map(fingerprint).join("\u0001");
    if (signature === lastSignature) return; // 快路径：无变化
    lastSignature = signature;

    const next = new Map(plan.registrations.map((skill) => [skill.name, skill] as const));

    // ① 差量注销：删除的 + 内容改动的
    for (const [name, entry] of [...active]) {
      const upcoming = next.get(name);
      if (upcoming !== undefined && fingerprint(upcoming) === entry.print) continue; // 不变 → 保留
      try {
        entry.dispose();
      } catch (error) {
        logger?.warn?.(`cohub: 注销自定义角色技能 ${name} 失败（忽略）`, error);
      }
      active.delete(name);
    }

    // ② 差量注册：新出现的 + 刚被注销待重建的
    for (const skill of plan.registrations) {
      if (active.has(skill.name)) continue; // 不变 → 跳过
      try {
        const off = skills.register(skill);
        active.set(skill.name, {
          dispose: typeof off === "function" ? off : () => { /* 宿主无 disposer：退化为不可注销 */ },
          print: fingerprint(skill),
        });
      } catch (error) {
        // 单条注册失败不得拖垮整批（更不得拖垮插件）
        logger?.warn?.(`cohub: 注册自定义角色技能 ${skill.name} 失败（跳过）`, error);
      }
    }

    if (plan.registrations.length > 0) {
      logger?.info?.(
        `cohub: 自定义角色技能 ${active.size} 个（${[...active.keys()].join(", ")}）`,
      );
    }
  }

  return {
    sync,
    active: () => [...active.keys()],
    start(intervalMs = CUSTOM_ROLE_POLL_MS) {
      sync(); // 挂载即注册，不等第一个 tick
      if (timer !== null || intervalMs <= 0) return () => { /* 未启动 */ };
      timer = setTimer(() => {
        try {
          sync();
        } catch (error) {
          // 防御：对账异常只告警，绝不打断宿主事件循环
          logger?.warn?.("cohub: 自定义角色对账失败（忽略）", error);
        }
      }, intervalMs);
      const handle = timer as { unref?: () => void };
      if (typeof handle?.unref === "function") handle.unref(); // 不阻止宿主进程退出
      return () => {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
      };
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      for (const [name, entry] of active) {
        try {
          entry.dispose();
        } catch {
          logger?.warn?.(`cohub: 卸载时注销自定义角色技能 ${name} 失败（忽略）`);
        }
      }
      active.clear();
      lastSignature = null;
    },
  };
}
