// dsh-cohub/test/batch-events.ts —— delegate_batch 的「进度事件 + task 时间线」门禁
//
// 覆盖（对应 src/delegate_batch.ts 的 BatchEvent / renderTaskTimeline / withTiming / pushBatchEvent）：
//   ① 成功批：每个结果条目带 startedAt / endedAt / durationMs，返回文本含 `## task 时间线`，
//      每行含 taskId 与 `耗时 Nms`，并带上该 task 的事件串（queued→started→completed）；
//   ② 1 成功 + 1 skill 名写错：失败 task 也有 endedAt / durationMs、status=error、事件含 `skill-error`，
//      成功 task 的返回文本不受影响（同批互不污染）；
//   ③ events 约束：每 task ≤ MAX_EVENTS_PER_TASK(5) 条、detail ≤ 120 字符（超长/多行 detail 被归一）；
//   ④ 预算裁剪无关性：把 batchTotalMaxChars 调到极小值（200），`## task 时间线` 段仍完整存在；
//   ⑤ 无 task 数据（空批次 / 超上限批次）时该段整体省略。
//
// 定位：全部用与 test/runtime-0.2.ts 层 3b 同构的 `ctx.subagents.startActivation` 桩驱动，
//       离线、不触网络、不触用户配置、不写盘。派发链路的真实分支（白名单 / 契约重写 / 预算）
//       都在 src 里被真实执行，只是「子代理」换成本地桩。
// 用法：node test/batch-events.ts（node >= 24 类型剥离）
import { createDelegateBatchTool } from "../src/delegate_batch.ts";
import type { SkillRouteConfig } from "../src/delegate.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string) {
  console.log("===== " + title + " =====");
}

/** 子代理桩的返回形状（只复刻 src 真正读取的字段：output / stopReason / diagnostic） */
type StubOutcome = { output: Array<{ type: string; text: string }>; stopReason: string; diagnostic?: string };

/** 一批的观测结果：返回文本 + 结构化事件包 + spawn 次数 + 每次派的 prompt 全文 */
interface BatchRun {
  text: string;
  envelope: any;
  envelopeCount: number;
  spawns: number;
  prompts: string[];
}

const COMPLETED = (text: string): StubOutcome => ({ output: [{ type: "text", text }], stopReason: "completed" });

/**
 * 与 test/runtime-0.2.ts 层 3b 同构的 startActivation 桩：
 *  - 校验 spec 顶层双写 parent/prompt（0.2.2-rc.3 只读顶层，缺了必崩在 spawn 前）；
 *  - 记录每次派发的 prompt 全文（用于契约注入/重写断言的旁证）；
 *  - 事件流经 exec.onBatchEvents 捕获（宿主不支持该能力时 src 会静默跳过，故这里必须提供）。
 */
async function runBatch(options: {
  tasks: any[];
  routes?: SkillRouteConfig[];
  config?: any;
  respond: (spawnNo: number) => StubOutcome;
}): Promise<BatchRun> {
  const prompts: string[] = [];
  const envelopes: any[] = [];
  let spawns = 0;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      async startActivation(spec: any) {
        spawns += 1;
        if (!spec?.parent || !spec?.prompt) {
          throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
        }
        const blocks: any[] = Array.isArray(spec.prompt) ? spec.prompt : [];
        prompts.push(blocks.map((b: any) => String(b?.text ?? "")).join("\n"));
        const outcome = options.respond(spawns);
        return {
          childId: "b" + spawns,
          messageId: "bm" + spawns,
          result: Promise.resolve(outcome),
          async dispose() {},
        };
      },
    },
  };
  const tool: any = createDelegateBatchTool(ctx, () => options.routes ?? [], options.config ?? {});
  const text: string = await tool.execute(
    { tasks: options.tasks },
    {
      agent: { id: "p-batch-events", session: { header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
      onBatchEvents: (envelope: any) => { envelopes.push(envelope); },
    },
  );
  return { text, envelope: envelopes[0], envelopeCount: envelopes.length, spawns, prompts };
}

const TIMELINE_HEADER = "## task 时间线";

/** 取「## task 时间线」段的行（只收 `- [` 开头的行；遇到空行/非行内容即收尾，避免吞掉后续降级提示） */
function parseTimeline(text: string): string[] {
  const at = text.indexOf(TIMELINE_HEADER);
  if (at < 0) return [];
  const rows: string[] = [];
  const rest = text.slice(at + TIMELINE_HEADER.length).split("\n");
  for (const raw of rest) {
    const line = raw.trim();
    if (line.length === 0) {
      if (rows.length > 0) break;
      continue;
    }
    if (!line.startsWith("- [")) break;
    rows.push(line);
  }
  return rows;
}

/** 按 taskId 归并事件（确认「每 task ≤5 条」的口径是逐 task，而不是整批总数） */
function eventsByTask(events: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const e of events) {
    const key = String(e?.taskId);
    (out[key] ??= []).push(e);
  }
  return out;
}

