// dsh-port/test/delegate-p1.ts —— P1 单测（fake subagents + fake ctx，无需 LLM）
// 覆盖：环境契约注入（enabled/text）、可配置重试（maxRetries/未知 reason）、
//       delegate 路由不回归（agentOptions 覆盖 / provider 不可用继承父模型）。
// 用法：bun run test/delegate-p1.ts（或 node test/delegate-p1.ts，node >= 24 类型剥离）
import { createDelegateTool, DELEGATE_PERSONA } from "../src/delegate.ts";

/** delegate 注入的特有标记：技能内容里 P0 已有「## 执行器环境契约」段落，故用带围栏的「--- … ---」区分 */
const DELEGATE_CONTRACT_MARKER = "--- 执行器环境契约（通用原则 + 探测式自适应） ---";

/**
 * fake subagents 服务的版本形态：
 * - "0.2.1"（默认）：只提供 startActivation(spec)，**不提供 start**——与宿主真实运行时一致，
 *   这样任何残留的 ctx.subagents.start(...) 调用都会像生产环境一样炸掉，而不是被桩掩盖。
 * - "0.2.0"：只提供 start(provider, request)，用于验证回退分支不回归。
 */
type SubagentsFlavor = "0.2.1" | "0.2.0";

interface MakeCtxOptions {
  flavor?: SubagentsFlavor;
  /** 原始 spec 捕获数组（0.2.1 路径下断言 persona 前置 / delivery 用） */
  rawSpecs?: any[];
  /** 原始 start 参数捕获数组（0.2.0 路径下断言 persona 原生字段用） */
  rawRequests?: any[];
}

/** 0.2.1 路径下把 persona 从 prompt 首块剥离，还原成「逻辑 request」交给各用例的 startImpl */
function toLogicalRequest(spec: any) {
  const prompt: any[] = Array.isArray(spec?.request?.prompt) ? spec.request.prompt : [];
  const headIsPersona = prompt.length > 1 && prompt[0]?.type === "text" && prompt[0]?.text === DELEGATE_PERSONA;
  return {
    label: spec?.label,
    prompt: headIsPersona ? prompt.slice(1) : prompt,
    parent: spec?.request?.parent,
    ...(spec?.request?.agentOptions !== undefined ? { agentOptions: spec.request.agentOptions } : {}),
    signal: spec?.signal,
    delivery: spec?.delivery,
    provider: spec?.provider,
    persona: headIsPersona ? DELEGATE_PERSONA : undefined,
  };
}

/** fake ctx：只提供 delegate 用到的 subagents / llm.listProviders / llm.listModels
 *（resolveModelInfo 可选：只有 reasoningEffort 预校验用得到） */
function makeCtx(
  startImpl: (req: any) => any,
  providers: any[] = [],
  modelsByProvider?: Record<string, any[] | Error>,
  resolveModelInfo?: (provider: string, model: string) => Promise<any>,
  options: MakeCtxOptions = {},
) {
  const flavor = options.flavor ?? "0.2.1";
  const rawSpecs = options.rawSpecs ?? [];
  const rawRequests = options.rawRequests ?? [];

  const subagents: any = {};
  if (flavor === "0.2.1") {
    // 真实 0.2.1 运行时契约：startActivation(spec) → { childId, messageId?, result, dispose }
    subagents.startActivation = async (spec: any) => {
      rawSpecs.push(spec);
      const run = await startImpl(toLogicalRequest(spec));
      return {
        childId: run?.id ?? "child-1",
        messageId: "msg-1",
        result: run?.result ?? Promise.resolve({ output: [], stopReason: "completed" }),
        async dispose() { run?.dispose?.(); },
      };
    };
  } else {
    // 0.2.0 契约：start(provider, request) → { id, result, dispose }
    subagents.start = async (_transport: string, req: any) => {
      rawRequests.push(req);
      return startImpl(req);
    };
  }

  return {
    llm: {
      listProviders: () => providers,
      async listModels(provider: string) {
        if (modelsByProvider === undefined) throw new Error("listModels 未在本次测试中提供");
        if (!Object.prototype.hasOwnProperty.call(modelsByProvider, provider)) {
          throw new Error('provider "' + provider + '" not owned');
        }
        const models = modelsByProvider[provider];
        if (models instanceof Error) throw models;
        return models;
      },
      ...(resolveModelInfo ? { resolveModelInfo } : {}),
    },
    subagents,
    _rawSpecs: rawSpecs,
    _rawRequests: rawRequests,
  };
}

