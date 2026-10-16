// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
// src/config/loader.test.ts
// loadCoHubConfig 回归基线（Wave1）：
//   - 旧配置兼容（无 context/quality/diag/council 字段）与全部字段可选
//   - 项目级覆盖用户级（agents / context 等键按覆盖合并，未覆盖键保留）
//   - 项目配置缺失/为空 → 回退用户配置
//   - 幂等：连续调用结果一致
//   - 只读：加载不改写磁盘配置
//   - DEFAULT_CONTEXT_CONFIG re-export 与默认值一致（旧配置缺省 context 时引擎侧兜底）
//
// ⚠️ 隔离策略（对齐 index.test.ts）：USER_CONFIG_PATH 是模块顶层常量（import 时求值），
// 无法在已加载模块后通过 mock 生效。本测试把全部场景放进**一个独立子进程**（内嵌 runner.ts），
// 子进程启动时用临时目录重写 USERPROFILE/HOME/XDG_*，使 os.homedir() 与全部派生路径
// 都指向临时 HOME，runner 在其中写入临时配置文件、调用真实 loadCoHubConfig、输出 JSON。
// 主测试进程只 spawn 子进程、解析 JSON 断言结果——不加载生产模块、不读真实用户路径。
// runner 内含隔离守卫：os.homedir() 必须等于重定向后的临时 HOME，否则场景直接失败。

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 生产 loader 的绝对路径（子进程 runner 用真实 import 加载） */
const LOADER_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'loader.ts');

/**
 * 子进程 runner 源码（内嵌，避免新增生产文件）。
 * 本字符串内不使用模板字符串插值（${}）与反引号，避免与外层模板冲突。
 */
const RUNNER_SRC = `// @ts-nocheck
// 隔离 HOME 子进程 runner：写入临时配置、调用真实 loadCoHubConfig、输出 JSON 场景结果。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import { loadCoHubConfig, DEFAULT_CONTEXT_CONFIG } from __LOADER_TS_PATH__;

// ===== 隔离守卫：os.homedir() 必须指向重定向后的临时 HOME =====
const expectedHome = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
assert.ok(
  expectedHome && os.homedir() === expectedHome,
  '隔离守卫失败：os.homedir() 未指向临时 HOME（env=' + JSON.stringify(expectedHome) + ' got=' + os.homedir() + '）',
);

// ===== 场景工具 =====
const USER_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'oh-my-opencode-cohub.json');

function writeUserConfig(json) {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(json), 'utf-8');
}
function writeProjectConfig(projectDir, json) {
  const d = path.join(projectDir, '.opencode');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'oh-my-opencode-cohub.json'), JSON.stringify(json), 'utf-8');
}
function scenario(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, message: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
}

const projectDir = path.join(os.homedir(), 'cohub-proj');
fs.mkdirSync(projectDir, { recursive: true });

const results = [
  scenario('旧配置兼容：无 context/quality/diag 字段可加载', () => {
    writeUserConfig({ agents: { 'co-fixer': { model: 'old-model' } } });
    const cfg = loadCoHubConfig();
    assert.strictEqual(cfg.agents['co-fixer'].model, 'old-model');
    // 旧配置不写 context → 不产生 context 字段（引擎侧 DEFAULT_CONTEXT_CONFIG 兜底）
    assert.strictEqual(cfg.context, undefined);
  }),

  scenario('配置全部可选：空对象可加载', () => {
    writeUserConfig({});
    assert.deepStrictEqual(loadCoHubConfig(), {});
  }),

  scenario('用户配置缺失（文件不存在）→ 返回空对象', () => {
    fs.rmSync(USER_CONFIG_FILE, { force: true });
    assert.deepStrictEqual(loadCoHubConfig(), {});
  }),

  scenario('项目级覆盖用户级（agents/context 合并，未覆盖键保留）', () => {
    writeUserConfig({
      agents: { 'co-fixer': { model: 'A' }, 'co-explorer': { model: 'E' } },
      context: { maxFiles: 5, summarizeMaxTokens: 2000 },
    });
    writeProjectConfig(projectDir, {
      agents: { 'co-fixer': { model: 'B' } },
      context: { maxFiles: 8 },
    });
    const cfg = loadCoHubConfig(projectDir);
    assert.strictEqual(cfg.agents['co-fixer'].model, 'B');      // 项目覆盖用户
    assert.strictEqual(cfg.agents['co-explorer'].model, 'E');   // 用户未覆盖键保留
    assert.strictEqual(cfg.context.maxFiles, 8);                // 项目覆盖
    assert.strictEqual(cfg.context.summarizeMaxTokens, 2000);   // 用户未覆盖键保留
  }),

  scenario('项目配置为空对象 → 回退用户配置', () => {
    writeUserConfig({ context: { maxFiles: 3 } });
    writeProjectConfig(projectDir, {});
    assert.deepStrictEqual(loadCoHubConfig(projectDir), { context: { maxFiles: 3 } });
  }),

  scenario('幂等：连续两次加载结果一致', () => {
    writeUserConfig({ agents: { 'co-fixer': { model: 'X' } }, context: { maxFiles: 7 } });
    const a = loadCoHubConfig();
    const b = loadCoHubConfig();
    assert.deepStrictEqual(a, b);
  }),

  scenario('只读：加载不改写磁盘配置', () => {
    const payload = { agents: { 'co-planner': { prompt: 'keep' } } };
    writeUserConfig(payload);
    loadCoHubConfig();
    const onDisk = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
    assert.deepStrictEqual(onDisk, payload);
  }),

  scenario('DEFAULT_CONTEXT_CONFIG re-export 与默认值一致', () => {
    // 旧配置缺省 context 时引擎用此默认兜底（基线：Wave2 计算旧配置迁移影响）
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.maxFiles, 5);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.relevantMessageWindow, 20);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.summarizeMaxTokens, 2000);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.maxDecisions, 10);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.maxErrors, 5);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.dependencyPropagation, true);
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.summaryReadMode, 'bounded'); // Wave3 新增，默认有界读
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.strategy['co-fixer'], 'relevant');
    assert.strictEqual(DEFAULT_CONTEXT_CONFIG.strategy['co-explorer'], 'none');
  }),

  scenario('新配置项 summaryReadMode 可选：缺省无键、项目可覆盖为 full', () => {
    // 旧配置不带 summaryReadMode → 返回对象中无该键（engine 侧 DEFAULT 'bounded' 兜底）
    writeUserConfig({ context: { maxFiles: 3 } });
    assert.strictEqual(loadCoHubConfig().context.summaryReadMode, undefined);
    // 项目级可覆盖为 'full'（关闭激进裁剪），用户级 'bounded' 被项目覆盖
    writeUserConfig({ context: { summaryReadMode: 'bounded' } });
    writeProjectConfig(projectDir, { context: { summaryReadMode: 'full' } });
    const cfg = loadCoHubConfig(projectDir);
    assert.strictEqual(cfg.context.summaryReadMode, 'full');
  }),
];

console.log(JSON.stringify(results));
`;

