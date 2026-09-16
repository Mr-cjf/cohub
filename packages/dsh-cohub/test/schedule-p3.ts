// dsh-port/test/schedule-p3.ts —— P3-3（N3 代价感知调度·小切片）单测
// 覆盖：
//   ① schedule Config 缺省与非法值（z.union 枚举拒绝）
//   ② 注入段（systemPrompt.section "cohub:schedule"）包含实际生效值
//   ③ 卡片 schema（CohubSettingsSchema）可读写 schedule / delegateRetry（含 N2 stall 子配置）
//   ④ delegate 读取 settings 优先、config 兜底（maxRetries 生效；settings 含 stall 子配置也生效）
// 用法：bun run test/schedule-p3.ts（或 node test/schedule-p3.ts，node >= 24 类型剥离）
import { Context } from "@deepseek-ai/cordis";
import systemPrompt from "@deepseek-ai/dsh-system-prompt";
import skills from "@deepseek-ai/dsh-skill";
import tools from "@deepseek-ai/dsh-tools";
import subagents from "@deepseek-ai/dsh-subagent";
import { Config, CohubSettingsSchema } from "../lib/index.js";
import * as cohub from "../lib/index.js";
import { createDelegateTool } from "../src/delegate.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- 用例 1：schedule Config 缺省与非法值 ----
{
  console.log("===== 用例 1：schedule Config 缺省与非法值 =====");
  const def = Config({});
  check("缺省 maxParallelBatch=3", def.schedule.maxParallelBatch === 3);
  check("缺省 wallClockBudgetMs=600000", def.schedule.wallClockBudgetMs === 600_000);
  check("缺省 useJobTracking=auto", def.schedule.useJobTracking === "auto");
  check("缺省 adaptiveBatch=auto", def.schedule.adaptiveBatch === "auto");
  try { Config({ schedule: { useJobTracking: "bogus" } }); check("非法 useJobTracking 被拒", false); }
  catch { check("非法 useJobTracking 被拒", true); }
  try { Config({ schedule: { adaptiveBatch: "bogus" } }); check("非法 adaptiveBatch 被拒", false); }
  catch { check("非法 adaptiveBatch 被拒", true); }
  const over = Config({ schedule: { maxParallelBatch: 5 } });
  check("部分覆盖保留其他缺省", over.schedule.maxParallelBatch === 5 && over.schedule.wallClockBudgetMs === 600_000);
}

// ---- 用例 2：注入段（systemPrompt.section）包含实际生效值 ----
{
  console.log("===== 用例 2：注入段包含实际值 =====");
  const root = new Context();
  root.plugin(systemPrompt);
  root.plugin(tools);
  root.plugin(skills);
  root.plugin(subagents);
  await new Promise(r => setImmediate(r));
  cohub.apply(root, {
    councillors: [],
    councilTimeoutMs: 180_000,
    schedule: { maxParallelBatch: 7, wallClockBudgetMs: 234_567, useJobTracking: "on", adaptiveBatch: "off" },
  });
  const assembly: any = await root.systemPrompt.assemble({});
  const section = assembly.sections.find((s: any) => s.name === "cohub:schedule");
  check("注入段存在（name=cohub:schedule）", !!section);
  check("注入段含实际批大小 7", !!section && section.text.includes("7"));
  check("注入段含实际墙钟 234567", !!section && section.text.includes("234567"));
  check("注入段含 useJobTracking=on", !!section && section.text.includes("job 跟踪 on"));
  check("注入段含 adaptiveBatch=off", !!section && section.text.includes("批间自适应 off"));
  root.dispose?.();
}

