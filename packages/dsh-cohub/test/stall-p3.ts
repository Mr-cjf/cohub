// dsh-port/test/stall-p3.ts —— P3-1（N2 停滞检测器）单测
// 覆盖：默认关闭不介入、S1 连续同类错误（含 start 前事件缓冲）、健康任务 0 误杀、
//       宽限窗口（最近成功不触发）、maxRetries 预算不被停滞重试突破、S3/S4/S2 信号、
//       recoverable=false、无事件源降级；
//       追加（用例 13-16）：S2/S3 降级为「只告警不杀」+ advisoryMaxMs 上限升级 + advisorySignals 开关回退。
// 用法：bun run test/stall-p3.ts（或 node test/stall-p3.ts，node >= 24 类型剥离）
import { createDelegateTool, normalizeAdvisorySignals, StallWatchdog } from "../src/delegate.ts";
import { makeToolRunContext, makeSessionHeader } from "./types/test-stubs.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn: () => boolean, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitUntil timeout");
    await sleep(2);
  }
}

function makeExec() {
  // delegationDepth: 0 = 主代理（depth guard fail-closed 后，桩必须显式声明身份）
  return makeToolRunContext({
    agent: { id: "parent-1", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
    signal: new AbortController().signal,
  });
}

/** fake ctx：subagents（0.2.1 startActivation 形态，与宿主真实运行时一致，无 start）
 * / llm.listProviders / logger / session/event 总线（on/off/_emit） */
function makeStallCtx(startImpl: (req: any, ctx: any) => any) {
  const listeners = new Set<(...a: any[]) => void>();
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      // 0.2.1 契约：startActivation(spec) → { childId, result, dispose }。
      // 故意不提供 start，确保任何残留 ctx.subagents.start(...) 都会像生产环境一样抛错。
      async startActivation(spec: any) {
        // 入参形状双版兼容：0.2.2-rc.3 顶层 parent/prompt（宿主锚点 dsh-subagent/lib/index.js:3019-3025），
        // rc.1 只读 spec.request.*；顶层优先、request 兜底。
        // 防回归断言：真实宿主 rc.3 只读顶层，顶层缺 parent/prompt 必崩在 spawn 前
        if (!spec?.parent || !spec?.prompt) {
          throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
        }
        const req = spec?.request ?? spec;
        const prompt: any[] = Array.isArray(spec?.prompt) ? spec.prompt : Array.isArray(req?.prompt) ? req.prompt : [];
        const headIsPersona = prompt.length > 1 && prompt[0]?.type === "text" && String(prompt[0]?.text ?? "").includes("你是被委派的专职代理");
        const agentOptions = spec?.agentOptions ?? req?.agentOptions;
        const run = await startImpl({
          label: spec?.label,
          prompt: headIsPersona ? prompt.slice(1) : prompt,
          parent: spec?.parent ?? req?.parent,
          ...(agentOptions !== undefined ? { agentOptions } : {}),
          signal: spec?.signal,
          delivery: spec?.delivery,
          provider: spec?.provider,
        }, ctx);
        return {
          childId: run?.id ?? "child-1",
          messageId: "msg-1",
          result: run?.result ?? Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() { run?.dispose?.(); },
        };
      },
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
  // advisorySignals: [] = 退回「S2/S3 也直接中止」的旧行为（默认 ["S2","S3"] 只告警不中止，
  // 该新路径由本文件用例 13-16 覆盖；本用例只验证信号能走到中止 + 重试诊断）
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, reasoningWithoutAction: 3, advisorySignals: [], checkIntervalMs: 50 } } });
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
  // advisorySignals: [] = 保留 S2 的旧杀戮权（默认下 S2 只告警，需走 advisoryMaxMs 升级才中止）
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, idleMs: 100, graceMs: 0, advisorySignals: [], checkIntervalMs: 40 } } });
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
      async startActivation(spec: any) {
        spawnCount++;
        return {
          childId: "child-1",
          result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }),
          async dispose() {},
        };
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
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeToolRunContext({ agent: { id: "parent-1", session: { header: makeSessionHeader({ delegationDepth: 0 }) } }, signal: preAborted.signal })); } catch (e) { err = e; }
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
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeToolRunContext({ agent: { id: "parent-1", session: { header: makeSessionHeader({ delegationDepth: 0 }) } }, signal: execCtl.signal }));
  await waitUntil(() => spawnCount >= 1);
  await sleep(5);
  execCtl.abort(); // 父中止 → 转发内部 ac → run.result 以 aborted settle
  let err: any = null;
  try { await p; } catch (e) { err = e; }
  check("T3b: 父中止 → cause.stopReason=aborted", err?.cause?.stopReason === "aborted");
  check("T3b: 保留部分输出", typeof err?.cause?.partial === "string" && err.cause.partial.includes("partial-1"));
}

