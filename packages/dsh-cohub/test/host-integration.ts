// dsh-port/test/host-integration.ts —— DSH 0.2 宿主集成门禁（真实 Loader / SettingsForms / subagents / app-boot preflight）
// 用法：node test/host-integration.ts（node >= 24 类型剥离）
// 前置：已 bun run build（lib/ 为 0.2 语义产物），node_modules 对齐宿主 cordis 4.1.0 / schemastery 3.19.0。
//
// 分层说明（真实组件 + stub 边界标注，不冒称完整宿主）：
//   ✓ 真实层：cordis-plugin-loader 真实 Loader + 真实 Include 树（mountRootInclude 官方 API）；
//     cohub 插件行真实挂载（entry.fiber.runtime.Config = 本包 Config）；真实 entry.update({config})
//     → Loader 私有 _commitVolatile 提交 volatile 引用 → get() 见新值；真实已注册 delegate 工具
//     （tools.get("delegate")）下一 execute 见新值；真实 dsh-settings SettingsForms.describe()
//     投影真实 volatile 表单（schema/value 可读）；真实 dsh-subagent SubagentRuntime + 注册
//     可控 in-memory provider（capabilities 真实校验，start/result/dispose 真实链路）；
//     mid-flight 取消：start 已发布后由真实 signal abort 驱动受控 result settle（stopReason=
//     aborted 传播，非仅断言 signal.aborted），并验证 dispose 资源清理；delegate 工具 execution
//     的取消链（父 exec.signal → run.result 停止 → 结构化 cause）；
//     app-boot evaluatePluginCompatibility 官方 helper 真实执行 peer 核验。
//   ✗ 边界（stub / 未覆盖，注释标注）：profileContext/configEditor 为内存最小边界（指向临时目录，
//     不加载真实 HOME，不触发旧 settings.yaml 迁移；configEditor 用官方 ConfigEditor 服务但 profile
//     patch 文件为临时空档）；subagent 模型 transport 用 in-memory provider stub（不启动真实进程
//     /LLM provider）；preset composition 用 app-boot composeEntries 静态组合（不真实挂载——
//     dsh-persona/dsh-tool-fs 等宿主包不在本包 node_modules，无法离线真实挂载）。
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import LlmRuntime from "@deepseek-ai/dsh-llm";
// 0.2.2-rc.1 服务注入图：SubagentRuntime.inject = ["workingDirectory","sessionProjections"]，
// 而 WorkingDirectoryService.inject = ["fs","sessionProjections","systemPrompt"]。
// 宿主真实栈必须显式挂 fs / workingDirectory，否则 SubagentRuntime fiber 停在 state=0，
// ctx.subagents 永远 undefined（本文件此前 buildHost 缺这两层）。
import FileSystem from "@deepseek-ai/dsh-fs";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
// 0.2.2-rc.1：SubagentRuntime 的 manager 由 `ctx.inject(["agents"], ...)` 建立，
// startActivation 共用 `ctx.agents.get(parent.id) === parent` 做「精确活父」授权，
// WorkingDirectoryService.ensure() 又要 `ctx.fs.resolve/stat` 与真实 Session。
// 故宿主栈必须再有 agents 服务与一个可用的 fs 后端，否则 delegate 工具无法真正 spawn。
import AgentRegistry from "@deepseek-ai/dsh-agent";
import { Session } from "@deepseek-ai/dsh-session";
import { normalize, resolve as resolvePath } from "node:path";

/**
 * 最小 fs 后端（测试边界，明确标注）：dsh-fs 的 FileSystem 是抽象 seam，
 * resolve/stat/processPath 由具体后端（dsh-fs-local / fs-sandbox）实现，二者不在本包
 * node_modules。这里给一个「永远把路径当已存在目录」的内存实现，只为让
 * WorkingDirectoryService.ensure() 走通（它要 fs.resolve + fs.stat 才能返回 cwd）。
 * 不读写真实文件、不触达沙箱策略——与「真实 fs 后端」的差别仅此三点。
 */
