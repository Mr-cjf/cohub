// dsh-port/test/env-sig-p3.ts —— P3-2（N1 环境契约持久化）单测
// 覆盖：无缓存回退探针式（与 P1 行为一致）、缓存命中确定性契约、指纹变化/TTL 过期回退、
//       manual Config contract 优先于缓存、use=off 不读不写、自动写（confirmCount 达标写出/不达标不写/
//       成功结果推断 moduleLoading）、缓存文件读写失败静默降级。
// 用法：bun run test/env-sig-p3.ts（或 node test/env-sig-p3.ts，node >= 24 类型剥离）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_VERSION, DEFAULT_ERROR_CATEGORIES, classifyEnvContractError, envFingerprint,
  isCacheValid, pickEnvContractText, readEnvSignatures, renderEnvContract, writeEnvSignatures,
  type EnvSignatureCache,
} from "../src/env-signatures.ts";
import { createDelegateTool } from "../src/delegate.ts";

const DELEGATE_DEFAULT_MARKER = "--- 执行器环境契约（通用原则 + 探测式自适应） ---";
const VERIFIED_MARKER = "--- 执行器环境契约（本环境已验证） ---";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeExec() {
  return { agent: { id: "parent-1" }, signal: new AbortController().signal };
}

/** fake ctx：仅 subagents.start / llm.listProviders（无事件总线，供读路径测试） */
function makeCtx(startImpl: (req: any) => any) {
  return {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start(_t: string, req: any) { return startImpl(req); },
    },
  };
}

/** fake ctx + session/event 总线（供自动写测试） */
function makeCtxWithBus(startImpl: (req: any, ctx: any) => any) {
  const listeners = new Set<(...a: any[]) => void>();
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    llm: { listProviders: () => [] },
    subagents: {
      async start(_t: string, req: any) { return startImpl(req, ctx); },
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

function completedRun(text = "OK") {
  return {
    id: "ok",
    result: Promise.resolve({ output: [{ type: "text", text }], stopReason: "completed" }),
    dispose() {},
  };
}

function makeCache(over: { updatedAt?: string; fingerprint?: any; contract?: any; errorSignatures?: string[] } = {}): EnvSignatureCache {
  return {
    version: CACHE_VERSION,
    updatedAt: over.updatedAt ?? new Date().toISOString(),
    fingerprint: over.fingerprint ?? envFingerprint(),
    contract: over.contract ?? { moduleLoading: "await-import", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true },
    errorSignatures: over.errorSignatures ?? ["err:ReferenceError: require is not defined"],
    confirmedCount: 2,
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cohub-envsig-"));
  tmpDirs.push(d);
  return d;
}

// ---- 用例 1：无缓存 → DEFAULT（探针式），与 P1 行为一致 ----
{
  console.log("===== 用例 1：无缓存 → 回退探针式（与 P1 一致） =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json"); // 不存在
  const prompts: string[] = [];
  const ctx = makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", cachePath } });
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("无缓存: 注入 DEFAULT 标记", prompts[0].includes(DELEGATE_DEFAULT_MARKER));
  check("无缓存: 含探针式文本「最小探针依次尝试候选写法」", prompts[0].includes("最小探针依次尝试候选写法"));
  check("无缓存: 含「先验证再批量」", prompts[0].includes("先验证再批量"));
  check("无缓存: 不含「本环境已验证」", !prompts[0].includes("本环境已验证"));
}

// ---- 用例 2：命中缓存（指纹+TTL 有效）→ 确定性契约文本 ----
{
  console.log("===== 用例 2：命中缓存 → 确定性契约 =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  writeEnvSignatures(makeCache(), cachePath);
  const prompts: string[] = [];
  const ctx = makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", cachePath } });
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("命中缓存: 注入「本环境已验证」标题", prompts[0].includes(VERIFIED_MARKER));
  check("命中缓存: 含 await import('node:fs')", prompts[0].includes("await import('node:fs')"));
  check("命中缓存: 含「无 `require`」", prompts[0].includes("无 `require`"));
  check("命中缓存: 含「禁止静态 `import`」", prompts[0].includes("禁止静态 `import`"));
  check("命中缓存: 不含探针式默认文本", !prompts[0].includes("最小探针依次尝试候选写法"));
  check("命中缓存: 不含 DEFAULT 标记", !prompts[0].includes(DELEGATE_DEFAULT_MARKER));
}

// ---- 用例 3：指纹变化 / TTL 过期 → 回退探针式 ----
{
  console.log("===== 用例 3：指纹变化 / TTL 过期 → 回退 =====");
  const dir = makeTmpDir();
  // 3a 指纹变化
  const cachePathA = join(dir, "a.json");
  const fp = envFingerprint();
  writeEnvSignatures(makeCache({ fingerprint: { ...fp, dsh: "999.0.0" } }), cachePathA);
  let prompts: string[] = [];
  const toolA = createDelegateTool(makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); }), () => [], { envSignatures: { use: "auto", cachePath: cachePathA } });
  await toolA.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("指纹变化: 回退 DEFAULT 标记", prompts[0].includes(DELEGATE_DEFAULT_MARKER));
  check("指纹变化: 不含「本环境已验证」", !prompts[0].includes("本环境已验证"));

  // 3b TTL 过期（8 天前，缺省 TTL 7 天）
  const cachePathB = join(dir, "b.json");
  writeEnvSignatures(makeCache({ updatedAt: new Date(Date.now() - 8 * 86400_000).toISOString() }), cachePathB);
  prompts = [];
  const toolB = createDelegateTool(makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); }), () => [], { envSignatures: { use: "auto", cachePath: cachePathB } });
  await toolB.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("TTL 过期: 回退 DEFAULT 标记", prompts[0].includes(DELEGATE_DEFAULT_MARKER));
  check("TTL 过期: 不含「本环境已验证」", !prompts[0].includes("本环境已验证"));
}

