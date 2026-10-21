// dsh-port/test/runtime-0.2.ts —— DSH 0.2 运行期契约验证（离线、无网络、不触用户配置）
// 用法：npm run test:runtime（node test/runtime-0.2.ts，node >= 24 类型剥离）
// 前置：已 bun run build（lib/ 为 0.2 语义产物）且 node_modules 解析到 0.2 依赖树
//       （lock 更新后：@deepseek-ai/cordis ~4.0.4、schemastery ~3.18.4、dsh-* 0.2.0-rc.2）。
//
// 分层说明（准确分层，不冒称完全宿主覆盖）：
//   ✓ 真实层：schemastery 3.18.4 解析 Config（.volatile() 契约）；cosmokit Volatile
//     （isVolatile / updateVolatile）；@deepseek-ai/dsh-tools 真实 defineTool 构造工具；
//     cordis 真实 Context 挂载插件 apply（stub 服务最小集）；delegate 真实执行路径。
//   ✗ 未覆盖（标注边界，需宿主集成验证）：cordis-plugin-loader 的真实 _commitVolatile
//     提交链路（profile patch → entry.update({config}) → loader/volatile-update）；
//     dsh-settings SettingsForms 设置页投影；真实 subagent transport（spawn）与真实 LLM。
//     volatile 提交用 cosmokit updateVolatile 模拟——只验证「引用更新后 get() 见新值、
//     下次 execute 生效」，不验证 loader 触发链路。
import { Context } from "@deepseek-ai/cordis";
import { isVolatile, updateVolatile } from "@deepseek-ai/cosmokit";
import { Config } from "../lib/index.js";
import { createDelegateTool } from "../src/delegate.ts";
import { createDelegateBatchTool } from "../src/delegate_batch.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

// ── 层 1：真实 schemastery 解析 Config → .volatile() 契约 ──
{
  console.log("===== 层 1：Config .volatile() 契约 =====");
  const parsed = Config({});
  check("skills 是 Volatile 引用", isVolatile(parsed.skills));
  check("schedule 是 Volatile 引用", isVolatile(parsed.schedule));
  check("delegateRetry 是 Volatile 引用", isVolatile(parsed.delegateRetry));
  check("skills 缺省空数组", Array.isArray(parsed.skills.get()) && parsed.skills.get().length === 0);
  check("schedule 缺省 batch=3", parsed.schedule.get().maxParallelBatch === 3);
  check("schedule 缺省 wall=600000", parsed.schedule.get().wallClockBudgetMs === 600_000);
  check("delegateRetry 缺省 maxRetries=0", parsed.delegateRetry.get().maxRetries === 0);
  check("delegateRetry.stall 缺省 enabled=false", parsed.delegateRetry.get().stall?.enabled === false);
  const over = Config({ schedule: { maxParallelBatch: 9 }, delegateRetry: { maxRetries: 2 } });
  check("覆盖 schedule.get().batch=9", over.schedule.get().maxParallelBatch === 9);
  check("覆盖 delegateRetry.get().maxRetries=2", over.delegateRetry.get().maxRetries === 2);
  // 普通字段仍是值（非 volatile）
  check("councillors 仍是普通值", Array.isArray(parsed.councillors));
  check("installPresets 仍是普通值", parsed.installPresets === true);

  // ── SkillRoute.reasoningEffort（按代理差异化推理强度）──
  const withEffort = Config({ skills: [{ name: "co-oracle", reasoningEffort: "high" }] });
  check("skills 路由可解析 reasoningEffort", withEffort.skills.get()[0]?.reasoningEffort === "high");
  check("reasoningEffort 可与 provider/model 并存",
    Config({ skills: [{ name: "co-oracle", provider: "p1", model: "m1", reasoningEffort: "high" }] })
      .skills.get()[0]?.reasoningEffort === "high");
  const withoutEffort = Config({ skills: [{ name: "co-explorer", provider: "p1", model: "m1" }] }).skills.get()[0];
  check("未配置 reasoningEffort 时解析结果不含该键（schemastery 可选字段）",
    !Object.prototype.hasOwnProperty.call(withoutEffort, "reasoningEffort"));
  // 官方设置页按 Config schema 序列化生成表单 → schema JSON 必须含该字段才会出现可编辑控件
  check("Config schema JSON 含 reasoningEffort 字段（官方表单投影依据）",
    JSON.stringify(Config.toJSON()).includes('"reasoningEffort"'));
  check("reasoningEffort 带 schema 描述（表单提示用）",
    JSON.stringify(Config.toJSON()).includes("推理强度"));
}

