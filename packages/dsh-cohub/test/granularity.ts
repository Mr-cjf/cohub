// dsh-cohub/test/granularity.ts —— src/granularity.ts 的离线验证（含 delegate_batch 端到端）
// 用法：node test/granularity.ts（node >= 24 类型剥离）
//
// 被测对象：validateTaskScope —— 把「单包硬上限」（可独立判定诉求 ≤3 / 模块域 ≤2）
// 从提示词软约束落成运行时校验：未声明一律放行，显式超限才拒绝并给拆分建议。
//
// 分层：
//   用例 1/2  未声明与上限内 → ok（历史调用零行为变化：NaN / 空串 / 负数 / 非对象都不误伤）；
//   用例 3    各类超限 → 拒绝 + 文案同时点名超了哪项、需要拆成几包、如何跳过校验；
//   用例 4    端到端：真实 delegate_batch 一批 2 task，A 带超限 scope 落 status:"error"、
//             B 正常 completed —— 证明「单 task 写错不拖垮整批」，且 A 根本没 spawn。
import {
  MAX_TASK_DEMANDS,
  MAX_TASK_DOMAINS,
  validateTaskScope,
  type TaskScope,
  type TaskScopeCheck,
} from "../src/granularity.ts";
import { createDelegateBatchTool } from "../src/delegate_batch.ts";
import { makeSessionHeader, makeSubagentReceipt, makeToolRunContext } from "./types/test-stubs.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** 拒绝结果的文案（ok 时返回空串，便于统一切片断言） */
function errorOf(result: TaskScopeCheck): string {
  return result.ok ? "" : result.error;
}

// 锁死契约常量：文案里的「上限 3 / 上限 2」必须来自这两个值，不能各写一份
group("用例 0：上限常量锁定（文案与常量不脱钩）");
check("MAX_TASK_DEMANDS = 3", MAX_TASK_DEMANDS === 3);
check("MAX_TASK_DOMAINS = 2", MAX_TASK_DOMAINS === 2);

// ── 用例 1：未声明 scope → 一律 ok（视为不校验）──
group("用例 1：未声明 scope → ok（历史调用零行为变化）");
check("undefined → ok", validateTaskScope(undefined).ok === true);
check("null → ok", validateTaskScope(null).ok === true);
check("{} → ok", validateTaskScope({}).ok === true);
check("{demands:NaN, domains:['',' ']} → ok（NaN 与纯空白域按未声明）",
  validateTaskScope({ demands: Number.NaN, domains: ["", " "] }).ok === true);
check("{demands:undefined, domains:undefined} → ok",
  validateTaskScope({ demands: undefined, domains: undefined }).ok === true);
check("显式 null 字段 → ok", validateTaskScope({ demands: null, domains: null } as unknown as TaskScope).ok === true);
check("非对象（字符串）→ ok（不抛、不误伤）",
  validateTaskScope("demands=9" as unknown as TaskScope).ok === true);

// ── 用例 2：上限内 → ok（含边界、向下取整、过滤空白域）──
group("用例 2：上限内 → ok（边界与非整数不误伤）");
const fullOk = validateTaskScope({ demands: 3, domains: ["a", "b"] });
check("{demands:3, domains:['a','b']}（正好顶格）→ ok", fullOk.ok === true);
check("ok 结果不带 error 字段", fullOk.ok === true && Object.keys(fullOk).length === 1);
check("{demands:3} → ok（域名可不写）", validateTaskScope({ demands: 3 }).ok === true);
check("{domains:['a','b']} → ok（诉求可不写）", validateTaskScope({ domains: ["a", "b"] }).ok === true);
check("{demands:0} → ok（非正数按未声明）", validateTaskScope({ demands: 0 }).ok === true);
check("{demands:-5} → ok（负数按未声明）", validateTaskScope({ demands: -5 }).ok === true);
check("{demands:3.9} → ok（floor→3，不按四舍五入误伤）", validateTaskScope({ demands: 3.9 }).ok === true);
check("{demands:Number.POSITIVE_INFINITY} → ok（非有限值按未声明）",
  validateTaskScope({ demands: Number.POSITIVE_INFINITY }).ok === true);