class MemoryFs extends FileSystem {
  async resolve(path: string, options?: { cwd?: string }) {
    return normalize(resolvePath(options?.cwd ?? process.cwd(), path));
  }
  async stat() {
    return { type: "directory" } as const;
  }
  processPath(target: string) {
    return target;
  }
}
import ConfigEditor from "@deepseek-ai/dsh-config-editor";
import SettingsForms from "@deepseek-ai/dsh-settings";
import { mountRootInclude, evaluatePluginCompatibility, getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

// 临时隔离环境：TestPath 父 + 测试自身 cleanup；不读真实 HOME / 用户 profile
const tmp = mkdtempSync(join(tmpdir(), "cohub-host-"));
const profileDir = join(tmp, "profile");
mkdirSync(profileDir, { recursive: true });
const home = join(tmp, "home");
mkdirSync(home, { recursive: true });
writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "host-fixture-profile" }));
const patchPath = join(profileDir, "cordis.patch.yml");
if (!existsSync(patchPath)) writeFileSync(patchPath, "[]\n");
const cordisPath = join(tmp, "cordis.yml");
writeFileSync(cordisPath, [
  "- id: cohub",
  `  name: '${pathToFileURL(join(process.cwd(), "lib", "index.js")).href}'`,
  "  config:",
  "    installPresets: false",
  "    councillors: []",
  "    skills: [{ name: co-fixer, provider: p1, model: m1 }]",
  "    schedule: { maxParallelBatch: 5, wallClockBudgetMs: 600000 }",
].join("\n"));
// DSH_HOME 隔离：env-signatures 等宿主路径能力全部指向临时 home
process.env.DSH_HOME = home;

// 内存 profileContext（app-boot 宿主事实的测试最小边界；dir/patchPath/home 均在临时目录）
const profileContext = {
  name: "host-fixture",
  dir: profileDir,
  patchPath,
  installAnchor: "host-fixture",
  cwd: process.cwd(),
  home,
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: undefined,
};

async function buildHost() {
  const root = new Context();
  const baseUrl = pathToFileURL(join(process.cwd(), "test")).href + "/";
  root.provide("profileContext", profileContext);
  root.plugin(Loader, { baseUrl });
  root.plugin(SystemPrompt);
  root.plugin(ToolRuntime);
  root.plugin(SkillRegistry);
  // 0.2.2-rc.1 服务注入图（实测）：
  //   WorkingDirectoryService.inject = ["fs","sessionProjections","systemPrompt"]
  //   SubagentRuntime.inject        = ["workingDirectory","sessionProjections"]，
  //   且其 manager 由 ctx.inject(["agents"], …) 建立（dsh-subagent lib/index.js:3009-3022），
  //   startActivation 用 ctx.agents.get(parent.id) === parent 做「精确活父」授权。
  // 缺 fs / workingDirectory → SubagentRuntime fiber 停在 state=0，root.subagents 恒 undefined；
  // 缺 agents → manager 为空，delegate 的 spawn 抛 CONTINUATION_UNAVAILABLE。
  // 故顺序必须是 fs → workingDirectory → agents → subagents。
  root.plugin(MemoryFs);
  root.plugin(WorkingDirectory, { defaultDirectory: process.cwd() });
  root.plugin(AgentRegistry);
  root.plugin(SubagentRuntime);
  root.plugin(SessionProjectionRegistry);
  root.plugin(LlmRuntime);
  await new Promise(r => setImmediate(r));
  await root.loader.await?.();
  new ConfigEditor(root);
  new SettingsForms(root);
  await new Promise(r => setImmediate(r));
  return root;
}

/**
 * 注册一个「精确活父」Agent（delegate 的 exec.agent 必须能在 ctx.agents 里按 id 找回同一对象，
 * 否则 dsh-subagent 段会以 UNAUTHORIZED 拒绝建子代理）。
 * 用官方 Session.create 造 header（version/id/cwd/isSeeded 由它校验并冻结），
 * agent 本体是测试桩：只需要 id / session / ctx.fiber.assertActive / inject。
 */
async function registerParentAgent(root: any, id: string) {
  const agents = root.get("agents");
  const session = Session.create(id);
  const agent: any = {
    id,
    session,
    ctx: { fiber: { assertActive() {} }, on() {}, effect() {} },
    inject() {},
  };
  agents.register(agent);
  await new Promise(r => setImmediate(r));
  return agent;
}