function makeExec() {
  return { agent: { id: "parent-1" }, signal: new AbortController().signal };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}

// ---- 用例 1：环境契约注入 ----
{
  console.log("===== 用例 1：环境契约注入 =====");
  let captured: string[] = [];
  const start = (req: any) => {
    captured.push(req.prompt[0].text);
    return { id: "c1", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [{ id: "deepseek-official" }]);

  // enabled=true（默认）
  const toolOn = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "deepseek-official", model: "m1" }]);
  await toolOn.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("enabled=true 注入 delegate 契约标记", captured[0].includes(DELEGATE_CONTRACT_MARKER));
  check("enabled=true 注入「先验证再批量」", captured[0].includes("先验证再批量"));
  check("enabled=true 注入「探测流程」", captured[0].includes("探测流程"));
  // P4-2：契约新增「工具批处理」通用原则（无依赖调用打包 / shell 合并 / 串行留白场景）
  check("契约含「工具批处理」原则", captured[0].includes("工具批处理"));
  check("契约说明无依赖只读调用可打包同批", captured[0].includes("无依赖") && captured[0].includes("同一批"));
  check("契约要求 shell 命令合并而非拆多次", captured[0].includes("不要拆成多次 shell 调用"));
  check("契约点明批处理不等于并行加速", captured[0].includes("不等于并行加速"));
  check("契约列出串行留白场景（同文件写 / 依赖前序结果）",
    captured[0].includes("同一文件的写操作") && captured[0].includes("取决于前一个调用的结果"));
  check("原有三条原则未因新增而丢失",
    captured[0].includes("自包含") && captured[0].includes("先验证再批量") && captured[0].includes("错误可回传"));

  // enabled=false：技能内容本身（P0）可能已含契约段落，只要求不含 delegate 注入标记
  captured = [];
  const toolOff = createDelegateTool(ctx, () => [], { delegateEnvContract: { enabled: false } });
  await toolOff.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("enabled=false 不含 delegate 契约标记", !captured[0].includes(DELEGATE_CONTRACT_MARKER));
  check("enabled=false 不含「--- 你的具体任务 ---」外的额外分隔（任务正常拼接）", captured[0].includes("--- 你的具体任务 ---"));

  // text 覆盖
  captured = [];
  const toolCustom = createDelegateTool(ctx, () => [], {
    delegateEnvContract: { enabled: true, text: "部署自定义契约文本 ABC123" },
  });
  await toolCustom.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("text 覆盖生效（不再用默认探测文本）", captured[0].includes("部署自定义契约文本 ABC123"));
  check("text 覆盖后不含默认探测短语", !captured[0].includes("最小探针依次尝试候选写法"));
}

// ---- 用例 2：maxRetries=0 中止即抛错且 cause.stopReason 存在 ----
{
  console.log("===== 用例 2：maxRetries=0 中止即抛错（保持现状） =====");
  let spawnCount = 0;
  const start = () => {
    spawnCount++;
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "partial work" }], stopReason: "aborted" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 0 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("抛错", !!err);
  check("spawn 次数 = 1（不重试）", spawnCount === 1);
  check("err.cause.stopReason === aborted", err?.cause?.stopReason === "aborted");
  check("err.cause.skill === co-fixer", err?.cause?.skill === "co-fixer");
  check("err.cause.retries === 0", err?.cause?.retries === 0);
  check("err.cause.partial 含已完成部分", typeof err?.cause?.partial === "string" && err.cause.partial.includes("partial work"));
}

