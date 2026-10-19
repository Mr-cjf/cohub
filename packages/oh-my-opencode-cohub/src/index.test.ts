// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供（对齐 council.test.ts 写法）
// src/index.test.ts
// 真实插件入口回归测试：Background Job Board 的会话隔离 + 任务精确关联
//
// 缺陷背景（会话隔离）：src/index.ts:752 已取到末尾 user 消息的 sessionID，但 :772 调用
// tracker.getBoardText() 时未传入该 sessionID，tracker 会回退到"最近一次
// tool hook 收到的 parentSessionId"（_currentParentSessionId），导致 A 会话
// 的 transform 注入 B 会话的任务（跨会话泄漏）。
//
// 缺陷背景（任务精确关联，Wave1 回归）：tool.execute.after 只传 parent sessionID，
// tracker.updateAfterTask(parent,...) 按"同 parent 最近创建的 running job"匹配，
// 并发乱序 / 未知 callID / child 复用场景会绑定/终结到错误的 job。
// 目标行为（后续修复）：按 (parentSessionID, callID) 精确关联 alias 与 childSessionID，
// 无匹配绝不回退最近、未知/歧义事件仅观测。
//
// 本文件经真实 tool.execute.before + tool.execute.after + event +
// experimental.chat.messages.transform hook 复现缺陷，作为后续修复的回归护栏。
// 期望行为（修复后）：
//   - A/B 交错注册（B 最后注册）：A 的 transform 只含 A 任务、不含 B；
//   - 无任务会话 / sessionID 缺失或为空：不注入任何 Board（不泄漏 B）；
//   - 空 content 防御回归：parts 空 / 无 text part 的 user 消息仍被补占位；
//   - 嵌套 A→C→D：A 只聚合直接子任务 C、不聚合孙任务 D；C 聚合 D。
//   - 同 parent 并发乱序：after(call1) 只更新 call1 的 job，不误伤 call2；
//   - 未知 callID：不更新任何 job（不回退最近）；
//   - child 复用：复用 session 只落在原调用，不覆盖新任务；
//   - 前台/后台 after 返回真实对象 {title, output, metadata}；
//   - 重复 after / 重复 session.idle 幂等。
//
// ⚠️ 隔离策略（不允许触碰真实用户文件）：
// 本包所有 config/state/log 路径都锚定 os.homedir()：
//   - src/index.ts 的 STATE_DIR（tracker-state.json / cohub-state.json / config-hook-ran.json）
//   - src/config/loader.ts 的 USER_CONFIG_PATH（~/.config/opencode/oh-my-opencode-cohub.json）
//   - src/task-manager/tracker.ts 的 STATS_FILE（stats.json）
//   - src/utils/log.ts 的 LOG_DIR（append-only 诊断日志）
//   - src/index.ts 的 loadFileOverrides 用户级覆盖目录（~/.config/opencode/oh-my-opencode-cohub/）
// 其中 USER_CONFIG_PATH / STATS_FILE / LOG_DIR 是**模块顶层常量**（导入时求值），
// 无法在已加载模块后通过 mock 生效；且并发会话下有真实文件覆写风险。
// 因此本测试把每个用例放进一个**独立子进程**（Bun 执行内嵌 runner.ts），
// 子进程启动时用临时目录重写 USERPROFILE/HOME/XDG_* 环境变量，使 os.homedir()
// 与全部派生路径都指向临时 HOME，再在其中导入真实插件并调用真实 hooks。
// 主测试进程只 spawn 子进程、解析其 JSON 断言结果——自身不加载生产模块、
// 不 mock 任何全局、不读不写真实用户路径。用例间进程级隔离，零共享状态。
// runner 脚本内嵌于本文件（含隔离守卫：os.homedir() 必须等于临时 USERPROFILE/HOME，
// 否则用例直接失败，防止测试在真实路径上偷偷运行）。

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 生产插件入口的绝对路径（子进程 runner 用真实 import 加载） */
const INDEX_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');

/**
 * 子进程 runner 源码（内嵌，避免新增生产文件）。
 * 由主进程写入临时 HOME 后以 `bun runner.ts` 执行；环境变量 COHUB_TEST_CASE 决定跑哪个用例。
 * 本字符串内不使用模板字符串插值（`${}`）与反引号，避免与外层模板冲突。
 */
