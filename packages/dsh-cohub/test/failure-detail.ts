// dsh-cohub/test/failure-detail.ts —— 「真实错误透传」门禁（describeFailureDetail + 两条失败出口）
//
// 覆盖（对应 src/delegate.ts:999-1014 describeFailureDetail、:2440-2452 失败收口、
//       src/delegate_batch.ts:920-942 per-task 失败结果）：
//   ① 单元：对象剥壳（error → errorMessage → failure → message → cause）、Set 防环、
//      空白折叠单行化、>200 字符截断 + 末尾 `…`、空/无文本返回 undefined；
//   ② delegate 端到端：宿主把失败归一成 stopReason="error" 且不产出 diagnostic，
//      只在结算对象上残留 { error } 时 —— 抛出的 Error.message 必须含该原文，
//      cause.diagnostic 带 `subagent error: ` 来源前缀；
//   ③ delegate 端到端：>500 字且多换行的错误 → 单行化、≤200（含末尾 `…`）、不含换行；
//   ④ delegate_batch 端到端：per-task 的 `error` 字段带出同一原文（不再只有 stopReason）；
//   ⑤ 反向对照：无残留错误、无 diagnostic 时不伪造文本（旧行为逐字不变）。
//
// 定位：全部用 test/delegate-p1.ts / test/batch-events.ts 同一套 startActivation 桩驱动，
//       离线、不触网络、不触用户配置、不写盘。
// 用法：node test/failure-detail.ts（node >= 24 类型剥离）
import { createDelegateTool, describeFailureDetail } from "../src/delegate.ts";
import { createDelegateBatchTool } from "../src/delegate_batch.ts";
import { makeToolRunContext, makeSessionHeader } from "./types/test-stubs.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string) {
  console.log("===== " + title + " =====");
}

/** 宿主真实错误样本：并发限流（就是本轮被吞掉的那类文案） */
const RAW_ERROR = "Concurrency limit exceeded for user, please retry later";

/** 与 test/delegate-p1.ts makeCtx 同构的最小桩：只提供 delegate 真正读取的字段。
 *  startImpl 每被调用一次 = 一次 spawn；spec 顶层 parent/prompt 双写校验与真实宿主一致。 */
function makeDelegateCtx(startImpl: () => any) {
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      async startActivation(spec: any) {
        if (!spec?.parent || !spec?.prompt) {
          throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
        }
        const run = startImpl();
        return {
          childId: run?.id ?? "child-fd",
          messageId: "msg-fd",
          result: run?.result ?? Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() { run?.dispose?.(); },
        };
      },
    },
  };
  return ctx;
}

