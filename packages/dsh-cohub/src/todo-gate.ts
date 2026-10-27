// src/todo-gate.ts —— turn-stopping 收尾闸门：turn 即将关闭且 todo 仍有 in_progress 时，
// 用 `agent.steer()` 逼模型再走一步把状态回写，而不是留下面板与实际不符的 in_progress。
//
// 官方语义（dsh-agent lib/types/runtime-types.d.ts:370-391）：`agent/turn-stopping` 在
// 「本可以关闭」的轮次边界前运行，`@mode serial` 且被 await；监听器只要往 inbox 里 steer
// 一条消息，状态机就重读 inbox —— 有新 steering 就再跑一步，没有才真正关 turn。
// 因此这里不依赖 handler 返回值，只产生「控制数据」。
//
// 硬约束（缺一即错）：
//   ① 子会话隔离：`header.parentSession` 非空直接 return。否则每个子代理 turn 关闭都被催，
//      delegate / delegate_batch 场景下会成倍放大成噪音风暴。
//   ② 每 session 硬上限 2 次：WeakMap 计数，对齐 todo-nudge.ts:25 的口径（多催也只是噪音）。
//   ③ in_progress 内容指纹去重：指纹不变就不催 —— 同一 turn 内自然也不会重复催。
//   ④ 文案必须给出三个出口（完成/保留继续/等外部条件降级 pending），否则模型只会干瞪眼。
//   ⑤ steer 纪律：先扣额度再调用；全程 try/catch 吞错；**不 await 网络/LLM**；不看返回值。
//   ⑥ kill switch：`COHUB_TODO_GATE=0` 时整体禁用（默认开启）。
//   ⑦ 类型不 declare module：投影只读一次、单点 `any`，用局部 Todo 类型 + 守卫收口。
//   ⑧ 卸载可撤销：注册必须包在 `ctx.effect(() => { const off = ...; return off })` 内。
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * 闸门正文（≤140 字）：一条可立即执行的动作指令 + 三个明确出口。
 * 与 todo-nudge.ts 的 NUDGE_TEXT 不重叠：那条讲「委派回来了快回写」，这条讲「turn 要关了，
 * in_progress 必须有交代」。
 */
export const GATE_TEXT =
  "收尾检查：todo 面板里还有 in_progress 项未回写。立刻用 todo_write 处理，三选一："
  + "① 已完成 → 标 completed；② 确需继续 → 保持 in_progress 并立刻做完；"
  + "③ 等外部条件 → 改 pending 并在正文写明在等什么。不要留无说明的 in_progress。";

/** 每 session 注入上限：硬编码 2 次（提醒两次仍不回写，再多只是噪音） */
const MAX_PER_SESSION = 2;

/** 会话级去重 + 计数：WeakMap 不阻止会话被回收；WeakSet 表达不了「最多 2 次」 */
const gateStates = new WeakMap<object, GateState>();

/** kill switch：默认开启，`COHUB_TODO_GATE=0` 时禁用（排障 / 用户不想要额外一步时用） */
function gateEnabled(): boolean {
  return process.env.COHUB_TODO_GATE !== "0";
}

/** 纯函数用的最小状态：上次触发的指纹 + 已用次数 */
export interface GateState {
  fingerprint: string;
  count: number;
}

/** 投影里的 todo 项：只认我们真正读的两个字段，其余一律不假设 */
type Todo = { content?: unknown; status?: unknown };

/** shouldSteer 的判定结果：steer=true 时 count 已经**预先扣掉**本次额度 */
export interface GateDecision {
  steer: boolean;
  fingerprint: string;
  count: number;
  items: string[];
}

/**
 * 守卫收口：从 unknown 里挑出 status === "in_progress" 的项，取 content 文本。
 * 任何形状不符（非数组 / 元素非对象 / 拼接失败）都退化为「跳过该项」，绝不抛。
 */
export function pickInProgress(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Todo;
    if (item.status !== "in_progress") continue;
    const content = item.content;
    const text = typeof content === "string"
      ? content
      : content === undefined || content === null
        ? ""
        : (() => { try { return JSON.stringify(content) ?? ""; } catch { return ""; } })();
    out.push(text);
  }
  return out;
}

