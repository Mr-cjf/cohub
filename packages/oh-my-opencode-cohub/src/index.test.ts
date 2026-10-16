// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供（对齐 council.test.ts 写法）
// src/index.test.ts
// 真实插件入口回归测试：Background Job Board 的会话隔离
//
// 缺陷背景：src/index.ts:752 已取到末尾 user 消息的 sessionID，但 :772 调用
// tracker.getBoardText() 时未传入该 sessionID，tracker 会回退到"最近一次
// tool hook 收到的 parentSessionId"（_currentParentSessionId），导致 A 会话
// 的 transform 注入 B 会话的任务（跨会话泄漏）。
//
// 本文件经真实 tool.execute.before + experimental.chat.messages.transform hook
// 复现该缺陷，作为后续"index 显式传 sessionID / tracker 参数必传且空值返回空"
// 修复的回归护栏。期望行为（修复后）：
//   - A/B 交错注册（B 最后注册）：A 的 transform 只含 A 任务、不含 B；
//   - 无任务会话 / sessionID 缺失或为空：不注入任何 Board（不泄漏 B）；
//   - 空 content 防御回归：parts 空 / 无 text part 的 user 消息仍被补占位；
//   - 嵌套 A→C→D：A 只聚合直接子任务 C、不聚合孙任务 D；C 聚合 D。
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
// 本测试统一传 context_override:'none' 避开；cleanupTimer 回调的 session.abort
// 需 30s 才触发，测试内不会走到。session.abort stub 备用（万一有路径触发）。
function makeStubClient() {
  return {
    session: {
      abort: async () => ({ data: {}, error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
    },
  };
}

function makePluginInput(projectDir: string) {
  return {
    client: makeStubClient(),
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
  opts: { subagent_type: string; description: string; task_id?: string; background?: boolean },
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
    { tool: 'task', sessionID, callID: 'call-' + sessionID + '-' + Math.random().toString(36).slice(2, 6) },
    output,
  );
  return output;
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
async function runCase(name: string, fn: (hooks: any) => Promise<void>) {
  const projectDir = fs.mkdtempSync(path.join(os.homedir(), 'cohub-proj-'));
  let hooks: any;
  let bodyErr: unknown;
  let disposeErr: unknown;
  let cleanupErr: unknown;
  try {
    hooks = await CoHubPlugin(makePluginInput(projectDir));
    await fn(hooks);
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

// ===== 6 个回归用例（与主进程 CASES 名称一一对应） =====
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
        // XDG 系变量一并重定向，杜绝任何平台惯例路径落到真实用户目录
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        COHUB_TEST_CASE: String(caseIndex),
        COHUB_CTX_DIAG: '0', // 强制关闭上下文诊断日志（opt-in 特性，测试不涉及）
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