// ---- 用例 4：manual 的 Config contract 优先于缓存 ----
{
  console.log("===== 用例 4：manual Config contract 优先于缓存 =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  // 缓存说 require，手动契约说 await-import → 应以手动为准
  writeEnvSignatures(makeCache({ contract: { moduleLoading: "require", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true } }), cachePath);
  const prompts: string[] = [];
  const ctx = makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); });
  const tool = createDelegateTool(ctx, () => [], {
    envSignatures: {
      use: "manual",
      cachePath,
      contract: { moduleLoading: "await-import", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true },
    },
  });
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("manual: 用 await-import 契约", prompts[0].includes("await import('node:fs')"));
  check("manual: 不用缓存的 require 契约", !prompts[0].includes("require('node:fs')"));
  check("manual: 标题为本环境已验证", prompts[0].includes(VERIFIED_MARKER));

  // 纯函数：manual contract 直接命中 source=manual-contract
  const picked = pickEnvContractText({
    envSig: { use: "manual", contract: { moduleLoading: "static-import", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: false } },
    cached: makeCache(),
    fingerprint: envFingerprint(),
  });
  check("manual 纯函数: source=manual-contract", picked.source === "manual-contract");
  check("manual 纯函数: 文本为静态 import", picked.text.includes("静态 `import`"));
}

// ---- 用例 5：use="off" → 不读不写，走 DEFAULT ----
{
  console.log("===== 用例 5：use=off → 不读不写 =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  writeEnvSignatures(makeCache(), cachePath); // 即使缓存有效也不读
  const prompts: string[] = [];
  const ctx = makeCtxWithBus((req) => { prompts.push(req.prompt[0].text); return completedRun(); });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "off", cachePath } });
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("off: 走 DEFAULT 标记", prompts[0].includes(DELEGATE_DEFAULT_MARKER));
  check("off: 不读缓存（无「本环境已验证」）", !prompts[0].includes("本环境已验证"));
  check("off: 未挂任何 session/event 监听", ctx.listenerCount() === 0);
  const picked = pickEnvContractText({ envSig: { use: "off" }, cached: makeCache(), fingerprint: envFingerprint() });
  check("off 纯函数: source=default", picked.source === "default");
}