const RUNNER_SRC = `// @ts-nocheck
// 隔离 HOME 子进程 runner：导入真实插件、调用真实 hooks，输出 JSON 断言结果。
import CoHubPlugin from __INDEX_TS_PATH__;
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

// ===== 隔离守卫：os.homedir() 必须指向重定向后的临时 HOME =====
// 若环境变量覆盖未生效（os.homedir 仍返回真实用户目录），立即失败并终止，
// 防止任何 config/state/log 写入真实用户路径。
const expectedHome = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
assert.ok(
  expectedHome && os.homedir() === expectedHome,
  '隔离守卫失败：os.homedir() 未指向临时 HOME（env=' + JSON.stringify(expectedHome) + ' got=' + os.homedir() + '）',
);

// ===== SDK client 最小 stub =====
// ContextEngine / CouncilManager / close_job 构造仅持有 client 引用；
// fillContextAsync 仅在策略非 none 时调用 client.session.messages——默认策略全部为 none，
// 本测试 registerTask 默认省略 context_override（走真实默认 none 路径，不读父历史），
// 显式 opt-in 用例单独传 context_override:'relevant' 验证详情注入。
// session.messages 供后台终态证据验证（session.idle 触发一次有界读取）——默认空记录
// （无证据 → 不终结），用例可经 setMessages 注入终态 / 中间轮 / 旧消息，
// 或经 gateMessages/releaseMessages 门控读取（模拟 idle await 期间的竞态）。
// session.prompt / session.message 若被调用说明插件自派发任务（红线），用例断言零调用。
function makeStubClient() {
  const calls = { prompt: 0, message: 0, abort: 0, messagesRead: 0 };
  let messages: unknown[] = [];
  // 队列式门控：每次 session.messages 读取取下一个 gate（FIFO 创建序）；无 gate 直读当前 messages。
  // gate→resolver 用 Map 按身份维护：gate 被读取（gated.shift 取走）后仍可被 releaseMessages
  // 按指定 gate 身份释放——绝不因 shift 导致「释放错位」（旧的 indexOf+shift 在并发多 gate 下
  // 会释放错 resolver，使 verify/capture 挂起、runner 无输出）。
  const gated: Array<Promise<unknown[]>> = [];
  const gateResolvers = new Map<Promise<unknown[]>, (m: unknown[]) => void>();
  const client = {
    session: {
      abort: async () => { calls.abort++; return { data: {}, error: undefined }; },
      messages: async () => {
        calls.messagesRead++;
        const gate = gated.shift();
        const data = gate ? await gate : messages;
        return { data, error: undefined };
      },
      prompt: async () => { calls.prompt++; return { data: {}, error: undefined }; },
      message: async () => { calls.message++; return { data: {}, error: undefined }; },
    },
  };
  return {
    client,
    calls,
    /** 尚未释放的 gate 数（测试末尾断言全部释放，避免挂起导致 runner 无输出）。
     *  按 Map 身份计数而非队列长度：gate 被 gated.shift() 读取后仍留在 Map 中直至 release 删除，
     *  用队列长度会把「已读取未释放」的 gate 误报为已释放，使挂起 Promise 被静默吞掉。 */
    getPendingGateCount: () => gateResolvers.size,
    setMessages: (m: unknown[]) => { messages = m; gated.length = 0; gateResolvers.clear(); },
    // TDZ 最小修复：Promise 执行器同步运行，执行器内引用尚未初始化的 p 会抛 ReferenceError，
    // 使返回的 Promise 立即拒绝 → 并发用例 verify/capture 拿不到消息（stats 无 completed、Board 空 records 假通过）。
    // 执行器只捕获 resolver，Promise 构造完成后再 Map.set(p, resolver)。
    gateMessages: () => {
      let resolver: (m: unknown[]) => void = () => {};
      const p = new Promise<unknown[]>((res) => { resolver = res; });
      gateResolvers.set(p, resolver);
      gated.push(p);
      return p;
    },
    // 无 gate 参数：释放最早创建的未释放 gate（既有用法兼容）；
    // 带 gate 参数：按身份释放指定 gate（并发乱序回放，已被读取的 gate 同样可释放）。
    releaseMessages: (m: unknown[], gate?: Promise<unknown[]>) => {
      const target = gate ?? gateResolvers.keys().next().value;
      const resolver = target ? gateResolvers.get(target) : undefined;
      if (target && resolver) {
        resolver(m);
        gateResolvers.delete(target);
      }
    },
  };
}

function makePluginInput(projectDir: string, client: unknown) {
  return {
    client,
    project: { id: 'cohub-index-test', directories: [projectDir] },
    directory: projectDir,
    worktree: projectDir,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://127.0.0.1:1'),
    $: () => {},
  };
}

/**
 * 经真实 tool.execute.before hook 注册一个子任务。
 * 默认省略 context_override（走默认策略——已改为全部 none，不注册/填充/读父历史，
 * 不注入上下文块）；需要验证显式 opt-in 时传 context_override:'relevant' 等；
 * 契约用例可传自定义 prompt（验证用户原文/手写契约块/空壳清理）。
 */
async function registerTask(
  hooks: any,
  sessionID: string,
  opts: { subagent_type: string; description: string; task_id?: string; background?: boolean; callID?: string; context_override?: string; prompt?: string },
) {
  const output: any = {
    args: {
      subagent_type: opts.subagent_type,
      description: opts.description,
      task_id: opts.task_id,
      background: opts.background ?? true,
      prompt: opts.prompt ?? '请执行：' + opts.description,
    },
  };
  if (opts.context_override !== undefined) {
    output.args.context_override = opts.context_override;
  }
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID, callID: opts.callID ?? 'call-' + sessionID + '-' + Math.random().toString(36).slice(2, 6) },
    output,
  );
  return output;
}

/**
 * 经真实 tool.execute.after hook 提交一次任务完成。
 * output 为 SDK 1.17.15 真实对象形态：{ title, output, metadata }；
 * childSessionId 经 metadata.sessionId 传递（与 src/index.ts extractChildSessionId 提取路径一致）。
 */
async function afterTask(
  hooks: any,
  sessionID: string,
  callID: string,
  opts: { childSessionId?: string; outputText?: string; background?: boolean } = {},
) {
  const output = {
    title: opts.outputText ?? 'done',
    output: opts.outputText ?? 'ok',
    metadata: opts.childSessionId ? { sessionId: opts.childSessionId } : {},
  };
  await hooks['tool.execute.after'](
    { tool: 'task', sessionID, callID, args: { background: opts.background ?? true } },
    output,
  );
}

/** 经真实 event hook 模拟宿主 session 生命周期事件（session.idle / session.deleted / session.error / session.status） */
async function emitEvent(hooks: any, type: string, sessionId: string, extra: Record<string, unknown> = {}) {
  await hooks['event']({ event: { type, properties: { sessionID: sessionId, ...extra } } });
}

/** 构造一条明确的终态 assistant 消息（finish + time.completed，无 tool/retry part） */
function terminalAssistantMsg(sessionId: string, createdMs?: number): unknown {
  const created = typeof createdMs === 'number' ? createdMs : Date.now();
  return {
    info: { role: 'assistant', sessionID: sessionId, time: { created: created, completed: created }, finish: 'finish' },
    parts: [{ type: 'text', text: 'done' }],
  };
}

/** 构造一条 tool-calls 中间轮 assistant 消息（无 finish/time.completed，含 tool part） */
function toolCallAssistantMsg(sessionId: string, createdMs?: number): unknown {
  const created = typeof createdMs === 'number' ? createdMs : Date.now();
  return {
    info: { role: 'assistant', sessionID: sessionId, time: { created: created } },
    parts: [{ type: 'tool', tool: 'bash', callID: 'tc-1', state: { status: 'completed' } }],
  };
}

/** 构造一条早于本轮调用的旧完成消息（复用会话历史，不应终结新调用） */
function oldTerminalMsg(sessionId: string, ageMs: number): unknown {
  const created = Date.now() - ageMs;
  return {
    info: { role: 'assistant', sessionID: sessionId, time: { created: created, completed: created }, finish: 'finish' },
    parts: [{ type: 'text', text: 'old' }],
  };
}

/** 等待异步诊断队列落盘（diag 用例用） */
function sleepMs(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 经真实 experimental.chat.messages.transform hook 对指定会话执行一次注入 */
async function transformFor(hooks: any, sessionID: string | undefined, userText = '请执行') {
  const output = {
    messages: [
      { info: { role: 'user', sessionID }, parts: [{ type: 'text', text: userText }] },
    ],
  };
  await hooks['experimental.chat.messages.transform']({}, output);
  return output;
}

/** 拼接消息全部 text part 内容，便于断言 Board 是否注入 */
function joinedText(parts: any[]): string {
  return (parts ?? [])
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text ?? '')
    .join('\\n');
}

/** 统一提取错误文本（不用反引号/模板插值，适配内嵌 runner 字符串） */
function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** 在隔离 HOME 内写入用户配置（插件实例化前调用，覆盖默认 quality/reuseBudget 开关） */
function writeUserConfig(cfg: Record<string, unknown>): void {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'oh-my-opencode-cohub.json'), JSON.stringify(cfg));
}

/** 每用例独立插件实例 + 独立临时 projectDir（均位于重定向后的临时 HOME 内），finally 必走 dispose 与清理 */
async function runCase(name: string, fn: (hooks: any, ctx: any) => Promise<void>, userConfig?: Record<string, unknown>) {
  const projectDir = fs.mkdtempSync(path.join(os.homedir(), 'cohub-proj-'));
  const stub = makeStubClient();
  const ctx = {
    calls: stub.calls,
    setMessages: stub.setMessages,
    gateMessages: stub.gateMessages,
    releaseMessages: stub.releaseMessages,
    getPendingGateCount: stub.getPendingGateCount,
  };
  let hooks: any;
  let bodyErr: unknown;
  let disposeErr: unknown;
  let cleanupErr: unknown;
  try {
    if (userConfig) writeUserConfig(userConfig);
    hooks = await CoHubPlugin(makePluginInput(projectDir, stub.client));
    await fn(hooks, ctx);
  } catch (err) {
    bodyErr = err;
  } finally {
    // finally 确保 cleanup 必走：dispose 与临时目录清理错误不再吞掉，
    // 与业务错误合并进失败结果（业务错误在前，均错时不互相覆盖，保留各自定位）。
    if (hooks?.dispose) {
      try { await hooks.dispose(); } catch (err) { disposeErr = err; }
    }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (err) { cleanupErr = err; }
  }
  if (bodyErr || disposeErr || cleanupErr) {
    const parts: string[] = [];
    if (bodyErr) parts.push('用例执行失败: ' + errText(bodyErr));
    if (disposeErr) parts.push('dispose 失败: ' + errText(disposeErr));
    if (cleanupErr) parts.push('临时目录清理失败: ' + errText(cleanupErr));
    return { name, ok: false, message: parts.join('\\n---\\n') };
  }
  return { name, ok: true };
}

// ===== 回归用例（与主进程 CASES 名称一一对应；config 为可选的用户配置注入，测试开关组合） =====
const runs: Array<{ name: string; fn: (hooks: any, ctx: any) => Promise<void>; config?: Record<string, unknown> }> = [
  {
    name: 'A/B 交错：A 只看到自己的任务，B 最后注册也不泄漏给 A',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', task_id: 'ses_A_child', background: true });
      await registerTask(hooks, 'ses_B', { subagent_type: 'co-explorer', description: '任务B', task_id: 'ses_B_child', background: true });

      // A 的会话：只显示 A 派生的任务（co-fixer / ses_A_child），不显示 B 的
      const outA = await transformFor(hooks, 'ses_A');
      const textA = joinedText(outA.messages[0].parts);
      assert.ok(textA.includes('Background Job Board'), 'A 应注入 Board');
      assert.ok(textA.includes('co-fixer'), 'A 应含 co-fixer');
      assert.ok(textA.includes('ses_A_child'), 'A 应含 ses_A_child');
      assert.ok(!textA.includes('co-explorer'), 'A 不应含 co-explorer');
      assert.ok(!textA.includes('ses_B_child'), 'A 不应含 ses_B_child');

      // B 的会话：只显示 B 派生的任务（co-explorer / ses_B_child）
      const outB = await transformFor(hooks, 'ses_B');
      const textB = joinedText(outB.messages[0].parts);
      assert.ok(textB.includes('Background Job Board'), 'B 应注入 Board');
      assert.ok(textB.includes('co-explorer'), 'B 应含 co-explorer');
      assert.ok(textB.includes('ses_B_child'), 'B 应含 ses_B_child');
      assert.ok(!textB.includes('co-fixer'), 'B 不应含 co-fixer');
      assert.ok(!textB.includes('ses_A_child'), 'B 不应含 ses_A_child');
    },
  },
  {
    name: '无任务的会话：transform 不注入任何 Board',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', task_id: 'ses_A_child', background: true });
      await registerTask(hooks, 'ses_B', { subagent_type: 'co-explorer', description: '任务B', task_id: 'ses_B_child', background: true });

      // C 从未注册任务：不应看到 A/B 任何任务（当前缺陷：无参会回退到 B → 泄漏）
      const outC = await transformFor(hooks, 'ses_C');
      const textC = joinedText(outC.messages[0].parts);
      assert.ok(!textC.includes('Background Job Board'), 'C 不应注入 Board');
      assert.ok(!textC.includes('co-fixer'), 'C 不应含 co-fixer');
      assert.ok(!textC.includes('co-explorer'), 'C 不应含 co-explorer');
      assert.ok(textC.includes('请执行'), 'C 应保留用户文本');
    },
  },
  {
    name: 'sessionID 缺失或为空：不泄漏最近注册的 B 任务',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_B', { subagent_type: 'co-explorer', description: '任务B', task_id: 'ses_B_child', background: true });

      for (const missing of [undefined, '']) {
        const out = await transformFor(hooks, missing);
        const text = joinedText(out.messages[0].parts);
        assert.ok(!text.includes('Background Job Board'), 'sessionID 缺失/为空不应注入 Board');
        assert.ok(!text.includes('co-explorer'), '不应泄漏 co-explorer');
        assert.ok(!text.includes('ses_B_child'), '不应泄漏 ses_B_child');
        assert.ok(text.includes('请执行'), '应保留用户文本');
      }
    },
  },
  {
    name: '空 content 防御：parts 为空或缺失 text part 的 user 消息仍被补占位，Board 追加其上',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', task_id: 'ses_A_child', background: true });

      // parts 为空数组
      const out1 = { messages: [{ info: { role: 'user', sessionID: 'ses_A' }, parts: [] }] };
      await hooks['experimental.chat.messages.transform']({}, out1);
      assert.ok(out1.messages[0].parts.length > 0, '空 parts 应被补占位');
      assert.ok(joinedText(out1.messages[0].parts).includes('Background Job Board'), 'Board 应追加到补位上');

      // parts 存在但无 text 类型（仅 tool 类型）
      const out2 = { messages: [{ info: { role: 'user', sessionID: 'ses_A' }, parts: [{ type: 'tool', tool: 'bash' }] }] };
      await hooks['experimental.chat.messages.transform']({}, out2);
      assert.ok(out2.messages[0].parts.some((p: any) => p.type === 'text'), '无 text part 应补 text part');
      assert.ok(joinedText(out2.messages[0].parts).includes('Background Job Board'), 'Board 应追加到补位上');
    },
  },
  {
    name: '无 user 消息：不注入、不改写既有消息',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', task_id: 'ses_A_child', background: true });

      const out = { messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'reply' }] }] };
      await hooks['experimental.chat.messages.transform']({}, out);
      assert.strictEqual(joinedText(out.messages[0].parts), 'reply');
    },
  },
  {
    name: '嵌套 A→C→D：A 只聚合直接子任务 C，不聚合孙任务 D；C 聚合 D',
    fn: async (hooks) => {
      // A 派生 C（parent=ses_A，child session=ses_C）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务C', task_id: 'ses_C', background: true });
      // C 派生 D（parent=ses_C，child session=ses_D）
      await registerTask(hooks, 'ses_C', { subagent_type: 'co-explorer', description: '任务D', task_id: 'ses_D', background: true });

      // A 只看直接子任务 C（co-fixer / ses_C），不聚合孙任务 D（co-explorer / ses_D）
      const outA = await transformFor(hooks, 'ses_A');
      const textA = joinedText(outA.messages[0].parts);
      assert.ok(textA.includes('Background Job Board'), 'A 应注入 Board');
      assert.ok(textA.includes('co-fixer'), 'A 应含 co-fixer');
      assert.ok(textA.includes('ses_C'), 'A 应含 ses_C');
      assert.ok(!textA.includes('co-explorer'), 'A 不应含 co-explorer');
      assert.ok(!textA.includes('ses_D'), 'A 不应含 ses_D');

      // C 看得到自己派生的 D
      const outC = await transformFor(hooks, 'ses_C');
      const textC = joinedText(outC.messages[0].parts);
      assert.ok(textC.includes('Background Job Board'), 'C 应注入 Board');
      assert.ok(textC.includes('co-explorer'), 'C 应含 co-explorer');
      assert.ok(textC.includes('ses_D'), 'C 应含 ses_D');
      assert.ok(!textC.includes('co-fixer'), 'C 不应含 co-fixer');
      assert.ok(!textC.includes('ses_C'), 'C 不应含 ses_C');
    },
  },
  // ===== Wave1 回归补充：任务精确关联（(parentSessionID, callID)） =====
  // 目标行为（后续修复后）：tool.execute.after 按 (sessionID, callID) 精确关联
  // before 注册的任务，无匹配绝不回退"最近 running job"；child 复用不覆盖原调用；
  // 未知/歧义事件仅观测。当前实现 updateAfterTask(parent,...) 按"同 parent 最近
  // running job"匹配且 index.ts 不消费 callID —— 以下 RED 用例即为该缺陷的回归复现，
  // GREEN 用例为改造后也必须保持的既有防回归。
  {
    name: '同 parent 并发乱序（后台）：after(call1) 只更新 call1 任务，call2 保持 pending',
    fn: async (hooks) => {
      // 同一 parent 并发注册两个后台任务：call1 → cof-1、call2 → cof-2
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Y', background: true, callID: 'call-2' });
      // after(call1) 只应命中 call1 对应的任务（cof-1），childSessionId 绑定到 cof-1
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_c1' });

      const out = await transformFor(hooks, 'ses_A');
      const text = joinedText(out.messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_c1 / alias=cof-1'), 'call1 任务应绑定 ses_c1');
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-2'), 'call2 任务应保持 pending');
    },
  },
  {
    name: '同 parent 并发乱序（前台）：after(call1) 只终结 call1 任务，call2 保持运行',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: false, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Y', background: false, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_f1' });

      const out = await transformFor(hooks, 'ses_A');
      const text = joinedText(out.messages[0].parts);
      // call1 任务（cof-1）应已完成消失；call2（cof-2）仍运行且未绑定 ses_f1
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-2'), 'call2 任务应保持 running/pending');
      assert.ok(!text.includes('alias=cof-1'), 'call1 任务应已终结不在 Board');
    },
  },
  {
    name: '未知 callID 的 after：不回退到最近任务，不更新任何 job',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      // 从未 before 过的 callID 出现在 after：目标行为是不匹配任何任务、仅观测不绑定
      await afterTask(hooks, 'ses_A', 'call-never-registered', { childSessionId: 'ses_unk' });

      const out = await transformFor(hooks, 'ses_A');
      const text = joinedText(out.messages[0].parts);
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-1'), '未知 callID 不应绑定 childSessionId');
    },
  },
  {
    name: '不同 parent 同 callID 不交叉（反向结束）：after(A) 不触 B、after(B) 不触 A',
    fn: async (hooks) => {
      // 同一 callID 在不同 parent 下出现（宿主可能复用 callID 命名空间），不得串扰；
      // 反向结束顺序：B 后注册，若被"最近"逻辑影响，A 的 after 会误伤 B。
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', background: true, callID: 'shared-call' });
      await registerTask(hooks, 'ses_B', { subagent_type: 'co-explorer', description: '任务B', background: true, callID: 'shared-call' });
      await afterTask(hooks, 'ses_A', 'shared-call', { childSessionId: 'ses_a' });
      await afterTask(hooks, 'ses_B', 'shared-call', { childSessionId: 'ses_b' });

      const textA = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      const textB = joinedText((await transformFor(hooks, 'ses_B')).messages[0].parts);
      assert.ok(textA.includes('co-fixer / running / ses_a / alias=cof-1'), 'A 的任务应绑定 ses_a');
      assert.ok(!textA.includes('ses_b'), 'A 不应泄漏 B 的 childSessionId');
      assert.ok(textB.includes('co-explorer / running / ses_b / alias=coe-1'), 'B 的任务应绑定 ses_b');
      assert.ok(!textB.includes('ses_a'), 'B 不应泄漏 A 的 childSessionId');
    },
  },
  {
    name: '前台任务 after 返回对象：childSessionId 绑定且状态终结',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: false, callID: 'call-1' });
      // output 为真实对象：{ title, output, metadata:{ sessionId } }（SDK 1.17.15 形态）
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_f1', outputText: '完成' });

      const out = await transformFor(hooks, 'ses_A');
      const text = joinedText(out.messages[0].parts);
      // 唯一任务已终结且已 reconcile：Active/Reusable 均无 → 不注入 Board
      assert.ok(!text.includes('Background Job Board'), '终结任务不应再注入 Board');
    },
  },
  {
    name: '后台任务 after 返回对象：childSessionId 绑定、保持 running',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1', outputText: '后台完成' });

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '后台任务应绑定 ses_b1 并保持 running');
    },
  },
  {
    name: '重复 after 幂等：前台任务二次 after 不重复改写、不误伤其他任务',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: false, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_f1' });
      // 第二次 after（重复事件）：已终结，不应再触发任何状态改写
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_f1' });

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), '重复 after 后 Board 仍为空');
    },
  },
  {
    name: 'event session.idle 幂等：有明确完成证据时收尾，重复 idle 不改状态、不重复渲染',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 注入明确终态证据后 idle → 完成收尾（idle 本身不是成功证据）
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      // 重复 idle（幂等）：已完成 job 不应再被改写
      await emitEvent(hooks, 'session.idle', 'ses_b1');

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), '完成后不应再注入 Board');
    },
  },
  {
    name: '同 child 会话复用登记：复用会话创建独立 job，不与原记录混淆',
    fn: async (hooks) => {
      // 复用已完成子会话（task_id=ses_reuse）：宿主按"复用已完成 session"语义发起新调用
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '复用任务', task_id: 'ses_reuse', background: true, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新任务', background: true, callID: 'call-2' });

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      // 两个 job 并存：复用 job 保留 ses_reuse，新 job 待绑定
      assert.ok(text.includes('co-fixer / running / ses_reuse / alias=cof-1'), '复用 job 应保留 ses_reuse');
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-2'), '新 job 应 pending');
    },
  },
  {
    name: 'child 复用不覆盖原调用：after(call1) 不得把复用 session 绑定到新任务',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '复用任务', task_id: 'ses_reuse', background: true, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新任务', background: true, callID: 'call-2' });
      // call1 完成：childSessionId 仍是复用的 ses_reuse，只能落在 call1 的 job（cof-1）上
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_reuse / alias=cof-1'), '复用 job 应保持 ses_reuse');
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-2'), '新任务不应被绑定复用 session');
    },
  },
  // ===== Wave4 新增：后台终态证据判定 + 事件幂等 + 观测接线 =====
  {
    name: '后台 idle 无证据不终结：空记录保持 running，不假成功',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // stub messages 默认空：idle 无终态证据 → 保持 running
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '无证据 idle 不应终结任务');
    },
  },
  {
    name: '后台 idle 有新鲜终态证据：明确完成才收尾',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 明确终态证据（finish + time.completed，创建时间晚于调用开始）
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), '有终态证据应完成收尾');
    },
  },
  {
    name: '后台 idle 中间轮不终结：tool-calls 轮保持 running',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([toolCallAssistantMsg('ses_b1')]); // tool-calls 中间轮，任务仍在执行
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '中间轮不应终结任务');
    },
  },
  {
    name: 'session.error 不假成功：仅观测，任务保持 running',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // API 错误（如 429）可能是宿主重试中的临时错误：不得终结成最终失败
      await emitEvent(hooks, 'session.error', 'ses_b1', { error: { name: 'APIError', data: { statusCode: 429, isRetryable: true } } });
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), 'session.error 不应终结任务');
    },
  },
  {
    name: 'session.status retry 后完成：retry 仅观测，idle+证据才收尾',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 宿主 retry：不终结
      await emitEvent(hooks, 'session.status', 'ses_b1', { status: { type: 'retry', attempt: 1, message: 'rate limited', next: Date.now() + 5000 } });
      let text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), 'retry 中不应终结');
      // retry 后终态证据 + idle → 完成
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), 'retry 后完成应收尾');
    },
  },
  {
    name: '同 child 复用旧消息不终结新调用：新鲜度边界生效',
    fn: async (hooks, ctx) => {
      // 复用会话历史：cof-1 持有 ses_reuse；cof-2 是复用该 session 的新调用
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '复用任务', task_id: 'ses_reuse', background: true, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新任务', background: true, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      await afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_reuse' });
      // 旧完成消息（创建时间早于新调用开始）：不得作为新调用完成证据
      ctx.setMessages([oldTerminalMsg('ses_reuse', 60000)]);
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('alias=cof-1'), '复用 job 不应被终结');
      assert.ok(text.includes('alias=cof-2'), '新调用不应被旧消息终结');
    },
  },
  {
    name: 'sessionID 缺失的事件不误关联任何任务',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // session.error / idle / status 均缺 sessionID：不得触碰任何任务
      await emitEvent(hooks, 'session.error', '');
      await emitEvent(hooks, 'session.idle', '');
      await emitEvent(hooks, 'session.status', '', { status: { type: 'retry', attempt: 1, message: 'x', next: Date.now() + 1000 } });
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '缺 sessionID 事件不应影响任务');
    },
  },
  {
    name: '原生 task 无二次启动：插件不调用 sdk prompt/message 自派发任务',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      assert.strictEqual(ctx.calls.prompt, 0, '插件不得调用 sdk session.prompt 自派发');
      assert.strictEqual(ctx.calls.message, 0, '插件不得调用 sdk session.message 自派发');
    },
  },
  {
    name: 'diag 默认关闭：任务生命周期事件不产生诊断写入',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      await emitEvent(hooks, 'session.status', 'ses_b1', { status: { type: 'retry', attempt: 1, message: 'x', next: Date.now() + 1000 } });
      await emitEvent(hooks, 'session.error', 'ses_b1', { error: { name: 'APIError', data: { statusCode: 429 } } });
      await sleepMs(150); // 给潜在异步写入留窗口，断言仍无文件
      const diagFile = path.join(os.tmpdir(), 'opencode', 'ctx-diag.log');
      assert.ok(!fs.existsSync(diagFile), 'diag 默认关闭不应产生诊断日志文件');
    },
  },
  {
    name: 'diag 开启：任务生命周期事件产生结构化 task 记录（白名单字段）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      await sleepMs(200); // 等待异步诊断队列落盘
      const diagFile = path.join(os.tmpdir(), 'opencode', 'ctx-diag.log');
      assert.ok(fs.existsSync(diagFile), 'diag 开启应产生诊断日志文件');
      const content = fs.readFileSync(diagFile, 'utf-8');
      assert.ok(content.includes('"t":"task"'), '日志应含 task 结构化记录');
      assert.ok(content.includes('task_started'), '应记录 task_started 事件');
      assert.ok(!content.includes('apiKey'), '白名单字段不应输出敏感键名');
    },
  },
  // ===== Wave4.1 新增：复用收尾 + 终态判定精度 + 竞态 =====
  {
    name: '复用收尾端到端：旧调用完成后复用新调用，新鲜证据 idle 收尾新调用（历史不阻碍）',
    fn: async (hooks, ctx) => {
      // 第一次调用：唯一 active → idle + 终态证据 → 完成（成为历史）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '旧调用', task_id: 'ses_reuse', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      ctx.setMessages([terminalAssistantMsg('ses_reuse')]);
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      let text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), '旧调用应收尾完成');

      // 复用同一子会话发起新调用
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新调用', task_id: 'ses_reuse', background: true, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_reuse' });
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('alias=cof-2'), '新调用应运行中');

      // 新鲜终态证据 + idle：历史（cof-1 同 childID）不应阻碍新调用收尾
      ctx.setMessages([terminalAssistantMsg('ses_reuse', Date.now())]);
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-2'), '新调用应收尾完成（历史不阻碍）');
    },
  },
  {
    name: '两个 active 共享 childID：idle 歧义无副作用，均保持 running',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', task_id: 'ses_dup', background: true, callID: 'call-1' });
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Y', task_id: 'ses_dup', background: true, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_dup' });
      await afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_dup' });
      ctx.setMessages([terminalAssistantMsg('ses_dup')]);
      await emitEvent(hooks, 'session.idle', 'ses_dup');

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('alias=cof-1'), '歧义时 cof-1 保持 running');
      assert.ok(text.includes('alias=cof-2'), '歧义时 cof-2 保持 running');
    },
  },
  {
    name: 'idle 读取期间 cancel：await 回来不误收尾（候选已终态）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 门控读取：idle 进入 await verifyChildTerminal（session.messages 被 gate 阻塞）
      ctx.gateMessages();
      const idlePromise = emitEvent(hooks, 'session.idle', 'ses_b1');
      // 读取期间用户 cancel（abortJob 按 sessionId）
      await hooks['tool.execute.after'](
        { tool: 'cancel_task', sessionID: 'ses_A', callID: 'cancel-1', args: { task_id: 'ses_b1' } },
        { title: 'cancelled', output: 'cancelled', metadata: {} },
      );
      // 释放终态证据：await 回来后竞态复核发现 job 已 cancelled → 不误更新
      ctx.releaseMessages([terminalAssistantMsg('ses_b1')]);
      await idlePromise;

      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'cancel 后 idle 不应把任务改为 completed');
      assert.ok(!text.includes('co-fixer / running'), '任务应保持 cancelled（非 running）');
    },
  },
  {
    name: 'latest assistant finish=tool-calls：中间轮不终结，保持 running',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now() }, finish: 'tool-calls' }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), 'tool-calls 中间轮应保持 running');
    },
  },
  {
    name: 'finish=length 不成功结局：收尾为 errored 而非假成功',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'length' }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'length 不成功结局不应假成功');
    },
  },
  {
    name: 'finish 未知值：不臆测成功，保持 running',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'mystery-stop' }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '未知 finish 应保持 running');
    },
  },
  {
    name: 'completed tool parts + 最终 stop：合法完成收尾',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish' },
        parts: [{ type: 'tool', tool: 'bash', callID: 'tc-1', state: { status: 'completed' } }, { type: 'text', text: 'done' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), 'completed tool parts + stop 应收尾');
    },
  },
  {
    name: '明确 error/abort 分类：普通最终 error → errored，MessageAbortedError → cancelled',
    fn: async (hooks, ctx) => {
      // 普通最终 error → errored（不显示 running）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now() }, error: { name: 'APIError', data: { message: 'boom', isRetryable: false } } }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      let text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('co-fixer / running / ses_b1 / alias=cof-1'), '最终 error 应收尾为 errored');

      // MessageAbortedError → cancelled（同样不显示 running）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Y', background: true, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_b2' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b2', time: { created: Date.now() }, error: { name: 'MessageAbortedError', data: { message: 'user aborted' } } }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b2');
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('co-fixer / running / ses_b2 / alias=cof-2'), 'abort 应收尾（cancelled 不显示 running）');
    },
  },
  {
    name: 'after metadata 显式失败：后台任务按真实结局收尾，不假成功',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      // after 返回 metadata.status=failed：task 工具调用明确失败（不从任意文本推断）
      await hooks['tool.execute.after'](
        { tool: 'task', sessionID: 'ses_A', callID: 'call-1', args: { background: true } },
        { title: 'failed', output: 'task rejected', metadata: { sessionId: 'ses_b1', status: 'failed' } },
      );
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), '显式失败应终结，不假成功');
    },
  },
  {
    name: '原生 task part error：message.part.updated 按父 session+callID 精确收尾',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 父会话 task 工具的 part 更新为 error 终态（SDK EventMessagePartUpdated 形状）
      await hooks['event']({ event: { type: 'message.part.updated', properties: {
        part: { type: 'tool', tool: 'task', sessionID: 'ses_A', callID: 'call-1', state: { status: 'error', error: 'dispatch failed' } },
      } } });
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'task part error 应按真实失败收尾');
    },
  },
  // ===== 宿主任务生命周期遗漏修复（Wave5）=====
  {
    name: '宿主 promotion：before 前台但 after 原生后台 shape → 保留 running，idle 新鲜终态正常收尾',
    fn: async (hooks, ctx) => {
      // before 认为前台（background: false），after 的原生 metadata 明确 background:true
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: false, callID: 'call-1' });
      await hooks['tool.execute.after'](
        { tool: 'task', sessionID: 'ses_A', callID: 'call-1', args: { background: false } },
        { title: 'started', output: 'task started in background', metadata: { sessionId: 'ses_b1', background: true, jobId: 'job-1' } },
      );
      // 应被 promotion 为后台并绑定 child，保持 running（不假成功 complete）
      let text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / ses_b1 / alias=cof-1'), 'promotion 后应后台运行并绑定 child');
      // 新鲜终态 idle → 正常收尾
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), 'promotion 后台任务应经 idle 收尾');
    },
  },
  {
    name: '宿主 promotion 最终 error：原生后台 idle + 最终错误 → errored（不假成功）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: false, callID: 'call-1' });
      await hooks['tool.execute.after'](
        { tool: 'task', sessionID: 'ses_A', callID: 'call-1', args: { background: false } },
        { title: 'started', output: 'bg', metadata: { sessionId: 'ses_b1', background: true } },
      );
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now() }, error: { name: 'APIError', data: { message: 'boom', isRetryable: false } } }, parts: [] }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'promotion 后台最终 error 应收尾 errored');
    },
  },
  {
    name: '首次 child 绑定前 idle 丢失：after 绑定后补有界核验收尾，不永久 running',
    fn: async (hooks, ctx) => {
      // 后台任务，before 未绑定 child（task_id 未传）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      // child 消息已完成但 idle 在绑定前到达：findActive no-match → idle 丢失（不操作）
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      // after 绑定 childID → 补一次有界核验（共用 reconcileJobTerminal）→ 收尾
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), '绑定后补核验应收尾，不永久 running');
    },
  },
  {
    name: '早到 idle：after 确认完成后仍捕获正文/质量与 300001 输入超预算',
    fn: async (hooks, ctx) => {
      // before 未传 task_id（未绑定 child）；child 已完成但 idle 在绑定前到达（no-match 丢失）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish', tokens: { input: 300000, output: 50, cache: { read: 0, write: 1 } } },
        parts: [{ type: 'text', text: '关键结论正文' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1'); // 早到：未绑定 childID → no-match 丢失
      // after 绑定 childID → 补核验 completed → 补捕获（正文/质量/复用采样随 idle 共用路径写回）
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      await sleepMs(150); // 等待 capture .then 异步写回
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('Background Job Board'), '早到 idle + after 补核验应收尾完成');
      // 归一化输入 = 300000 + 0 + 1 = 300001 > 200K 默认预算 → 超预算，不建议复用
      assert.ok(text.includes('ses_b1(co-fix/超预算，不建议复用)'), '300001 输入应标超预算不建议复用');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      const rec = records.find((r) => (r as { status?: string }).status === 'completed');
      assert.ok(rec, '应有 completed 统计记录（after 补捕获写回）');
      assert.strictEqual((rec as { tokens?: { input?: number } }).tokens?.input, 300000, '质量 tokens 应写回');
    },
  },
  {
    name: '早到 idle：显式 dependencyPropagation=true 结果可传播',
    config: { context: { dependencyPropagation: true } },
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: '已确定方案：采用字段缺失方案' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1'); // 早到：no-match 丢失
      // after 绑定 childID → 补核验 completed → 补捕获 → dependencyCache 写入（显式开启传播）
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      await sleepMs(200); // 等待 capture 异步写入 dependencyCache
      // 复用该 session 发起新调用（显式 relevant 触发 fill）：依赖结果应注入 prompt
      const out = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新任务', task_id: 'ses_b1', background: true, callID: 'call-2', context_override: 'relevant' });
      assert.ok(out.args.prompt.includes('依赖结果'), '应注入依赖结果区块');
      assert.ok(out.args.prompt.includes('已确定方案'), '依赖结果应传播到新调用 prompt');
    },
  },
  {
    name: '早到 idle：重复 after/idle 仅针对原调用收尾捕获，不累积不覆盖',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'done' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1'); // 早到丢失
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' }); // 首次：补核验 completed + 补捕获
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' }); // 重复 after：不重复捕获
      await emitEvent(hooks, 'session.idle', 'ses_b1'); // 重复 idle：已终态 no-match 不操作
      await sleepMs(150);
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      const completed = records.filter((r) => (r as { status?: string }).status === 'completed');
      assert.strictEqual(completed.length, 1, '重复 after/idle 不应累积 stats 记录');
      // 读取计数明确无重复捕获：早到 idle 0 读 + 首次 after verify 1 读 + capture 1 读 +
      // 重复 after 核验 1 读（竞态拦截不捕获）+ 重复 idle 0 读 = 3；重复 after 不得再发起 capture。
      assert.strictEqual(ctx.calls.messagesRead, 3, '重复 after/idle 不应产生额外捕获读取');
      assert.ok(records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100), '首次补捕获应写回质量 tokens');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('ses_b1(co-fix/最近输入 110)'), '应展示一次采样 100+5+5=110');
    },
  },
  {
    name: '早到 idle：异步旧采样晚到不污染复用后新调用（snapshot+sequence guards）',
    fn: async (hooks, ctx) => {
      // 旧调用：before 未绑定 child，idle 早到丢失（no-match，不读 messages）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '旧调用', background: true, callID: 'call-1' });
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      // FIFO gate：after-1 verify(g0)、after-1 补捕获 capture(g1)、after-2 verify(g2)、
      // 新 idle verify(g3)、新 idle capture(g4)
      const g0 = ctx.gateMessages();
      const g1 = ctx.gateMessages();
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const g4 = ctx.gateMessages();
      const afterP = afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g0); // verify 见终态 → completed
      await afterP; // 补捕获已发起（capture 读 g1 挂起）
      // 复用同一 child 发起新调用：绑定后保持 running（verify 读 g2 中间轮）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '新调用', task_id: 'ses_reuse', background: true, callID: 'call-2' });
      const after2 = afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_reuse' });
      ctx.releaseMessages([toolCallAssistantMsg('ses_reuse')], g2); // 中间轮 → unknown → 保持 running
      await after2;
      // 新 idle：终态证据 → cof-2 收尾 + 捕获（读 g3/g4）
      const idleP = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse', Date.now())], g3);
      await idleP;
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 300, output: 200, cache: { read: 10, write: 10 } } },
        parts: [{ type: 'text', text: 'two' }],
      }], g4);
      await sleepMs(150); // 新调用采样 300 先写回
      // 旧 after 补捕获迟到（g1）：旧消息 tokens 100（created 早于旧调用开始 → 复用采样未知）
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() - 60000 }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'old-stale' }],
      }], g1);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      // 快照/代次守卫：旧 after 补捕获 100 写回原调用（call-1），不得覆盖新调用 cof-2 的 300
      const t300 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 300);
      const t100 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100);
      assert.ok(t300, '新调用采样 300 应写回（不被旧采样覆盖）');
      assert.ok(t100, '旧 after 补捕获 100 应写回原调用（call 隔离，不污染新调用）');
    },
  },
  {
    name: '同 call 同 alias：旧 after 核验迟到不得借用 idle 收尾额外捕获（300001 保留）',
    fn: async (hooks, ctx) => {
      // 精确反例（oracle 实测）：同 call 同 alias，after 核验 await 挂起期间新 idle 核验并发
      // 收尾 completed 并采样 300001；旧 after 核验返回中间轮，reconcile 竞态复核看到终态直接
      // 退出——外层不得借用 idle 的 completed 状态递增 seq 额外捕获（丢 idle 有效采样、Board 变
      // 输入未知）。修复：reconcile 返回"本次实际完成 running→completed"，非本次收尾不补捕获。
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      // 首次 after 绑定自带补核验：verify 直读默认空消息（在 g0 之前，不占 gate）→ unknown → 不捕获
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_race' });
      // FIFO gate：旧 after verify(g0)、新 idle verify(g1)、新 idle capture(g2)
      const g0 = ctx.gateMessages();
      const afterP = afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_race' }); // 旧 after 重入：verify 挂起 g0
      const g1 = ctx.gateMessages();
      const g2 = ctx.gateMessages();
      const idleP = emitEvent(hooks, 'session.idle', 'ses_race'); // 新 idle：verify 读 g1 挂起
      // 新 idle 先回终态：本次收尾 completed + 分配代次 + 发起采样（capture 读 g2 挂起）
      ctx.releaseMessages([terminalAssistantMsg('ses_race', Date.now())], g1);
      await idleP;
      // 旧 after 核验迟到回中间轮：reconcile 竞态复核发现 job 已被 idle 收尾 → 本次未收尾、
      // 外层不得因看到 completed 而额外捕获（不递增代次、不发起第二次 capture）
      ctx.releaseMessages([toolCallAssistantMsg('ses_race')], g0);
      await afterP;
      // idle 的采样 300001（300000 + 0 + 1）应写回；旧 after 若额外捕获会把有效采样覆盖为未知
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_race', time: { created: Date.now(), completed: Date.now() }, finish: 'finish', tokens: { input: 300000, output: 50, cache: { read: 0, write: 1 } } },
        parts: [{ type: 'text', text: 'big' }],
      }], g2);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      const completed = records.filter((r) => (r as { status?: string }).status === 'completed');
      assert.strictEqual(completed.length, 1, '旧 after 不得额外捕获产生第二条 completed 记录');
      const t300 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 300000);
      assert.ok(t300, 'idle 的 300000 采样应写回（不被旧 after 额外捕获覆盖为未知）');
      // 读取计数恰为 4：首次 after 绑定补核验 verify(1) + 旧 after 重入 verify(2) +
      // 新 idle verify(3) + 新 idle capture(4)；旧 after 重入竞态拦截不补捕获（无第 5 读）。
      assert.strictEqual(ctx.calls.messagesRead, 4, '读取应恰为首次 after verify + 旧 after verify + 新 idle verify + 新 idle capture（旧 after 重入无额外捕获）');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('ses_race(co-fix/超预算，不建议复用)'), 'Board 应保留 idle 的 300001 超预算建议');
      assert.ok(!text.includes('输入未知'), '旧 after 不得把有效采样冲成未知');
    },
  },
  {
    name: '原生 subtask after undefined：不崩溃不假成功，error part 按已登记 part.id 精确收尾',
    fn: async (hooks) => {
      // before.callID = part.id（宿主 subtask 失败路径：调用标识用 part.id）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'part-123' });
      // after 无有效输出（undefined）：保留 running，不让 after 访问 undefined 崩溃
      await hooks['tool.execute.after'](
        { tool: 'task', sessionID: 'ses_A', callID: 'part-123', args: { background: true } },
        undefined,
      );
      let text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('co-fixer / running / pending / alias=cof-1'), 'after undefined 应保持 running');
      // 错误 part：id 相同（part-123）但 callID 不同 → 按已登记 part.id 回退关联 → errored
      await hooks['event']({ event: { type: 'message.part.updated', properties: {
        part: { id: 'part-123', type: 'tool', tool: 'task', sessionID: 'ses_A', callID: 'part-999', state: { status: 'error', error: 'dispatch failed' } },
      } } });
      text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'error part 应按已登记 part.id 收尾 errored');
    },
  },
  {
    name: '质量写回：两次同 child 复用输出不同 tokens，旧记录不被新结果覆盖',
    fn: async (hooks, ctx) => {
      // 第一次调用：消息 A tokens {100,50}
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务一', task_id: 'ses_reuse', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50 } }, parts: [{ type: 'text', text: 'one' }] }]);
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      // 第二次复用：消息 B tokens {300,200}
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务二', task_id: 'ses_reuse', background: true, callID: 'call-2' });
      await afterTask(hooks, 'ses_A', 'call-2', { childSessionId: 'ses_reuse' });
      ctx.setMessages([{ info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 300, output: 200 } }, parts: [{ type: 'text', text: 'two' }] }]);
      await emitEvent(hooks, 'session.idle', 'ses_reuse');
      // 等待异步质量回送 then 落盘 stats（隔离 HOME 内）
      await sleepMs(200);
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      const t1 = records.find((r) => (r as { tokens?: { input?: number; output?: number } }).tokens?.input === 100 && (r as { tokens?: { input?: number; output?: number } }).tokens?.output === 50);
      const t2 = records.find((r) => (r as { tokens?: { input?: number; output?: number } }).tokens?.input === 300 && (r as { tokens?: { input?: number; output?: number } }).tokens?.output === 200);
      assert.ok(t1 && t2, '两次复用质量 tokens 应分别写回（旧记录不被新结果覆盖）');
    },
  },
  {
    name: '真实 close_job 工具：co-orchestrator 取消后台任务，engine 镜像 + 精确 parent 刷新（Board 正确）',
    fn: async (hooks) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 真实 tools.close_job.execute（仅 co-orchestrator 身份）
      const res = await hooks.tool.close_job.execute({ task_id: 'cof-1' }, { sessionID: 'ses_A', agent: 'co-orchestrator' });
      const parsed = JSON.parse(res) as Record<string, unknown>;
      assert.strictEqual(parsed.ok, true, 'close_job 应返回 ok');
      assert.strictEqual(parsed.status, 'cancelled', 'close_job 应返回 cancelled');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(!text.includes('alias=cof-1'), 'cancelled 任务不应显示在 Board');
    },
  },
  // ===== Wave7：复用可见性 / 采样新鲜度 / 开关独立 / 并发代次守卫 =====
  {
    name: '完整链路：idle 终态完成后 Board 展示可复用 session 与输入未知建议',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 新鲜终态证据（无 tokens）→ idle 完成收尾；capture 无采样
      ctx.setMessages([terminalAssistantMsg('ses_b1')]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      await sleepMs(150); // 等待 capture .then 异步写回
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      // 真实 finalize 路径完成后 session 仍可复用（不再从 Board 消失），无采样 → 输入未知
      assert.ok(text.includes('复用:'), '完成后应展示可复用 session');
      assert.ok(text.includes('ses_b1(co-fix/输入未知)'), '应含 session 与输入未知建议');
    },
  },
  {
    name: '质量关闭+预算开启：复用采样写回且不写虚构分数（开关独立）',
    config: { quality: { enabled: false } },
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      // 终态消息带 tokens+cache：归一化 input = 100+40+60 = 200
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 40, write: 60 } } },
        parts: [{ type: 'text', text: 'done' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      await sleepMs(150);
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('最近输入 200'), 'quality 关闭不应阻止预算采样写回');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      if (fs.existsSync(statsFile)) {
        const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
        const rec = records.find((r) => (r as { status?: string }).status === 'completed');
        // 质量关闭：只写采样，不写虚构 tokens/score
        assert.ok(rec && (rec as { tokens?: unknown }).tokens === undefined, '质量关闭不应写虚构 tokens');
      }
    },
  },
  {
    name: '两者皆关闭：不回写质量/采样（capture 仍承载依赖传播）',
    config: { quality: { enabled: false }, reuseBudget: { enabled: false } },
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish', tokens: { input: 300, output: 50, cache: { read: 10, write: 10 } } },
        parts: [{ type: 'text', text: 'done' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      await sleepMs(150);
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      // Board 仍展示可复用 session，但不带任何建议（reuse 参数关闭）
      assert.ok(text.includes('复用:'), '应展示可复用 session');
      assert.ok(!text.includes('最近输入'), '预算关闭不应显示用量');
      assert.ok(!text.includes('输入未知'), '预算关闭不应显示建议');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      if (fs.existsSync(statsFile)) {
        const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
        const rec = records.find((r) => (r as { status?: string }).status === 'completed');
        assert.ok(rec && (rec as { tokens?: unknown }).tokens === undefined, '两者关闭不应写虚构 tokens');
      }
    },
  },
  {
    name: '并发 idle capture：新高用量不被旧 low 迟到覆盖（代次守卫）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      // 第一次 idle：verify 中间轮（无终态证据）→ 保持 running；capture1 挂起（读 g1）
      const g0 = ctx.gateMessages();
      const g1 = ctx.gateMessages();
      const idle1 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([toolCallAssistantMsg('ses_reuse')], g0);
      await idle1;
      // 第二次 idle：新鲜终态证据 → 完成收尾；capture2 挂起（读 g3）
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const idle2 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g2);
      await idle2;
      // 新结果先回（capture2：tokens 300）
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, tokens: { input: 300, output: 200, cache: { read: 10, write: 10 } } },
        parts: [{ type: 'text', text: 'two' }],
      }], g3);
      await sleepMs(150);
      // 旧结果迟到（capture1：tokens 100）——代次守卫应拦截，不覆盖新结果
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'one' }],
      }], g1);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      // 恰好一条 completed：capture2 写回一次，capture1 迟到被代次守卫拦截（不会产生第二条记录）
      const completed = records.filter((r) => (r as { status?: string }).status === 'completed');
      assert.strictEqual(completed.length, 1, '应恰好一条 completed 记录（代次守卫去重）');
      const t300 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 300);
      const t100 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100);
      assert.ok(t300, '新结果 300 应写回');
      assert.ok(!t100, '旧结果 100 不应覆盖（代次守卫拦截）');
    },
  },
  {
    name: '并发 idle capture：新未知先回，旧有值迟到不覆盖未知（未知亦遵守）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      // 第一次 idle：verify 中间轮 → 保持 running；capture1 挂起（读 g1）
      const g0 = ctx.gateMessages();
      const g1 = ctx.gateMessages();
      const idle1 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([toolCallAssistantMsg('ses_reuse')], g0);
      await idle1;
      // 第二次 idle：新鲜终态证据 → 完成收尾；capture2 挂起（读 g3）
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const idle2 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g2);
      await idle2;
      // 最新请求（capture2）先回：消息无 tokens → 采样/质量 tokens 未知
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: 'latest-no-tokens' }],
      }], g3);
      await sleepMs(150);
      // 旧请求（capture1：tokens 100）迟到——即使最新为未知，旧值也不得覆盖（未知亦遵守）
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'one' }],
      }], g1);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      // 恰好一条 completed（unknown 采样也写回）：空 records 时 Board「输入未知」是假通过，须有真实记录支撑
      const completed = records.filter((r) => (r as { status?: string }).status === 'completed');
      assert.strictEqual(completed.length, 1, '应恰好一条 completed 记录（未知采样仍写回）');
      const t100 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100);
      assert.ok(!t100, '旧值 100 不得覆盖未知（代次守卫，未知亦遵守）');
      // Board 确实展示该 session 输入未知（非无采样的空 records 假通过）
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('ses_reuse(co-fix/输入未知)'), 'Board 应显示该 session 输入未知');
      assert.ok(!text.includes('最近输入'), '未知采样不应显示用量');
    },
  },
  {
    name: 'idle 终态 verify 旧消息：不把旧采样回填本轮（新鲜度边界）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      // verify 读新鲜终态（完成收尾），capture 读旧历史消息（created 早于本轮调用开始）
      const g0 = ctx.gateMessages();
      const g1 = ctx.gateMessages();
      const idleP = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g0);
      await idleP;
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() - 60000 }, finish: 'finish', tokens: { input: 999, output: 1, cache: { read: 1, write: 1 } } },
        parts: [{ type: 'text', text: 'stale' }],
      }], g1);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      // 旧采样未写回 → 显示输入未知（而非旧 999）。此断言基于真实采样路径：
      // gate 已释放使 capture 确实读到旧消息，新鲜度边界将其判为未知——不是 gate 崩溃导致的空 records 假通过。
      assert.ok(text.includes('ses_reuse(co-fix/输入未知)'), '旧采样不应回填本轮');
      assert.ok(!text.includes('最近输入'), '不应显示旧用量');
    },
  },
  {
    name: '并发 idle verify 倒序：旧 verify 迟到不得取代新 idle 采样（序号 await 前分配）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      // messages 直读兜底为旧有值 100（旧实现下 idle1 的 capture 直读 messages 写回覆盖新采样）
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'stale' }],
      }]);
      const g0 = ctx.gateMessages();
      const idle1 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const idle2 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      // verify 倒序释放：新 idle2 先回（终态证据 → 完成收尾），旧 idle1 后回
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g2);
      await idle2;
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g0);
      await idle1;
      // capture：新（idle2）先回 tokens 300
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 300, output: 200, cache: { read: 10, write: 10 } } },
        parts: [{ type: 'text', text: 'new' }],
      }], g3);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      // 新采样 300 应写回；旧 idle1 的 verify 迟到不得取得更大序号使新采样失效（旧采样反而写回）
      const t300 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 300);
      const t100 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100);
      assert.ok(t300, '新采样 300 应写回（旧 verify 迟到不得使新采样失效）');
      assert.ok(!t100, '旧 idle1 采样 100 不得写回（verify 倒序下仍由新 idle 采样）');
    },
  },
  {
    name: '并发 idle verify 倒序：新 idle 未知写回，旧 verify 迟到不得撤销（gate 全释放）',
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 5, write: 5 } } },
        parts: [{ type: 'text', text: 'stale' }],
      }]);
      const g0 = ctx.gateMessages();
      const idle1 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const idle2 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g2);
      await idle2;
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g0);
      await idle1;
      // 新（idle2）capture 无 tokens → 最新未知（采样亦写回，不残留旧有值）
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: 'latest-no-tokens' }],
      }], g3);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const statsFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'stats.json');
      assert.ok(fs.existsSync(statsFile), 'stats 应持久化');
      const records = JSON.parse(fs.readFileSync(statsFile, 'utf-8')) as Array<Record<string, unknown>>;
      const t100 = records.find((r) => (r as { tokens?: { input?: number } }).tokens?.input === 100);
      assert.ok(!t100, '旧 idle1 有值 100 不得覆盖最新未知（verify 倒序 + 代次守卫）');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      assert.ok(text.includes('ses_reuse(co-fix/输入未知)'), 'Board 应显示输入未知（最新无 tokens 采样）');
    },
  },
  {
    name: '质量关闭+预算开启：同 job 先有值、后未知、最终完成 board 未知（旧样本被清空）',
    config: { quality: { enabled: false } },
    fn: async (hooks, ctx) => {
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_reuse' });
      // 第一次 idle：verify 中间轮（保持 running）；capture 有 tokens → 写回采样 200
      const g0 = ctx.gateMessages();
      const g1 = ctx.gateMessages();
      const idle1 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([toolCallAssistantMsg('ses_reuse')], g0);
      await idle1;
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish', tokens: { input: 100, output: 50, cache: { read: 40, write: 60 } } },
        parts: [{ type: 'text', text: 'first' }],
      }], g1);
      await sleepMs(150); // 等 capture1 写回（job 仍 running，写回在内存态）
      // 第二次 idle：verify 中间轮（保持 running）；capture 无 tokens → 提交清空 reuseInput
      const g2 = ctx.gateMessages();
      const g3 = ctx.gateMessages();
      const idle2 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([toolCallAssistantMsg('ses_reuse')], g2);
      await idle2;
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: 'second-no-tokens' }],
      }], g3);
      await sleepMs(150);
      // 最终完成：verify 终态证据 → 落 completed；capture 无 tokens（board 未知）
      const g4 = ctx.gateMessages();
      const g5 = ctx.gateMessages();
      const idle3 = emitEvent(hooks, 'session.idle', 'ses_reuse');
      ctx.releaseMessages([terminalAssistantMsg('ses_reuse')], g4);
      await idle3;
      ctx.releaseMessages([{
        info: { role: 'assistant', sessionID: 'ses_reuse', time: { created: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: 'third' }],
      }], g5);
      await sleepMs(150);
      assert.strictEqual(ctx.getPendingGateCount(), 0, '全部 gate 应释放（防 runner 挂起无输出）');
      const text = joinedText((await transformFor(hooks, 'ses_A')).messages[0].parts);
      // 同一 job 先有值 200、后未知 → 最新未知必须清空旧样本：不显示「最近输入 200」
      assert.ok(text.includes('ses_reuse(co-fix/输入未知)'), '最终 board 应显示输入未知（最新无 tokens 覆盖旧样本）');
      assert.ok(!text.includes('最近输入'), '旧采样 200 不得残留（未知采样提交清空 reuseInput）');
    },
  },
  {
    name: '默认省略 context_override：不注入任务上下文块、不追加契约、不读父历史',
    fn: async (hooks, ctx) => {
      const out = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务A', background: true });
      // 默认策略全部 none：不注册/填充/注入历史详情
      assert.ok(!out.args.prompt.includes('任务上下文'), '默认不应注入任务上下文块');
      assert.ok(!out.args.prompt.includes('当前任务'), '默认不应注入当前任务目标');
      assert.ok(!out.args.prompt.includes('CONTRACT_BEGIN'), '默认不应追加契约块');
      assert.strictEqual(ctx.calls.messagesRead, 0, '默认不应读父历史消息');
    },
  },
  {
    name: '显式 context_override=relevant：父历史有内容才注入详情，无内容不注入',
    fn: async (hooks, ctx) => {
      // 父历史为空 → 详情为空 → 不注入任何上下文块
      ctx.setMessages([]);
      const outEmpty = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务E', background: true, context_override: 'relevant' });
      assert.ok(!outEmpty.args.prompt.includes('任务上下文'), '无父历史内容不应注入上下文块');
      assert.ok(!outEmpty.args.prompt.includes('相关文件'), '无父历史内容不应注入相关文件详情');
      assert.strictEqual(ctx.calls.messagesRead, 1, 'opt-in 时应读取一次父历史');

      // 父历史有内容 → 详情非空才附加（仅详情，不重复任务目标）
      ctx.setMessages([
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/src/main.ts' }, output: 'main content' } },
          ],
        },
      ]);
      const outFilled = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务F', background: true, context_override: 'relevant' });
      assert.ok(outFilled.args.prompt.includes('相关文件'), '父历史有内容应注入相关文件详情');
      assert.ok(outFilled.args.prompt.includes('/src/main.ts'), '应注入文件路径');
      assert.ok(!outFilled.args.prompt.includes('任务上下文'), '详情注入不应包含旧任务上下文标题');
      assert.ok(!outFilled.args.prompt.includes('当前任务'), '详情注入不应重复任务目标');
      assert.strictEqual(ctx.calls.messagesRead, 2, '第二次 opt-in 应再次读取父历史');
    },
  },
  {
    name: '契约：用户手写契约块与原文保留、goal-only 空壳被清理、重复 before 不累积',
    fn: async (hooks) => {
      // 用户手写契约块（含内容）保守保留，原文保留，且不追加新契约
      const handWritten = '<!-- CONTRACT_BEGIN -->\\n- 关键结果: 用户手写结论\\n<!-- CONTRACT_END -->';
      const out = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, prompt: '前置文本\\n' + handWritten + '\\n后置文本' });
      assert.ok(out.args.prompt.includes('关键结果: 用户手写结论'), '用户手写契约块应保留');
      assert.ok(out.args.prompt.includes('前置文本'), '用户原文应保留');
      assert.ok(out.args.prompt.includes('后置文本'), '用户原文应保留');
      assert.strictEqual((out.args.prompt.match(/CONTRACT_BEGIN/g) || []).length, 1, '不应追加新契约块');

      // 插件旧版 goal-only 空壳被清理，用户原文保留
      const shell = '<!-- CONTRACT_BEGIN -->\\n## 本任务前置上下文\\n- 目标: 旧目标\\n<!-- CONTRACT_END -->';
      const out2 = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Y', background: true, prompt: '开头\\n' + shell + '\\n结尾' });
      assert.ok(!out2.args.prompt.includes('CONTRACT_BEGIN'), 'goal-only 空壳应被清理');
      assert.ok(out2.args.prompt.includes('开头') && out2.args.prompt.includes('结尾'), '空壳清理后用户原文保留');

      // 重复 before（同 callID 重入）：不累积契约块、不产生内容膨胀
      const out3 = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Z', background: true, callID: 'reenter-call', prompt: '原文' });
      const out3again = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务Z', background: true, callID: 'reenter-call', prompt: '原文' });
      assert.strictEqual(out3.args.prompt, '原文', '无注入时 prompt 保持用户原文');
      assert.strictEqual(out3again.args.prompt, '原文', '重复 before 不累积任何内容');
    },
  },
  {
    name: '父会话隔离：idle 捕获透传 parent，A 的结果只进 A、不进 B（显式传播）',
    config: { context: { dependencyPropagation: true } },
    fn: async (hooks, ctx) => {
      // A 派生子任务，绑定 child，idle 终态 → 捕获（parent=ses_A 透传进 dependencyCache）
      await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: '任务X', background: true, callID: 'call-1' });
      await afterTask(hooks, 'ses_A', 'call-1', { childSessionId: 'ses_b1' });
      ctx.setMessages([{
        info: { role: 'assistant', sessionID: 'ses_b1', time: { created: Date.now(), completed: Date.now() }, finish: 'finish' },
        parts: [{ type: 'text', text: 'A 会话关键结论' }],
      }]);
      await emitEvent(hooks, 'session.idle', 'ses_b1');
      await sleepMs(200); // 等待 capture 异步写回 dependencyCache
      // B 会话 fill relevant：不注入 A 的依赖（跨父会话隔离，绝不回退全局最近）
      const outB = await registerTask(hooks, 'ses_B', { subagent_type: 'co-fixer', description: 'B 任务', background: true, callID: 'call-2', context_override: 'relevant' });
      assert.ok(!outB.args.prompt.includes('依赖结果'), 'B 不应注入 A 的依赖结果');
      // A 会话 fill relevant：注入自己的依赖
      const outA = await registerTask(hooks, 'ses_A', { subagent_type: 'co-fixer', description: 'A 新任务', background: true, callID: 'call-3', context_override: 'relevant' });
      assert.ok(outA.args.prompt.includes('依赖结果'), 'A 应注入自己的依赖结果');
      assert.ok(outA.args.prompt.includes('A 会话关键结论'), 'A 的结论应传播到同父新调用');
    },
  },
  // ===== build-lock：真实 tool.execute.before / tool.execute.after 接线回归 =====
  // 构建互斥由 src/index.ts 的 before（bash + isBuildCommand → acquireBuildLock）与
  // after（bash + isBuildCommand → releaseBuildLock）接线；锁文件落在隔离 HOME 的
  // STATE_DIR/build-locks/ 下（runCase 的 projectDir 位于 os.homedir() 内，零触碰真实用户目录）。
  // 冲突抛 BuildLockError 由 before 的 catch 重新上抛（不被静默吞掉）。
  {
    name: 'build-lock：tool.execute.before 获取构建锁（bash + npm run build）',
    fn: async (hooks) => {
      await hooks['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a' },
        { args: { command: 'npm run build' } },
      );
      const locksDir = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'build-locks');
      assert.ok(fs.existsSync(locksDir), 'build-locks 目录应存在');
      const files = fs.readdirSync(locksDir).filter((f) => f.endsWith('.lock'));
      assert.strictEqual(files.length, 1, '应恰有一个锁文件');
      const rec = JSON.parse(fs.readFileSync(path.join(locksDir, files[0]), 'utf-8'));
      assert.strictEqual(rec.pid, process.pid, '锁记录应含持有进程 pid');
      assert.strictEqual(rec.sessionID, 'ses_test_a', '锁记录应含 sessionID');
      assert.strictEqual(rec.callID, 'call_a', '锁记录应含 callID');
      assert.strictEqual(rec.command, 'npm run build', '锁记录应含 command');
      assert.ok(typeof rec.acquiredAt === 'number', '锁记录应含 acquiredAt');
    },
  },
  {
    name: 'build-lock：同一 worktree 第二 session 并发 build 抛 BuildLockError（传播不被吞）',
    fn: async (hooks) => {
      await hooks['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a' },
        { args: { command: 'npm run build' } },
      );
      let thrown: unknown;
      try {
        await hooks['tool.execute.before'](
          { tool: 'bash', sessionID: 'ses_test_b', callID: 'call_b' },
          { args: { command: 'npm run build:cli' } },
        );
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, '并发 build 应抛错（BuildLockError 不被静默吞掉）');
      const msg = (thrown as Error).message;
      assert.ok(msg.includes('构建互斥'), '错误应标识构建互斥');
      assert.ok(msg.includes('ses_test_a'), '错误应含持有 sessionID');
      assert.ok(msg.includes('call_a'), '错误应含持有 callID');
      assert.ok(msg.includes('npm run build'), '错误应含持有 command');
      assert.ok(msg.includes('acquiredAt='), '错误应含持有时间');
    },
  },
  {
    name: 'build-lock：非构建命令（bun test）不创建锁',
    fn: async (hooks) => {
      await hooks['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a' },
        { args: { command: 'bun test ./src' } },
      );
      const locksDir = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'build-locks');
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0, '非构建命令不应创建锁');
    },
  },
  {
    name: 'build-lock：tool.execute.after 同 session/callID 释放锁',
    fn: async (hooks) => {
      await hooks['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a' },
        { args: { command: 'npm run build' } },
      );
      const locksDir = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub', 'build-locks');
      const lockFiles = () => fs.readdirSync(locksDir).filter((f) => f.endsWith('.lock'));
      assert.strictEqual(lockFiles().length, 1, 'before 后应有锁');
      await hooks['tool.execute.after'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a', args: { command: 'npm run build' } },
        {},
      );
      assert.strictEqual(lockFiles().length, 0, 'after 后锁应释放');
      // 重复释放幂等：不抛错、不误删（release 不匹配返回 false，不外抛）
      await hooks['tool.execute.after'](
        { tool: 'bash', sessionID: 'ses_test_a', callID: 'call_a', args: { command: 'npm run build' } },
        {},
      );
    },
  },
];

async function main() {
  const caseIndex = Number(process.env.COHUB_TEST_CASE ?? '0');
  const run = runs[caseIndex];
  if (!run) {
    console.log(JSON.stringify([{ name: 'unknown-case-' + caseIndex, ok: false, message: '未知用例索引: ' + caseIndex }]));
    return;
  }
  const result = await runCase(run.name, run.fn, run.config);
  console.log(JSON.stringify([result]));
}

void main();
`;

