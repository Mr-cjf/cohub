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
// fillContextAsync 仅在 context_override !== 'none' 时调用 client.session.messages，
// 本测试统一传 context_override:'none' 避开。
// session.messages 供后台终态证据验证（session.idle 触发一次有界读取）——默认空记录
// （无证据 → 不终结），用例可经 setMessages 注入终态 / 中间轮 / 旧消息，
// 或经 gateMessages/releaseMessages 门控读取（模拟 idle await 期间的竞态）。
// session.prompt / session.message 若被调用说明插件自派发任务（红线），用例断言零调用。
function makeStubClient() {
  const calls = { prompt: 0, message: 0, abort: 0, messagesRead: 0 };
  let messages: unknown[] = [];
  let messagesGate: Promise<unknown[]> | undefined;
  let releaseGate: ((m: unknown[]) => void) | undefined;
  const client = {
    session: {
      abort: async () => { calls.abort++; return { data: {}, error: undefined }; },
      messages: async () => {
        calls.messagesRead++;
        const data = messagesGate ? await messagesGate : messages;
        return { data, error: undefined };
      },
      prompt: async () => { calls.prompt++; return { data: {}, error: undefined }; },
      message: async () => { calls.message++; return { data: {}, error: undefined }; },
    },
  };
  return {
    client,
    calls,
    setMessages: (m: unknown[]) => { messages = m; messagesGate = undefined; releaseGate = undefined; },
    gateMessages: () => {
      messagesGate = new Promise((res) => { releaseGate = res; });
    },
    releaseMessages: (m: unknown[]) => { if (releaseGate) { releaseGate(m); releaseGate = undefined; } },
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

/** 经真实 tool.execute.before hook 注册一个子任务（context_override:'none' 避开外部 API） */
async function registerTask(
  hooks: any,
  sessionID: string,
  opts: { subagent_type: string; description: string; task_id?: string; background?: boolean; callID?: string },
) {
  const output = {
    args: {
      subagent_type: opts.subagent_type,
      description: opts.description,
      task_id: opts.task_id,
      background: opts.background ?? true,
      context_override: 'none',
      prompt: '请执行：' + opts.description,
    },
  };
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
    { tool: 'task', sessionID, callID, args: { background: opts.background ?? true, context_override: 'none' } },
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

/** 每用例独立插件实例 + 独立临时 projectDir（均位于重定向后的临时 HOME 内），finally 必走 dispose 与清理 */
async function runCase(name: string, fn: (hooks: any, ctx: any) => Promise<void>) {
  const projectDir = fs.mkdtempSync(path.join(os.homedir(), 'cohub-proj-'));
  const stub = makeStubClient();
  const ctx = {
    calls: stub.calls,
    setMessages: stub.setMessages,
    gateMessages: stub.gateMessages,
    releaseMessages: stub.releaseMessages,
  };
  let hooks: any;
  let bodyErr: unknown;
  let disposeErr: unknown;
  let cleanupErr: unknown;
  try {
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

// ===== 16 个回归用例（与主进程 CASES 名称一一对应） =====
const runs: Array<{ name: string; fn: (hooks: any) => Promise<void> }> = [
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
];

async function main() {
  const caseIndex = Number(process.env.COHUB_TEST_CASE ?? '0');
  const run = runs[caseIndex];
  if (!run) {
    console.log(JSON.stringify([{ name: 'unknown-case-' + caseIndex, ok: false, message: '未知用例索引: ' + caseIndex }]));
    return;
  }
  const result = await runCase(run.name, run.fn);
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
  '原生 subtask after undefined：不崩溃不假成功，error part 按已登记 part.id 精确收尾',
  '质量写回：两次同 child 复用输出不同 tokens，旧记录不被新结果覆盖',
  '真实 close_job 工具：co-orchestrator 取消后台任务，engine 镜像 + 精确 parent 刷新（Board 正确）',
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
