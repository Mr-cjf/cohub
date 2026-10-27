// test/todo-nudge.ts —— maybeDeferTodoNudge 单测（独立运行，不连真宿主）
//
// 覆盖 6 组行为：基本注入 / 同会话上限 / 不同 agent 独立计数 /
//              无 deferContext 时 fail-soft / 后台任务分支不注入 / deferContext 抛错时 fail-soft。
// 用法：node test/todo-nudge.ts（node >= 24 类型剥离）
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { NUDGE_TEXT, maybeDeferTodoNudge } from "../src/todo-nudge.ts";

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

/** 同会话注入上限硬编码值（src/todo-nudge.ts:25 MAX_PER_SESSION 未导出，这里按契约钉住） */
const MAX_PER_SESSION = 2;

/** 假 exec：只提供 agent + deferContext，不连宿主；agent 每次新建以避免 WeakMap 跨用例污染 */
function makeExec(opts: { throwOnDefer?: boolean; extra?: Record<string, any> } = {}) {
  const calls: any[] = [];
  const agent = {};
  const exec: any = {
    agent,
    deferContext(msg: any) {
      if (opts.throwOnDefer) throw new Error("宿主拒绝：上下文已终结（测试桩故意抛出）");
      calls.push(msg);
    },
    ...(opts.extra ?? {}),
  };
  return { exec, agent, calls };
}

/** 从 createUserMessage 产出的消息里取纯文本（content 数组 → 拼接 text） */
function textOf(msg: any): string {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  return parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
}

// ---- 用例 1：基本注入 ----
{
  console.log("===== 用例 1：基本注入 =====");
  const { exec, calls } = makeExec();
  maybeDeferTodoNudge(exec);
  check("deferContext 被调用 1 次", () => assert.equal(calls.length, 1, "前台委派成功应注入 1 条提醒"));
  check("消息正文含 todo 关键词", () =>
    assert.ok(/todo/i.test(textOf(calls[0])), "提醒正文必须出现 todo，否则编排者不知道要做什么"));
  check("消息正文等于 NUDGE_TEXT", () =>
    assert.equal(textOf(calls[0]), NUDGE_TEXT, "注入内容应与导出的 NUDGE_TEXT 完全一致"));
  check("source kind 为 cohub-todo-nudge", () =>
    assert.equal(calls[0]?.source?.kind, "cohub-todo-nudge", "source.kind 必须是本插件专属 kind"));
  check("消息角色为 user", () =>
    assert.equal(calls[0]?.role, "user", "注入的是 plugin-sourced user 消息"));
}

// ---- 用例 2：上限生效 ----
{
  console.log("===== 用例 2：上限生效（MAX_PER_SESSION=2） =====");
  const { exec, calls } = makeExec();
  maybeDeferTodoNudge(exec);
  maybeDeferTodoNudge(exec);
  check("前 2 次各注入 1 条（累计 2）", () => assert.equal(calls.length, 2, "上限内的 2 次都应注入"));
  check("第 3 次静默跳过且不抛错", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge(exec), "超限必须静默返回，不能打断调用方");
    assert.equal(calls.length, MAX_PER_SESSION, "第 3 次不应再注入（上限 2 次）");
  });
  check("第 4 次仍不注入", () => {
    maybeDeferTodoNudge(exec);
    assert.equal(calls.length, MAX_PER_SESSION, "超限后继续调用也不应恢复注入");
  });
}

// ---- 用例 3：不同 agent 独立计数 ----
{
  console.log("===== 用例 3：不同 agent 独立计数 =====");
  const a = makeExec();
  const b = makeExec();
  maybeDeferTodoNudge(a.exec);
  maybeDeferTodoNudge(a.exec);
  maybeDeferTodoNudge(a.exec);
  maybeDeferTodoNudge(b.exec);
  check("agentA 触发 2 次（被自己的上限截断）", () =>
    assert.equal(a.calls.length, MAX_PER_SESSION, "A 会话应恰好注入 2 次"));
  check("agentB 触发 1 次（未被 A 的配额挤掉）", () =>
    assert.equal(b.calls.length, 1, "不同 agent 的计数必须独立，B 的首次注入不应被 A 影响"));
  check("两个 agent 注入内容一致", () =>
    assert.equal(textOf(a.calls[0]), textOf(b.calls[0]), "同一模板应对所有会话生成相同正文"));
  // 反向再验：B 还有 1 次配额，A 已归零
  maybeDeferTodoNudge(b.exec);
  maybeDeferTodoNudge(a.exec);
  check("配额互不干扰（B 第 2 次仍注入，A 不再注入）", () => {
    assert.equal(b.calls.length, MAX_PER_SESSION, "B 的第 2 次应在其自身配额内注入");
    assert.equal(a.calls.length, MAX_PER_SESSION, "A 已用尽配额，不应因 B 的调用而恢复");
  });
}

