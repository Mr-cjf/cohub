// dsh-cohub/test/route-degrade.ts —— 模型路由「三处静默降级」的可观测性门禁
//
// 覆盖（对应 src/delegate.ts 的 buildAgentOptions + 可选 onDegrade，以及两个调用点）：
//   ① provider 未注册 → 返回文本写清「未注册 / 继承父会话 / 可用清单」，且子代理**仍被 spawn**
//      （证明走的是「继承父会话」的 fail-soft，而不是整次委派失败）；
//   ② 配了 provider 未配 model → 文本写清「回退」，且实际 model === 该 provider 目录首个模型；
//   ③ 配了模型不支持的强度 → 文本写清「不支持 + 支持档位」，运行仍成功且不传 reasoningEffort；
//   ④ 聚合：model 回退 + 强度不支持 两条同时发生时合并渲染成一段「降级提示：…」；
//   ⑤ 零噪音：onDegrade 缺省时 buildAgentOptions 返回值与旧行为逐字一致；且「route 完全未命中」
//      （skill 没配路由）在 delegate / delegate_batch 的返回文本里**不出现**任何路由降级提示。
//   ⑥ delegate_batch 每 task 独立降级槽：两个 task 各触发一种降级，互不串味。
//
// 全部用与 test/runtime-0.2.ts / test/batch-events.ts 同构的 `ctx.subagents.startActivation`
// 桩驱动：离线、不触网络、不触用户配置、不写盘，也不真的派子代理。
// 用法：node test/route-degrade.ts（node >= 24 类型剥离）
import { createDelegateTool, buildAgentOptions } from "../src/delegate.ts";
import type { SkillRouteConfig } from "../src/delegate.ts";
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

/** 子代理桩的返回形状（只复刻 src 真正读取的字段） */
type StubOutcome = { output: Array<{ type: string; text: string }>; stopReason: string };
const COMPLETED = (text: string): StubOutcome => ({ output: [{ type: "text", text }], stopReason: "completed" });

/** 桩环境：只提供 buildAgentOptions 会用到的 llm 只读查询 + delegate 用到的 subagents。 */
interface CtxOptions {
  /** llm.listProviders() 返回的 provider id（**故意只给一部分**：真实场景里用户配了没装的 provider） */
  providers: string[];
  /** provider → 模型目录（string[] = 正常目录；Error = listModels 抛错） */
  models?: Record<string, string[] | Error>;
  /** model → 支持的推理强度档位（"none" = 不暴露任何档位；"throw" = 查询抛错） */
  efforts?: Record<string, string[] | "none" | "throw">;
}

function makeStubCtx(options: CtxOptions) {
  const spawned: any[] = [];
  const ctx: any = {
    logger: { info() {}, warn() {} },
    llm: {
      listProviders: () => options.providers.map((id) => ({ id })),
      async listModels(provider: string) {
        const models = options.models?.[provider];
        if (models instanceof Error) throw models;
        return (models ?? []).map((id) => ({ id, name: id }));
      },
      async resolveModelInfo(provider: string, model: string) {
        const efforts = options.efforts?.[model];
        if (efforts === "throw") throw new Error("resolveModelInfo boom");
        if (efforts === "none" || efforts === undefined) return { provider, id: model, name: model };
        return { provider, id: model, name: model, reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } };
      },
    },
    subagents: {
      async startActivation(spec: any) {
        spawned.push(spec);
        // 与真实 0.2.2-rc.3 契约对齐：顶层必须双写 parent/prompt
        if (!spec?.parent || !spec?.prompt) {
          throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
        }
        return {
          childId: "rd" + spawned.length,
          messageId: "rdm" + spawned.length,
          result: Promise.resolve(COMPLETED("OK")),
          async dispose() {},
        };
      },
    },
  };
  return { ctx, spawned };
}