// ---- 用例 6a：自动写 → 同类错误 ≥ confirmCount 写出缓存 ----
{
  console.log("===== 用例 6a：自动写（confirmCount=2 达标 → 写出） =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  let spawnCount = 0;
  const ctx = makeCtxWithBus(async (req, c) => {
    spawnCount++;
    const runId = "child-" + spawnCount;
    // start 返回前发出 2 次同类环境契约错误（验证缓冲归属 + 计数）
    for (let i = 0; i < 2; i++) {
      c._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
      c._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "ReferenceError: require is not defined" }] } } });
    }
    return { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", confirmCount: 2, cachePath } });
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("自动写: 正常完成", out === "OK");
  check("自动写: 缓存文件已写出", existsSync(cachePath));
  const cached = readEnvSignatures(cachePath);
  const fp = envFingerprint();
  check("自动写: 缓存指纹一致", !!cached && cached.fingerprint.dsh === fp.dsh && cached.fingerprint.codeRuntime === fp.codeRuntime
    && cached.fingerprint.host === fp.host && cached.fingerprint.locale === fp.locale);
  check("自动写: errorSignatures 含 require 签名", !!cached && cached.errorSignatures.some(s => s.includes("require is not defined")));
}

// ---- 用例 6b：自动写 → 不足 confirmCount 不写 ----
{
  console.log("===== 用例 6b：自动写（不足 confirmCount → 不写） =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  const ctx = makeCtxWithBus(async (req, c) => {
    const runId = "child-1";
    c._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
    c._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "ReferenceError: require is not defined" }] } } });
    return { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", confirmCount: 2, cachePath } });
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("不达标: 正常完成", out === "OK");
  check("不达标: 未写出缓存文件", !existsSync(cachePath));
}

// ---- 用例 6c：自动写 → 成功结果含 await import( 推断 moduleLoading=await-import ----
{
  console.log("===== 用例 6c：推断 moduleLoading=await-import =====");
  const dir = makeTmpDir();
  const cachePath = join(dir, "env-signatures.json");
  const ctx = makeCtxWithBus(async (req, c) => {
    const runId = "child-1";
    for (let i = 0; i < 2; i++) {
      c._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
      c._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "Cannot use import statement outside a module" }] } } });
    }
    c._emit(runId, { type: "tool/result", data: { message: { isError: false, content: [{ type: "text", text: "OK: await import('node:fs') works" }] } } });
    return { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  });
  const tool = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", confirmCount: 2, cachePath } });
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  const cached = readEnvSignatures(cachePath);
  check("推断: 写缓存且 moduleLoading=await-import", cached?.contract?.moduleLoading === "await-import");
}