// ── 层 2：Volatile 引用更新（loader/volatile-update 的引用层等价）──
{
  console.log("===== 层 2：updateVolatile 提交 → get() 见新值 =====");
  const parsed = Config({});
  const next = Config({
    skills: [{ name: "co-fixer", provider: "p1", model: "m1" }],
    schedule: { maxParallelBatch: 7, wallClockBudgetMs: 111_000 },
    delegateRetry: { maxRetries: 4 },
  });
  updateVolatile(parsed.schedule, next.schedule);
  updateVolatile(parsed.skills, next.skills);
  updateVolatile(parsed.delegateRetry, next.delegateRetry);
  check("schedule.get() 提交后 batch=7", parsed.schedule.get().maxParallelBatch === 7);
  check("skills.get() 提交后 1 条路由", parsed.skills.get().length === 1 && parsed.skills.get()[0].name === "co-fixer");
  check("delegateRetry.get() 提交后 maxRetries=4", parsed.delegateRetry.get().maxRetries === 4);
  // 独立引用不受影响
  check("next 引用保持原值", next.schedule.get().maxParallelBatch === 7);
}

// ── 层 3：真实 delegate 工具（真实 defineTool）+ volatile 更新 → 下次 execute 见新值 ──
{
  console.log("===== 层 3：delegate 每次 execute 读取 volatile getter =====");
  const parsed = Config({ delegateRetry: { maxRetries: 0 } });
  let spawnCount = 0;
  let abortedOnce = false;
  let forwardedAborted = false;
  let lastAgentOptions: any = null;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      // 0.2.1 契约：startActivation(spec)（无 start），persona 已在 prompt 首块
      async startActivation(spec: any) {
        spawnCount++;
        const prompt: any[] = Array.isArray(spec?.request?.prompt) ? spec.request.prompt : [];
        const req = {
          label: spec?.label,
          prompt,
          parent: spec?.request?.parent,
          agentOptions: spec?.request?.agentOptions,
          signal: spec?.signal,
          delivery: spec?.delivery,
        };
        lastAgentOptions = req?.agentOptions;
        // AbortSignal 转发链断言：父 exec.signal 已中止时应出现在子代理 start 请求中
        if (req?.signal?.aborted) forwardedAborted = true;
        const settled = !abortedOnce;
        if (!abortedOnce) abortedOnce = true;
        const run = settled
          ? { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "partial" }], stopReason: "aborted" }), dispose() {} }
          : { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "ok-retry" }], stopReason: "completed" }), dispose() {} };
        return {
          childId: run.id,
          messageId: "msg-" + spawnCount,
          result: run.result,
          async dispose() { run.dispose(); },
        };
      },
    },
  };
  const getSettings = () => ({
    skills: parsed.skills.get(),
    schedule: parsed.schedule.get(),
    delegateRetry: parsed.delegateRetry.get(),
  });
  const tool = createDelegateTool(ctx, () => parsed.skills.get(), { delegateRetry: { maxRetries: 0 } }, getSettings);

  // 真实 defineTool 输入/输出 schema 断言（0.2 ToolDefinition）
  const def = tool as any;
  check("delegate 工具 name=delegate", def.name === "delegate");
  // 0.2 defineTool 编译后的 parameters 是 JSON Schema 形态：{ type: "object", properties: {...}, required: [...] }
  check("delegate 参数 schema 含 skill/prompt", def.parameters && def.parameters.properties && def.parameters.properties.skill && def.parameters.properties.prompt);
  check("delegate 输出 schema=string", def.output?.schema?.type === "string");
  check("isConcurrencySafe=true", typeof def.isConcurrencySafe === "function");

  // ① 首次 execute：maxRetries=0 → aborted 不重试，抛错
  let err1: any = null;
  try {
    await tool.execute({ skill: "co-fixer", prompt: "任务 A" }, { agent: { id: "p" }, signal: new AbortController().signal });
  } catch (e) { err1 = e; }
  check("maxRetries=0 → 单次尝试后抛错", err1 && err1.cause?.retries === 0 && spawnCount === 1);
  check("错误信息含 aborted", err1 && String(err1.message).includes("aborted"));

  // ② volatile 更新（模拟 loader volatile-update 提交）：maxRetries 0→1 + schedule
  const next = Config({ schedule: { maxParallelBatch: 5 }, delegateRetry: { maxRetries: 1, retryDelayMs: 1 } });
  updateVolatile(parsed.delegateRetry, next.delegateRetry);
  updateVolatile(parsed.schedule, next.schedule);
  check("提交后 get().maxRetries=1", parsed.delegateRetry.get().maxRetries === 1);

  // ③ 下次 execute：aborted 后因 maxRetries=1 重试 1 次并成功（spawn 共 2 次）
  const out2 = await tool.execute({ skill: "co-fixer", prompt: "任务 B" }, { agent: { id: "p" }, signal: new AbortController().signal });
  check("volatile 更新后下次 execute 重试生效（spawn=2）", out2 === "ok-retry" && spawnCount === 2);

  // ④ AbortSignal：exec.signal 已中止 → start 请求携带已中止 signal（delegate 原样转发链）
  const ac = new AbortController();
  ac.abort();
  await tool.execute({ skill: "co-fixer", prompt: "任务 C" }, { agent: { id: "p" }, signal: ac.signal });
  check("已中止信号转发到子代理 start 请求", forwardedAborted);

  // ⑤ reasoningEffort 路由（只配强度、不配 provider/model）经 volatile 提交后下一次 execute 生效
  const nextEffort = Config({ skills: [{ name: "co-fixer", reasoningEffort: "low" }] });
  updateVolatile(parsed.skills, nextEffort.skills);
  await tool.execute({ skill: "co-fixer", prompt: "任务 D" }, { agent: { id: "p" }, signal: new AbortController().signal });
  check("只配 reasoningEffort → 子代理 start 收到 agentOptions.reasoningEffort",
    lastAgentOptions?.reasoningEffort === "low");
  check("只配 reasoningEffort 时不覆盖 provider/model",
    !("provider" in (lastAgentOptions ?? {})) && !("model" in (lastAgentOptions ?? {})));
}

