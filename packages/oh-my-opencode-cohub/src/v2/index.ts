/**
 * OpenCode 2.x 入口
 *
 * 这是 `oh-my-opencode-cohub` 在 OpenCode 2.x 上的服务器入口，通过
 * `package.json` 的 `exports["./server"]` 暴露（v2 优先解析该子路径，
 * 1.x 只读根导出，因此两代可以共存于同一个 npm 包）。
 *
 * 设计取向：**不重写编排逻辑**。`src/index.ts` 里那套上下文引擎、任务追踪、
 * 编排引擎、council 等业务模块都有完整的单元测试覆盖，把它们全部改写成 v2 风格会引入
 * 与"适配新宿主"无关的回归面。这里的做法是：
 *
 * 1. 用 `compat.ts` 把 v2 的 `ctx` 反向适配成 v1 的 `PluginInput`；
 * 2. 直接调用 v1 的插件工厂拿到它产出的 hooks 对象；
 * 3. 把 hooks 里的每个能力**翻译**成 v2 的 domain 注册。
 *
 * 代价是保留了 v1 的部分词汇（`path/body/query` 调用风格），收益是业务逻辑零分叉。
 */
import { CoHubPlugin, __setNativeToolWrapping } from '../index';
import { createV1Input } from './compat';
import { toV1Event, mapEventType } from './events';
import {
  applyAgentDefinition,
  resolveConfig,
  toV2Model,
  wrapToolInput,
  setZod,
  type V1AgentLike,
} from './adapt';
import { backfillVariants, type CatalogModelInfo } from './variant-backfill';
import type { PortableToolDefinition } from '../tools/portable';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** v2 `Plugin.define` 的返回形状（不 import @opencode/plugin，保持零运行时依赖） */
export interface V2PluginDefinition {
  id: string;
  setup: (ctx: V2Context) => Promise<() => void> | (() => void);
}

/**
 * 只读的模型目录视图（仅取我们需要的部分）。
 *
 * 分工：`get` 用于确认模型已存在，`update` 只作用于已存在模型——
 * 宿主 `update` 是 upsert，对未知模型调用会创建空模型污染目录。
 */
interface CatalogView {
  model?: {
    update?(
      providerID: string,
      modelID: string,
      fn: (draft: CatalogModelInfo) => void,
    ): void;
    get?(providerID: string, modelID: string): CatalogModelInfo | undefined;
  };
}

/** 只声明我们真正用到的 v2 上下文能力，避免把宿主类型变成硬依赖 */
interface V2Context {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  catalog?: {
    transform(fn: (catalog: CatalogView) => unknown): Promise<unknown> | unknown;
  };
  agent?: {
    transform: (fn: (editor: V2AgentEditor) => void) => Promise<unknown>;
  };
  tool?: {
    transform: (fn: (editor: V2ToolEditor) => void) => Promise<unknown>;
    hook: (name: 'execute.before' | 'execute.after', fn: (input: unknown) => unknown) => Promise<unknown>;
  };
  session?: {
    hook: (name: string, fn: (input: unknown) => unknown) => Promise<unknown>;
  };
  shell?: {
    hook: (name: 'create.before', fn: (input: unknown) => unknown) => Promise<unknown>;
  };
  event?: {
    subscribe: (options?: { types?: readonly string[] }) => AsyncIterable<{ type?: string; data?: Record<string, unknown> }>;
  };
  permission?: {
    hook: (name: 'evaluate', fn: (input: unknown) => unknown) => Promise<unknown>;
  };
}

interface V2AgentEditor {
  list: () => ReadonlyArray<{ id: string }>;
  get: (id: string) => Record<string, unknown> | undefined;
  update: (id: string, fn: (agent: Record<string, unknown>) => void) => void;
  default: (id: string | undefined) => void;
}

interface V2ToolEditor {
  list: () => ReadonlyArray<{ id: string }>;
  add: (tool: Record<string, unknown>) => void;
  update: (id: string, fn: (tool: Record<string, unknown>) => void) => void;
}

/** v1 插件工厂产出的 hooks（只取我们桥接的部分） */
interface V1Hooks {
  agent?: Record<string, V1AgentLike>;
  tool?: Record<string, V1ToolDefinition>;
  /** 中立形状的原始工具定义（v2 入口消费，不依赖宿主包） */
  portableTools?: Record<string, PortableToolDefinition>;
  config?: (cfg: Record<string, unknown>) => Promise<void>;
  event?: (input: { event: unknown }) => Promise<void>;
  'tool.execute.before'?: (input: V1ToolInput, output: { args: Record<string, unknown> }) => Promise<void>;
  'tool.execute.after'?: (input: V1ToolInput, output: Record<string, unknown>) => Promise<void>;
  'experimental.chat.messages.transform'?: (
    input: Record<string, unknown>,
    output: { messages: V1Message[] },
  ) => Promise<void>;
  'experimental.chat.system.transform'?: (
    input: Record<string, unknown>,
    output: { system: string[] },
  ) => Promise<void>;
  dispose?: () => Promise<void>;
}