// ── 层 1：真实 Loader 挂载 cohub 行 + entry.update({config}) volatile 提交 → get() 见新值 ──
{
  console.log("===== 层 1：真实 Loader entry.update volatile 提交 =====");
  const root = await buildHost();
  const includeEntry = await mountRootInclude(root, cordisPath, [], undefined, "host");
  check("官方 mountRootInclude 创建 include 行", !!includeEntry && includeEntry.options?.id === "include");
  await root.loader.await();
  const entry = [...root.loader.entries()].find(e => e.options.id === "cohub");
  check("cohub 行真实挂载（fiber active）", entry?.fiber?.state === 2);
  check("entry.fiber.runtime.Config = 本包 Config", !!(entry?.fiber?.runtime?.Config));
  const cfg = entry?.fiber?.effectiveConfig;
  // cordis 4.1.0 双观测点（都真实，互不替代）：
  //   entry.fiber.config          —— 本次已解析的普通值（cfg.skills 是普通 Array）；
  //   entry.fiber.effectiveConfig —— apply() 实际收到的**那一份**已解析 config
  //     （cordis lib/index.js:359-360 `const config = this.resolveConfig(this.config); this._effectiveConfig = config;`
  //      → 随后 `new runtime.callback(this.ctx, config)` 即传入插件）。
  // volatile 提交走 loader `_commitVolatile`：`volatileEntries(fiber.effectiveConfig)` 取 ref，
  // `updateVolatile(ref, source)` 原地写值（loader lib/index.js:528/546）。因此断言读
  // effectiveConfig.<field>.get() 就是读「插件 apply 侧持有的同一引用」，语义与 3.18 时代
  // entry.fiber.config.<field>.get() 完全一致，且此处不等价于放宽。
  const rawCfg = entry?.fiber?.config;
  check("初始 skills = cordis.yml 配置的 1 条路由",
    Array.isArray(cfg?.skills?.get?.()) && cfg.skills.get().length === 1 && cfg.skills.get()[0].name === "co-fixer"
    // 同时确认 cordis 4.1.0 的 config 语义：普通入口拿到的是已解析数组（不是 .get() 引用）
    && Array.isArray(rawCfg?.skills) && typeof (rawCfg?.skills as any)?.get === "undefined"
    && rawCfg.skills.length === 1 && rawCfg.skills[0].name === "co-fixer");
  check("初始 schedule 默认 batch=5", cfg?.schedule?.get?.()?.maxParallelBatch === 5);

  // 真实 entry.update({config})：Loader._commitVolatile 提交 volatile-only 变更（官方实际 API）
  await entry.update({ config: {
    installPresets: false, councillors: [],
    skills: [{ name: "co-fixer", provider: "p1", model: "m1" }, { name: "co-explorer", provider: "p2" }],
    schedule: { maxParallelBatch: 5, wallClockBudgetMs: 111_000 },
    delegateRetry: { maxRetries: 1, retryDelayMs: 1 },
  } });
  check("volatile 提交后 skills.get() 见 2 条路由", cfg?.skills?.get?.()?.length === 2 && cfg.skills.get()[1].name === "co-explorer");
  check("volatile 提交后 schedule.get() batch=5", cfg?.schedule?.get?.()?.maxParallelBatch === 5);
  check("volatile 提交后 schedule.get() wall=111000", cfg?.schedule?.get?.()?.wallClockBudgetMs === 111_000);
  check("volatile 提交后 delegateRetry.get() maxRetries=1", cfg?.delegateRetry?.get?.()?.maxRetries === 1);
  root.stop?.();
}