/**
 * 在独立子进程中跑全部 loader 场景：
 * 1. mkdtemp 独立临时 HOME；
 * 2. 把内嵌 runner.ts 写入该临时 HOME；
 * 3. spawn Bun 子进程，env 将 USERPROFILE/HOME/XDG_* 全部重定向到临时 HOME；
 * 4. 解析 stdout 末行 JSON，返回场景结果数组；
 * 5. finally 递归删除临时 HOME。真实用户路径零接触。
 */
function runIsolatedScenarios(): Array<{ name: string; ok: boolean; message?: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cohub-home-'));
  try {
    const runnerPath = path.join(home, 'runner.ts');
    fs.writeFileSync(runnerPath, RUNNER_SRC.replace('__LOADER_TS_PATH__', JSON.stringify(LOADER_TS_PATH)));

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
        COHUB_CTX_DIAG: '0', // 强制关闭上下文诊断日志（opt-in 特性，测试不涉及）
      },
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });

    if (res.error) {
      throw new Error('spawn 失败: ' + (res.error.message ?? String(res.error)));
    }
    if (res.status !== 0) {
      throw new Error('runner 退出码 ' + res.status + ': ' + (res.stderr ?? '').trim());
    }
    const stdout = (res.stdout ?? '').trim();
    const lastLine = stdout.split('\n').filter((l) => l.trim()).pop();
    if (!lastLine) throw new Error('runner 无输出');
    const parsed = JSON.parse(lastLine) as Array<{ name: string; ok: boolean; message?: string }>;
    if (!Array.isArray(parsed)) throw new Error('runner 输出异常: ' + lastLine.slice(0, 200));
    return parsed;
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (err) {
      // 临时 HOME 清理失败：附在抛错前无法返回，直接抛出（残留目录由系统回收）
      // 注：此处不再吞错——清理失败表明有文件句柄未释放，值得让用例失败暴露
      throw new Error('临时 HOME 清理失败（残留目录: ' + home + '）: ' + (err instanceof Error ? (err.stack ?? err.message) : String(err)));
    }
  }
}

describe('loadCoHubConfig（隔离 HOME 子进程）', () => {
  test('全部 9 个场景通过', () => {
    const results = runIsolatedScenarios();
    const failed = results.filter((r) => !r.ok);
    const detail = failed.map((f) => f.name + ': ' + (f.message ?? '')).join('\n---\n');
    expect(failed, detail).toEqual([]);
    // 场景数量完整性检查（防止 runner 侧场景被误删）
    expect(results).toHaveLength(9);
  });
});