// ---- 用例 3：maxRetries=2 中止重试 ≤2 次，重试 prompt 含 [重试 #n] ----
{
  console.log("===== 用例 3：maxRetries=2 自动重试 =====");
  let spawnCount = 0;
  const prompts: string[] = [];
  const start = (req: any) => {
    spawnCount++;
    prompts.push(req.prompt[0].text);
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "partial-" + spawnCount }], stopReason: "aborted" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 2, retryDelayMs: 1 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("spawn 次数 = 3（1 初始 + 2 重试）", spawnCount === 3);
  check("重试 prompt #1 含 [重试 #1]", prompts[1]?.includes("[重试 #1]"));
  check("重试 prompt #2 含 [重试 #2]", prompts[2]?.includes("[重试 #2]"));
  check("重试 prompt 含原因 aborted", prompts[1]?.includes("aborted") && prompts[2]?.includes("aborted"));
  check("重试 prompt 含已完成部分", prompts[1]?.includes("partial-1") && prompts[2]?.includes("partial-2"));
  check("err.cause.retries === 2", err?.cause?.retries === 2);
}

// ---- 用例 4：未知 reason 即使 maxRetries>0 也不重试 ----
{
  console.log("===== 用例 4：未知 reason 不重试（保守） =====");
  let spawnCount = 0;
  const start = () => {
    spawnCount++;
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "x" }], stopReason: "error" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 3, retryDelayMs: 1 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("spawn 次数 = 1（未知 reason 不重试）", spawnCount === 1);
  check("err.cause.stopReason === error", err?.cause?.stopReason === "error");
  check("err.cause.retries === 0", err?.cause?.retries === 0);
}

// ---- 用例 5：completed 正常返回（不回归） ----
{
  console.log("===== 用例 5：completed 正常返回 =====");
  const start = (req: any) => {
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "完成结果" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => []);
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("返回完成结果", out === "完成结果");
}

// ---- 用例 6：agentOptions 路由不回归 ----
{
  console.log("===== 用例 6：agentOptions 路由不回归 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions, label: req.label, persona: req.persona };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start, [{ id: "deepseek-official" }]), () => [
    { name: "co-fixer", provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 4000 },
  ]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("agentOptions.provider 覆盖", captured?.agentOptions?.provider === "deepseek-official");
  check("agentOptions.model 覆盖", captured?.agentOptions?.model === "deepseek-v4-flash");
  check("agentOptions.maxTokens 覆盖", captured?.agentOptions?.maxTokens === 4000);
  check("label = delegate:co-fixer", captured?.label === "delegate:co-fixer");
}

// ---- 用例 7：provider 不可用则继承父模型（不回归） ----
{
  console.log("===== 用例 7：provider 不可用则继承父模型 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start, [{ id: "other-provider" }]), () => [
    { name: "co-fixer", provider: "not-available", model: "m1" },
  ]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("provider 不可用 → 不传 agentOptions（继承父模型）", captured?.agentOptions === undefined);
}

// ---- 用例 8：只配 provider 未配 model → 回退为该 provider 的首个目录模型（P4-1 核心） ----
{
  console.log("===== 用例 8：未配 model 回退 provider 默认模型 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  // 模拟真实故障场景：route 只有 provider，provider 目录里没有父会话模型 deepseek-flash
  const ctx = makeCtx(start, [{ id: "tokenproto" }], {
    tokenproto: [
      { id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ],
  });
  const tool = createDelegateTool(ctx, () => [{ name: "co-explorer", provider: "tokenproto" }]);
  await tool.execute({ skill: "co-explorer", prompt: "任务" }, makeExec());
  check("agentOptions.provider = tokenproto", captured?.agentOptions?.provider === "tokenproto");
  check("agentOptions.model 回退为首个目录模型", captured?.agentOptions?.model === "deepseek-v4-flash");
  check("不再把 model 留空（避免继承父模型 deepseek-flash）", captured?.agentOptions?.model !== undefined);
}

// ---- 用例 9：未配 model 且 provider 无模型目录 → 降级为不传 model（不抛错） ----
{
  console.log("===== 用例 9：无法解析目录时降级 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [{ id: "ghost" }], { ghost: new Error("listModels boom") });
  const tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "ghost" }]);
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("listModels 抛错时委派仍成功", out === "OK");
  check("降级为不传 model（provider 仍覆盖）", captured?.agentOptions?.provider === "ghost" && captured?.agentOptions?.model === undefined);
}

