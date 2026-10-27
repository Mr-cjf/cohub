// test/review-report.ts —— buildReport 事件重放统计单测
// 覆盖：完整 turn（usage/工具/结束原因）、usage 缺失记 null、无 result 的 pending 进 gaps、
//       空 events 不崩、主+子两会话独立聚合、确定性（两次调用深相等）。
// 用法：node test/review-report.ts（node >= 24 类型剥离）
import assert from "node:assert";
import { buildReport, type SessionEvents } from "../src/review-report.ts";

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

const ev = (seq: number, time: number, type: string, data: any) => ({ seq, time, type, data });

function mainSession(over: Partial<SessionEvents> = {}): SessionEvents {
  return {
    sessionId: "s1",
    parentSessionId: null,
    cwd: "C:\\work\\demo",
    events: [
      ev(1, 1000, "turn/start", { turn: 1 }),
      ev(2, 1001, "assistant/message", {
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 2, cacheWriteTokens: null, reasoningTokens: null },
      }),
      ev(3, 1002, "tool/call", { callId: "c1", name: "read" }),
      ev(4, 1003, "tool/result", { callId: "c1", message: { isError: false } }),
      ev(5, 1004, "tool/call", { callId: "c2", name: "grep" }),
      ev(6, 1005, "tool/result", { callId: "c2", message: { isError: true } }),
      ev(7, 1006, "assistant/message", { usage: { inputTokens: 5, outputTokens: 1 } }),
      ev(8, 1007, "turn/end", { turn: 1, reason: "completed" }),
    ],
    ...over,
  };
}

// ---- 用例 1：完整 turn → tokens / 工具 / 结束原因 ----
{
  console.log("===== 用例 1：完整 turn → 统计正确 =====");
  const report = buildReport({ root: mainSession() });
  const turn = report.sessions[0].turns[0];
  check("turn 号取自 turn/end payload", () => assert.equal(turn.turn, 1));
  check("end.seq/time 取自信封", () => {
    assert.equal(turn.end.seq, 8);
    assert.equal(turn.end.time, 1007);
  });
  check("end.kind = completed", () => assert.equal(turn.end.kind, "completed"));
  check("usage 累加 input=15 / output=5 / total=14", () => {
    assert.ok(turn.usage);
    assert.equal(turn.usage!.inputTokens, 15);
    assert.equal(turn.usage!.outputTokens, 5);
    assert.equal(turn.usage!.totalTokens, 14);
    assert.equal(turn.usage!.cacheReadTokens, 2);
    assert.equal(turn.usage!.reasoningTokens, null);
  });
  check("usageEvidenceSeqs = [2,7]", () => assert.deepEqual(turn.usageEvidenceSeqs, [2, 7]));
  check("两个工具 success/error 配对", () => {
    assert.equal(turn.tools.length, 2);
    assert.deepEqual(turn.tools[0], {
      callId: "c1", name: "read", callSeq: 3, resultSeq: 4,
      startedAt: 1002, endedAt: 1003, status: "success",
    });
    assert.equal(turn.tools[1].callId, "c2");
    assert.equal(turn.tools[1].status, "error");
    assert.equal(turn.tools[1].resultSeq, 6);
  });
  check("project.cwd 来自 header，key 为 16 位 hex", () => {
    assert.equal(report.project.cwd, "C:\\work\\demo");
    assert.match(report.project.key, /^[0-9a-f]{16}$/);
  });
  check("attempts / findings 为空数组", () => {
    assert.deepEqual(report.attempts, []);
    assert.deepEqual(report.findings, []);
  });
  check("analysis 占位字段", () => {
    assert.equal(report.analysis.status, "completed");
    assert.equal(report.analysis.invocations, 0);
  });
}

// ---- 用例 2：usage 缺失 → null（不记 0） ----
{
  console.log("===== 用例 2：无 usage → null =====");
  const report = buildReport({
    root: {
      sessionId: "s1",
      parentSessionId: null,
      events: [
        ev(1, 1000, "turn/start", { turn: 1 }),
        ev(2, 1001, "tool/call", { callId: "c1", name: "read" }),
        ev(3, 1002, "tool/result", { callId: "c1" }),
        ev(4, 1003, "turn/end", { turn: 1, reason: { type: "aborted", at: 1 } }),
      ],
    },
  });
  const turn = report.sessions[0].turns[0];
  check("usage === null", () => assert.equal(turn.usage, null));
  check("usageEvidenceSeqs 为空", () => assert.deepEqual(turn.usageEvidenceSeqs, []));
  check("对象 reason 取 type → aborted", () => assert.equal(turn.end.kind, "aborted"));
}