interface V1ToolInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: Record<string, unknown>;
}

interface V1ToolDefinition {
  description: string;
  args: unknown;
  execute: (args: unknown, context: unknown) => Promise<unknown>;
}

/** v1 的消息块（transform hook 里操作的对象） */
interface V1Message {
  info?: { role?: string; sessionID?: string; id?: unknown };
  parts?: Array<{ type?: string; text?: string }>;
}

/**
 * v2 的 `session.hook('context')` 给的是 `{ system: SystemPart[], messages: Message[] }`，
 * 而 v1 的 hook 分别操作 `system: string[]` 与 `{ info: { role }, parts: [] }` 形态的消息块。
 * 这里做双向搬移，让 v1 的业务逻辑（中文指令注入、Background Job Board）原样复用。
 */
function systemPartsToText(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((p) => (p && typeof p === 'object' ? (p as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === 'string');
}

function textToSystemParts(texts: string[]): Array<{ type: 'text'; text: string }> {
  return texts.map((text) => ({ type: 'text' as const, text }));
}

/** v2 Message（`{ id, role, content: [] }`）→ v1 消息块（`{ info, parts }`） */
function toV1Messages(messages: unknown[]): V1Message[] {
  const out: V1Message[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { id?: unknown; role?: unknown; content?: unknown };
    const parts: Array<{ type?: string; text?: string }> = [];
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as { type?: unknown; text?: unknown };
        // v2 的 "text" part 与 v1 的 text part 同名；其余（media/tool-call/tool-result）
        // v1 侧不处理，跳过即可（Board 只关心文本）
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text });
        }
      }
    }
    out.push({
      info: {
        role: typeof msg.role === 'string' ? msg.role : undefined,
        id: msg.id,
      },
      parts,
    });
  }
  return out;
}

/**
 * 把 v1 hook 改写后的文本回写到 v2 消息。
 *
 * 只回写 `text` part 的文本内容，不新增/删除 part，也不碰其他类型——
 * v1 的 Board 注入语义就是"在最后一条 user 消息末尾追加文本"。
 */
function applyV1Messages(target: unknown[], transformed: V1Message[]): void {
  for (let i = 0; i < target.length && i < transformed.length; i++) {
    const t = target[i] as { content?: unknown };
    const src = transformed[i];
    if (!t || typeof t !== 'object' || !Array.isArray(t.content) || !src?.parts) continue;
    // 位置对齐回写：把 v1 parts 里的 text 依次覆盖 v2 的 text parts
    const srcTexts = src.parts.filter((p) => p.type === 'text');
    let k = 0;
    for (const part of t.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type !== 'text') continue;
      const next = srcTexts[k++];
      if (next && typeof next.text === 'string') p.text = next.text;
    }
  }
}

export { buildVariantBody } from './variant-backfill';

/**
 * 构造 v2 插件定义。
 *
 * 注意 `setup` 里对 v1 工厂的调用是**一次性的**：v1 工厂在调用期间会启动
 * 两个定时器（过期任务清理 / 上下文清理），v2 没有对应的 dispose 时机，
 * 因此把清理函数交给 setup 返回的 cleanup，由宿主在卸载插件时调用。
 */