check("{domains:['a','','  ']} → ok（只数非空字符串域）",
  validateTaskScope({ domains: ["a", "", "  "] }).ok === true);
check("{domains:[]} → ok（空数组不超限）", validateTaskScope({ domains: [] }).ok === true);

// ── 用例 3：超限 → 拒绝 + 拆分建议文案 ──
group("用例 3：超限 → 拒绝并给出拆分建议");
const overDemands = validateTaskScope({ demands: 4 });
check("{demands:4} → 拒绝", overDemands.ok === false);
check("{demands:4} 文案含「上限 3」", errorOf(overDemands).includes("上限 3"));
check("{demands:4} 文案含「拆分」", errorOf(overDemands).includes("拆分"));
check("{demands:4} 文案点名诉求 4 项", errorOf(overDemands).includes("可独立判定诉求 4 项"));
check("{demands:4} 给出拆成 2 个 task（ceil(4/3)=2）", errorOf(overDemands).includes("拆分为 2 个 task"));
check("{demands:4} 拒绝结果只有 ok:false + error 两字段",
  overDemands.ok === false && typeof overDemands.error === "string" && overDemands.error.length > 0);

const overDomains = validateTaskScope({ domains: ["a", "b", "c"] });
check("{domains:['a','b','c']} → 拒绝", overDomains.ok === false);
check("{domains:3 个} 文案含「上限 2」", errorOf(overDomains).includes("上限 2"));
check("{domains:3 个} 文案点名模块域 3 个", errorOf(overDomains).includes("模块域 3 个"));
check("{domains:3 个} 给出拆成 2 个 task（ceil(3/2)=2）", errorOf(overDomains).includes("拆分为 2 个 task"));
check("{domains:3 个} 文案不含诉求超限项（只报真正超的那项）", !errorOf(overDomains).includes("可独立判定诉求"));

const overBoth = validateTaskScope({ demands: 7, domains: ["a", "b", "c"] });
check("{demands:7, domains:3 个} → 拒绝", overBoth.ok === false);
check("双超时文案**同时**点名诉求 7 项", errorOf(overBoth).includes("可独立判定诉求 7 项"));
check("双超时文案**同时**点名模块域 3 个", errorOf(overBoth).includes("模块域 3 个"));
check("双超时按较大一档给包数：max(ceil(7/3), ceil(3/2)) = 3",
  errorOf(overBoth).includes("拆分为 3 个 task"));

const overDemandsOnly = validateTaskScope({ demands: 4, domains: [] });
check("{demands:4, domains:[]} 不点名模块域项（空域不参与计数，无「（上限 2）」）",
  !errorOf(overDemandsOnly).includes("（上限 2）"));
const longDomains = validateTaskScope({ domains: ["a", "b", "c", "d", "e", "f", "g", "h"] });
check("域名过长时只展示前 6 个并标「等 8 个」",
  errorOf(longDomains).includes("模块域 8 个") && errorOf(longDomains).includes("等 8 个"));
check("所有拒绝文案都给「省略 scope 跳过校验」的口子",
  errorOf(overDemands).includes("省略 scope 字段") && errorOf(overDomains).includes("省略 scope 字段"));
check("拒绝文案说明拆完可独立判定/独立验收", errorOf(overBoth).includes("独立判定"));