// ---- 用例 10：空目录同样降级，不影响 provider/maxTokens 覆盖 ----
{
  console.log("===== 用例 10：空目录 + maxTokens 保留 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [{ id: "empty-provider" }], { "empty-provider": [] });
  const tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "empty-provider", maxTokens: 1234 }]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("空目录 → 不传 model", captured?.agentOptions?.model === undefined);
  check("maxTokens 仍被保留", captured?.agentOptions?.maxTokens === 1234);
}

// ---- 用例 11：reasoningEffort 路由（按代理差异化推理强度） ----
{
  console.log("===== 用例 11：reasoningEffort 路由 =====");
  let captured: any = null;
  const warns: string[] = [];
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  // 模型目录：m1 支持 low/high（defaultEffort=high）；m2 完全不暴露难度档位；m3 查询抛错
  const ctx: any = makeCtx(start, [{ id: "p1" }], { p1: [{ id: "m1", name: "m1" }] }, async (provider: string, model: string) => {
    if (model === "m1") {
      return { provider, id: model, name: "m1", reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "high" } };
    }
    if (model === "m2") return { provider, id: model, name: "m2" };
    throw new Error("resolveModelInfo boom");
  });
  ctx.logger = { info() {}, warn: (m: any) => warns.push(String(m)) };

  // ① provider + model + reasoningEffort：全部传给子代理
  let tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "p1", model: "m1", reasoningEffort: "low" }]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("provider/model/reasoningEffort 同时传递",
    captured?.agentOptions?.provider === "p1" && captured?.agentOptions?.model === "m1" && captured?.agentOptions?.reasoningEffort === "low");

  // ② 只配 reasoningEffort（不配 provider/model）→ 交出部分 options，provider/model 由 DSH 继承父会话
  tool = createDelegateTool(ctx, () => [{ name: "co-explorer", reasoningEffort: "high" }]);
  await tool.execute({ skill: "co-explorer", prompt: "任务" }, makeExec());
  check("只配 reasoningEffort → agentOptions = { reasoningEffort }",
    JSON.stringify(captured?.agentOptions) === JSON.stringify({ reasoningEffort: "high" }));
  check("只配强度时不写入 provider/model 键",
    !("provider" in (captured?.agentOptions ?? {})) && !("model" in (captured?.agentOptions ?? {})));

  // ③ 目标模型不支持该档位 → fail-soft 丢弃强度 + 告警，委派照常成功
  tool = createDelegateTool(ctx, () => [{ name: "co-planner", provider: "p1", model: "m2", reasoningEffort: "low" }]);
  const outUnsupported = await tool.execute({ skill: "co-planner", prompt: "任务" }, makeExec());
  check("模型无 reasoning 元数据 → 丢弃强度但保留 provider/model",
    outUnsupported === "OK" && captured?.agentOptions?.provider === "p1"
    && captured?.agentOptions?.model === "m2" && captured?.agentOptions?.reasoningEffort === undefined);
  check("丢弃强度时记录告警", warns.some(w => w.includes("不支持推理强度")));

  // ④ 档位不在模型 efforts 里 → 同样丢弃
  tool = createDelegateTool(ctx, () => [{ name: "co-oracle", provider: "p1", model: "m1", reasoningEffort: "ultra" }]);
  await tool.execute({ skill: "co-oracle", prompt: "任务" }, makeExec());
  check("档位不在 efforts 列表 → 丢弃强度", captured?.agentOptions?.reasoningEffort === undefined);

  // ⑤ 目录查询抛错（无法判定）→ 放行，不因查询失败丢用户配置
  tool = createDelegateTool(ctx, () => [{ name: "co-oracle", provider: "p1", model: "m3", reasoningEffort: "high" }]);
  await tool.execute({ skill: "co-oracle", prompt: "任务" }, makeExec());
  check("resolveModelInfo 抛错 → 强度照传（fail-open）", captured?.agentOptions?.reasoningEffort === "high");

  // ⑥ 空串 / 纯空白 = 未配置（设置页清空字段会写回 ""）
  tool = createDelegateTool(ctx, () => [{ name: "co-fixer", reasoningEffort: "" }, { name: "co-explorer", reasoningEffort: "   " }]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  // 归一化（normalizeReasoningEffort）已把空串/纯空白折成 undefined，故此后的行为应是
  // 「P1-2 分层默认值回落」而非「不传 agentOptions」：co-fixer 只有 maxTokens，co-explorer 回落到 low。
  check("空串 reasoningEffort 归一为未配置（不含 reasoningEffort 键，仅分层默认 maxTokens）",
    captured?.agentOptions?.reasoningEffort === undefined && captured?.agentOptions?.maxTokens === 8192);
  await tool.execute({ skill: "co-explorer", prompt: "任务" }, makeExec());
  check("纯空白 reasoningEffort 归一为未配置（回落到分层默认 low，不把空白串传给 DSH）",
    captured?.agentOptions?.reasoningEffort === "low");

  // ⑦ provider 配了但不可用 + 配了强度 → 连强度一起继承（保守，避免父模型不支持的硬失败）
  tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "not-available", reasoningEffort: "low" }]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("provider 不可用 → 不传 agentOptions（强度一并忽略）", captured?.agentOptions === undefined);
  check("provider 不可用时记录强度被忽略的告警", warns.some(w => w.includes("一并忽略")));

  // ⑧ maxTokens 与强度并存（既有覆盖不回归）
  tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "p1", model: "m1", maxTokens: 900, reasoningEffort: "high" }]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("maxTokens 与 reasoningEffort 同时保留",
    captured?.agentOptions?.maxTokens === 900 && captured?.agentOptions?.reasoningEffort === "high");
}