// ================= 追加：S2/S3「只告警不杀」+ advisory 上限升级 =================
// 语义：S1/S4 恒致命（立即中止）；S2/S3 默认降级为 advisory（只发一次 warning、继续评估），
//       持续满足超过 advisoryMaxMs（缺省 idleMs × 2）才升级为中止；advisorySignals:[] 退回旧行为。
const ADVISORY_TAG = "[cohub stall advisory]";

/** fake ctx：只捕获 advisory 通道的 logger.warn（其它 warn 不计入，避免顺序耦合） */
function makeAdvisoryCtx(adv: string[]) {
  const listeners = new Set<(...a: any[]) => void>();
  const ctx: any = {
    logger: {
      info: () => {},
      warn: (...a: any[]) => {
        const line = a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
        if (line.includes(ADVISORY_TAG)) adv.push(line);
      },
    },
    llm: { listProviders: () => [] },
    subagents: {
      async startActivation(spec: any) {
        if (!spec?.parent || !spec?.prompt) throw new Error("startActivation spec 必须双写顶层 parent/prompt");
        const req = spec?.request ?? spec;
        return {
          childId: "child-1",
          result: (req?.__result ?? Promise.resolve({ output: [], stopReason: "completed" })),
          async dispose() {},
        };
      },
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

/** 搭台：spawn 时记录子代理 signal（断言 abort 与否），run 可中止（5s 兜底防挂死） */
function makeAdvisoryHarness(adv: string[]) {
  const ctx = makeAdvisoryCtx(adv);
  const origStart = ctx.subagents.startActivation;
  const state = { spawnCount: 0, seenSignal: null as AbortSignal | null };
  ctx.subagents.startActivation = async (spec: any) => {
    state.spawnCount++;
    state.seenSignal = spec?.signal;
    const run = abortableRun("child-" + state.spawnCount, spec.signal, "partial-1", "unused", 5000);
    return await origStart({ ...spec, request: { ...(spec.request ?? spec), __result: run.result } });
  };
  return { ctx, state };
}

/** 跑一次 delegate 并等待 settle（errBox.err 收错误） */
function runAdvisoryDelegate(tool: any) {
  const errBox: { err: any } = { err: undefined };
  const p = tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec())
    .then(() => { errBox.err = null; }, (e) => { errBox.err = e; });
  return { p, errBox };
}

// ---- 用例 13：归一与 advisoryMaxMs 默认推导（同步，零时序） ----
{
  console.log("===== 用例 13：advisorySignals 归一 / advisoryMaxMs 默认推导 =====");
  check("缺省 → [S2,S3]", JSON.stringify(normalizeAdvisorySignals(undefined)) === '["S2","S3"]');
  check("小写+空白归一，非法值忽略", JSON.stringify(normalizeAdvisorySignals([" s3 ", "S2", "S9"])) === '["S3","S2"]');
  check("显式空数组 → []（全部保留杀戮权）", normalizeAdvisorySignals([]).length === 0);
  check("非数组 → []", normalizeAdvisorySignals("S2").length === 0);
  const wd: any = new StallWatchdog({ enabled: true, idleMs: 700 }, () => {}, () => {});
  check("advisoryMaxMs 缺省 = idleMs × 2", wd.cfg.advisoryMaxMs === 1400);
  const wd0: any = new StallWatchdog({ enabled: true, idleMs: 700, advisoryMaxMs: 0 }, () => {}, () => {});
  check("advisoryMaxMs=0 被保留（不回落默认）", wd0.cfg.advisoryMaxMs === 0);
  check("advisorySignals 只认 S2/S3（S1/S4 写进来无效）", normalizeAdvisorySignals(["S1", "S4"]).length === 0);
}

// ---- 用例 14：S2 告警不中止 → 只发一次 warning → 超 advisoryMaxMs 才升级中止 ----
{
  console.log("===== 用例 14：S2 只告警不杀 + 上限升级 =====");
  const adv: string[] = [];
  const { ctx, state } = makeAdvisoryHarness(adv);
  const tool = createDelegateTool(ctx, () => [], {
    delegateRetry: { maxRetries: 0, stall: { enabled: true, idleMs: 60, graceMs: 0, advisoryMaxMs: 240, checkIntervalMs: 50 } },
  });
  const { p, errBox } = runAdvisoryDelegate(tool);
  await waitUntil(() => state.spawnCount >= 1 && state.seenSignal !== null);
  await sleep(5);
  // 先给出一次成功工具结果（刷新 lastActivityAt / lastSuccessAt）
  ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "a" } });
  ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
  await waitUntil(() => adv.length > 0, 2000);
  const w0 = adv[0] ?? "";
  check("S2: 发出 advisory warning（走 logger.warn）", adv.length >= 1);
  check("S2: 告警含档位 S2", w0.includes("S2"));
  check("S2: 告警标注未中止 + 升级上限", w0.includes("advisory") && w0.includes("升级为中止"));
  check("S2: 告警后仍未 abort", state.seenSignal!.aborted === false);
  // 在 advisoryMaxMs（240ms）之前不应升级，且不刷屏
  await sleep(120);
  check("S2: 上限内未 abort", state.seenSignal!.aborted === false);
  check("S2: 告警只发一次（不刷屏）", adv.length === 1);
  await waitUntil(() => state.seenSignal!.aborted, 2000);
  await p;
  check("S2: 超上限后 abort", state.seenSignal!.aborted === true);
  check("S2: 中止归一为 aborted", errBox.err?.cause?.stopReason === "aborted");
  check("S2: cause.stall.escalated=true", errBox.err?.cause?.stall?.escalated === true);
  check("S2: cause.stall.signals 含 S2", (errBox.err?.cause?.stall?.signals ?? []).some((s: string) => s.startsWith("S2")));
  check("S2: 全程只告警一次", adv.length === 1);
}

