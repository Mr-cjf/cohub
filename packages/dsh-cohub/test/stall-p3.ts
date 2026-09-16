// dsh-port/test/stall-p3.ts —— P3-1（N2 停滞检测器）单测
// 覆盖：默认关闭不介入、S1 连续同类错误（含 start 前事件缓冲）、健康任务 0 误杀、
//       宽限窗口（最近成功不触发）、maxRetries 预算不被停滞重试突破、S3/S4/S2 信号、
//       recoverable=false、无事件源降级。
// 用法：bun run test/stall-p3.ts（或 node test/stall-p3.ts，node >= 24 类型剥离）
import { createDelegateTool } from "../src/delegate.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn: () => boolean, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitUntil timeout");
    await sleep(2);
  }
}

function makeExec() {
  return { agent: { id: "parent-1" }, signal: new AbortController().signal };
}

/** fake ctx：subagents.start / llm.listProviders / logger / session/event 总线（on/off/_emit） */
function makeStallCtx(startImpl: (req: any, ctx: any) => any) {
  const listeners = new Set<(...a: any[]) => void>();
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start(_t: string, req: any) { return startImpl(req, ctx); },
    },
    on(type: string, h: (...a: any[]) => void) {
      if (type === "session/event") { listeners.add(h); return () => listeners.delete(h); }
      return () => {};
    },
    listenerCount: () => listeners.size,
    _emit(sessionId: string, event: any) {
      const session = { id: sessionId };
      for (const h of [...listeners]) h(session, event);
    },
  };
  return ctx;
}

/** 可中止的 fake run：ac.abort → 以 aborted settle（保留部分输出）；超时兜底 completed，防挂死 */
function abortableRun(runId: string, signal: AbortSignal, partialText = "partial", doneText = "done", doneMs = 800) {
  return {
    id: runId,
    result: new Promise((r) => {
      const timer = setTimeout(() => r({ output: [{ type: "text", text: doneText }], stopReason: "completed" }), doneMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        r({ output: [{ type: "text", text: partialText }], stopReason: "aborted" });
      }, { once: true });
    }),
    dispose() {},
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

// ---- 用例 1：默认关闭（enabled=false）→ 不注册监听、不 abort，行为同 P1 ----
{
  console.log("===== 用例 1：默认关闭 → 不介入（同 P1） =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async () => {
    spawnCount++;
    return { id: "r", result: Promise.resolve({ output: [{ type: "text", text: "partial work" }], stopReason: "aborted" }), dispose() {} };
  });
  const tool = createDelegateTool(ctx, () => [], {}); // 无任何 stall 配置
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("disabled: spawn=1（单次尝试）", spawnCount === 1);
  check("disabled: 抛错", !!err);
  check("disabled: cause.stopReason=aborted", err?.cause?.stopReason === "aborted");
  check("disabled: cause.retries=0", err?.cause?.retries === 0);
  check("disabled: cause 无 stall 字段", err?.cause?.stall === undefined);
  check("disabled: 未注册 session/event 监听", ctx.listenerCount() === 0);
}

// ---- 用例 2：S1 连续 3 次同类错误（含 start 返回前事件缓冲）→ 停滞中止 + 重试 prompt 含停滞诊断 ----
{
  console.log("===== 用例 2：S1 连续同类错误 → 提前中止 + 续跑重试 =====");
  let spawnCount = 0;
  const prompts: string[] = [];
  const ctx = makeStallCtx(async (req, c) => {
    spawnCount++;
    prompts.push(req.prompt[0].text);
    const runId = "child-" + spawnCount;
    if (spawnCount === 1) {
      // 在 start 返回前发出 S1 事件：验证「spawn 前注册监听 + 按 run.id 缓冲」路径
      for (let i = 0; i < 3; i++) {
        c._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
        c._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: boom" }] } } });
      }
    }
    return spawnCount > 1
      ? { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} }
      : abortableRun(runId, req.signal, "partial-1", "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, consecutiveErrors: 3, checkIntervalMs: 50 } } });
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("S1: spawn=2（1 初始 + 1 重试）", spawnCount === 2);
  check("S1: 最终完成", out === "OK");
  check("S1: 重试 prompt 含 [重试 #1]", prompts[1]?.includes("[重试 #1]"));
  check("S1: 重试 prompt 含停滞诊断", prompts[1]?.includes("停滞诊断"));
  check("S1: 重试 prompt 含 S1 信号", prompts[1]?.includes("S1"));
}

// ---- 用例 3：健康长任务（间歇成功）→ 0 误杀 ----
{
  console.log("===== 用例 3：健康长任务 → 0 误杀 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    return abortableRun("child-1", req.signal, "partial", "OK", 150);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 0, stall: { enabled: true, consecutiveErrors: 3, checkIntervalMs: 20 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  for (let round = 0; round < 4; round++) {
    ctx._emit("child-1", { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: round, text: "思考中" } } });
    ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "step" + round } });
    ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
    await sleep(8);
  }
  const out = await p;
  check("健康: spawn=1（无误杀）", spawnCount === 1);
  check("健康: 正常完成", out === "OK");
}