// ── 层 2：真实已注册 delegate 工具，entry.update 后下一 execute 见新值 ──
{
  console.log("===== 层 2：真实 delegate 工具下一 execute 见 volatile 新值 =====");
  const root = await buildHost();
  const calls: any[] = [];
  // logger spy：捕获 delegate 每次 execute 打印的生效调度参数（验证下次 execute 读取的是新值）
  const logs: string[] = [];
  (root.logger as any).info = (...a: any[]) => logs.push(a.map(String).join(" "));
  // 注册可控 in-memory subagent provider（真实 SubagentRuntime 服务；capabilities 真实校验；
  // 模型 transport 为 stub——不启动真实进程/LLM，仅验证 delegate→start 的转发与结果链路）
  root.subagents.registerProvider({
    name: "spawn",
    // agentPreset: true 是必需的——0.2.2-rc.1 的 assertCapabilities 对「请求带 agentPreset 但
    // provider 未声明该能力」会直接拒绝（dsh-subagent lib/index.js:3327），测试 provider 必须
    // 如实声明，否则 delegate 会走 preset fail-soft 降级（那是环境缺陷，不是被测语义）。
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true, agentPreset: true },
    inheritsParentContext: false,
    start(request: any) {
      calls.push({ label: request.label, agentOptions: request.agentOptions, promptHead: String(request.prompt?.[0]?.text ?? "").slice(0, 30), aborted: request.signal?.aborted === true });
      return {
        id: "child-" + calls.length,
        result: Promise.resolve({ output: [{ type: "text", text: "ok-child" }], stopReason: "completed" }),
        dispose() {},
      };
    },
  });
  await mountRootInclude(root, cordisPath, [], undefined, "host");
  await root.loader.await();
  // delegate 的 exec.agent 必须是 ctx.agents 里的「精确活父」：0.2.2-rc.1 的
  // SubagentRuntime.startActivation 用 `ctx.agents.get(parent.id) === parent` 授权建子代理
  // （dsh-subagent lib/index.js:3060），传一个临时对象会被 UNAUTHORIZED 拒绝。
  const parentAgent = await registerParentAgent(root, "parent-1");
  const entry = [...root.loader.entries()].find(e => e.options.id === "cohub");
  const delegate = root.tools.get("delegate");
  check("delegate 工具已注册（tools.get）", !!delegate);

  const out1 = await delegate.execute(
    { skill: "co-fixer", prompt: "任务甲" },
    { agent: parentAgent, signal: new AbortController().signal },
  );
  // 子代理真实输出必须原样回传；其后的 `[...]` 降级提示是本测试 provider 的既有边界：
  // in-memory provider（external、无 prepareContinuable）不会在 ctx.agents 里留下子 Agent，
  // 故 delegate 的 toolFilter 施加路径如实登记「裁剪未生效」（src/delegate.ts:734-739）。
  // 这是被测代码的 fail-soft 语义，不是环境红；关键是首行必须是子代理输出，
  // 且**不得**出现 preset 降级（provider 已如实声明 agentPreset 能力）。
  const out1Text = String(out1);
  check("真实 execute 返回子代理结果",
    out1Text.startsWith("ok-child") && !out1Text.includes("preset 未生效")
    && (!out1Text.includes("[") || out1Text.includes("工具裁剪未生效")));
  check("子代理 start 收到委派 label", calls[0]?.label === "delegate:co-fixer");

  // volatile 更新：schedule batch 5→9（模拟设置卡片提交）
  await entry.update({ config: {
    installPresets: false, councillors: [],
    skills: [{ name: "co-fixer", provider: "p1", model: "m1" }],
    schedule: { maxParallelBatch: 9, wallClockBudgetMs: 123 },
  } });
  check("提交后 schedule.get().batch=9", entry.fiber?.effectiveConfig?.schedule?.get?.()?.maxParallelBatch === 9);
  await delegate.execute(
    { skill: "co-fixer", prompt: "任务乙" },
    { agent: parentAgent, signal: new AbortController().signal },
  );
  check("更新后下一 execute 仍正常（spawn 第二次）", calls.length === 2);
  // delegate 的 resolveRuntimeConfig 读取 settingsNow.schedule（getSettings() = currentSettings()），
  // 更新后的 batch=9 被真实读到并打印——证明 volatile 提交后下次 execute 即见新值
  // delegate 的 resolveRuntimeConfig 读取 settingsNow.schedule（getSettings() = currentSettings()），
  // 更新后的 batch=9 被真实读到并打印——证明 volatile 提交后下次 execute 即见新值
  const scheduleLog = logs.some(l => l.includes("[cohub schedule]") && l.includes("batch=9"));
  check("下一 execute 读到新 schedule（日志含 batch=9）", scheduleLog);

  // reasoningEffort 路由：只配强度（不配 provider/model）→ 真实 SubagentRuntime 把
  // 部分 agentOptions 转发到 provider start（provider/model 由 DSH 继承父会话）
  await entry.update({ config: {
    installPresets: false, councillors: [],
    skills: [{ name: "co-fixer", reasoningEffort: "low" }],
  } });
  await delegate.execute(
    { skill: "co-fixer", prompt: "任务丙" },
    { agent: parentAgent, signal: new AbortController().signal },
  );
  check("提交 reasoningEffort 后下一 execute 转发 agentOptions.reasoningEffort",
    calls[2]?.agentOptions?.reasoningEffort === "low");
  check("转发时不含 provider/model 键（保持继承）",
    !("provider" in (calls[2]?.agentOptions ?? {})) && !("model" in (calls[2]?.agentOptions ?? {})));
  root.stop?.();
}