function phasesOf(events: any[]): string[] {
  return events.map(e => String(e?.phase));
}

/** 时间线单行应有的形态：`- [taskId] <status> · 耗时 <n>ms[ · 事件串]` */
const ROW_RE = /^- \[([^\]]+)\] (completed|failed|error) · 耗时 (\d+)ms(?: · (.+))?$/;

// ── 用例 1：成功批（2 task）——时间字段 + 时间线段 + 事件串 ──
{
  group("用例 1：成功批 2 task → startedAt/endedAt/durationMs + 时间线");
  const run = await runBatch({
    tasks: [
      { id: "t-a", skill: "co-fixer", prompt: "任务 A" },
      { id: "t-b", skill: "co-explorer", prompt: "任务 B" },
    ],
    respond: n => COMPLETED("结果正文-" + n),
  });

  check("spawn 2 次（2 个 task 都真的派发了）", run.spawns === 2);
  const results: any[] = run.envelope?.results ?? [];
  check("结构化结果 2 条", results.length === 2);
  check("每个结果条目都带 startedAt/endedAt/durationMs",
    results.length === 2 && results.every(r =>
      typeof r.startedAt === "number" && typeof r.endedAt === "number" && typeof r.durationMs === "number"));
  check("durationMs === endedAt - startedAt 且 ≥0",
    results.every(r => r.durationMs === Math.max(0, r.endedAt - r.startedAt) && r.durationMs >= 0));
  check("endedAt 不早于 startedAt", results.every(r => r.endedAt >= r.startedAt));
  check("runId 透传（桩 childId）", results.every(r => typeof r.runId === "string" && r.runId.length > 0));

  check("返回文本含「## task 时间线」", run.text.includes(TIMELINE_HEADER));
  const rows = parseTimeline(run.text);
  check("时间线 2 行（每 task 一行）", rows.length === 2);
  check("每行都含 taskId", rows.some(l => l.includes("[t-a]")) && rows.some(l => l.includes("[t-b]")));
  check("每行都含「耗时 Nms」", rows.length === 2 && rows.every(l => /耗时 \d+ms/.test(l)));
  check("每行都符合 `- [id] status · 耗时 Nms` 形态", rows.length === 2 && rows.every(l => ROW_RE.test(l)));
  check("每行状态为 completed", rows.every(l => l.includes("] completed · 耗时 ")));
  check("每行事件串为 queued→started→completed",
    rows.length === 2 && rows.every(l => l.includes("queued→started→completed")));

  const events: any[] = run.envelope?.events ?? [];
  check("onBatchEvents 发射 1 次且携带 events", run.envelopeCount === 1 && events.length === 6);
  check("envelope.text 与工具返回文本一致", run.envelope?.text === run.text);
  check("每条事件都有 taskId / phase / at",
    events.every(e => typeof e.taskId === "string" && typeof e.phase === "string" && typeof e.at === "number"));
  const byTask = eventsByTask(events);
  check("逐 task 相位序列 = queued,started,completed",
    JSON.stringify(phasesOf(byTask["t-a"] ?? [])) === JSON.stringify(["queued", "started", "completed"])
    && JSON.stringify(phasesOf(byTask["t-b"] ?? [])) === JSON.stringify(["queued", "started", "completed"]));
  check("queued 事件 detail 回显 skill 名",
    (byTask["t-a"] ?? [])[0]?.detail === "co-fixer" && (byTask["t-b"] ?? [])[0]?.detail === "co-explorer");
}

