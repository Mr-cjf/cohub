// test/todo-gate.ts —— turn-stopping 收尾闸门单测（独立运行，不连真宿主）
//
// 覆盖 6 组 oracle 必改项：
//   ① 指纹去重（同 todos 连发 2 次只催 1 次）
//   ② 无 in_progress（全 completed / 投影缺失 null）→ 0 次
//   ③ 内容变化 → 第 2 次触发；再变 → 被 session 硬上限 2 截断
//   ④ 子会话（header.parentSession 非空）→ 0 次
//   ⑤ agent.steer 抛错 → 不抛出、不炸，且额度已扣（不会无限重试）
//   ⑥ kill switch：COHUB_TODO_GATE=0 → 0 次，恢复后仍可用
// 用法：node test/todo-gate.ts（node >= 24 类型剥离）
import assert from "node:assert";
import {
  GATE_TEXT,
  createTodoGateHandler,
  fingerprintOf,
  pickInProgress,
  registerTodoGate,
  shouldSteer,
} from "../src/todo-gate.ts";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log("  " + name + ": PASS");
    pass++;
  } catch (err) {
    console.log("  " + name + ": FAIL — " + (err instanceof Error ? err.message : String(err)));
    fail++;
  }
}

/** 同会话注入上限硬编码值（src/todo-gate.ts MAX_PER_SESSION 未导出，这里按契约钉住） */
const MAX_PER_SESSION = 2;

/** todo 项构造：只关心 content / status 两个字段 */
function todo(content: string, status = "in_progress") {
  return { content, status };
}

/**
 * 假 ctx：只提供 on("agent/turn-stopping") + sessionProjections.snapshot，
 * 不连真宿主（参照 test/review-collector.ts:26-41 的假 ctx 模式）。
 */
function makeCtx(initialTodos: any) {
  const listeners = new Set<(...a: any[]) => void>();
  const state: { todos: any } = { todos: initialTodos };
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    sessionProjections: {
      snapshot: (_session: any) => ({ asOfSeq: 1, values: { todo: { items: state.todos } } }),
    },
    on(type: string, h: (...a: any[]) => void) {
      if (type === "agent/turn-stopping") { listeners.add(h); return () => listeners.delete(h); }
      return () => {};
    },
    listenerCount: () => listeners.size,
    /** 驱动一次 turn-stopping（真实宿主是 serial + await，这里同步驱动即可） */
    emit(agent: any, turn = 1) {
      for (const h of [...listeners]) h({ agent, turn, signal: new AbortController().signal });
    },
    setTodos(next: any) { state.todos = next; },
    off: () => { listeners.clear(); },
  };
  return ctx;
}

/** 假 session：header.parentSession 缺省即主会话 */
function sessionOf(id: string, parentSession?: string) {
  const header: any = { id };
  if (parentSession !== undefined) header.parentSession = parentSession;
  return { id, header };
}

/** 假 agent：记录 steer 入参；throwOnSteer 时故意抛错，模拟宿主拒绝 */
function makeAgent(session: any, opts: { throwOnSteer?: boolean } = {}) {
  const steers: any[] = [];
  const agent: any = {
    session,
    steer(message: any) {
      if (opts.throwOnSteer) throw new Error("宿主拒绝：turn 已终结（测试桩故意抛出）");
      steers.push(message);
    },
  };
  return { agent, steers };
}

/** 从 createUserMessage 产出的消息里取纯文本 */
function textOf(msg: any): string {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  return parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
}

