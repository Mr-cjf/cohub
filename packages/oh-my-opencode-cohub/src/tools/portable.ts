/**
 * 跨代工具定义形状
 *
 * cohub 的工具（`council_session` / `close_job`）需要在 OpenCode 1.x 与 2.x 上
 * 同时可用。两代宿主对"工具定义"的包装器不同（v1 是 `tool()`，v2 是
 * `ctx.tool.add()`），但**数据形状是一致的**：
 *
 *   { description, args, execute(args, ctx) }
 *
 * 因此工具模块只产出这个中立形状，由入口层负责翻译：
 * - `src/index.ts`（v1）：`tool({ description, args, execute })`
 * - `src/v2/index.ts`（v2）：`ctx.tool.add({ name, description, input, execute })`
 *
 * 这样工具本身不 import 任何宿主包，构建产物也不会把 `@opencode-ai/plugin`
 * 钉进 2.x 的加载路径（那是 `Cannot find package` 的直接来源）。
 */
/** 中立工具定义 */
export interface PortableToolDefinition {
  description: string;
  args: unknown;
  execute: (args: any, context: PortableToolContext) => Promise<string>;
}

/** 工具执行时宿主提供的上下文（取两代的交集，够 cohub 使用） */
export interface PortableToolContext {
  sessionID: string;
  /** 调用该工具的代理名；v1 直接给 `agent`，v2 同样是 `agent` */
  agent: string;
}

/** 工具集合 */
export type PortableToolSet = Record<string, PortableToolDefinition>;