// ---- 用例 4：无 deferContext 时 fail-soft ----
{
  console.log("===== 用例 4：无 deferContext 时 fail-soft =====");
  check("exec 缺 deferContext 字段时不抛错", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge({ agent: {} }), "旧版宿主/测试桩无 deferContext 必须静默返回");
  });
  check("deferContext 非函数（undefined/null/字符串）时不抛错", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge({ agent: {}, deferContext: undefined }), "undefined 应被 typeof 守卫吞掉");
    assert.doesNotThrow(() => maybeDeferTodoNudge({ agent: {}, deferContext: null }), "null 应被 typeof 守卫吞掉");
    assert.doesNotThrow(() => maybeDeferTodoNudge({ agent: {}, deferContext: "not-a-fn" }), "非函数值应被守卫吞掉");
  });
  check("exec 为 undefined/null 时不抛错", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge(undefined), "缺少 exec 也必须 fail-soft");
    assert.doesNotThrow(() => maybeDeferTodoNudge(null), "exec 为 null 也必须 fail-soft");
  });
  check("无 deferContext 不消耗配额（事后补上宿主能力仍可注入）", () => {
    const agent = {};
    const calls: any[] = [];
    maybeDeferTodoNudge({ agent }); // 第一次：无能力，静默
    maybeDeferTodoNudge({ agent, deferContext: (m: any) => calls.push(m) }); // 同 agent 第二次：有能力
    assert.equal(calls.length, 1, "跳过分支必须在计数之前返回，否则白白吃掉一次配额");
  });
}

// ---- 用例 5：后台任务分支不注入 ----
// 说明：后台判断位于调用点（exec/jobId 分支），不在 maybeDeferTodoNudge 内部；
// 因此本组用「动态证明 nudge 不做后台过滤」+「调用点控制流静态断言」两段共同覆盖。
{
  console.log("===== 用例 5：后台任务分支不注入 =====");
  check("nudge 本身不按 background 字段过滤（后台保护应由调用点保证）", () => {
    const { exec, calls } = makeExec({ extra: { background: true, jobId: "job-abc123" } });
    maybeDeferTodoNudge(exec);
    assert.equal(calls.length, 1, "nudge 内部无后台分支；若它自行过滤，说明调用点契约与实现不符");
  });
  check("delegate.ts：jobId 分支在 nudge 之前直接 return（后台路径不可达注入）", () => {
    const src = readFileSync(new URL("../src/delegate.ts", import.meta.url), "utf8");
    const occurrences = src.split("maybeDeferTodoNudge(exec)").length - 1;
    assert.equal(occurrences, 1, "delegate.ts 应只有 1 处注入调用点");
    const jobBranchAt = src.indexOf("if (jobId !== undefined) {");
    assert.ok(jobBranchAt > -1, "未找到后台 jobId 分支，测试前提失效（代码结构已变）");
    const nudgeAt = src.indexOf("maybeDeferTodoNudge(exec)");
    assert.ok(jobBranchAt < nudgeAt, "jobId 分支必须位于注入点之前");
    // 后台分支体内必须用 return 提前离开，否则会落到 nudge 调用点
    const branchBody = src.slice(jobBranchAt, nudgeAt);
    assert.ok(/return\s/.test(branchBody), "jobId 分支内必须有 return 提前返回，后台任务才不会被注入");
  });
  check("delegate_batch.ts：仅在批量结果成型后注入 1 次（无后台分支）", () => {
    const src = readFileSync(new URL("../src/delegate_batch.ts", import.meta.url), "utf8");
    assert.equal(src.split("maybeDeferTodoNudge(exec)").length - 1, 1, "delegate_batch.ts 应只有 1 处注入调用点");
    assert.ok(!/jobId|background/.test(src), "delegate_batch 无后台模式，不应出现 jobId/background 分支");
  });
}

// ---- 用例 6：deferContext 抛错时 fail-soft ----
{
  console.log("===== 用例 6：deferContext 抛错时 fail-soft =====");
  const { exec } = makeExec({ throwOnDefer: true });
  check("宿主 deferContext 抛错时 maybeDeferTodoNudge 不抛", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge(exec), "注入失败是锦上添花，绝不能冒泡打断委派结果回传");
  });
  check("抛错后再次调用仍不抛（异常被完全吞掉，状态未损坏）", () => {
    assert.doesNotThrow(() => maybeDeferTodoNudge(exec), "连续失败也必须 fail-soft");
  });
  check("agent 上无残留可观测副作用（key 仍是普通对象，无新增自有字段）", () => {
    assert.deepEqual(Object.keys(exec.agent ?? {}), [], "计数只存 WeakMap，不应污染 agent 对象");
  });
}

console.log("\n总计：" + (pass + fail) + " 条断言，PASS " + pass + "，FAIL " + fail);
process.exit(fail ? 1 : 0);
