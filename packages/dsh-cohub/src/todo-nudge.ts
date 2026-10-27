// src/todo-nudge.ts —— 委派成功返回后注入「立刻 todo_write 回写」提醒
//
// 问题：delegate / delegate_batch 做完后，编排者常忘了把 todo 面板里对应项从
// in_progress 改回 completed，于是「任务做完了但面板还停在 in_progress」。
// 做法：用官方 ToolRunContext.deferContext()（dsh-tools lib/types/index.d.ts:305-312）
// 把一条 plugin-sourced user 上下文挂到本次工具结果之后——agent loop 只在
// `tool/result` 落盘后才追加它，所以提醒与结果同批到达，不抢正文位置。
// 约束：fail-soft。宿主没有 deferContext（旧版 / 测试桩）或构造被拒 → 静默跳过，
// 绝不打断委派本身。节流：同会话最多 2 次，避免反复刷屏反而变成噪音。
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// MessageSourceMap 是官方「可合并扩展」的 kind 表（dsh-llm message.d.ts:95-108：
// 每个生产者在自己模块里声明 kind，消费方对未知 kind 直接放行）。这里声明本插件
// 专属 kind，既满足类型又不改变宿主行为——不用 as any 绕类型。
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "cohub-todo-nudge": { kind: "cohub-todo-nudge" };
  }
}

/** 提醒正文（≤60 字）：一条可立即执行的动作指令，不解释来由 */
export const NUDGE_TEXT = "委派结果已返回：立刻 todo_write 回写对应项状态（整表覆盖，保留未动项），再继续下一步。";

/** 同会话注入上限：硬编码 2 次（不做配置开关——提醒过两次仍不回写，再多也只是噪音） */
const MAX_PER_SESSION = 2;

/** 会话级计数：key 用 exec.agent 对象身份（WeakMap 不阻止回收；WeakSet 表达不了「最多 2 次」） */
const nudged = new WeakMap<object, number>();

/**
 * 委派成功返回后调用：向父会话注入一条 todo 回写提醒。
 * 内部吞掉所有异常（fail-soft），调用方无需 try/catch，也无需判断宿主能力。
 */
export function maybeDeferTodoNudge(exec: any): void {
  try {
    if (typeof exec?.deferContext !== "function") return; // 宿主不支持 → 静默跳过
    const key = exec.agent ?? exec; // 会话级归属优先按 agent 实例，退化到 exec 自身
    if (key === null || typeof key !== "object") return;
    const used = nudged.get(key) ?? 0;
    if (used >= MAX_PER_SESSION) return;
    nudged.set(key, used + 1);
    exec.deferContext(
      createUserMessage({
        content: [{ type: "text", text: NUDGE_TEXT }],
        source: { kind: "cohub-todo-nudge" },
      }),
    );
  } catch {
    // 宿主不支持 / 构造被拒 / 上下文已终结：提醒是锦上添花，不能影响委派结果
  }
}