// ── 层 3：真实 SettingsForms.describe() 投影 volatile 表单 schema/value 可读 ──
{
  console.log("===== 层 3：SettingsForms.describe() 真实 volatile 表单 =====");
  const root = await buildHost();
  await mountRootInclude(root, cordisPath, [], undefined, "host");
  await root.loader.await();
  const entry = [...root.loader.entries()].find(e => e.options.id === "cohub");
  const forms = root.settings.describe();
  check("describe() 返回非空", forms.length >= 1);
  const row = forms.find(f => f.ns === "cohub");
  check("描述行 ns=cohub", row?.ns === "cohub");
  check("applies=live", row?.applies === "live");
  check("表单 value 含 volatile 字段（skills）", Object.keys(row?.value ?? {}).includes("skills"));
  check("表单 value 含 volatile 字段（schedule）", Object.keys(row?.value ?? {}).includes("schedule"));
  check("表单 value 含 volatile 字段（delegateRetry）", Object.keys(row?.value ?? {}).includes("delegateRetry"));
  check("schema 可读（schemastery 序列化节点）", !!row?.schema && typeof row.schema === "object");
  // value 投影真实 fiber 的 volatile 引用（apply 侧持有的那一份）：读 effectiveConfig。<field>.get()
  check("value.skills 与 config.skills.get() 一致", JSON.stringify(row?.value?.skills) === JSON.stringify(entry.fiber?.effectiveConfig?.skills?.get?.()));
  check("value.schedule 与 config.schedule.get() 一致", JSON.stringify(row?.value?.schedule) === JSON.stringify(entry.fiber?.effectiveConfig?.schedule?.get?.()));
  // 旧 settings.yaml 迁移不触发：临时 home 无 settings.yaml，importLegacyDocument 直接 return
  check("未触发旧 settings.yaml 迁移（home 无该文件且未被创建）", !existsSync(join(home, "settings.yaml")));
  // 官方设置页按序列化 schema 生成控件：schema 里必须有 reasoningEffort 才会出现可编辑字段
  check("表单 schema 含 skills[].reasoningEffort（官方表单据此渲染该字段）",
    JSON.stringify(row?.schema ?? {}).includes("reasoningEffort"));
  // volatile 提交带 reasoningEffort 的路由 → describe 的 value 出现该字段（用户保存即生效）
  await entry.update({ config: {
    installPresets: false, councillors: [],
    skills: [{ name: "co-oracle", provider: "p1", model: "m1", reasoningEffort: "high" }],
  } });
  const rowAfter = root.settings.describe().find(f => f.ns === "cohub");
  check("提交后 describe() 的 value 带 reasoningEffort", rowAfter?.value?.skills?.[0]?.reasoningEffort === "high");
  check("提交后 config.skills.get() 也带 reasoningEffort（同一引用）",
    entry.fiber?.effectiveConfig?.skills?.get?.()[0]?.reasoningEffort === "high");
  root.stop?.();
}