// ---- 用例 7：缓存文件读写失败 → 静默降级，行为同无缓存 ----
{
  console.log("===== 用例 7：读写失败静默降级 =====");
  const dir = makeTmpDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x"); // 普通文件
  const badPath = join(blocker, "sub", "env-signatures.json"); // 父路径是文件 → mkdir/read 必失败
  // 读失败
  let prompts: string[] = [];
  const toolR = createDelegateTool(makeCtx((req) => { prompts.push(req.prompt[0].text); return completedRun(); }), () => [], { envSignatures: { use: "auto", cachePath: badPath } });
  await toolR.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("读失败: 不抛错且走 DEFAULT", prompts[0].includes(DELEGATE_DEFAULT_MARKER));
  // 写失败
  const ctx = makeCtxWithBus(async (req, c) => {
    const runId = "child-1";
    for (let i = 0; i < 2; i++) {
      c._emit(runId, { type: "tool/call", data: { name: "run_code", arguments: "x" } });
      c._emit(runId, { type: "tool/result", data: { message: { isError: true, content: [{ type: "text", text: "ReferenceError: require is not defined" }] } } });
    }
    return { id: runId, result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  });
  const toolW = createDelegateTool(ctx, () => [], { envSignatures: { use: "auto", confirmCount: 2, cachePath: badPath } });
  const out = await toolW.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("写失败: 不抛错且正常完成", out === "OK");
}

// ---- 用例 8：纯函数（renderEnvContract / classify / isCacheValid / pick 优先级） ----
{
  console.log("===== 用例 8：纯函数 =====");
  const renderAwait = renderEnvContract({ moduleLoading: "await-import", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true });
  check("render await-import: 非空且含 await import", !!renderAwait && renderAwait.includes("await import('node:fs')"));
  const renderRequire = renderEnvContract({ moduleLoading: "require", topLevelAwait: false, wallClockLimitMs: 0, hasJobTracking: false });
  check("render require: 含 require('node:fs')", !!renderRequire && renderRequire.includes("require('node:fs')"));
  check("render require: topLevelAwait=false 描述", !!renderRequire && renderRequire.includes("不可用"));
  const renderStatic = renderEnvContract({ moduleLoading: "static-import", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true });
  check("render static-import: 含静态 import", !!renderStatic && renderStatic.includes("静态 `import`"));
  check("render unknown: null", renderEnvContract({ moduleLoading: "unknown", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true }) === null);
  check("render null: null", renderEnvContract(null) === null);

  check("classify require 签名: true", classifyEnvContractError("err:ReferenceError: require is not defined"));
  check("classify 静态 import 签名: true", classifyEnvContractError("err:Cannot use import statement outside a module"));
  check("classify 非环境错误: false", !classifyEnvContractError("err:ENOENT: no such file"));

  const fp = envFingerprint();
  const valid = makeCache();
  check("isCacheValid 有效: true", isCacheValid(valid, fp, 604_800_000));
  check("isCacheValid 指纹不符: false", !isCacheValid(makeCache({ fingerprint: { ...fp, host: "other" } }), fp, 604_800_000));
  check("isCacheValid 过期: false", !isCacheValid(makeCache({ updatedAt: new Date(Date.now() - 8 * 86400_000).toISOString() }), fp, 604_800_000));
  check("isCacheValid 版本不符: false", !isCacheValid({ ...valid, version: 99 }, fp, 604_800_000));

  const pickedManualText = pickEnvContractText({ manualText: "手工覆盖文本 XYZ", envSig: { use: "auto" }, cached: makeCache(), fingerprint: fp });
  check("pick: P1 手工 text 覆盖最高优先", pickedManualText.source === "manual" && pickedManualText.text === "手工覆盖文本 XYZ");
  const pickedCache = pickEnvContractText({ envSig: { use: "auto" }, cached: makeCache(), fingerprint: fp });
  check("pick: auto 命中缓存 → cache", pickedCache.source === "cache");
  const pickedOff = pickEnvContractText({ envSig: { use: "off" }, cached: makeCache(), fingerprint: fp });
  check("pick: off → default", pickedOff.source === "default");
  const pickedManualNoFacts = pickEnvContractText({ envSig: { use: "manual", contract: { moduleLoading: "unknown", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true } }, cached: makeCache({ contract: { moduleLoading: "require", topLevelAwait: true, wallClockLimitMs: 600_000, hasJobTracking: true } }), fingerprint: fp });
  check("pick: manual 无事实 → 落回缓存", pickedManualNoFacts.source === "cache");
  check("pick: 缺省 errorCategories 非空", DEFAULT_ERROR_CATEGORIES.length > 0);
}

// 清理临时目录
for (const d of tmpDirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ }
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);