// ---- 用例 12：DSH 0.2.1 —— fake ctx 只提供 startActivation，不提供 start ----
// 这是本用例集的核心防线：如果 delegate 仍直接调用 ctx.subagents.start(...)，
// 这里会像生产环境一样抛 "ctx.subagents.start is not a function"，而不是被桩掩盖。
{
  console.log("===== 用例 12：0.2.1 仅 startActivation（无 start）delegate 仍可用 =====");
  const rawSpecs: any[] = [];
  let spawnCount = 0;
  const start = (req: any) => {
    spawnCount++;
    return { id: "child-42", result: Promise.resolve({ output: [{ type: "text", text: "0.2.1 完成" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [{ id: "deepseek-official" }], undefined, undefined, { flavor: "0.2.1", rawSpecs });
  check("桩里确实没有 start 方法", typeof (ctx as any).subagents.start === "undefined");
  check("桩里提供 startActivation", typeof (ctx as any).subagents.startActivation === "function");

  const tool = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "deepseek-official", model: "m1" }]);
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("delegate 正常返回结果", out === "0.2.1 完成");
  check("spawn 次数 = 1", spawnCount === 1);

  const spec = rawSpecs[0];
  check("spec.provider === spawn（transport 名）", spec?.provider === "spawn");
  check("delivery 显式传 caller（不用默认 parent）", spec?.delivery === "caller");
  check("label 在 spec 顶层（不在 request 内）", spec?.label === "delegate:co-fixer" && spec?.request?.label === undefined);
  check("signal 在 spec 顶层", spec?.signal instanceof AbortSignal || typeof spec?.signal?.aborted === "boolean");
  check("request 不含 persona 字段（persona 前置到 prompt 首块）", spec?.request && !("persona" in spec.request));
  // P1-1：toolFilter 仍被 SubagentStartRequest 接受（只是不再经模型工具层暴露），
  // 故 delegate 现在按角色透传 deny 裁剪；co-fixer 属写类：不含 write，但含 subagent_fork。
  check("request 透传 toolFilter（按角色 deny 裁剪）",
    spec?.request?.toolFilter?.deny?.includes("subagent_fork") === true
    && spec?.request?.toolFilter?.deny?.includes("write") !== true);
  check("persona 前置为 prompt 首个 text 块", spec?.request?.prompt?.[0]?.type === "text" && spec?.request?.prompt?.[0]?.text === DELEGATE_PERSONA);
  check("任务 prompt 顺延为第二块", spec?.request?.prompt?.[1]?.type === "text" && spec.request.prompt[1].text.includes("--- 你的具体任务 ---"));
  check("agentOptions 落到 request 内", spec?.request?.agentOptions?.provider === "deepseek-official");
}

// ---- 用例 13：DSH 0.2.0 回退 —— fake ctx 只提供 start，不提供 startActivation ----
{
  console.log("===== 用例 13：0.2.0 回退分支（仅 start） =====");
  const rawRequests: any[] = [];
  let spawnCount = 0;
  const start = (req: any) => {
    spawnCount++;
    return { id: "run-7", result: Promise.resolve({ output: [{ type: "text", text: "0.2.0 完成" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [], undefined, undefined, { flavor: "0.2.0", rawRequests });
  check("桩里没有 startActivation（走回退分支）", typeof (ctx as any).subagents.startActivation === "undefined");

  const tool = createDelegateTool(ctx, () => []);
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("0.2.0 回退路径正常返回", out === "0.2.0 完成");
  check("spawn 次数 = 1", spawnCount === 1);
  const req = rawRequests[0];
  check("0.2.0 保留 persona 原生字段", req?.persona === DELEGATE_PERSONA);
  check("0.2.0 prompt 未被前置 persona（单块）", req?.prompt?.length === 1 && req.prompt[0].text.includes("--- 你的具体任务 ---"));
  check("0.2.0 label 在 request 内", req?.label === "delegate:co-fixer");
  check("0.2.0 传了 signal", req?.signal !== undefined);
}

// ---- 用例 14：0.2.1 无 subagents 服务 → fail loud（不静默） ----
{
  console.log("===== 用例 14：缺 subagents 服务时 fail loud =====");
  const tool = createDelegateTool({ llm: { listProviders: () => [] } } as any, () => []);
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("缺 subagents 抛错", !!err);
  check("错误信息点名 startSubagentRun 需要 subagents 服务",
    String(err?.message ?? "").includes("startSubagentRun requires the subagents service"));
}

// ---- 用例 15：错误诊断透传（SubagentResult.diagnostic） ----
{
  console.log("===== 用例 15：错误诊断透传 =====");
  const DIAG = "provider returned 400: Illegal API invocation from an unapproved channel";
  const start = () => ({
    id: "diag-run",
    result: Promise.resolve({
      output: [{ type: "text", text: "半成品" }],
      stopReason: "error",
      diagnostic: DIAG,
    }),
    dispose() {},
  });
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 0 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  const msg = String(err?.message ?? "");
  check("抛错", !!err);
  check("错误消息含 diagnostic 原文", msg.includes(DIAG));
  check("错误消息含 diagnostic: 标签", msg.includes("diagnostic: " + DIAG));
  check("错误消息仍保留 stopReason 原文", msg.includes('stopped with reason "error"'));
  check("err.cause.diagnostic === 原文", err?.cause?.diagnostic === DIAG);
  check("err.cause.stopReason 未被 diagnostic 污染", err?.cause?.stopReason === "error");

  // 无 diagnostic 时不引入噪音（不回归）
  const startNoDiag = () => ({
    id: "nod", result: Promise.resolve({ output: [], stopReason: "error" }), dispose() {},
  });
  const tool2 = createDelegateTool(makeCtx(startNoDiag), () => [], { delegateRetry: { maxRetries: 0 } });
  let err2: any = null;
  try { await tool2.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err2 = e; }
  check("无 diagnostic 时消息不含 diagnostic 字样", !String(err2?.message ?? "").includes("diagnostic"));
  check("无 diagnostic 时 cause 不含该字段", err2?.cause?.diagnostic === undefined);
}

// ---- 用例 16：diagnostic 不破坏可重试原因判定 ----
{
  console.log("===== 用例 16：diagnostic 不污染 RETRYABLE 匹配 =====");
  const start = () => ({
    id: "r",
    result: Promise.resolve({
      output: [{ type: "text", text: "partial work" }],
      stopReason: "aborted",
      diagnostic: "aborted by watchdog",
    }),
    dispose() {},
  });
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 1, retryDelayMs: 1 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  // 若 diagnostic 被拼进 lastReason，RETRYABLE.has("aborted; diagnostic: ...") 会为 false → 不重试
  check("aborted + diagnostic 仍按可重试处理（cause.retries === 1）", err?.cause?.retries === 1);
  check("cause.stopReason 保持纯 aborted", err?.cause?.stopReason === "aborted");
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);