// ── 用例 4：端到端 —— 一批 2 task，A 超限 / B 正常（单 task 写错不拖垮整批）──
group("用例 4：端到端 delegate_batch（A scope 超限 → error，B → completed）");
const spawnedSpecs: any[] = [];
const ctx: any = {
  logger: { info: () => {}, warn: () => {} },
  llm: { listProviders: () => [], listModels: async () => [] },
  subagents: {
    // 与 test/runtime-0.2.ts 层 3b 同构：0.2.1 契约只有 startActivation（无 start）。
    // 返回用 makeSubagentReceipt 工厂（{childId, messageId, result, dispose}）。
    async startActivation(spec: any) {
      spawnedSpecs.push(spec);
      // rc.3 宿主只读顶层 parent/prompt；此处顺带守住「双写」这个真实契约
      if (!spec?.parent || !spec?.prompt) {
        throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
      }
      const index = spawnedSpecs.length;
      return makeSubagentReceipt(
        "child-" + index,
        Promise.resolve({ output: [{ type: "text", text: "batch-ok-" + index }], stopReason: "completed" }),
      );
    },
  },
};
const batchTool: any = createDelegateBatchTool(ctx, () => [], {}, () => ({
  schedule: { maxParallelBatch: 5, wallClockBudgetMs: 5_000 },
}));
let envelope: any = null;
const exec: any = makeToolRunContext({
  agent: { id: "p-granularity", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
  signal: new AbortController().signal,
});
exec.onBatchEvents = (payload: any) => { envelope = payload; };

const textOut: any = await batchTool.execute({
  tasks: [
    { id: "A", skill: "co-fixer", prompt: "任务 A：声明了超限的粒度", scope: { demands: 4 } },
    { id: "B", skill: "co-fixer", prompt: "任务 B：正常任务" },
  ],
}, exec);

const results: any[] = Array.isArray(envelope?.results) ? envelope.results : [];
const resultA = results.find(entry => entry.id === "A");
const resultB = results.find(entry => entry.id === "B");
check("批结果 2 条（A/B 都在，未整批拒绝）", results.length === 2);
check("A 落 status:'error'", resultA?.status === "error");
check("A 的 error 含「上限 3」与拆分建议",
  String(resultA?.error ?? "").includes("上限 3") && String(resultA?.error ?? "").includes("拆分"));
check("B 落 status:'completed'", resultB?.status === "completed");
check("B 的结果正文回传（batch-ok-1）", String(textOut).includes("batch-ok-1"));
check("只有 B 真的 spawn（A 在 spawn 之前就被拦下，零副作用）", spawnedSpecs.length === 1);
// persona 前置在 prompt 首块，任务正文在后续块 → 拼接全部块再找
const spawnedText = ((spawnedSpecs[0]?.prompt ?? []) as any[])
  .map(block => String(block?.text ?? ""))
  .join("\n");
check("被 spawn 的是 B（spec 全部 prompt 块含「任务 B」）", spawnedText.includes("任务 B"));
check("批返回文本含 A 的拆分建议（失败可见，不被静默吞掉）", String(textOut).includes("上限 3"));
check("批返回文本仍含 B 的完成结果（未因 A 失败而丢弃）",
  String(textOut).includes("batch-ok-1") && String(textOut).includes("B"));

// 对照：同样两个 task 都不声明 scope → 两个都 spawn 且都 completed（证明上面的 error 由 scope 引起）
const spawned2: any[] = [];
const ctx2: any = {
  ...ctx,
  subagents: {
    async startActivation(spec: any) {
      spawned2.push(spec);
      return makeSubagentReceipt(
        "child-" + spawned2.length,
        Promise.resolve({ output: [{ type: "text", text: "batch-ok-" + spawned2.length }], stopReason: "completed" }),
      );
    },
  },
};
const batchTool2: any = createDelegateBatchTool(ctx2, () => [], {}, () => ({
  schedule: { maxParallelBatch: 5, wallClockBudgetMs: 5_000 },
}));
let envelope2: any = null;
const exec2: any = makeToolRunContext({
  agent: { id: "p-granularity-2", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
  signal: new AbortController().signal,
});
exec2.onBatchEvents = (payload: any) => { envelope2 = payload; };
await batchTool2.execute({
  tasks: [
    { id: "A", skill: "co-fixer", prompt: "任务 A：未声明粒度" },
    { id: "B", skill: "co-fixer", prompt: "任务 B：正常任务" },
  ],
}, exec2);
const results2: any[] = Array.isArray(envelope2?.results) ? envelope2.results : [];
check("对照组：不声明 scope → 两个 task 都 completed",
  results2.length === 2 && results2.every(entry => entry.status === "completed"));
check("对照组：两个 task 都真的 spawn（spawn=2）", spawned2.length === 2);

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