// ---- 用例 0：纯函数契约（shouldSteer / pickInProgress 守卫） ----
{
  console.log("===== 用例 0：纯函数契约 =====");
  check("pickInProgress 挑出 in_progress 的 content", () => {
    const got = pickInProgress([todo("A"), todo("B", "completed"), todo("C")]);
    assert.deepEqual(got, ["A", "C"]);
  });
  check("pickInProgress 对非数组 / 怪形状返回 []（不抛）", () => {
    assert.deepEqual(pickInProgress(null), []);
    assert.deepEqual(pickInProgress(undefined), []);
    assert.deepEqual(pickInProgress("in_progress"), []);
    assert.deepEqual(pickInProgress([null, 1, "x", { status: "in_progress" }]), [""], "缺 content 退化为空串而不是抛错");
  });
  check("fingerprintOf 与顺序无关", () => {
    assert.equal(fingerprintOf(["A", "B"]), fingerprintOf(["B", "A"]));
  });
  check("shouldSteer：首次有 in_progress → steer 且 count 预扣为 1", () => {
    const d = shouldSteer([todo("A")], undefined);
    assert.equal(d.steer, true);
    assert.equal(d.count, 1, "必须在调用前把额度扣掉（避免 steer 抛错后无限重试）");
  });
  check("shouldSteer：同指纹 → 不催", () => {
    const d = shouldSteer([todo("A")], { fingerprint: fingerprintOf(["A"]), count: 1 });
    assert.equal(d.steer, false);
    assert.equal(d.count, 1, "去重分支不得消耗额度");
  });
  check("shouldSteer：count 已达上限 → 即使指纹变了也不催", () => {
    const d = shouldSteer([todo("Z")], { fingerprint: "old", count: MAX_PER_SESSION });
    assert.equal(d.steer, false);
  });
}

// ---- 用例 1：同 todos 连续 emit 2 次 → 只 steer 1 次（指纹去重） ----
{
  console.log("===== 用例 1：指纹去重（同 todos 连发 2 次） =====");
  const ctx = makeCtx([todo("写代码"), todo("跑测试", "completed")]);
  const { agent, steers } = makeAgent(sessionOf("sess-gate-1"));
  registerTodoGate(ctx);
  ctx.emit(agent);
  ctx.emit(agent);
  check("emit 2 次只 steer 1 次", () => assert.equal(steers.length, 1, "同一 turn 内重复关闭事件不应重复催"));
  check("正文等于 GATE_TEXT", () => assert.equal(textOf(steers[0]), GATE_TEXT));
  check("source kind 为 cohub-todo-gate（不与 todo-nudge 冲突）", () =>
    assert.equal(steers[0]?.source?.kind, "cohub-todo-gate"));
  check("消息角色为 user", () => assert.equal(steers[0]?.role, "user"));
  check("文案给出三个出口", () => {
    const text = textOf(steers[0]);
    assert.ok(text.includes("completed"), "必须告诉模型可标 completed");
    assert.ok(text.includes("in_progress"), "必须告诉模型可保留 in_progress 继续做");
    assert.ok(text.includes("pending"), "必须告诉模型可降级 pending 写明在等什么");
  });
}

// ---- 用例 2：全 completed / 投影缺失 → 0 次 ----
{
  console.log("===== 用例 2：无 in_progress → 0 次 =====");
  const done = makeCtx([todo("A", "completed"), todo("B", "completed")]);
  const a1 = makeAgent(sessionOf("sess-gate-2a"));
  registerTodoGate(done);
  done.emit(a1.agent);
  check("全部 completed → 0 次", () => assert.equal(a1.steers.length, 0));

  const nul = makeCtx(null);
  const a2 = makeAgent(sessionOf("sess-gate-2b"));
  registerTodoGate(nul);
  nul.emit(a2.agent);
  check("投影缺失（null）→ 0 次且不抛", () => assert.equal(a2.steers.length, 0));
}

// ---- 用例 3：内容变化触发第 2 次；再变被 session 上限截断（总 2 次） ----
{
  console.log("===== 用例 3：内容变化计数 + 每 session 上限 2 =====");
  const ctx = makeCtx([todo("第一步")]);
  const { agent, steers } = makeAgent(sessionOf("sess-gate-3"));
  registerTodoGate(ctx);
  ctx.emit(agent);
  check("第 1 次：新 in_progress → steer 1", () => assert.equal(steers.length, 1, "首次应触发"));
  ctx.setTodos([todo("第二步")]);
  ctx.emit(agent);
  check("第 2 次：内容变化 → steer 2", () => assert.equal(steers.length, 2, "指纹变化应重新触发"));
  ctx.setTodos([todo("第三步")]);
  ctx.emit(agent);
  check("第 3 次：内容再变 → 被上限截断（仍为 2）", () =>
    assert.equal(steers.length, MAX_PER_SESSION, "每 session 硬上限 2 次"));
  ctx.setTodos([todo("第四步")]);
  ctx.emit(agent);
  check("第 4 次仍不涨（上限是硬的）", () => assert.equal(steers.length, MAX_PER_SESSION));
}

