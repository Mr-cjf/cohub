/**
 * OpenCode 2.x 兼容层
 *
 * OpenCode 2.0 重写了插件 API：v1 的 `(input, options) => Hooks` 函数形态被
 * `{ id, setup(ctx) }` 定义取代，全部 hook 也从"返回对象上的键"改成了
 * 必须显式注册的 domain（`ctx.agent.transform` / `ctx.tool.hook` / ...）。
 *
 * 本模块只做一件事：把 v2 的 `ctx` 反向适配成 v1 的 `PluginInput` 形状，
 * 让 `src/index.ts` 里的编排逻辑（上下文引擎、任务追踪、编排引擎、council）
 * 无需为每个 client 调用点改写。适配是**窄的**——只覆盖 v1 实际用到的
 * `session.create/abort/messages/prompt` 四个方法，不做通用代理。
 *
 * 之所以不直接改写业务代码：那些模块有完整的单元测试覆盖，把它们全部
 * 迁到 v2 的 `{ sessionID }` 参数风格会引入大量与本次移植无关的回归面。
 */

/** v1 风格的 session 调用入参（`{ path, body, query }`） */
export interface V1CallOptions {
  path?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

/** v2 domain 上我们实际依赖的最小方法集 */
export interface V2SessionLike {
  create?: (input: Record<string, unknown>) => Promise<unknown>;
  remove?: (input: Record<string, unknown>) => Promise<unknown>;
  interrupt?: (input: Record<string, unknown>) => Promise<unknown>;
  prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  context?: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 把 v1 的 `{ path: { id }, query: { limit } }` 折叠成 v2 的扁平入参
 * `{ sessionID, limit }`。v2 的 client 方法统一只收一个对象，没有 path/query 分层。
 */
function flatten(options?: V1CallOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const path = options?.path;
  if (path && typeof path === 'object') {
    // v1 用 `id` 承载 session 标识；v2 统一叫 sessionID
    const id = (path as Record<string, unknown>).id;
    if (typeof id === 'string') out.sessionID = id;
    for (const [k, v] of Object.entries(path)) {
      if (k !== 'id') out[k] = v;
    }
  }
  const query = options?.query;
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) out[k] = v;
    }
  }
  const body = options?.body;
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/**
 * v2 的方法直接 reject（而不是返回 `{ error }`），而 v1 的调用点普遍写成
 * `const res = await client.x(); if (res.error) ...`。这里统一包成 v1 的
 * 结果形状，避免业务代码里已经写好的错误分支全部失效（静默假成功）。
 */
async function toV1Result<T>(run: () => Promise<T>): Promise<{ data?: T; error?: unknown }> {
  try {
    const data = await run();
    return { data };
  } catch (error) {
    return { error };
  }
}

export interface V2ContextLike {
  session?: V2SessionLike & Record<string, unknown>;
  location?: { directory?: string };
  agent?: unknown;
  tool?: unknown;
  event?: unknown;
  permission?: unknown;
  shell?: unknown;
  skill?: unknown;
  command?: unknown;
  options?: Record<string, unknown>;
}

/**
 * 构造 v1 形状的 `PluginInput`。
 *
 * 只填 v1 业务代码真正读到的字段；`project` / `worktree` / `serverUrl` / `$`
 * 在 v2 里没有对应物，给安全占位值而不是让调用方崩溃——这些字段在当前
 * 业务路径里未被解引用（已核对 src/ 下全部 `input.` 访问点）。
 */
export function createV1Input(ctx: V2ContextLike): Record<string, unknown> {
  const session = ctx.session ?? {};

  const v1Session: Record<string, unknown> = {};

  if (typeof session.create === 'function') {
    v1Session.create = (options?: V1CallOptions) => toV1Result(() => session.create!(flatten(options)));
  }
  if (typeof session.remove === 'function') {
    v1Session.remove = (options?: V1CallOptions) => toV1Result(() => session.remove!(flatten(options)));
  }
  if (typeof session.prompt === 'function') {
    v1Session.prompt = (options?: V1CallOptions) => toV1Result(() => session.prompt!(flatten(options)));
  }
  // v2 用 `interrupt` 表达中止；v1 叫 `abort`
  if (typeof session.interrupt === 'function') {
    v1Session.abort = (options?: V1CallOptions) => toV1Result(() => session.interrupt!(flatten(options)));
  }
  // v2 没有 `messages`，对应能力是 `context`（返回消息列表）
  if (typeof session.context === 'function') {
    v1Session.messages = (options?: V1CallOptions) => toV1Result(() => session.context!(flatten(options)));
  }

  const directory =
    typeof ctx.location?.directory === 'string' ? ctx.location.directory : process.cwd();

  return {
    client: { session: v1Session },
    directory,
    // v2 无对应：保留 v1 字段以免解构崩溃，值可为空
    project: {},
    worktree: directory,
    serverUrl: undefined,
    $: undefined,
  };
}
