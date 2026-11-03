/**
 * OpenCode 2.x 定义转换
 *
 * cohub 内部用 v1 的配置词汇描述代理与权限（`mode` / `prompt` / `permission: { tool: 'deny' }`），
 * 而 v2 换成了另一套：
 *
 * | v1                          | v2                                        |
 * |-----------------------------|-------------------------------------------|
 * | `prompt: string`            | `system?: string`                         |
 * | `model: 'prov/variant'`     | `model: { providerID, id, variant }`      |
 * | `permission: { t: 'deny' }` | `permissions: [{ action, resource, effect }]` |
 * | `temperature: 0.1`          | `request.body.temperature`                |
 *
 * 这里只做单向转换（v1 → v2），保留 cohub 既有的配置表达能力，不引入第二套配置格式。
 */

/** v1 的权限映射：工具名 → 效果 */
export type V1Permission = Record<string, 'allow' | 'deny' | 'ask'>;

/** v2 的权限条目 */
export interface V2PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** v2 的模型引用 */
export interface V2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/**
 * 把 v1 的 `'provider/model'` 字符串解析成 v2 的模型引用。
 *
 * v1 里模型有两种写法：`'provider/model'` 和单独的 `'model'`（继承默认 provider）。
 * 后者在 v2 无法表达 provider，返回 undefined 让调用方保留 v2 已有的默认值。
 */
export function toV2Model(model: unknown): V2ModelRef | undefined {
  if (typeof model !== 'string' || model.length === 0) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
  };
}

/**
 * v1 的 `permission: { tool: 'deny' }` → v2 的规则数组。
 *
 * v2 用 `action` 表达被判定的动作类别，用 `resource` 表达具体资源。
 * cohub 目前只按工具粒度授权，因此 `action` 取工具名、`resource` 取 `'*'`。
 * `'ask'` 在 v2 里仍是合法效果（交给宿主的交互门），原样保留。
 */
export function toV2Permissions(permission: unknown): V2PermissionRule[] {
  if (!permission || typeof permission !== 'object') return [];
  const out: V2PermissionRule[] = [];
  for (const [action, effect] of Object.entries(permission as V1Permission)) {
    if (effect !== 'allow' && effect !== 'deny' && effect !== 'ask') continue;
    out.push({ action, resource: '*', effect });
  }
  return out;
}

/** cohub 代理定义在转换时需要保留的字段 */
export interface V1AgentLike {
  name: string;
  description?: string;
  /** 嵌套形态（工厂内部的 agents 数组用这个） */
  config?: Record<string, unknown>;
  /** 扁平形态（工厂返回的 `agent` 记录把 config 直接摊平在顶层） */
  [key: string]: unknown;
}

/**
 * 取出代理定义里的配置字段。
 *
 * 工厂内部两种形态并存，必须都支持：
 * - `agents` 数组：`{ name, config: { mode, prompt, ... } }`
 * - `hooks.agent` 记录：`{ name, mode, prompt, permission, ... }`（config 已摊平）
 */
export function resolveConfig(agent: V1AgentLike): Record<string, unknown> {
  if (agent.config && typeof agent.config === 'object') return agent.config;
  return agent as Record<string, unknown>;
}

/**
 * 把 cohub 的 v1 代理定义套用到 v2 的 `Agent.Info` 上。
 *
 * 采用"修改现有对象"的写法而不是返回新对象，因为 v2 的 `AgentEditor.update`
 * 给的是一个可变代理对象，语义就是就地改写。
 *
 * 注意：**不写 `id`**。v2 的 `update(id, fn)` 已经按 id 定位，
 * 而 id 是带 brand 的类型，覆写会破坏宿主内部一致性。
 *
 * variant 原样下发：若宿主目录里没有该 variant，由入口层提前把它补进 catalog，
 * 而不是在这里剔除（见 `v2/index.ts` 的补齐逻辑）。
 */
export function applyAgentDefinition(
  target: Record<string, unknown>,
  agent: V1AgentLike,
): void {
  const config = resolveConfig(agent);

  const mode = config.mode;
  if (mode === 'primary' || mode === 'subagent' || mode === 'all') {
    target.mode = mode;
  } else {
    target.mode = 'subagent';
  }

  if (config.prompt !== undefined) {
    // v1 用 prompt，v2 改名 system；两者语义都是"代理的常驻系统提示词"
    target.system = config.prompt;
  }
  if (agent.description !== undefined) {
    target.description = agent.description;
  }

  const model = toV2Model(config.model);
  if (model) {
    // 保留已有的变体（若 v1 侧未显式给出 variant）
    const existing = target.model as Record<string, unknown> | undefined;
    const merged: Record<string, unknown> = { ...model };
    if (config.variant !== undefined) {
      merged.variant = config.variant;
    } else if (existing && typeof existing.variant === 'string') {
      merged.variant = existing.variant;
    }
    target.model = merged;
  } else if (config.variant !== undefined) {
    // 模型字符串解析不出 provider 时，仍把 variant 合并进宿主已有的 model
    const existing = target.model as Record<string, unknown> | undefined;
    if (existing) target.model = { ...existing, variant: config.variant };
  }

  // temperature 之类的采样参数在 v2 归入 request.body
  const temperature = config.temperature;
  if (typeof temperature === 'number') {
    const request = (target.request as Record<string, unknown> | undefined) ?? {};
    const body = (request.body as Record<string, unknown> | undefined) ?? {};
    target.request = { ...request, body: { ...body, temperature } };
  }

  const permissions = toV2Permissions(config.permission);
  if (permissions.length > 0) {
    // v2 的 permissions 是规则数组；与宿主既有规则合并时保留既有项，
    // 同 action/resource 以插件声明为准（插件表达的是 cohub 的强制约束）。
    const existing = Array.isArray(target.permissions)
      ? (target.permissions as V2PermissionRule[])
      : [];
    const key = (r: V2PermissionRule) => `${r.action}\u0000${r.resource}`;
    const incoming = new Map(permissions.map((r) => [key(r), r]));
    const kept = existing.filter((r) => !incoming.has(key(r)));
    target.permissions = [...kept, ...permissions];
  }
}

/** zod 兼容层：只需要 `object()`，由调用方注入（见 `v2/index.ts` 的 `tool.schema`） */
export interface ZodLike {
  object: (shape: Record<string, unknown>) => unknown;
}

let zodRef: ZodLike | undefined;

/** 注入 zod 实现；不注入时工具参数原样下传（仅在无工具的纯代理场景安全） */
export function setZod(zod: ZodLike): void {
  zodRef = zod;
}

/**
 * 把 zod 的 `ZodRawShape` 包成 v2 `Tool.Info.input` 需要的单值 schema。
 *
 * v1 的 `tool({ args: shape })` 收的是字段表，v2 的 `tool.add({ input })` 要的是
 * 完整 schema。zod 4 的实例满足 StandardSchemaV1，包一层 `object()` 即可直接交给 v2，
 * 无需再转 JSON Schema。
 */
export function wrapToolInput(shape: unknown): unknown {
  if (!zodRef) return shape;
  try {
    return zodRef.object(shape as Record<string, unknown>);
  } catch {
    return shape;
  }
}