export function createV2Plugin(): V2PluginDefinition {
  return {
    id: 'oh-my-opencode-cohub',
    setup: async (ctx: V2Context) => {
      const v1Input = createV1Input(ctx);

      // v2 宿主没有 `@opencode-ai/plugin`，工厂内禁止走 v1 的工具包装器
      __setNativeToolWrapping(false);

      // v1 工厂的第二个参数是插件 options（来自 opencode.json 的 plugins 条目）
      const options = ctx.options ?? {};

      // 关键：v1 工厂是纯函数式的（返回 hooks 对象），不会自己注册任何东西
      const hooks = (await (CoHubPlugin as unknown as (
        input: unknown,
        options: unknown,
      ) => Promise<V1Hooks>)(v1Input, options)) ?? {};

      // ---------- 诊断 ----------
      // COHUB_V2_DIAG=1 时把注册结果写到文件，便于在真实宿主里核对（默认关闭）
      const diagFile = process.env.COHUB_V2_DIAG
        ? path.join(os.tmpdir(), 'cohub-v2-diag.log')
        : undefined;
      const diag = (m: string) => {
        if (!diagFile) return;
        try {
          fs.appendFileSync(diagFile, `[${new Date().toISOString()}] ${m}\n`);
        } catch {
          // 诊断失败不影响插件
        }
      };

      // ---------- 1. 代理注册 ----------
      // v2 的 AgentEditor 没有 add()，但 update() 对未知 id 会创建条目
      // （已用 OpenCode 2.2.5 真实二进制验证）。因此 13 个代理逐个 update 即可。
      const agentDefs = Object.values(hooks.agent ?? {});
      diag(`agentDefs=${agentDefs.length} names=${agentDefs.map((d) => d.name).join(',')}`);

      // ---------- 补齐 agent 声明的 variant ----------
      // v2 宿主遇到 model.variants 里不存在的 variant 会抛 VariantUnavailableError
      // （v1 只是静默降级），导致子代理加载失败。
      // 这里把 agent 配置声明的 variant 直接补进 catalog，让宿主能找到它。
      // 幂等：每次目录物化都会重放，已存在则跳过。
      if (ctx.catalog && typeof ctx.catalog.transform === 'function') {
        const declared: Array<{ providerID: string; modelID: string; variant: string }> = [];
        for (const def of agentDefs) {
          const cfg = resolveConfig(def);
          const ref = toV2Model(cfg.model);
          if (!ref) continue;
          const variant = cfg.variant;
          if (typeof variant !== 'string' || variant.length === 0) continue;
          declared.push({ providerID: ref.providerID, modelID: ref.id, variant });
        }

        if (declared.length > 0) {
          try {
            await ctx.catalog.transform((catalog: CatalogView) => {
              backfillVariants(catalog, declared, diag);
            });
          } catch {
            // catalog 不可用：不阻断代理注册。此时 variant 保持原样下发，
            // 若宿主报 VariantUnavailableError，需在 opencode.json 手动声明。
          }
        }
      }

      if (agentDefs.length > 0 && ctx.agent) {
        await ctx.agent.transform((editor) => {
          for (const def of agentDefs) {
            editor.update(def.name, (target) => {
              applyAgentDefinition(target as Record<string, unknown>, def);
            });
          }
          // co-orchestrator 是 cohub 的默认主代理；v1 通过 config hook 写 default_agent，
          // v2 没有 config hook，改由 AgentEditor.default() 表达。
          if (agentDefs.some((d) => d.name === 'co-orchestrator')) {
            editor.default('co-orchestrator');
          }
        });
      }

      // ---------- 2. 工具注册 ----------
      const v1Tools = (hooks.portableTools ?? {}) as Record<string, PortableToolDefinition>;
      diag(`portableTools=${Object.keys(v1Tools).length} names=${Object.keys(v1Tools).join(',')} hasCtxTool=${!!ctx.tool}`);
      if (Object.keys(v1Tools).length > 0 && ctx.tool) {
        setZod(z as unknown as Parameters<typeof setZod>[0]);
        await ctx.tool.transform((editor) => {
          diag(`tool.transform fired existing=${editor.list().length}`);
          for (const [name, def] of Object.entries(v1Tools)) {
            // v2 的 tool 需要 name 与 input；input 是完整 schema（v1 的 args 是字段表）
            const v2Tool = {
              name,
              description: def.description,
              input: wrapToolInput(def.args),
              execute: async (input: unknown, toolCtx: unknown) => {
                const result = await def.execute(input, toolCtx as never);
                // v2 的 Result 用 content 承载文本
                if (typeof result === 'string') return { content: result };
                return { content: JSON.stringify(result) };
              },
            };
            // 已存在的同名工具用 update 就地替换，缺失的用 add
            if (editor.list().some((t) => t.id === name)) {
              editor.update(name, (target) => {
                Object.assign(target, v2Tool);
              });
            } else {
              editor.add(v2Tool);
            }
          }
          diag(`tool.transform done, has=${editor.list().filter((t) => Object.keys(v1Tools).includes(t.id)).map((t) => t.id).join(',')}`);
        });
      }

      // ---------- 3. 工具执行前后 hook ----------
      // v1 的 callID ↔ v2 的 id；v1 的 output.args ↔ v2 可变的 input
      if (hooks['tool.execute.before'] && ctx.tool) {
        const before = hooks['tool.execute.before'];
        await ctx.tool.hook('execute.before', async (raw) => {
          const e = raw as { tool: string; sessionID: string; id: string; input: unknown };
          const args = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
          await before(
            { tool: e.tool, sessionID: e.sessionID, callID: e.id, args },
            { args },
          );
        });
      }

      if (hooks['tool.execute.after'] && ctx.tool) {
        const after = hooks['tool.execute.after'];
        await ctx.tool.hook('execute.after', async (raw) => {
          const e = raw as {
            tool: string;
            sessionID: string;
            id: string;
            input: unknown;
            status: 'completed' | 'error';
            result?: { content?: unknown; metadata?: unknown };
            error?: { message?: string };
          };
          const args = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
          // v1 的 output 形状是 { title, output, metadata }；v2 拆成 result/error
          const output: Record<string, unknown> = {
            title: '',
            output: e.status === 'completed' ? String(e.result?.content ?? '') : '',
            metadata: e.result?.metadata,
          };
          if (e.status === 'error') {
            output.error = e.error?.message ?? e.error;
          }
          await after({ tool: e.tool, sessionID: e.sessionID, callID: e.id, args }, output);
        });
      }

      // ---------- 4. 系统提示词与消息注入 ----------
      // v2 把它们统一收敛到 session.hook('context')：system 与 messages 在同一处
      const systemTransform = hooks['experimental.chat.system.transform'];
      const messagesTransform = hooks['experimental.chat.messages.transform'];
      if ((systemTransform || messagesTransform) && ctx.session) {
        await ctx.session.hook('context', async (raw) => {
          const e = raw as {
            sessionID?: string;
            agent?: string;
            model?: unknown;
            system?: unknown[];
            messages?: V1Message[];
          };
          diag(`session.context fired agent=${e.agent} systemParts=${Array.isArray(e.system) ? e.system.length : 'n/a'} msgs=${Array.isArray(e.messages) ? e.messages.length : 'n/a'}`);

          if (systemTransform && Array.isArray(e.system)) {
            const texts = systemPartsToText(e.system);
            const beforeLen = texts.length;
            await systemTransform(
              { sessionID: e.sessionID, model: e.model },
              { system: texts },
            );
            e.system = textToSystemParts(texts);
            diag(`system.transform before=${beforeLen} after=${texts.length}`);
          }

          // messages.transform（Background Job Board 注入）在 v1 里操作
          // `{ info: { role }, parts: [] }`；v2 的 messages 是 `{ role, content }` 的类实例。
          // 走「转 v1 形状 → 调 hook → 文本回写」三步，Board 逻辑本身零改动。
          if (messagesTransform && Array.isArray(e.messages) && e.messages.length > 0) {
            const v1Messages = toV1Messages(e.messages);
            await messagesTransform({}, { messages: v1Messages });
            applyV1Messages(e.messages, v1Messages);
            diag(`messages.transform applied msgs=${v1Messages.length}`);
          }
        });
      }

      // ---------- 5. 事件订阅 ----------
      // v2 **没有** `session.idle` 事件（实测 2.2.5 只有 session.execution.* /
      // session.step.* 等）；等价能力是 `session.hook('experimental.idle')`。
      // 这里两路都接：idle 走 hook（语义精确），其余生命周期事件走事件流。
      if (hooks.event && ctx.event) {
        const handle = hooks.event;
        const stream = ctx.event.subscribe();
        // 事件流是长驻的：立刻启动消费循环，不让 setup 阻塞在 await 上
        void (async () => {
          try {
            for await (const ev of stream) {
              const mapped = mapEventType(ev.type ?? '');
              if (!mapped) continue;
              const v1Event = toV1Event({
                type: mapped,
                data: ev.data,
              });
              // 类型被映射过时要让 v1 侧看到原始语义
              if (mapped !== ev.type) {
                if (ev.type === 'session.retry.scheduled') {
                  v1Event.properties = {
                    ...(v1Event.properties ?? {}),
                    status: { type: 'retry', ...(ev.data ?? {}) },
                  };
                }
              }
              await handle({ event: v1Event });
            }
          } catch {
            // 事件流中断不阻塞插件生命周期；宿主关闭时会自行结束
          }
        })();
      }

      // session.idle：v1 用事件，v2 用 hook
      if (hooks.event && ctx.session) {
        const handle = hooks.event;
        await ctx.session.hook('experimental.idle', async (raw) => {
          const e = raw as { sessionID?: string; background?: unknown[] };
          if (typeof e.sessionID !== 'string') return;
          diag(`idle hook session=${e.sessionID} background=${e.background?.length ?? 0}`);
          await handle({
            event: {
              type: 'session.idle',
              properties: { sessionID: e.sessionID },
            },
          });
        });
      }

      // ---------- 6. 卸载 ----------
      return () => {
        void hooks.dispose?.();
      };
    },
  };
}

export default createV2Plugin();