/** delegationDepth: 0 = 主代理（depth guard fail-closed 后桩必须显式声明身份） */
function makeExec() {
  return makeToolRunContext({
    agent: { id: "parent-fd", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
    signal: new AbortController().signal,
  });
}

/** 跑一次 delegate，返回抛出的 err（成功时抛断言错，避免用例静默通过） */
async function delegateError(outcome: any): Promise<any> {
  const tool = createDelegateTool(makeDelegateCtx(() => ({
    id: "fd-run",
    result: Promise.resolve(outcome),
    dispose() {},
  })), () => [], { delegateRetry: { maxRetries: 0 } });
  try {
    await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  } catch (e) {
    return e;
  }
  throw new Error("预期 delegate 抛错，但正常返回了");
}

// ── 用例 1：describeFailureDetail 单元口径 ──
{
  group("用例 1：describeFailureDetail 剥壳 / 单行化 / 截断");
  check("字符串直取", describeFailureDetail(RAW_ERROR) === RAW_ERROR);
  check("Error 实例取 message", describeFailureDetail(new Error(RAW_ERROR)) === RAW_ERROR);
  check("对象剥壳 error 字段", describeFailureDetail({ error: RAW_ERROR }) === RAW_ERROR);
  check("嵌套剥壳（error.message）", describeFailureDetail({ error: { message: RAW_ERROR } }) === RAW_ERROR);
  check("errorMessage 兜底", describeFailureDetail({ errorMessage: RAW_ERROR }) === RAW_ERROR);
  check("failure 兜底", describeFailureDetail({ failure: RAW_ERROR }) === RAW_ERROR);
  check("cause 兜底", describeFailureDetail({ cause: RAW_ERROR }) === RAW_ERROR);

  // 防环：自引用对象不能死循环
  const cyclic: any = {};
  cyclic.error = cyclic;
  check("自引用对象不死循环（返回 undefined）", describeFailureDetail(cyclic) === undefined);
  const two: any = {};
  const other: any = { error: two };
  two.error = other;
  check("互相引用不死循环（返回 undefined）", describeFailureDetail(two) === undefined);

  check("纯空白折叠后为空 → undefined", describeFailureDetail("   \n\t  ") === undefined);
  check("undefined 输入 → undefined", describeFailureDetail(undefined) === undefined);
  check("空对象 → undefined", describeFailureDetail({}) === undefined);

  // 多换行 + 连续空白：一律折成单个空格并去掉首尾
  const multiline = "第一行错误\n\n第二行  细节\t\t第三行";
  check("多换行/多空白折成单空格单行", describeFailureDetail(multiline) === "第一行错误 第二行 细节 第三行");

  // 200 字符边界
  check("恰好 200 字符不截断（无省略号）",
    describeFailureDetail("a".repeat(200)) === "a".repeat(200));
  const long = "b".repeat(201);
  const cut = describeFailureDetail(long);
  check("201 字符截断到 200 + `…`", cut === "b".repeat(200) + "…");
  check("截断结果长度 = 201（200 + 省略号）", String(cut).length === 201);
}

// ── 用例 2：delegate —— 结算对象残留 error → error.message 带原文 ──
{
  group("用例 2：delegate 失败携带 error 载荷 → message 含原文");
  const err = await delegateError({ output: [], stopReason: "error", error: RAW_ERROR });
  const msg = String(err?.message ?? "");
  check("抛错", !!err && err instanceof Error);
  check("Error.message 含原始错误全文", msg.includes(RAW_ERROR));
  check("cause.diagnostic 带来源前缀 subagent error: ",
    err?.cause?.diagnostic === "subagent error: " + RAW_ERROR);
  check("cause.stopReason 仍为纯 error（未被诊断污染）", err?.cause?.stopReason === "error");
  check("message 保留 diagnostic: 标签", msg.includes("; diagnostic: subagent error: " + RAW_ERROR));

  // 另一条真实来源：spawn / result 抛出的原始 err 必须原样上抛（不吞成「stopped with reason」）
  const tool = createDelegateTool(makeDelegateCtx(() => {
    throw new Error(RAW_ERROR);
  }), () => [], { delegateRetry: { maxRetries: 0 } });
  let thrown: any = null;
  try {
    await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  } catch (e) { thrown = e; }
  check("spawn 抛错时原错误原样上抛（message 含原文）",
    String(thrown?.message ?? "").includes(RAW_ERROR));
}

// ── 用例 3：delegate —— 超长多行错误被归一 ──
{
  group("用例 3：超长多行错误 → 单行化 + ≤200 含 `…` + 无换行");
  const longError = [
    "Error: provider returned 400",
    "{\"code\":\"Illegal Channel\",\"detail\":\"" + "x".repeat(400) + "\"}",
    "    at handler (src/server.ts:42:7)",
    "    at process (node:internal/process:1:1)",
    "第二段说明：请稍后重试",
  ].join("\n");
  check("样本本身 >500 字且含 5 个换行", longError.length > 500 && (longError.match(/\n/g) ?? []).length === 4);

  const err = await delegateError({ output: [], stopReason: "error", error: longError });
  const diag = String(err?.cause?.diagnostic ?? "");
  const detail = diag.replace(/^subagent error: /, "");
  check("diagnostic 带来源前缀", diag.startsWith("subagent error: "));
  check("detail 长度 ≤201（200 字符 + 省略号）", detail.length <= 201);
  check("detail 以 `…` 收尾（确认被截断而非原样透传）", detail.endsWith("…"));
  check("detail 不含换行符", !detail.includes("\n") && !detail.includes("\r"));
  check("detail 不含连续空白（已单行化）", !/\s{2,}/.test(detail));
  check("整条 message 也不含换行（不会把整页堆栈灌进上下文）",
    !String(err?.message ?? "").includes("\n"));
}

// ── 用例 4：delegate_batch —— per-task error 带出原文 ──
{
  group("用例 4：delegate_batch per-task error 带出同一原文");
  const envelopes: any[] = [];
  let spawns = 0;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      async startActivation(spec: any) {
        spawns++;
        if (!spec?.parent || !spec?.prompt) throw new Error("spec 必须双写顶层 parent/prompt");
        return {
          childId: "b" + spawns,
          messageId: "bm" + spawns,
          // 宿主归一：stopReason="error" 且无 diagnostic，真实原因只在 error 字段上
          result: Promise.resolve({ output: [], stopReason: "error", error: RAW_ERROR }),
          async dispose() {},
        };
      },
    },
  };
  const tool: any = createDelegateBatchTool(ctx, () => [], {});
  const text: string = await tool.execute(
    { tasks: [{ id: "t-fail", skill: "co-fixer", prompt: "会失败的任务" }] },
    {
      agent: { id: "p-fd-batch", session: { header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
      onBatchEvents: (envelope: any) => { envelopes.push(envelope); },
    },
  );
  const entry = (envelopes[0]?.results ?? []).find((r: any) => r.id === "t-fail");
  check("spawn 1 次", spawns === 1);
  check("任务状态为 failed（stopReason 归一，非 error 出口）", entry?.status === "failed");
  check("per-task error 字段含原始错误全文", String(entry?.error ?? "").includes(RAW_ERROR));
  check("per-task error 带来源前缀 subagent error: ",
    String(entry?.error ?? "").includes("subagent error: " + RAW_ERROR));
  check("per-task diagnostic 字段同口径", entry?.diagnostic === "subagent error: " + RAW_ERROR);
  check("per-task stopReason 未被污染", entry?.stopReason === "error");
  check("返回文本的失败段也回显原文", text.includes(RAW_ERROR) || text.includes("t-fail"));
}

// ── 用例 5：反向对照 —— 无残留错误时不伪造文本（旧行为不变） ──
{
  group("用例 5：无错误载荷 → 不伪造 diagnostic");
  const err = await delegateError({ output: [], stopReason: "error" });
  const msg = String(err?.message ?? "");
  check("仍抛错", !!err);
  check("message 不含 diagnostic 字样", !msg.includes("diagnostic"));
  check("cause 不含 diagnostic 字段", err?.cause?.diagnostic === undefined);
  check("message 仍保留原有 stopReason 文案", msg.includes('stopped with reason "error"'));

  // 有 diagnostic 时优先用宿主原文，不被 error 载荷顶替
  const DIAG = "host produced diagnostic";
  const err2 = await delegateError({ output: [], stopReason: "error", diagnostic: DIAG, error: RAW_ERROR });
  check("宿主 diagnostic 优先", err2?.cause?.diagnostic === DIAG);
  check("上游残留 error 不顶替宿主 diagnostic", !String(err2?.cause?.diagnostic ?? "").includes(RAW_ERROR));
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