// ---- 用例 3：tool/call 无 result → pending + 进 gaps ----
{
  console.log("===== 用例 3：pending 工具 → gaps =====");
  const report = buildReport({
    root: {
      sessionId: "s1",
      parentSessionId: null,
      events: [
        ev(1, 1000, "turn/start", { turn: 1 }),
        ev(2, 1001, "tool/call", { callId: "c1", name: "read" }),
        ev(3, 1002, "turn/end", { turn: 1, reason: "completed" }),
      ],
    },
  });
  const tool = report.sessions[0].turns[0].tools[0];
  check("status = pending", () => assert.equal(tool.status, "pending"));
  check("resultSeq = null / endedAt = null", () => {
    assert.equal(tool.resultSeq, null);
    assert.equal(tool.endedAt, null);
  });
  check("gaps 含 pending 描述", () =>
    assert.ok(report.coverage.gaps.includes("s1: tool/call c1 has no result"), JSON.stringify(report.coverage.gaps)));
  check("coverage.complete = false", () => assert.equal(report.coverage.complete, false));
}

// ---- 用例 4：空 events → complete=false + gap，不崩 ----
{
  console.log("===== 用例 4：空 events =====");
  const report = buildReport({
    root: { sessionId: "s1", parentSessionId: null, events: [] },
  });
  check("turns 为空数组", () => assert.deepEqual(report.sessions[0].turns, []));
  check("throughSeq = 0（无 seq 可覆盖）", () => assert.equal(report.coverage.throughSeq.s1, 0));
  check("coverage.complete = false", () => assert.equal(report.coverage.complete, false));
  check("gaps 非空且描述缺 turn/end", () => {
    assert.ok(report.coverage.gaps.length >= 1);
    assert.ok(report.coverage.gaps.some(g => g.includes("no turn/end")));
  });
  check("project.cwd 缺省为 null", () => assert.equal(report.project.cwd, null));
}

// ---- 用例 5：主 + 子两会话，各自 turns 独立 ----
{
  console.log("===== 用例 5：多会话聚合 =====");
  const report = buildReport({
    root: mainSession(),
    children: [{
      sessionId: "s2",
      parentSessionId: "s1",
      events: [
        ev(1, 2000, "turn/start", { turn: 1 }),
        ev(2, 2001, "assistant/message", { usage: { inputTokens: 7, outputTokens: 3 } }),
        ev(3, 2002, "turn/end", { turn: 1, reason: "completed" }),
      ],
    }],
  });
  check("sessions 长度 2", () => assert.equal(report.sessions.length, 2));
  check("根会话在前，子会话挂 parentSessionId=s1", () => {
    assert.equal(report.sessions[0].sessionId, "s1");
    assert.equal(report.sessions[0].parentSessionId, null);
    assert.equal(report.sessions[1].sessionId, "s2");
    assert.equal(report.sessions[1].parentSessionId, "s1");
  });
  check("各自 turns 独立（s1 usage=15，s2 usage=7）", () => {
    assert.equal(report.sessions[0].turns.length, 1);
    assert.equal(report.sessions[1].turns.length, 1);
    assert.equal(report.sessions[0].turns[0].usage!.inputTokens, 15);
    assert.equal(report.sessions[1].turns[0].usage!.inputTokens, 7);
    assert.equal(report.sessions[1].turns[0].tools.length, 0);
  });
  check("throughSeq 记录两会话", () => {
    assert.deepEqual(report.coverage.throughSeq, { s1: 8, s2: 3 });
  });
  check("两会话都完整 → complete=true", () => assert.equal(report.coverage.complete, true));
}

// ---- 用例 6：确定性（同一输入两次结果深相等） ----
{
  console.log("===== 用例 6：确定性 =====");
  const a = buildReport({ root: mainSession(), children: [{ sessionId: "s2", parentSessionId: "s1", events: [] }] });
  const b = buildReport({ root: mainSession(), children: [{ sessionId: "s2", parentSessionId: "s1", events: [] }] });
  check("两次输出 JSON 完全相等", () => assert.equal(JSON.stringify(a), JSON.stringify(b)));
  check("深相等（deepStrictEqual）", () => assert.deepEqual(a, b));
  check("不改写输入事件对象", () => {
    const input = mainSession();
    const snapshot = JSON.stringify(input);
    buildReport({ root: input });
    assert.equal(JSON.stringify(input), snapshot);
  });
}