// ── 层 4：真实 subagents 服务传输（正常 / 失败 / AbortSignal / result / dispose）──
{
  console.log("===== 层 4：真实 SubagentRuntime + in-memory provider 传输 =====");
  const root = new Context();
  const baseUrl = pathToFileURL(join(process.cwd(), "test")).href + "/";
  root.plugin(Loader, { baseUrl });
  // 同 buildHost：0.2.2-rc.1 下 SubagentRuntime 需要 fs → workingDirectory → agents 三级前置
  // （WorkingDirectory.inject 还含 systemPrompt，故 SystemPrompt 也必须挂）
  root.plugin(SystemPrompt);
  root.plugin(MemoryFs);
  root.plugin(WorkingDirectory, { defaultDirectory: process.cwd() });
  root.plugin(AgentRegistry);
  root.plugin(SubagentRuntime);
  root.plugin(SessionProjectionRegistry);
  root.plugin(LlmRuntime);
  await new Promise(r => setImmediate(r));
  await root.loader.await?.();
  await new Promise(r => setImmediate(r));
  const parent = await registerParentAgent(root, "parent-ctrl");

  const events: string[] = [];
  const eventRunIds: string[] = [];
  root.on("subagent/start", (info: any) => { events.push("start:" + info.runId); eventRunIds.push(info.runId); });
  root.on("subagent/end", (info: any) => events.push("end:" + info.runId + ":" + info.stopReason));

  // 可控 provider：capabilities 全开；start 返回可控 result/dispose；记录 dispose 次数
  let disposed = 0;
  root.subagents.registerProvider({
    name: "ctrl",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true },
    inheritsParentContext: false,
    start() {
      return {
        id: "ctrl-child",
        result: Promise.resolve({ output: [{ type: "text", text: "ctrl-ok" }], stopReason: "completed" }),
        dispose() { disposed++; },
      };
    },
  });
  await new Promise(r => setImmediate(r));

  // ① 正常路径（0.2.2-rc.1 唯一真实入口是 startActivation；返回 { childId, result, dispose }）
  const receipt = await root.subagents.startActivation({
    provider: "ctrl",
    label: "t-normal",
    request: { prompt: [{ type: "text", text: "正常任务" }], parent },
    signal: new AbortController().signal,
    delivery: "caller",
  });
  check("startActivation 返回子运行（childId）", !!receipt?.childId);
  const result = await receipt.result;
  check("result.stopReason=completed", result?.stopReason === "completed");
  check("result.output 内容正确", String(result?.output?.[0]?.text) === "ctrl-ok");
  check("dispose 可调用", typeof receipt.dispose === "function");
  await receipt.dispose();
  check("dispose 已执行", disposed === 1);

  // ② 失败路径：provider.start 抛错 → startActivation reject（无子运行可 dispose）
  const failedProvider: any = {
    name: "failing",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true },
    inheritsParentContext: false,
    start() { throw new Error("ctrl-start-failed"); },
  };
  root.subagents.registerProvider(failedProvider);
  await new Promise(r => setImmediate(r));
  let startErr: any = null;
  try {
    await root.subagents.startActivation({
      provider: "failing",
      label: "t-fail",
      request: { prompt: [{ type: "text", text: "x" }], parent },
      signal: new AbortController().signal,
      delivery: "caller",
    });
  } catch (e) { startErr = e; }
  check("start 失败抛错（无 run）", startErr !== null && String(startErr?.message ?? startErr).includes("ctrl-start-failed"));

  // ③ 能力不足拒绝：请求 persona 但 provider 缺 persona capability → assertCapabilities 拒绝
  const noPersona: any = {
    name: "no-cap",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: false },
    inheritsParentContext: false,
    start() { throw new Error("should-not-reach"); },
  };
  root.subagents.registerProvider(noPersona);
  await new Promise(r => setImmediate(r));
  let capErr: any = null;
  try {
    await root.subagents.startActivation({
      provider: "no-cap",
      label: "t-cap",
      request: { prompt: [{ type: "text", text: "x" }], parent, persona: "p" },
      signal: new AbortController().signal,
      delivery: "caller",
    });
  } catch (e) { capErr = e; }
  check("缺失 capability 被真实拒绝（fail loud）", capErr !== null && String(capErr?.code ?? capErr?.message ?? "").length > 0);

  // ④ pre-aborted signal：0.2.2-rc.1 的 startActivation 在发布前 throwIfAborted（materializeTracked
  // 首行 inputs.signal.throwIfAborted()），故**拒绝建立子运行**，而非 0.2.0 start() 的「照常发布、
  // 由 provider 自行决定」。这是宿主 API 语义变化，断言随之改为验证「拒绝 + 未产生副作用」。
  let preStarted = 0;
  root.subagents.registerProvider({
    name: "ctrl2",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true },
    inheritsParentContext: false,
    start() { preStarted++; return { id: "ctrl2-child", result: Promise.resolve({ output: [], stopReason: "completed" }), dispose() {} }; },
  });
  await new Promise(r => setImmediate(r));
  const ac = new AbortController();
  ac.abort();
  let abortErr: any = null;
  try {
    await root.subagents.startActivation({
      provider: "ctrl2",
      label: "t-abort",
      request: { prompt: [{ type: "text", text: "x" }], parent },
      signal: ac.signal,
      delivery: "caller",
    });
  } catch (e) { abortErr = e; }
  check("pre-aborted signal 下拒绝建立子运行（provider 未被调用、无 run）",
    abortErr !== null && preStarted === 0 && (abortErr?.name === "AbortError" || abortErr?.code === 20 || /abort/i.test(String(abortErr?.message ?? ""))));

  // ⑤ mid-flight 取消：startActivation 已发布子运行（childId 存在）、result 受控 pending 时，
  // 走 0.2.2-rc.1 的真实取消通道 `subagents.interrupt(childId, {kind:"user", parentSessionId})`
  // → manager 对激活 controller.abort() → provider 由真实 signal 事件驱动 result settle
  // （stopReason='aborted'），再验证 result 停止传播与 dispose 资源清理；不以 signal.aborted
  // 为唯一结论，也不自行模拟 result 常量冒充宿主返回。
  let midStarted = 0;
  let midDisposed = 0;
  let midSettled = false;
  let midSignalAborted = false;
  root.subagents.registerProvider({
    name: "mid",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true },
    inheritsParentContext: false,
    start(request: any) {
      midStarted++;
      let resolveResult: (r: any) => void = () => {};
      const result = new Promise<any>(r => { resolveResult = r; });
      const onAbort = () => {
        midSignalAborted = true;
        if (midSettled) return;
        midSettled = true;
        resolveResult({ output: [], stopReason: "aborted" });
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      return {
        id: "mid-child",
        result,
        dispose() { midDisposed++; request.signal.removeEventListener("abort", onAbort); },
      };
    },
  });
  await new Promise(r => setImmediate(r));
  // 清空此前 ctrl 正常路径产生的生命周期边，只保留本条 mid 激活的 start/end
  events.length = 0;
  eventRunIds.length = 0;
  const midReceipt = await root.subagents.startActivation({
    provider: "mid",
    label: "t-mid-abort",
    request: { prompt: [{ type: "text", text: "长任务" }], parent },
    signal: new AbortController().signal,
    delivery: "caller",
  });
  check("mid-flight: 已发布子运行（provider.start 已发生）", !!midReceipt?.childId && midStarted === 1);
  check("mid-flight: interrupt 前 result 仍 pending（模型可控等待中）", !midSettled);
  root.subagents.interrupt(midReceipt.childId, { kind: "user", parentSessionId: parent.id });
  const midOutcome = await midReceipt.result;
  check("mid-flight: 取消后 result 传播 stopReason=aborted（真实 signal 驱动 settle）",
    midOutcome?.stopReason === "aborted" && midSettled && midSignalAborted);
  await midReceipt.dispose();
  check("mid-flight: dispose 已调用（资源清理）", midDisposed === 1);
  check("mid-flight: 真实生命周期事件（start → end:aborted，runId 来自宿主 observer）",
    // 注意：subagent/start|end 的 info.runId 是宿主为每次激活新铸的 SubagentRunId（不是 provider 的 id），
    // 故按「计数 + stopReason」核对，而不是拼接 receipt.childId。
    eventRunIds.length === 1 && events.includes("start:" + eventRunIds[0])
    && events.includes("end:" + eventRunIds[0] + ":aborted"));
  root.stop?.();
}