// ---- 用例 3：卡片 schema（CohubSettingsSchema）可读写 schedule / delegateRetry ----
{
  console.log("===== 用例 3：CohubSettingsSchema 读写 schedule / delegateRetry =====");
  const parsed = CohubSettingsSchema({ schedule: { maxParallelBatch: 5, wallClockBudgetMs: 123_456 }, delegateRetry: { maxRetries: 2 } });
  check("settings.schedule.maxParallelBatch=5", parsed.schedule.maxParallelBatch === 5);
  check("settings.schedule.wallClockBudgetMs=123456", parsed.schedule.wallClockBudgetMs === 123_456);
  check("settings.schedule.useJobTracking 缺省 auto", parsed.schedule.useJobTracking === "auto");
  check("settings.delegateRetry.maxRetries=2", parsed.delegateRetry.maxRetries === 2);
  check("settings.delegateRetry.stall 缺省 enabled=false", parsed.delegateRetry.stall.enabled === false);
  const empty = CohubSettingsSchema({});
  check("空 settings.schedule 缺省齐全", empty.schedule.maxParallelBatch === 3 && empty.schedule.wallClockBudgetMs === 600_000);
  check("空 settings.delegateRetry 缺省 maxRetries=0", empty.delegateRetry.maxRetries === 0);
}

// ---- 用例 4：delegate 读取 settings 优先、config 兜底（maxRetries 生效；stall 子配置生效）----
{
  console.log("===== 用例 4a：settings 优先（maxRetries=2 生效） =====");
  let spawnCount = 0;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start(_t: string, _req: any) {
        spawnCount++;
        return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "x" }], stopReason: "aborted" }), dispose() {} };
      },
    },
  };
  // config.maxRetries=0，但 settings 给 2 → 应重试 2 次（spawn=3）
  const tool = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 0 } }, () => ({ delegateRetry: { maxRetries: 2, retryDelayMs: 1 } }));
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, { agent: { id: "p" }, signal: new AbortController().signal }); } catch (e) { err = e; }
  check("settings.maxRetries=2 → spawn=3", spawnCount === 3);
  check("cause.retries=2", err?.cause?.retries === 2);

  console.log("===== 用例 4b：config 兜底（无 getSettings → config.maxRetries=0） =====");
  spawnCount = 0;
  const tool2 = createDelegateTool(ctx, () => [], { delegateRetry: { maxRetries: 0 } });
  err = null;
  try { await tool2.execute({ skill: "co-fixer", prompt: "任务" }, { agent: { id: "p" }, signal: new AbortController().signal }); } catch (e) { err = e; }
  check("config.maxRetries=0 → spawn=1", spawnCount === 1);
  check("cause.retries=0", err?.cause?.retries === 0);

  console.log("===== 用例 4c：settings 含 N2 stall 子配置也生效 =====");
  // settings 给 stall.enabled=true + 连续 3 次同类错误 → 看门狗提前中止并重试（spawn=2 且重试 prompt 带停滞诊断）
  const listeners = new Set<(...a: any[]) => void>();
  const stallCtx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start(_t: string, req: any) {
        spawnCount++;
        const runId = "child-" + spawnCount;
        if (spawnCount === 1) {
          for (let i = 0; i < 3; i++) {
            stallCtx._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
            stallCtx._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Error: boom" }] } } });
          }
        }
        return spawnCount > 1
          ? { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} }
          : (() => {
              const run: any = {
                id: runId,
                result: new Promise((resolve) => {
                  const timer = setTimeout(() => resolve({ output: [{ type: "text", text: "unused" }], stopReason: "completed" }), 800);
                  req.signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ output: [{ type: "text", text: "partial-1" }], stopReason: "aborted" }); }, { once: true });
                }),
                dispose() {},
              };
              return run;
            })();
      },
    },
    on(type: string, h: (...a: any[]) => void) {
      if (type === "session/event") { listeners.add(h); return () => listeners.delete(h); }
      return () => {};
    },
    _emit(sessionId: string, event: any) {
      const session = { id: sessionId };
      for (const h of [...listeners]) h(session, event);
    },
  };
  spawnCount = 0;
  // config 无 stall；settings 提供 stall.enabled=true
  const tool3 = createDelegateTool(stallCtx, () => [], {}, () => ({
    delegateRetry: { maxRetries: 1, retryDelayMs: 1, stall: { enabled: true, consecutiveErrors: 3, checkIntervalMs: 50 } },
  }));
  const out = await tool3.execute({ skill: "co-fixer", prompt: "任务" }, { agent: { id: "p" }, signal: new AbortController().signal });
  check("settings.stall 生效 → 提前中止后重试成功", out === "OK" && spawnCount === 2);
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