/** 主进程用例清单（与 runner 内 runs 名称一一对应，失败时用于定位） */
const CASES = [
  'A/B 交错：A 只看到自己的任务，B 最后注册也不泄漏给 A',
  '无任务的会话：transform 不注入任何 Board',
  'sessionID 缺失或为空：不泄漏最近注册的 B 任务',
  '空 content 防御：parts 为空或缺失 text part 的 user 消息仍被补占位，Board 追加其上',
  '无 user 消息：不注入、不改写既有消息',
  '嵌套 A→C→D：A 只聚合直接子任务 C，不聚合孙任务 D；C 聚合 D',
  '同 parent 并发乱序（后台）：after(call1) 只更新 call1 任务，call2 保持 pending',
  '同 parent 并发乱序（前台）：after(call1) 只终结 call1 任务，call2 保持运行',
  '未知 callID 的 after：不回退到最近任务，不更新任何 job',
  '不同 parent 同 callID 不交叉（反向结束）：after(A) 不触 B、after(B) 不触 A',
  '前台任务 after 返回对象：childSessionId 绑定且状态终结',
  '后台任务 after 返回对象：childSessionId 绑定、保持 running',
  '重复 after 幂等：前台任务二次 after 不重复改写、不误伤其他任务',
  'event session.idle 幂等：有明确完成证据时收尾，重复 idle 不改状态、不重复渲染',
  '同 child 会话复用登记：复用会话创建独立 job，不与原记录混淆',
  'child 复用不覆盖原调用：after(call1) 不得把复用 session 绑定到新任务',
  '后台 idle 无证据不终结：空记录保持 running，不假成功',
  '后台 idle 有新鲜终态证据：明确完成才收尾',
  '后台 idle 中间轮不终结：tool-calls 轮保持 running',
  'session.error 不假成功：仅观测，任务保持 running',
  'session.status retry 后完成：retry 仅观测，idle+证据才收尾',
  '同 child 复用旧消息不终结新调用：新鲜度边界生效',
  'sessionID 缺失的事件不误关联任何任务',
  '原生 task 无二次启动：插件不调用 sdk prompt/message 自派发任务',
  'diag 默认关闭：任务生命周期事件不产生诊断写入',
  'diag 开启：任务生命周期事件产生结构化 task 记录（白名单字段）',
  '复用收尾端到端：旧调用完成后复用新调用，新鲜证据 idle 收尾新调用（历史不阻碍）',
  '两个 active 共享 childID：idle 歧义无副作用，均保持 running',
  'idle 读取期间 cancel：await 回来不误收尾（候选已终态）',
  'latest assistant finish=tool-calls：中间轮不终结，保持 running',
  'finish=length 不成功结局：收尾为 errored 而非假成功',
  'finish 未知值：不臆测成功，保持 running',
  'completed tool parts + 最终 stop：合法完成收尾',
  '明确 error/abort 分类：普通最终 error → errored，MessageAbortedError → cancelled',
  'after metadata 显式失败：后台任务按真实结局收尾，不假成功',
  '原生 task part error：message.part.updated 按父 session+callID 精确收尾',
  '宿主 promotion：before 前台但 after 原生后台 shape → 保留 running，idle 新鲜终态正常收尾',
  '宿主 promotion 最终 error：原生后台 idle + 最终错误 → errored（不假成功）',
  '首次 child 绑定前 idle 丢失：after 绑定后补有界核验收尾，不永久 running',
  '早到 idle：after 确认完成后仍捕获正文/质量与 300001 输入超预算',
  '早到 idle：显式 dependencyPropagation=true 结果可传播',
  '早到 idle：重复 after/idle 仅针对原调用收尾捕获，不累积不覆盖',
  '早到 idle：异步旧采样晚到不污染复用后新调用（snapshot+sequence guards）',
  '同 call 同 alias：旧 after 核验迟到不得借用 idle 收尾额外捕获（300001 保留）',
  '原生 subtask after undefined：不崩溃不假成功，error part 按已登记 part.id 精确收尾',
  '质量写回：两次同 child 复用输出不同 tokens，旧记录不被新结果覆盖',
  '真实 close_job 工具：co-orchestrator 取消后台任务，engine 镜像 + 精确 parent 刷新（Board 正确）',
  '完整链路：idle 终态完成后 Board 展示可复用 session 与输入未知建议',
  '质量关闭+预算开启：复用采样写回且不写虚构分数（开关独立）',
  '两者皆关闭：不回写质量/采样（capture 仍承载依赖传播）',
  '并发 idle capture：新高用量不被旧 low 迟到覆盖（代次守卫）',
  '并发 idle capture：新未知先回，旧有值迟到不覆盖未知（未知亦遵守）',
  'idle 终态 verify 旧消息：不把旧采样回填本轮（新鲜度边界）',
  '并发 idle verify 倒序：旧 verify 迟到不得取代新 idle 采样（序号 await 前分配）',
  '并发 idle verify 倒序：新 idle 未知写回，旧 verify 迟到不得撤销（gate 全释放）',
  '质量关闭+预算开启：同 job 先有值、后未知、最终完成 board 未知（旧样本被清空）',
  '默认省略 context_override：不注入任务上下文块、不追加契约、不读父历史',
  '显式 context_override=relevant：父历史有内容才注入详情，无内容不注入',
  '契约：用户手写契约块与原文保留、goal-only 空壳被清理、重复 before 不累积',
  '父会话隔离：idle 捕获透传 parent，A 的结果只进 A、不进 B（显式传播）',
  'build-lock：tool.execute.before 获取构建锁（bash + npm run build）',
  'build-lock：同一 worktree 第二 session 并发 build 抛 BuildLockError（传播不被吞）',
  'build-lock：非构建命令（bun test）不创建锁',
  'build-lock：tool.execute.after 同 session/callID 释放锁',
];