// ── 层 5：appboot preflight 实际执行官方 compatibility helper（peer 核验，无 allowversion）──
{
  console.log("===== 层 5：app-boot evaluatePluginCompatibility 真实执行 =====");
  const runtime = getDshRuntimeVersion();
  check("getDshRuntimeVersion() = 0.2.2-rc.1", runtime === "0.2.2-rc.1");
  // 本包 package.json 作为真实 pack 候选：官方 helper 核验 dsh peer（无 exemptions）
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const issue = evaluatePluginCompatibility(manifest, {}, runtime);
  check("本包 peer 核验通过（无冲突）", issue === undefined);
  // 不兼容 pack → 官方 helper 返回结构化 issue（证明 helper 真实校验，不是文件存在即放行）
  const bad = {
    name: "fake-bad-pack", version: "1.0.0",
    peerDependencies: { "@deepseek-ai/dsh-tools": "^0.1.0-rc.1", "@deepseek-ai/cordis": "^3.0.0" },
  };
  const issue2 = evaluatePluginCompatibility(bad, {}, runtime);
  // 0.2.2-rc.1 的 helper 把明细放在 issue.requirements（不是旧版的 issue.peers）；
  // 且只收录命名空间受管的 @deepseek-ai/dsh-* peer（@deepseek-ai/cordis 不参与核验）。
  check("不兼容 pack 返回 requirements 明细", issue2 !== undefined && Object.keys(issue2?.requirements ?? {}).includes("@deepseek-ai/dsh-tools"));
  check("不兼容 pack 未被豁免", issue2?.exempted === false);
  // 无 peerDependencies 的 pack → undefined（合法）
  check("无 peer 的 pack 通过", evaluatePluginCompatibility({ name: "x", version: "1.0.0" }, {}, runtime) === undefined);
}