// ── 用例 2：1 成功 + 1 skill 名写错 —— 失败也有耗时，成功不受影响 ──
{
  group("用例 2：1 成功 + 1 skill 名写错 → 失败带耗时且事件含 skill-error");
  const run = await runBatch({
    tasks: [
      { id: "ok-1", skill: "co-fixer", prompt: "正常任务" },
      { id: "bad-1", skill: "co-fixer-typo", prompt: "写错 skill 的任务" },
    ],
    respond: () => COMPLETED("成功任务的结果正文"),
  });

  check("只 spawn 1 次（写错的 skill 不派发）", run.spawns === 1);
  const results: any[] = run.envelope?.results ?? [];
  const okEntry = results.find(r => r.id === "ok-1");
  const badEntry = results.find(r => r.id === "bad-1");
  check("两条结果都在（失败不吞条）", results.length === 2 && okEntry !== undefined && badEntry !== undefined);
  check("失败 task 状态为 error", badEntry?.status === "error");
  check("失败 task 也有 endedAt/durationMs",
    typeof badEntry?.endedAt === "number" && typeof badEntry?.durationMs === "number"
    && badEntry.endedAt >= 0 && badEntry.durationMs >= 0);
  // 批次 2 起错误文案改为「不存在 / 已被禁用」二义区分，并回显**运行时**可用角色名单
  // （内置 13 + config.customRoles），因此这里断言的是「名单仍在文案里」。
  check("失败 task 的 error 给出合法名单",
    String(badEntry?.error ?? "").includes("可用角色：")
    && String(badEntry?.error ?? "").includes("co-fixer"));
  check("成功 task 状态 completed 且正文完整",
    okEntry?.status === "completed" && String(okEntry?.result ?? "").includes("成功任务的结果正文"));
  check("成功 task 的时间字段未被失败 task 污染",
    typeof okEntry?.startedAt === "number" && typeof okEntry?.endedAt === "number"
    && okEntry.durationMs === Math.max(0, okEntry.endedAt - okEntry.startedAt));

  const events: any[] = run.envelope?.events ?? [];
  const badPhases = phasesOf(eventsByTask(events)["bad-1"] ?? []);
  check("失败 task 的事件串含 skill-error", badPhases.includes("skill-error"));
  check("失败 task 的事件串以 queued 起、以 skill-error 止",
    badPhases[0] === "queued" && badPhases[badPhases.length - 1] === "skill-error");
  check("成功 task 的事件串不含 skill-error",
    !phasesOf(eventsByTask(events)["ok-1"] ?? []).includes("skill-error"));

  const rows = parseTimeline(run.text);
  check("时间线仍为 2 行（失败 task 也在时间线上）", rows.length === 2);
  check("失败 task 行状态为 error 且带耗时",
    rows.some(l => l.startsWith("- [bad-1] error · 耗时 ") && /耗时 \d+ms/.test(l)));
  check("失败 task 行事件串含 skill-error", rows.some(l => l.includes("[bad-1]") && l.includes("skill-error")));
  check("返回文本的失败段回显该 task",
    run.text.includes("## 失败/错误任务") && run.text.includes("### bad-1"));
}

// ── 用例 3：events 约束——每 task ≤5 条、detail ≤120 字符且单行 ──
{
  group("用例 3：events 约束（≤5 条/task、detail ≤120 字符）");
  // 3a 多相位场景：strict 契约重写 → queued→started→contract-retry→completed（本批可达的最长链）
  const strictValid = JSON.stringify({ changed: ["src/a.ts"], verification: "node test/x.ts 全 PASS" });
  const retryRun = await runBatch({
    tasks: [{ id: "strict-ok", skill: "co-fixer", prompt: "需要 JSON 输出的任务" }],
    routes: [{ name: "co-fixer", outputContract: "strict" }],
    respond: n => COMPLETED(n === 1 ? "我先说明一下，稍后给出结果。" : strictValid),
  });
  check("strict 重写触发第二次派发（spawn=2）", retryRun.spawns === 2);
  const retryEvents: any[] = retryRun.envelope?.events ?? [];
  const retryPhases = phasesOf(retryEvents);
  check("多相位事件串 = queued,started,contract-retry,completed",
    JSON.stringify(retryPhases) === JSON.stringify(["queued", "started", "contract-retry", "completed"]));
  check("多相位场景下每 task 事件数仍 ≤5", retryEvents.length <= 5);
  check("重写后合规 → 结果不带契约标记，且无 contractViolated",
    retryRun.envelope?.results?.[0]?.result === strictValid
    && retryRun.envelope?.results?.[0]?.contractViolated === undefined);
  check("时间线事件串含 contract-retry",
    parseTimeline(retryRun.text).some(l => l.includes("queued→started→contract-retry→completed")));
  check("第二次派发的 prompt 含重写说明", String(retryRun.prompts[1] ?? "").includes("[契约重写]"));

  // 3b 仍违约：第四相位仍是 completed（detail 标注违约），事件数依旧 ≤5
  const stillBadRun = await runBatch({
    tasks: [{ id: "strict-bad", skill: "co-fixer", prompt: "仍然不守契约" }],
    routes: [{ name: "co-fixer", outputContract: "strict" }],
    respond: () => COMPLETED("依然不是 JSON 的说明文字"),
  });
  check("二次违约也只有 2 次派发（绝不第三次）", stillBadRun.spawns === 2);
  const badEvents: any[] = stillBadRun.envelope?.events ?? [];
  check("二次违约事件数 ≤5", badEvents.length <= 5);
  check("二次违约标记落到结果与 completed 事件 detail",
    stillBadRun.envelope?.results?.[0]?.contractViolated === true
    && String(stillBadRun.envelope?.results?.[0]?.result ?? "").includes("[契约]")
    && String(badEvents[badEvents.length - 1]?.detail ?? "").includes("契约违约"));

  // 3c detail 归一：400 字符 + 多行 diagnostic 必须被压成 ≤120 字符单行
  const longDiag = "D".repeat(400) + "\n第二行\n第三行";
  const diagRun = await runBatch({
    tasks: [{ id: "diag-1", skill: "co-fixer", prompt: "返回 error" }],
    respond: () => ({ output: [{ type: "text", text: "半成品" }], stopReason: "error", diagnostic: longDiag }),
  });
  const diagEvents: any[] = diagRun.envelope?.events ?? [];
  const failedEvent = diagEvents.find(e => e.phase === "failed");
  check("非 completed 也有 failed 事件", failedEvent !== undefined);
  check("超长 detail 被截断到 ≤120 字符", String(failedEvent?.detail ?? "").length <= 120);
  check("detail 已被压成单行", !String(failedEvent?.detail ?? "").includes("\n"));
  check("失败结果条目仍带 endedAt/durationMs",
    typeof diagRun.envelope?.results?.[0]?.endedAt === "number"
    && typeof diagRun.envelope?.results?.[0]?.durationMs === "number");

  // 3d 全局不变量：以上所有批次里，任一 task 的事件数 ≤5、任一 detail ≤120
  const suites: any[][] = [retryEvents, badEvents, diagEvents];
  const allTasksOk = suites.every(evts => Object.values(eventsByTask(evts)).every(list => list.length <= 5));
  const allDetailOk = suites.every(evts => evts.every(e => e.detail === undefined || String(e.detail).length <= 120));
  check("全部场景：每 task 事件数 ≤5", allTasksOk);
  check("全部场景：detail ≤120 字符", allDetailOk);
}