// ---- 用例 4：子会话隔离 ----
{
  console.log("===== 用例 4：子会话 → 0 次 =====");
  const ctx = makeCtx([todo("子代理自己的活")]);
  const { agent, steers } = makeAgent(sessionOf("child-1", "parent-1"));
  registerTodoGate(ctx);
  ctx.emit(agent);
  check("parentSession 非空 → 不催", () =>
    assert.equal(steers.length, 0, "子代理 turn 关闭被催会在 delegate 场景爆炸"));
  check("子会话不消耗额度（主会话仍可催 1 次）", () => {
    const main = makeAgent(sessionOf("sess-gate-4-main"));
    ctx.emit(main.agent);
    assert.equal(main.steers.length, 1, "子会话分支必须在读投影/扣额度之前返回");
  });
}

// ---- 用例 5：agent.steer 抛错 → 不抛出，额度已扣 ----
{
  console.log("===== 用例 5：steer 抛错 fail-soft =====");
  const ctx = makeCtx([todo("会抛错的会话")]);
  const { agent, steers } = makeAgent(sessionOf("sess-gate-5"), { throwOnSteer: true });
  registerTodoGate(ctx);
  check("steer 抛错时 handler 不抛", () =>
    assert.doesNotThrow(() => ctx.emit(agent), "闸门异常绝不能穿透到 turn 关闭流程"));
  check("连续抛错也不抛（状态未损坏）", () => {
    assert.doesNotThrow(() => ctx.emit(agent));
    assert.equal(steers.length, 0);
  });
  check("抛错后额度已扣（同指纹不再重试）", () => {
    // 换内容以绕过指纹；若前面已扣 2 次额度，这次仍不该催
    ctx.setTodos([todo("换个内容")]);
    assert.doesNotThrow(() => ctx.emit(agent));
    assert.equal(steers.length, 0);
  });
}

// ---- 用例 6：kill switch COHUB_TODO_GATE=0 ----
{
  console.log("===== 用例 6：kill switch =====");
  const ctx = makeCtx([todo("开关测试")]);
  const { agent, steers } = makeAgent(sessionOf("sess-gate-6"));
  registerTodoGate(ctx);
  const before = process.env.COHUB_TODO_GATE;
  try {
    process.env.COHUB_TODO_GATE = "0";
    ctx.emit(agent);
    check("COHUB_TODO_GATE=0 → 0 次", () => assert.equal(steers.length, 0, "kill switch 必须整体禁用闸门"));
    check("禁用期间不消耗额度", () => {
      process.env.COHUB_TODO_GATE = "1";
      ctx.emit(agent);
      assert.equal(steers.length, 1, "开关恢复后首次触发应立即生效");
    });
  } finally {
    if (before === undefined) delete process.env.COHUB_TODO_GATE;
    else process.env.COHUB_TODO_GATE = before;
  }
}

// ---- 用例 7：卸载可撤销 + handler 直驱等价 ----
{
  console.log("===== 用例 7：effect 撤销 + handler 直驱 =====");
  const ctx = makeCtx([todo("撤销测试")]);
  const { agent, steers } = makeAgent(sessionOf("sess-gate-7"));
  const off = registerTodoGate(ctx);
  check("注册后监听存在", () => assert.equal(ctx.listenerCount(), 1));
  off();
  check("off() 后监听被摘掉", () => assert.equal(ctx.listenerCount(), 0));
  ctx.emit(agent);
  check("摘监听后不再 steer", () => assert.equal(steers.length, 0));
  check("重复调用 off() 不抛", () => assert.doesNotThrow(() => off()));
  check("createTodoGateHandler 可单独直驱（handler 只做读投影→判定→steer）", () => {
    const handler = createTodoGateHandler(ctx);
    const solo = makeAgent(sessionOf("sess-gate-7solo"));
    handler({ agent: solo.agent, turn: 1, signal: new AbortController().signal });
    assert.equal(solo.steers.length, 1);
    assert.equal(textOf(solo.steers[0]), GATE_TEXT);
  });
  check("payload 畸形（无 agent / session 为 null）时不抛", () => {
    const handler = createTodoGateHandler(ctx);
    assert.doesNotThrow(() => handler(undefined));
    assert.doesNotThrow(() => handler({ agent: null }));
    assert.doesNotThrow(() => handler({ agent: { session: null, steer: () => {} } }));
  });
}

console.log("\n总计：" + (pass + fail) + " 条断言，PASS " + pass + "，FAIL " + fail);
process.exit(fail ? 1 : 0);