// ---- 用例 4：宽限窗口——最近 30s 内成功过 → 不触发 ----
{
  console.log("===== 用例 4：最近成功过 → 宽限不触发 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    return abortableRun("child-1", req.signal, "partial", "OK", 150);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 0, stall: { enabled: true, consecutiveErrors: 3, checkIntervalMs: 20 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  // 先成功一次（刷新宽限窗口），随后连续 3 次同类错误（S1 已满足但被宽限挡住）
  ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "a" } });
  ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
  for (let i = 0; i < 3; i++) {
    ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "b" } });
    ctx._emit("child-1", { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: boom" }] } } });
  }
  const out = await p;
  check("宽限: 不触发（spawn=1）", spawnCount === 1);
  check("宽限: 正常完成", out === "OK");
}

// ---- 用例 5：maxRetries 预算不被停滞重试突破（maxRetries=2 → 停滞重试 ≤2，spawn ≤3） ----
{
  console.log("===== 用例 5：停滞重试计入 maxRetries 预算 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    return abortableRun("child-" + spawnCount, req.signal, "partial-" + spawnCount, "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 2, retryDelayMs: 1, stall: { enabled: true, consecutiveErrors: 3, checkIntervalMs: 50 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
    await waitUntil(() => spawnCount >= attemptNo);
    await sleep(5);
    for (let i = 0; i < 3; i++) {
      ctx._emit("child-" + attemptNo, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
      ctx._emit("child-" + attemptNo, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: boom" }] } } });
    }
  }
  let err: any = null;
  try { await p; } catch (e) { err = e; }
  check("预算: spawn=3（≤ maxRetries+1）", spawnCount === 3);
  check("预算: 抛错", !!err);
  check("预算: cause.retries=2", err?.cause?.retries === 2);
  check("预算: cause.stall.signals 含 S1", !!err?.cause?.stall && err.cause.stall.signals.some((s: string) => s.startsWith("S1")));
}

// ---- 用例 6：S3 纯推理无动作（连续推理块且 0 次工具调用） ----
{
  console.log("===== 用例 6：S3 纯推理无动作 =====");
  let spawnCount = 0;
  const prompts: string[] = [];
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    prompts.push(req.prompt[0].text);
    const runId = "child-" + spawnCount;
    return spawnCount > 1
      ? { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} }
      : abortableRun(runId, req.signal, "partial-1", "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, reasoningWithoutAction: 3, checkIntervalMs: 50 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  for (let i = 0; i < 3; i++) {
    ctx._emit("child-1", { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: i, text: "思考" } } });
  }
  const out = await p;
  check("S3: spawn=2", spawnCount === 2);
  check("S3: 完成", out === "OK");
  check("S3: 重试 prompt 含 S3", prompts[1]?.includes("S3"));
}

// ---- 用例 7：S4 重复调用循环（同工具+同参数且结果错误） ----
{
  console.log("===== 用例 7：S4 重复调用循环 =====");
  let spawnCount = 0;
  const prompts: string[] = [];
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    prompts.push(req.prompt[0].text);
    const runId = "child-" + spawnCount;
    return spawnCount > 1
      ? { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} }
      : abortableRun(runId, req.signal, "partial-1", "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, loopCount: 3, checkIntervalMs: 50 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  for (let i = 0; i < 3; i++) {
    ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "ls" } });
    ctx._emit("child-1", { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: x" }] } } });
  }
  const out = await p;
  check("S4: spawn=2", spawnCount === 2);
  check("S4: 完成", out === "OK");
  check("S4: 重试 prompt 含 S4", prompts[1]?.includes("S4"));
}