/**
 * 在独立子进程中跑一个用例：
 * 1. mkdtemp 独立临时 HOME（每用例全新目录，用例间零共享）；
 * 2. 把内嵌 runner.ts 写入该临时 HOME；
 * 3. spawn Bun 子进程，env 将 USERPROFILE/HOME/XDG_* 全部重定向到临时 HOME；
 * 4. 解析 stdout 末行 JSON，返回断言结果；
 * 5. finally 递归删除临时 HOME（含全部 config/state/log 产物）；删除失败直接使用例失败，不吞错误。
 * 真实用户路径在主进程与子进程两侧均零接触。
 */
function runIsolatedCase(caseIndex: number): { ok: boolean; message?: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cohub-home-'));
  let result: { ok: boolean; message?: string } | undefined;
  try {
    const runnerPath = path.join(home, 'runner.ts');
    fs.writeFileSync(runnerPath, RUNNER_SRC.replace('__INDEX_TS_PATH__', JSON.stringify(INDEX_TS_PATH)));

    const res = spawnSync(process.execPath, [runnerPath], {
      cwd: home,
      env: {
        ...process.env,
        // Windows：os.homedir() 优先 USERPROFILE；POSIX 优先 HOME；双设兜底
        USERPROFILE: home,
        HOME: home,
        HOMEDRIVE: home.slice(0, 2),
        HOMEPATH: home.slice(2),
        // TEMP/TMP 一并重定向：os.tmpdir()（Windows 优先 TEMP）与默认 ctx-diag 路径
        // （os.tmpdir()/opencode/ctx-diag.log）都必须落在临时 HOME 内，杜绝写真实系统临时目录
        TEMP: path.join(home, 'tmp'),
        TMP: path.join(home, 'tmp'),
        // XDG 系变量一并重定向，杜绝任何平台惯例路径落到真实用户目录
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        COHUB_TEST_CASE: String(caseIndex),
        // 诊断日志 opt-in：默认关闭（用例 25 索引 25 显式开启以验证结构化记录）
        COHUB_CTX_DIAG: caseIndex === 25 ? '1' : '0',
      },
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });

    if (res.error) {
      result = { ok: false, message: 'spawn 失败: ' + (res.error.message ?? String(res.error)) };
    } else if (res.status !== 0) {
      result = { ok: false, message: 'runner 退出码 ' + res.status + ': ' + (res.stderr ?? '').trim() };
    } else {
      const stdout = (res.stdout ?? '').trim();
      const lastLine = stdout.split('\n').filter(l => l.trim()).pop();
      if (!lastLine) {
        result = { ok: false, message: 'runner 无输出' };
      } else {
        const parsed = JSON.parse(lastLine) as Array<{ ok: boolean; message?: string }>;
        const r = parsed?.[0];
        if (!r || typeof r.ok !== 'boolean') {
          result = { ok: false, message: 'runner 输出异常: ' + lastLine.slice(0, 200) };
        } else {
          result = { ok: r.ok, message: r.message };
        }
      }
    }
  } finally {
    // 临时 HOME 必须删除；rmSync 失败不再吞掉——直接使用例失败并保留清理错误
    // （与业务错误合并：业务错误在前，均错时不互相覆盖）。
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (err) {
      const cleanMsg = '临时 HOME 清理失败（残留目录: ' + home + '）: ' + (err instanceof Error ? (err.stack ?? err.message) : String(err));
      result = result && result.ok === false
        ? { ok: false, message: result.message + '\n---\n' + cleanMsg }
        : { ok: false, message: cleanMsg };
    }
  }
  return result ?? { ok: false, message: 'runIsolatedCase 内部异常（未捕获）' };
}

describe('真实插件入口：Background Job Board 会话隔离回归（隔离 HOME 子进程）', () => {
  for (let i = 0; i < CASES.length; i++) {
    test(CASES[i], () => {
      const result = runIsolatedCase(i);
      expect(result.ok, result.message ?? '').toBe(true);
    });
  }
});