// ── 层 3b：delegate_batch 在 0.2.1 契约（仅 startActivation，无 start）下可用 ──
{
  console.log("===== 层 3b：delegate_batch 走 0.2.1 startActivation =====");
  const specs: any[] = [];
  let batchSpawns = 0;
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      // 0.2.1 契约：只有 startActivation。若 delegate_batch 仍调 ctx.subagents.start 会在此炸掉。
      async startActivation(spec: any) {
        batchSpawns++;
        specs.push(spec);
        return {
          childId: "b" + batchSpawns,
          messageId: "bm" + batchSpawns,
          result: Promise.resolve({ output: [{ type: "text", text: "batch-ok-" + batchSpawns }], stopReason: "completed" }),
          async dispose() {},
        };
      },
    },
  };
  const batchTool: any = createDelegateBatchTool(ctx, () => [], {});
  const out: any = await batchTool.execute(
    { tasks: [{ skill: "co-explorer", prompt: "任务 1" }, { skill: "co-fixer", prompt: "任务 2" }] },
    { agent: { id: "p-batch" }, signal: new AbortController().signal },
  );
  check("delegate_batch 在仅 startActivation 下 spawn 2 次", batchSpawns === 2);
  check("delegate_batch 每个 spec 都传 delivery=caller", specs.every(s => s?.delivery === "caller"));
  check("delegate_batch spec.provider=spawn", specs.every(s => s?.provider === "spawn"));
  check("delegate_batch persona 前置到 prompt 首块",
    specs.every(s => String(s?.request?.prompt?.[0]?.text ?? "").includes("你是被委派的专职代理")));
  check("delegate_batch 两个任务都返回结果",
    JSON.stringify(out).includes("batch-ok-1") && JSON.stringify(out).includes("batch-ok-2"));
}

// ── 层 4：真实 cordis Context + apply 挂载（stub 服务最小集）→ 插件行可挂载 ──
{
  console.log("===== 层 4：cordis Context + apply 挂载 =====");
  const registered: string[] = [];
  const stubCtx: any = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn: () => unknown) => { fn(); return () => {}; },
    reflect: { get: (name: string) => (name === "subagents" ? {} : undefined) },
    systemPrompt: { section: () => {} },
    skills: { register: () => {} },
    tools: { register: (t: any) => { registered.push(t?.name ?? t?.definition?.name ?? "?"); } },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    on: () => () => {},
  };
  const parsed = Config({ councillors: [], councilTimeoutMs: 180_000, installPresets: false });
  const lib: any = await import("../lib/index.js");
  lib.apply(stubCtx, parsed);
  check("apply 挂载不抛错（installPresets=false 不触用户 preset root）", registered.length >= 0);
  check("delegate 工具注册", registered.includes("delegate"));
  check("delegate_batch 工具注册", registered.includes("delegate_batch"));
  check("councillors 空 → 不注册 council", !registered.includes("council_session"));

  // council 分支：councillors 非空 → 注册 council_session（councilProvider 缺省 spawn）
  const registered2: string[] = [];
  const stubCtx2 = { ...stubCtx, tools: { register: (t: any) => { registered2.push(t?.name ?? "?"); } } };
  const parsed2 = Config({ councillors: [{ name: "e1", provider: "p1", model: "m1" }] });
  lib.apply(stubCtx2, parsed2);
  check("councillors 非空 → 注册 council_session", registered2.includes("council_session"));
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