function makeExec() {
  // delegationDepth: 0 = 主代理（depth guard fail-closed 后，桩必须显式声明身份）
  return makeToolRunContext({
    agent: { id: "parent-route-degrade", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
    signal: new AbortController().signal,
  });
}

/** 跑一次真实 delegate 工具（子代理换成本地桩），回传返回文本 + 实际投递的 agentOptions。 */
async function runDelegate(options: CtxOptions & { routes: SkillRouteConfig[]; skill?: string }) {
  const { ctx, spawned } = makeStubCtx(options);
  const tool: any = createDelegateTool(ctx, () => options.routes);
  const text: string = await tool.execute(
    { skill: options.skill ?? "co-fixer", prompt: "测试任务" },
    makeExec(),
  );
  return { text, agentOptions: spawned[0]?.agentOptions, spawns: spawned.length };
}

/** 跑一次真实 delegate_batch 工具（子代理换成本地桩），回传返回文本 + 结构化事件包。 */
async function runBatch(options: CtxOptions & { routes: SkillRouteConfig[]; tasks: any[] }) {
  const { ctx, spawned } = makeStubCtx(options);
  const envelopes: any[] = [];
  const tool: any = createDelegateBatchTool(ctx, () => options.routes, {});
  const text: string = await tool.execute(
    { tasks: options.tasks },
    {
      agent: { id: "p-route-degrade", session: { header: makeSessionHeader({ delegationDepth: 0 }) } },
      signal: new AbortController().signal,
      onBatchEvents: (envelope: any) => { envelopes.push(envelope); },
    },
  );
  return { text, envelope: envelopes[0], spawns: spawned.length };
}

// ---- 用例 1：provider 未注册 → 可观测 + 走继承（不是失败） ----
{
  group("用例 1：provider 未注册 → 「未注册 / 继承父会话」且子代理仍 spawn");
  const { text, agentOptions, spawns } = await runDelegate({
    providers: ["deepseek-official", "tokenproto"],
    routes: [{ name: "co-fixer", provider: "not-available", model: "m1", reasoningEffort: "high" }],
  });
  check("返回文本含「未注册」", text.includes("未注册"));
  check("返回文本含「继承父会话」", text.includes("继承父会话"));
  check("返回文本列出可用 provider（可操作）", text.includes("可用：deepseek-official/tokenproto"));
  check("返回文本回显用户配置的 provider 名", text.includes('"not-available"'));
  check("agentOptions 缺省（provider/model 全部未生效）", agentOptions === undefined);
  check("子代理仍被 spawn（走继承而非失败）", spawns === 1);
}

// ---- 用例 2：未配 model → 回退到目录首个模型 ----
{
  group("用例 2：未配 model → 「回退」且实际用目录首个模型");
  const { text, agentOptions } = await runDelegate({
    providers: ["tokenproto"],
    models: { tokenproto: ["deepseek-v4-flash", "deepseek-v4-pro"] },
    routes: [{ name: "co-fixer", provider: "tokenproto" }],
  });
  check("返回文本含「回退」", text.includes("回退"));
  check("返回文本写明回退到的模型", text.includes("deepseek-v4-flash"));
  check("实际投递 model = 目录首个", agentOptions?.model === "deepseek-v4-flash");
  check("provider 仍按配置生效", agentOptions?.provider === "tokenproto");
}

// ---- 用例 3：模型不支持配置的强度 → 可观测 + 运行不失败 ----
{
  group("用例 3：强度不被支持 → 「不支持 + 支持档位」，运行仍成功");
  const { text, agentOptions, spawns } = await runDelegate({
    providers: ["p1"],
    models: { p1: ["m1"] },
    efforts: { m1: ["off", "low", "high"] },
    routes: [{ name: "co-fixer", provider: "p1", model: "m1", reasoningEffort: "max" }],
  });
  check("返回文本含「不被模型 … 支持」", text.includes("不被模型") && text.includes("支持"));
  check("返回文本回显配置的强度 max", text.includes('"max"'));
  check("返回文本列出支持档位 off/low/high", text.includes("（支持：off/low/high）"));
  check("返回文本说明按默认档执行", text.includes("默认档"));
  check("运行未失败（返回子代理结果开头为 OK）", text.startsWith("OK"));
  check("子代理被 spawn", spawns === 1);
  check("不传 reasoningEffort（强度确实没生效）", agentOptions?.reasoningEffort === undefined);
  check("model 仍按配置生效", agentOptions?.model === "m1");
}

// ---- 用例 4：两条降级同时发生的聚合渲染 ----
{
  group("用例 4：model 回退 + 强度不支持 → 合并成一段「降级提示：」");
  const { text } = await runDelegate({
    providers: ["p1"],
    models: { p1: ["m1"] },
    efforts: { m1: ["off", "low", "high"] },
    routes: [{ name: "co-fixer", provider: "p1", reasoningEffort: "max" }],
  });
  check("同时出现「回退」与「不被模型…支持」", text.includes("回退") && text.includes("不被模型"));
  check("多条走「[降级提示：…；…]」段", text.includes("[降级提示：") && text.includes("；"));
  check("只渲染一段（同一运行不重复拼）", (text.match(/\[降级提示：/g) ?? []).length === 1);
}

// ---- 用例 5：零噪音（onDegrade 缺省 / route 完全未命中） ----
{
  group("用例 5：onDegrade 缺省 → 返回值不变；route 未命中 → 无提示（零噪音）");
  const { ctx } = makeStubCtx({
    providers: ["tokenproto"],
    models: { tokenproto: ["deepseek-v4-flash", "deepseek-v4-pro"] },
    efforts: { "deepseek-v4-flash": ["off", "low", "high"] },
  });
  // onDegrade 未传：三处 fail-soft 的返回值必须与改动前一致（不抛错、不发 note）
  const missingProvider = await buildAgentOptions(
    { name: "co-fixer", provider: "not-available", model: "m1" }, ctx, "co-fixer",
  );
  check("provider 未注册：不传 onDegrade 仍返回 undefined", missingProvider === undefined);
  const fallback = await buildAgentOptions({ name: "co-fixer", provider: "tokenproto" }, ctx, "co-fixer");
  check("未配 model：返回值逐字不变（provider + 回退 model）",
    JSON.stringify(fallback) === JSON.stringify({ provider: "tokenproto", model: "deepseek-v4-flash" }));
  const unsupported = await buildAgentOptions(
    { name: "co-fixer", provider: "tokenproto", model: "deepseek-v4-flash", reasoningEffort: "max" },
    ctx, "co-fixer",
  );
  check("强度不支持：返回值逐字不变（不含 reasoningEffort）",
    JSON.stringify(unsupported) === JSON.stringify({ provider: "tokenproto", model: "deepseek-v4-flash" }));

  // route 完全未命中（skill 没配路由）：最常见情况，**故意不提示**，避免每任务噪音
  const delegateNoRoute = await runDelegate({ providers: ["tokenproto"], routes: [] });
  check("delegate route 未命中：返回文本逐字等于子代理输出", delegateNoRoute.text === "OK");
  check("delegate route 未命中：不含任何路由降级文案",
    !delegateNoRoute.text.includes("未注册") && !delegateNoRoute.text.includes("回退")
    && !delegateNoRoute.text.includes("不支持"));
  const batchNoRoute = await runBatch({
    providers: ["tokenproto"],
    routes: [],
    tasks: [{ id: "only", skill: "co-fixer", prompt: "任务" }],
  });
  check("delegate_batch route 未命中：无降级段", !batchNoRoute.text.includes("降级提示"));
  check("delegate_batch route 未命中：结果条目无 degrade 字段",
    batchNoRoute.envelope?.results?.[0] !== undefined
    && batchNoRoute.envelope.results[0].degrade === undefined);
}

// ---- 用例 6：delegate_batch 每 task 独立槽，不跨 task 串味 ----
{
  group("用例 6：delegate_batch 两个 task 各触发一种降级，互不污染");
  const { text, envelope, spawns } = await runBatch({
    providers: ["tokenproto"],
    models: { tokenproto: ["deepseek-v4-flash"] },
    routes: [
      { name: "co-fixer", provider: "ghost" },
      { name: "co-planner", provider: "tokenproto" },
    ],
    tasks: [
      { id: "t-missing", skill: "co-fixer", prompt: "任务A" },
      { id: "t-fallback", skill: "co-planner", prompt: "任务B" },
    ],
  });
  const results: any[] = envelope?.results ?? [];
  check("两个 task 都被 spawn（降级不阻断派发）", spawns === 2);
  check("批级降级段按 taskId 标注", text.includes("t-missing 路由 provider 未注册")
    && text.includes("t-fallback 路由未配置 model"));
  check("t-missing 条目 degrade 含「未注册」", String(results[0]?.degrade ?? "").includes("未注册"));
  check("t-missing 条目 degrade 不含「回退」（不串味）",
    !String(results[0]?.degrade ?? "").includes("回退"));
  check("t-fallback 条目 degrade 含「回退」", String(results[1]?.degrade ?? "").includes("回退"));
  check("t-fallback 条目 degrade 不含「未注册」（不串味）",
    !String(results[1]?.degrade ?? "").includes("未注册"));
  check("两个 task 均 completed（降级不改变成败判定）",
    results[0]?.status === "completed" && results[1]?.status === "completed");
}

console.log("");
if (fail > 0) {
  console.error(`❌ ${fail} 个断言 FAIL（PASS ${pass} / 共 ${pass + fail}）`);
  process.exit(1);
}
console.log(`✅ 全部 PASS（共 ${pass} 个断言）`);