/** 指纹：in_progress 项 content 集合的排序快照（顺序变化不算变化） */
export function fingerprintOf(items: string[]): string {
  return [...items].sort().join("\u0000");
}

/**
 * 判定纯函数（handler 只做「读投影 → 调本函数 → 调 steer」三件事）：
 *   - 无 in_progress → 不催（面板干净或投影缺失都走这里）；
 *   - 已达 session 上限 → 不催（硬截断，先于指纹判断，避免白算）；
 *   - 指纹与上次相同 → 不催（同 turn 内重复 emit、同状态反复关闭都被吸收）；
 *   - 其余 → 催，并把 count 预扣到本次（调用方写回即可，见 ⑤）。
 */
export function shouldSteer(todos: unknown, state: GateState | undefined): GateDecision {
  const items = pickInProgress(todos);
  const fingerprint = fingerprintOf(items);
  const count = state?.count ?? 0;
  if (items.length === 0) return { steer: false, fingerprint, count, items };
  if (count >= MAX_PER_SESSION) return { steer: false, fingerprint, count, items };
  if (state !== undefined && state.fingerprint === fingerprint) return { steer: false, fingerprint, count, items };
  return { steer: true, fingerprint, count: count + 1, items };
}

/**
 * 从 sessionProjections 快照里读 todo 列表（⑦ 的单点取值所在）。
 * 官方投影 key 是 `todo`（state/view 均为 `{ items }`，见 dsh-session-projection README.md:39-51）；
 * 这里对 `todo` / `todos` 两种键与「裸数组 / { items }」两种形状都做退化，读不到就返回 null。
 */
function readTodos(snap: any): unknown {
  const values = snap?.values;
  if (values === null || typeof values !== "object") return null;
  for (const key of ["todo", "todos"] as const) {
    const value = (values as any)[key];
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object" && Array.isArray((value as any).items)) {
      return (value as any).items;
    }
  }
  return null;
}

/**
 * 构造 turn-stopping 监听器（导出便于单测直接驱动，不必造完整 cordis 宿主）。
 * 注意：同步函数，不返回 Promise —— 闸门只投递控制数据，绝不 await 网络/LLM（⑤）。
 */
export function createTodoGateHandler(ctx: any) {
  return (payload: any): void => {
    try {
      if (!gateEnabled()) return; // ⑥ kill switch
      const agent: any = payload?.agent;
      const session: any = agent?.session;
      if (session === null || typeof session !== "object") return;
      // ① 子会话隔离：子代理的 turn 关闭与父会话的 todo 面板无关
      if ((session as any).header?.parentSession) return;
      if (typeof agent?.steer !== "function") return; // 宿主无 steer 能力 → 静默跳过
      // ⑦ 单点读投影（其余一律走守卫收口，不给 todo 形状任何类型假设）
      const snap: any = ctx.sessionProjections.snapshot(session);
      const decision = shouldSteer(readTodos(snap), gateStates.get(session));
      if (!decision.steer) return;
      // ⑤ 先扣额度再调用：steer 抛错也已记账，不会无限重试
      gateStates.set(session, { fingerprint: decision.fingerprint, count: decision.count });
      agent.steer(
        createUserMessage({
          content: [{ type: "text", text: GATE_TEXT }],
          // ⑦ 不做 declare module 扩展：未知 kind 由消费方放行，这里局部宽化即可
          source: { kind: "cohub-todo-gate" } as any,
        }) as any,
      );
    } catch {
      // ⑤ fail-soft：闸门是锦上添花，任何异常都不得打断 turn 关闭流程
    }
  };
}

/**
 * 注册监听并返回撤销函数（⑧：调用方必须把它放进 `ctx.effect(() => {...; return off})`）。
 * 返回的 off 自身也吞错，重复调用 / 宿主已终结都不会抛。
 */
export function registerTodoGate(ctx: any): () => void {
  const off = ctx.on("agent/turn-stopping" as any, createTodoGateHandler(ctx));
  return () => {
    try {
      if (typeof off === "function") off();
    } catch {
      // 卸载期异常同样不得冒泡到插件卸载流程
    }
  };
}