// ── 层 6：preset agent.cordis.yml 组合检查（文本行级断言，不引入额外 YAML 依赖）──
{
  console.log("===== 层 6：preset agent.cordis.yml 组合检查 =====");
  // 说明：preset 引用的 @deepseek-ai/dsh-persona / dsh-tool-fs 等为宿主 bundle 包，
  // 不在本包 node_modules（离线测试环境无法真实挂载整棵 preset 树）。此处用行文本
  // 结构断言替代真实挂载，真实挂载留给宿主集成（dsh 重启后选 preset 实测）。
  for (const preset of ["co-orchestrator", "cohub-cordis"]) {
    const file = join(process.cwd(), "presets", preset, "agent.cordis.yml");
    const text = readFileSync(file, "utf8");
    // 行尾兼容：core.autocrlf=true 的 checkout 会把 preset 文件转成 CRLF，
    // 正则里 persona 行后的换行须兼容 \r\n（否则 CRLF worktree 下误判为缺失 prefix）。
    const hasPersonaPrefix = /\n\s*- id: persona\r?\n[\s\S]*?\r?\n(\s*config:)?\s*prefix:/.test(text);
    const hasPersonaTextField = /\n\s*- id: persona\r?\n[\s\S]*?^\s*text:/m.test(text);
    const hasToolCordis = /name:\s*['"]?@deepseek-ai\/dsh-tool-cordis/.test(text);
    check(`${preset}: 组合非空且含 persona 行`, text.includes("- id: persona"));
    check(`${preset}: persona 用 prefix（无 text: 字段）`, hasPersonaPrefix && !hasPersonaTextField);
    check(`${preset}: 不挂 tool-cordis（进程单例 realm 由官方创造模式独占）`, !hasToolCordis);
  }
}

// ── 层 7：delegate 工具 execution 运行中取消链（父 exec.signal → run.result 停止 → 结构化 cause）──
{
  console.log("===== 层 7：delegate 工具运行中取消链 =====");
  const root = await buildHost();
  let delStarted = 0;
  let delDisposed = 0;
  let delSettled = false;
  // 受控 spawn provider：start 发布 run 后 result 保持 pending（模型可控等待），
  // 父 signal abort 时由真实 signal 事件驱动 settle 为 stopReason=aborted。
  root.subagents.registerProvider({
    name: "spawn",
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, persona: true },
    inheritsParentContext: false,
    start(request: any) {
      delStarted++;
      let resolveResult: (r: any) => void = () => {};
      const result = new Promise<any>(r => { resolveResult = r; });
      const onAbort = () => {
        if (delSettled) return;
        delSettled = true;
        resolveResult({ output: [], stopReason: "aborted" });
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      return {
        id: "delegate-mid",
        result,
        dispose() { delDisposed++; request.signal.removeEventListener("abort", onAbort); },
      };
    },
  });
  await mountRootInclude(root, cordisPath, [], undefined, "host");
  await root.loader.await();
  // 同层 2：exec.agent 必须是 ctx.agents 里的精确活父，否则 startActivation 在
  // `ctx.agents.get(parent.id) === parent` 处就以 UNAUTHORIZED 拒绝，provider 根本收不到 spawn
  const parentAgent = await registerParentAgent(root, "parent-delegate");
  const delegate = root.tools.get("delegate");
  check("delegate 工具已注册（取消链前置）", !!delegate);

  const parentAc = new AbortController();
  const execPromise = delegate.execute(
    { skill: "co-fixer", prompt: "长任务" },
    { agent: parentAgent, signal: parentAc.signal },
  ).then(
    (v: any) => ({ ok: true, value: v }),
    (e: any) => ({ ok: false, error: e }),
  );
  // 确保 start 已发生（delegate 已把 exec.signal 传给 subagents.start 并发布 run）
  const t0 = Date.now();
  while (delStarted === 0 && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 5));
  check("delegate 取消链: start 已发生（provider 收到 spawn）", delStarted === 1);
  check("delegate 取消链: result 仍在等待（未 settle）", !delSettled);
  parentAc.abort();
  const execOutcome: any = await execPromise;
  check("delegate 取消链: 父 abort 停止子代理（execute 失败而非返回）", execOutcome?.ok === false);
  check("delegate 取消链: 结构化 cause.stopReason=aborted", execOutcome?.ok === false && execOutcome?.error?.cause?.stopReason === "aborted");
  check("delegate 取消链: 错误消息含 aborted", execOutcome?.ok === false && String(execOutcome?.error?.message ?? "").includes("aborted"));
  check("delegate 取消链: run.dispose 已调用（资源清理）", delDisposed === 1);
  root.stop?.();
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
rmSync(tmp, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