// ---- 用例 7：真实宿主形状（callId 只在 message.toolCallId，isError 只在 message.isError） ----
// 回归 P1-2：顶层没有 callId 时也必须能配对；顶层没有 error/isError 时错误判定也要生效。
// 同时回归 P1-3（空 usage 不记证据）与 P1-4（部分 token 字段缺失 → totalTokens 为 null 不拼凑）。
{
  console.log("===== 用例 7：真实宿主形状 + 空 usage + 残缺 token =====");
  const report = buildReport({
    root: {
      sessionId: "s1",
      parentSessionId: null,
      events: [
        ev(1, 1000, "turn/start", { turn: 1, step: 1 }),
        // 只给 inputTokens：outputTokens/totalTokens 从未出现 → 必须为 null，不能凑成 5 或 0
        ev(2, 1001, "assistant/message", { turn: 1, step: 1, usage: { inputTokens: 5 } }),
        // 空 usage 对象：无任何有效数值字段 → 不得成为 usage 证据
        ev(3, 1002, "assistant/message", { turn: 1, step: 1, usage: {} }),
        ev(4, 1003, "tool/call", { turn: 1, step: 1, callId: "t1", name: "read", arguments: "{}" }),
        // 失败判定只在 message.isError，data 上没有 error 字段
        ev(5, 1004, "tool/result", { turn: 1, step: 1, message: { toolCallId: "t1", isError: true, content: "boom" } }),
        ev(6, 1005, "tool/call", { turn: 1, step: 1, callId: "t2", name: "grep", arguments: "{}" }),
        ev(7, 1006, "tool/result", { turn: 1, step: 1, message: { toolCallId: "t2", isError: false, content: "ok" } }),
        ev(8, 1007, "turn/end", { turn: 1, reason: "completed" }),
      ],
    },
  });
  const turn = report.sessions[0].turns[0];
  check("真实形状 result 能配对（不再全部 pending）", () => {
    assert.equal(turn.tools.length, 2);
    assert.equal(turn.tools[0].status, "error");
    assert.equal(turn.tools[1].status, "success");
  });
  check("message.toolCallId 配对 → resultSeq/endedAt 取自信封", () => {
    assert.deepEqual(turn.tools[0], {
      callId: "t1", name: "read", callSeq: 4, resultSeq: 5,
      startedAt: 1003, endedAt: 1004, status: "error",
    });
    assert.equal(turn.tools[1].resultSeq, 7);
    assert.equal(turn.tools[1].endedAt, 1006);
  });
  check("message.isError 判定生效（无 data.error）", () => assert.equal(turn.tools[0].status, "error"));
  check("真实形状无 pending → complete=true 且无 gaps", () => {
    assert.equal(report.coverage.complete, true);
    assert.deepEqual(report.coverage.gaps, []);
  });
  check("空 usage 对象不进 usageEvidenceSeqs（只有 seq 2）", () =>
    assert.deepEqual(turn.usageEvidenceSeqs, [2]));
  check("只有 inputTokens 时 outputTokens/totalTokens 为 null（不拼 0/不残缺相加）", () => {
    assert.ok(turn.usage);
    assert.equal(turn.usage!.inputTokens, 5);
    assert.equal(turn.usage!.outputTokens, null);
    assert.equal(turn.usage!.totalTokens, null);
  });
}

// ---- 用例 8：usage 全为空对象 → usage 为 null，证据为空 ----
{
  console.log("===== 用例 8：仅空 usage → null =====");
  const report = buildReport({
    root: {
      sessionId: "s1",
      parentSessionId: null,
      events: [
        ev(1, 1000, "assistant/message", { turn: 1, usage: {} }),
        ev(2, 1001, "turn/end", { turn: 1, reason: "completed" }),
      ],
    },
  });
  const turn = report.sessions[0].turns[0];
  check("usage === null", () => assert.equal(turn.usage, null));
  check("usageEvidenceSeqs === []（空 usage 不构成证据）", () => assert.deepEqual(turn.usageEvidenceSeqs, []));
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