// ---- 用例 8：S2 无结果空转（超 idleMs 且仍在产出推理） ----
{
  console.log("===== 用例 8：S2 无结果空转 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    const runId = "child-" + spawnCount;
    return spawnCount > 1
      ? { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} }
      : abortableRun(runId, req.signal, "partial-1", "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, idleMs: 100, graceMs: 0, checkIntervalMs: 40 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "a" } });
  ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
  await sleep(150); // 超过 idleMs 仍无工具结果
  ctx._emit("child-1", { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: 0, text: "还在想" } } });
  const out = await p;
  check("S2: spawn=2", spawnCount === 2);
  check("S2: 完成", out === "OK");
}

// ---- 用例 9：recoverable=false → 停滞中止不重试，直接抛错带 cause.stall ----
{
  console.log("===== 用例 9：recoverable=false → 不重试 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    return abortableRun("child-1", req.signal, "partial-1", "unused", 800);
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 3, retryDelayMs: 1, stall: { enabled: true, consecutiveErrors: 3, recoverable: false, checkIntervalMs: 50 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  for (let i = 0; i < 3; i++) {
    ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "x" } });
    ctx._emit("child-1", { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: boom" }] } } });
  }
  let err: any = null;
  try { await p; } catch (e) { err = e; }
  check("recoverable=false: spawn=1（即使 maxRetries=3 也不重试）", spawnCount === 1);
  check("recoverable=false: cause.stall 存在", !!err?.cause?.stall && Array.isArray(err.cause.stall.signals));
}

// ---- 用例 10：无事件源（ctx.on 缺失）→ 三态降级，正常完成 ----
{
  console.log("===== 用例 10：无事件源降级 =====");
  let spawnCount = 0;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start() {
        spawnCount++;
        return { id: "child-1", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
      },
    },
    // 故意没有 on（无 session/event 事件源）
  };
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { stall: { enabled: true } } });
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("降级: 无事件源仍正常完成", out === "OK");
  check("降级: spawn=1", spawnCount === 1);
}

// ---- 用例 11：T3 prePublicationAbort（start 抛错且 ac 已中止）→ 归一为 aborted ----
{
  console.log("===== 用例 11：T3 prePublicationAbort 归一 aborted =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    if (req.signal.aborted) throw Object.assign(new Error("subagent activation aborted"), { code: "CANCELLED" });
    return { id: "child-1", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  });
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { stall: { enabled: true, checkIntervalMs: 50 } } });
  const preAborted = new AbortController(); preAborted.abort();
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, { agent: { id: "parent-1" }, signal: preAborted.signal }); } catch (e) { err = e; }
  check("T3a: start 抛错被归一为 aborted", err?.cause?.stopReason === "aborted");
  check("T3a: spawn 被调用一次（随即预中止抛错）", spawnCount === 1);
}

// ---- 用例 12：T3 父中止转发（exec.signal abort → ac abort → 子代理 aborted，保留部分输出） ----
{
  console.log("===== 用例 12：T3 父中止转发 =====");
  let spawnCount = 0;
  const ctx = makeStallCtx(async (req) => {
    spawnCount++;
    return abortableRun("child-1", req.signal, "partial-1", "unused", 800);
  });
  const execCtl = new AbortController();
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { stall: { enabled: true, checkIntervalMs: 50 } } });
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, { agent: { id: "parent-1" }, signal: execCtl.signal });
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  execCtl.abort(); // 父中止 → 转发内部 ac → run.result 以 aborted settle
  let err: any = null;
  try { await p; } catch (e) { err = e; }
  check("T3b: 父中止 → cause.stopReason=aborted", err?.cause?.stopReason === "aborted");
  check("T3b: 保留部分输出", typeof err?.cause?.partial === "string" && err.cause.partial.includes("partial-1"));
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