// ── 用例 4：预算裁剪无关性——极小 batchTotalMaxChars 也切不掉时间线 ──
{
  group("用例 4：预算裁剪无关性（batchTotalMaxChars 极小）");
  const run = await runBatch({
    tasks: [
      { id: "big-1", skill: "co-fixer", prompt: "长输出任务 1" },
      { id: "big-2", skill: "co-fixer", prompt: "长输出任务 2" },
    ],
    // 两档都压到 MIN_BUDGET_CHARS(=200)，确保任务级与总串级裁剪都会真的发生
    config: { resultBudget: { batchTaskMaxChars: 200, batchTotalMaxChars: 200 } },
    respond: n => COMPLETED("正文-" + n + "-" + "x".repeat(1200)),
  });

  check("spawn 2 次", run.spawns === 2);
  check("预算裁剪确实发生过（输出含省略标记）", run.text.includes("…[已省略"));
  check("极小总预算下「## task 时间线」段仍存在", run.text.includes(TIMELINE_HEADER));
  const rows = parseTimeline(run.text);
  check("极小总预算下时间线仍 2 行（一行不少）", rows.length === 2);
  check("极小总预算下每行仍带 taskId 与耗时",
    rows.some(l => l.includes("[big-1]") && /耗时 \d+ms/.test(l))
    && rows.some(l => l.includes("[big-2]") && /耗时 \d+ms/.test(l)));
  check("统计行同样不被裁掉（追加式保证）",
    run.text.includes("并发 2 个子代理") && run.text.includes("2/2 完成"));
}

// ── 用例 5：无 task 数据 → 时间线段整体省略 ──
{
  group("用例 5：无 task 数据 → 时间线段整体省略");
  const emptyRun = await runBatch({ tasks: [], respond: () => COMPLETED("不该被调用") });
  check("空批次返回既有占位文案", emptyRun.text === "delegate_batch: 无任务");
  check("空批次不 spawn", emptyRun.spawns === 0);
  check("空批次不发射 events（无 task 数据）", emptyRun.envelopeCount === 0);
  check("空批次返回文本不含「## task 时间线」", !emptyRun.text.includes(TIMELINE_HEADER));

  const overRun = await runBatch({
    tasks: Array.from({ length: 6 }, (_v, i) => ({ id: "over-" + i, skill: "co-fixer", prompt: "任务 " + i })),
    respond: () => COMPLETED("不该被调用"),
  });
  check("超上限批次返回分批提示", overRun.text.includes("超过上限"));
  check("超上限批次不 spawn", overRun.spawns === 0);
  check("超上限批次不含「## task 时间线」", !overRun.text.includes(TIMELINE_HEADER));

  // 反向对照：同样是「无 → 有」的转换，正常批次必须有该段（避免上面的断言空转）
  const controlRun = await runBatch({
    tasks: [{ id: "ctl-1", skill: "co-fixer", prompt: "对照任务" }],
    respond: () => COMPLETED("对照结果"),
  });
  check("对照批次（有 1 个 task）必有该段", controlRun.text.includes(TIMELINE_HEADER));
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