// ---- 用例 15：S3 告警不中止 + 上限升级 ----
{
  console.log("===== 用例 15：S3 只告警不杀 + 上限升级 =====");
  const adv: string[] = [];
  const { ctx, state } = makeAdvisoryHarness(adv);
  const tool = createDelegateTool(ctx, () => [], {
    delegateRetry: { maxRetries: 0, stall: { enabled: true, reasoningWithoutAction: 2, graceMs: 0, advisoryMaxMs: 240, checkIntervalMs: 50 } },
  });
  const { p, errBox } = runAdvisoryDelegate(tool);
  await waitUntil(() => state.spawnCount >= 1 && state.seenSignal !== null);
  await sleep(5);
  ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "a" } });
  ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
  ctx._emit("child-1", { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: 0, text: "想" } } });
  ctx._emit("child-1", { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: 1, text: "再想" } } });
  await waitUntil(() => adv.length > 0, 2000);
  const w0 = adv[0] ?? "";
  check("S3: 发出 advisory warning", adv.length >= 1);
  check("S3: 告警含档位 S3", w0.includes("S3"));
  check("S3: 告警后仍未 abort", state.seenSignal!.aborted === false);
  await sleep(120);
  check("S3: 上限内未 abort", state.seenSignal!.aborted === false);
  check("S3: 告警只发一次", adv.length === 1);
  await waitUntil(() => state.seenSignal!.aborted, 2000);
  await p;
  check("S3: 超上限后 abort", state.seenSignal!.aborted === true);
  check("S3: cause.stall.escalated=true", errBox.err?.cause?.stall?.escalated === true);
  check("S3: cause.stall.signals 含 S3", (errBox.err?.cause?.stall?.signals ?? []).some((s: string) => s.startsWith("S3")));
}

// ---- 用例 16：advisorySignals: [] → S2 退回直接中止（旧行为，无 advisory 告警） ----
{
  console.log("===== 用例 16：advisorySignals 为空 → S2 直接中止 =====");
  const adv: string[] = [];
  const { ctx, state } = makeAdvisoryHarness(adv);
  const tool = createDelegateTool(ctx, () => [], {
    delegateRetry: { maxRetries: 0, stall: { enabled: true, idleMs: 60, graceMs: 0, advisorySignals: [], checkIntervalMs: 50 } },
  });
  const { p, errBox } = runAdvisoryDelegate(tool);
  await waitUntil(() => state.spawnCount >= 1 && state.seenSignal !== null);
  await sleep(5);
  ctx._emit("child-1", { type: "tool/call", data: { name: "run_code", arguments: "a" } });
  ctx._emit("child-1", { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "ok" }] } } });
  await waitUntil(() => state.seenSignal!.aborted, 2000);
  await p;
  check("[]: S2 直接 abort", state.seenSignal!.aborted === true);
  check("[]: 无 advisory 告警", adv.length === 0);
  check("[]: cause.stall.signals 含 S2", (errBox.err?.cause?.stall?.signals ?? []).some((s: string) => s.startsWith("S2")));
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
