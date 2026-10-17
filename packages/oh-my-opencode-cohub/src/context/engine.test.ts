// src/context/engine.test.ts
// 验证 fillContextAsync 的 in-flight promise 去重行为
// Wave1 追加：上下文优化基线 fixture（同请求去重 / summary 有界读观测 / 预算保护 / 父会话隔离 / fill 前后保留主任务）
// Wave3 修正：mock 设施改为「捕获真实函数值」方案（修复 Wave2 报告的无界递归崩溃——
//   Bun 的 mock.module 会替换 node:fs 命名空间导出（live binding），若包装函数引用
//   live namespace（realFs.readFileSync）会递归调用自身 → RangeError）；
//   观测范围扩展为有界读取实际使用的 open/fstat/read/close 全路径。
// Wave5 修正（集中验证实测：本文件单独/合并运行均报 ReferenceError: describe is not defined，
//   0 用例执行——根因为本文件只 import { mock }，describe/test/expect/beforeEach 依赖全局自动注入
//   而在「顶层 await import + mock.module」组合下注入失效）：
//   - 显式导入真实用到的 bun:test API（describe/test/expect/beforeEach），不依赖全局注入；
//   - mock 工厂导出补全常用 fs API（appendFileSync/mkdirSync/statSync/promises 等）透传真实函数值，
//     避免仅 engine 链完整、合并运行其他依赖 fs 的测试文件时缺导出；
//   - J 用例按独立实测证据修正（纯 emoji 预算 1999 时旧 full 截断点 cut=4×预算 恒为偶数 codeunit、
//     恒落在字符边界，本就不产生孤立 surrogate；不再声称 bounded 修复了本不存在的缺陷）。
// Wave7 追加：目录名含 ~（8.3 短名风格）真实夹具——结构化 + 文本同路径引用去重为单文件，
// 回归验证预算不因 ~ 截断伪路径条目减半（单文件累计 read 16004 而非 8004）。
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import * as realFs from 'node:fs';
import * as realOs from 'node:os';
import * as path from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// 修复：在 mock.module 替换模块导出【之前】捕获全部真实函数值。
// 之后包装函数与测试自身都只引用捕获值（非 live namespace），
// mock 工厂返回对象也只含捕获值——杜绝递归，也不污染其他模块/文件。
// ───────────────────────────────────────────────────────────────────────────
const realReadFileSync = realFs.readFileSync;
const realOpenSync = realFs.openSync;
const realFstatSync = realFs.fstatSync;
const realReadSync = realFs.readSync;
const realCloseSync = realFs.closeSync;
const realMkdtempSync = realFs.mkdtempSync;
const realWriteFileSync = realFs.writeFileSync;
const realRmSync = realFs.rmSync;
// 透传补全（合并运行其他依赖 fs 的测试文件时不缺导出，全部捕获真实函数值/对象）
const realExistsSync = realFs.existsSync;
const realStatSync = realFs.statSync;
const realMkdirSync = realFs.mkdirSync;
const realAppendFileSync = realFs.appendFileSync;
const realReaddirSync = realFs.readdirSync;
const realUnlinkSync = realFs.unlinkSync;
const realPromises = realFs.promises;

/** 有界读取全路径观测：open / read / close / readFile（full 模式），记录 fd 与读取字节 */
const fsOps: Array<{ path: string; op: 'open' | 'read' | 'close' | 'readFile'; fd?: number; bytes?: number }> = [];
/** fd → path（readSync 只有 fd，需回查路径做断言） */
const openFds = new Map<number, string>();

/**
 * 一次性 readSync 干预（模拟 partial-read / EOF=0 / 读取失败）：
 * - { type:'partial', value:n }：本次只返回 n 字节（short-read，后续循环继续读）；
 * - { type:'partial', value:0 }：本次返回 0（模拟 EOF，循环正常结束）；
 * - { type:'error', error }：本次抛错（验证 fd 关闭与 summary 降级）。
 * 每次干预只生效一次，beforeEach 重置为 null。
 */
let forcedReadResult: { type: 'partial'; value: number } | { type: 'error'; error: Error } | null = null;

mock.module('node:fs', () => ({
  // engine.ts 用到的全部 API：指向捕获的真实函数值（无 live binding，无递归）
  readFileSync(...args: unknown[]) {
    const r = realReadFileSync(...(args as never[]));
    fsOps.push({ path: String(args[0]), op: 'readFile' });
    return r;
  },
  openSync(filePath: unknown, ...args: unknown[]) {
    const fd = realOpenSync(filePath as never, ...(args as never[]));
    openFds.set(fd, String(filePath));
    fsOps.push({ path: String(filePath), op: 'open', fd });
    return fd;
  },
  fstatSync(fd: number) {
    return realFstatSync(fd);
  },
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
    const intervention = forcedReadResult;
    if (intervention) {
      forcedReadResult = null; // 一次性
      if (intervention.type === 'error') throw intervention.error;
      // 模拟 partial-read / EOF=0：只读 value 字节（0 = EOF），剩余交给后续循环
      const n = realReadSync(fd, buffer, offset, Math.max(0, Math.min(length, intervention.value)), position as never);
      const p = openFds.get(fd) ?? 'fd:' + fd;
      fsOps.push({ path: p, op: 'read', fd, bytes: n });
      return n;
    }
    const n = realReadSync(fd, buffer, offset, length, position as never);
    const p = openFds.get(fd) ?? 'fd:' + fd;
    fsOps.push({ path: p, op: 'read', fd, bytes: n });
    return n;
  },
  closeSync(fd: number) {
    realCloseSync(fd);
    const p = openFds.get(fd) ?? 'fd:' + fd;
    openFds.delete(fd);
    fsOps.push({ path: p, op: 'close', fd });
  },
  // 透传的真实函数值（不拦截观测）：本文件自身与合并运行的其他测试文件都只引用捕获值，
  // 避免 mock.module 替换命名空间后缺导出（如 diag-log 的 appendFileSync/promises）
  mkdtempSync: realMkdtempSync,
  writeFileSync: realWriteFileSync,
  rmSync: realRmSync,
  existsSync: realExistsSync,
  statSync: realStatSync,
  mkdirSync: realMkdirSync,
  appendFileSync: realAppendFileSync,
  readdirSync: realReaddirSync,
  unlinkSync: realUnlinkSync,
  promises: realPromises,
}));

const { ContextEngine } = await import('./engine');

// ---------------------------------------------------------------------------
// Helpers: mock 构造
// ---------------------------------------------------------------------------

/** 标准 mock：始终返回 1 个文件 + 1 个决策 + 0 个错误 */
function createMockClient() {
  let callCount = 0;
  const messages = async () => {
    await new Promise((r) => setTimeout(r, 5));  // 确保真实 yield，防止未来去掉 async 后静默失效
    callCount++;
    return {
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: '我决定使用 TypeScript 严格模式' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '/src/main.ts' },
                output: 'file content',
              },
            },
          ],
        },
      ],
    };
  };
  return {
    client: { session: { messages } },
    getCallCount: () => callCount,
  };
}

/** 第一次调用失败、后续成功的 mock */
function createFailingMock() {
  let callCount = 0;
  const messages = async () => {
    await new Promise((r) => setTimeout(r, 5));  // 确保真实 yield，防止未来去掉 async 后静默失效
    callCount++;
    if (callCount === 1) throw new Error('Network error');
    return {
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: '我决定使用 Node.js' }],
        },
      ],
    };
  };
  return {
    client: { session: { messages } },
    getCallCount: () => callCount,
  };
}

/** 每次调用返回不同数据的 mock（批次计数器递增），用于验证跨批次不脏读 */
function createIncrementingMock() {
  let callCount = 0;
  let batchId = 0;
  const messages = async () => {
    await new Promise((r) => setTimeout(r, 5));  // 确保真实 yield
    callCount++;
    batchId++;
    return {
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: `批次-${batchId} 的决策` }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: `/src/main-v${batchId}.ts` },
                output: `批次-${batchId} — file content v${batchId}`,
              },
            },
          ],
        },
      ],
    };
  };
  return {
    client: { session: { messages } },
    getCallCount: () => callCount,
  };
}

// ===========================================================================
// fillContextAsync — in-flight promise 去重
// ===========================================================================
describe('fillContextAsync — in-flight promise 去重', () => {
  // ── 用例 1: 首次调用触发 API ────────────────────────────────────────
  test('首次调用会触发 client.session.messages', async () => {
    const { client, getCallCount } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId = engine.registerContext({ description: 'test' });

    await engine.fillContextAsync(ctxId, 'ses_parent_1', {
      strategy: 'relevant',
    });

    expect(getCallCount()).toBe(1);
  });

  // ── 用例 2: 并发调用共享同一次 API ─────────────────────────────────
  test('并发调用（Promise.all）共享同一次 API 调用', async () => {
    const { client, getCallCount } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId1 = engine.registerContext({ description: 'test1' });
    const ctxId2 = engine.registerContext({ description: 'test2' });

    await Promise.all([
      engine.fillContextAsync(ctxId1, 'ses_parent', { strategy: 'relevant' }),
      engine.fillContextAsync(ctxId2, 'ses_parent', { strategy: 'relevant' }),
    ]);

    // 两次并发 fill，但 API 只应调用 1 次（共享 inflight promise）
    expect(getCallCount()).toBe(1);
  });

  // ── 用例 3: 顺序第二次调用重新调 API（验证无脏读）─────────────────
  test('顺序的第二次调用（跨批次）重新调 API，无脏读', async () => {
    const { client, getCallCount } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId1 = engine.registerContext({ description: 'test1' });
    const ctxId2 = engine.registerContext({ description: 'test2' });

    await engine.fillContextAsync(ctxId1, 'ses_parent', { strategy: 'relevant' });
    await engine.fillContextAsync(ctxId2, 'ses_parent', { strategy: 'relevant' });

    // 两次串行 fill，inflight 在第一次完成后已被删除，应当重新调 API
    expect(getCallCount()).toBe(2);
  });

  // ── 用例 4: 不同 parentSessionId 不共享 ────────────────────────────
  test('不同 parentSessionId 不共享 inflight', async () => {
    const { client, getCallCount } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxIdA = engine.registerContext({ description: 'A' });
    const ctxIdB = engine.registerContext({ description: 'B' });

    await engine.fillContextAsync(ctxIdA, 'ses_parent_a', { strategy: 'relevant' });
    await engine.fillContextAsync(ctxIdB, 'ses_parent_b', { strategy: 'relevant' });

    // 两个不同的 parentSessionId → 两次 API 调用
    expect(getCallCount()).toBe(2);
  });

  // ── 用例 5: 数据一致性 ─────────────────────────────────────────────
  test('返回的数据与 mock 内容相符', async () => {
    const { client } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId = engine.registerContext({ description: 'test' });

    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'relevant' });

    const result = engine.formatContextDetails(ctxId);
    // 文件路径
    expect(result).toContain('/src/main.ts');
    // 决策内容
    expect(result).toContain('TypeScript 严格模式');
    // 不应有错误（mock 数据无错误）
    expect(result).not.toContain('近期错误');
  });

  // ── 用例 6: strategy='none' 不触发 API ─────────────────────────────
  test("strategy='none' 不会触发 API 调用", async () => {
    const { client, getCallCount } = createMockClient();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'none' },
    });
    const ctxId = engine.registerContext({ description: 'test' });

    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'none' });

    expect(getCallCount()).toBe(0);
  });

  // ── 用例 7: 第一次调用失败后 inflight 被清理，后续能重试 ──────────
  test('第一次调用失败后 inflight 被清理，后续调用能重试', async () => {
    const { client, getCallCount } = createFailingMock();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId1 = engine.registerContext({ description: 'test1' });
    const ctxId2 = engine.registerContext({ description: 'test2' });

    // 第一次调用失败（被 catch 静默处理）
    await engine.fillContextAsync(ctxId1, 'ses_parent', { strategy: 'relevant' });
    // 第二次调用应触发新 API 调用（inflight 已被清理）
    await engine.fillContextAsync(ctxId2, 'ses_parent', { strategy: 'relevant' });

    // 第一次失败（1 次调用）+ 第二次重试（1 次调用）= 2
    expect(getCallCount()).toBe(2);
  });

  // ── 用例 8: 跨批次串行拿到最新数据（真正验证无脏读）─────────────────
  test('跨批次串行调用拿到最新数据，不返回旧缓存', async () => {
    const { client, getCallCount } = createIncrementingMock();
    const engine = new ContextEngine(client, {
      strategy: { 'test-agent': 'relevant' },
    });
    const ctxId1 = engine.registerContext({ description: 'batch1' });
    const ctxId2 = engine.registerContext({ description: 'batch2' });

    // 第一次调用 → 批次-1
    await engine.fillContextAsync(ctxId1, 'ses_parent', { strategy: 'relevant' });
    const result1 = engine.formatContextDetails(ctxId1);

    // 第二次串行调用（同一 parentSessionId）→ 应调 API 拿到新数据，不返回旧缓存
    await engine.fillContextAsync(ctxId2, 'ses_parent', { strategy: 'relevant' });
    const result2 = engine.formatContextDetails(ctxId2);

    expect(getCallCount()).toBe(2);

    // 第一次拿到批次-1 的数据
    expect(result1).toContain('批次-1');
    expect(result1).toContain('/src/main-v1.ts');
    // 第二次拿到批次-2 的数据（不是复用批次-1 的缓存）
    expect(result2).toContain('批次-2');
    expect(result2).toContain('/src/main-v2.ts');
    // 两次结果不同，真正证明跨批次不会脏读
    expect(result1).not.toBe(result2);
  });
});

// ===========================================================================
// Wave1 上下文优化基线（只增不改现有用例）
// 分类：A/B/D/E/F/G/H 为回归护栏（pass）；C 在 Wave3 有界读取实现后转绿——
// 优化前：attachTruncatedBodies 用 fs.readFileSync 全量读源文件（read=200000/injected≈8021）；
// 优化后：默认按预算有界读 + 4 字节 lookahead（read=16004 ≤ bound=16384），注入结果与旧行为等价。
// Wave3 补强：多语言 fixture（中文/纯 emoji/混合）验证等价边界与诚实截断标记；
// 异常/partial-read/EOF=0 集成用例验证 fd 关闭与 summary 降级。
// fixture 原始注入长度/重复次数记录见 FIXTURE_BASELINE。
// ===========================================================================

/** 大文件 fixture：全量内容（200_000 字符，英文 → 估算约 50_000 tokens，远超默认预算 2000） */
const BIG_FILE_CONTENT = 'x'.repeat(200_000);

/** 中文大文件 fixture：200_000 字符（约 200_000 tokens，600_000 字节） */
const CJK_FILE_CONTENT = '中'.repeat(200_000);

/** 纯 emoji 大文件 fixture：U+1F600（4 字节 UTF-8，2 codeunit，估算 0.5 token/个） */
const EMOJI_FILE_CONTENT = '😀'.repeat(200_000);

/** 混合大文件 fixture：ASCII + 中文 + emoji 均在读取窗口内，且尾部填充使文件超上限 */
const MIXED_FILE_CONTENT = 'a'.repeat(6000) + '中'.repeat(3333) + '😀'.repeat(500) + 'a'.repeat(50_000);

/**
 * 检测字符串中的孤立 surrogate（未配对的 UTF-16 高/低位），用于验证
 * 有界读取不产生旧 truncateByTokens 在 4 字节非 CJK 字符边界切出的孤立代理项。
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // 已配对的高位+低位，跳过低位
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // 孤立低位
    }
  }
  return false;
}

/** 创建临时目录 fixture（仅测试内使用，不触碰真实用户路径）；prefix 可含 ~ 模拟 8.3 短名风格目录名 */
function createTempFileFixture(prefix = 'cohub-ctx-'): { dir: string; cleanup: () => void } {
  const dir = realMkdtempSync(path.join(realOs.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try { realRmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录由系统回收 */ }
    },
  };
}

/** 以 summary 策略填充并返回注入文本（bounded/full 通用） */
async function fillSummary(engine: ContextEngine): Promise<string> {
  const ctxId = engine.registerContext({ description: 'test' });
  await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
  return engine.formatContextDetails(ctxId);
}

/** 从注入文本中提取正文块（```text ... ```） */
function injectedBodyOf(result: string): string {
  return result.match(/```text\n([\s\S]*?)```/)?.[1] ?? '';
}

/** 构造「单个工具 part 引用一个文件」的 session.messages mock */
function singleFileMessagesClient(filePath: string) {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath }, output: 'large file' } },
            ],
          },
        ],
      }),
    },
  };
}

/**
 * 有界读取基线：预算 2000 → 上限 16000 字节 + 4 字节 lookahead。
 * Wave3 补强后：ASCII 大文件实际读取 = 16004（含 lookahead 判定，≤ bound 16384）。
 */
const FIXTURE_BASELINE = {
  /** 去重 fixture：同一路径被引用次数（重复路径引用数 → 去重后注入 1 次） */
  repeatPathRefs: 3,
  /** summary 大文件 fixture：源文件全量字符数 */
  bigFileChars: BIG_FILE_CONTENT.length,
  /** summary 预算（tokens，默认值） */
  summaryBudgetTokens: 2000,
  /** 默认预算对应字节上限（2000 × 8） */
  defaultByteLimit: 16000,
  /** 有界读上界：读取字节 ≤ max(注入字符 × 2, 16KB)（ASCII 实际 16004 ≤ 16384） */
  boundedReadBoundOf: (injectedChars: number) => Math.max(injectedChars * 2, 16 * 1024),
} as const;

describe('Wave1 上下文优化基线', () => {
  beforeEach(() => {
    fsOps.length = 0;
    openFds.clear();
    forcedReadResult = null;
  });

  // ── A. 同请求文件去重：多消息引用同一路径 → 读取/注入不重复（旧实现 pass）──
  test('同请求内同一路径多次引用（3 处）→ 注入仅 1 次', async () => {
    // fixture：3 处引用同一路径（2 个 tool part + 1 处 text part）
    const messages = {
      data: [
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/src/main.ts' }, output: 'main content' } },
          ],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/src/main.ts', oldString: 'const a = 1;' } } },
          ],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: '请修改 /src/main.ts 文件后重新构建' },
          ],
        },
      ],
    };
    const client = { session: { messages: async () => messages } };
    const engine = new ContextEngine(client, { strategy: { t: 'relevant' } });
    const ctxId = engine.registerContext({ description: 'test' });

    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'relevant' });
    const result = engine.formatContextDetails(ctxId);

    // 去重：同一路径只注入 1 次（fixture 引用 FIXTURE_BASELINE.repeatPathRefs=3 次 → 注入 1 次）
    const occurrences = (result.match(/\/src\/main\.ts/g) ?? []).length;
    expect(occurrences).toBe(1);
    // 不应出现其他无关文件
    expect(result).not.toContain('file2');
  });

  // ── B. summary 预算保护（注入层）：大文件正文截断到预算内，文件保留（优化后 pass）──
  test('summary 策略：大文件注入正文被截断到预算内', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const bigFile = path.join(dir, 'big.ts');
      realWriteFileSync(bigFile, BIG_FILE_CONTENT, 'utf-8');
      const client = {
        session: {
          messages: async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: bigFile }, output: 'large file' } },
                ],
              },
            ],
          }),
        },
      };
      const engine = new ContextEngine(client, {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });
      const ctxId = engine.registerContext({ description: 'test' });

      await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
      const result = engine.formatContextDetails(ctxId);

      // 文件路径保留
      expect(result).toContain('big.ts');
      // 注入正文存在且被截断（远小于源文件全量字符）
      const injected = result.match(/```text\n([\s\S]*?)```/)?.[1] ?? '';
      expect(injected.length).toBeGreaterThan(0);
      expect(injected.length).toBeLessThan(BIG_FILE_CONTENT.length / 10);
      // 基线记录（Wave3 验收）：优化前 read=200000/injected≈8021；优化后 readBytes 见 C 用例，
      // 注入估算 tokens 与旧行为一致（同预算下必要信息不丢失）
      console.log(`[Wave3 baseline] summary fixture: sourceChars=${BIG_FILE_CONTENT.length} injectedChars=${injected.length} injectedTokens=${Math.ceil(injected.length / 4)} budgetTokens=${FIXTURE_BASELINE.summaryBudgetTokens}`);
    } finally {
      cleanup();
    }
  });

  // ── C. 有界读取（Wave3 实现后转绿）：open/fstat/read/close 全路径观测，读取 >0 且 ≤ 上限 ──
  test('summary 策略：读取层有界（实际 open/read/close >0 读取且 ≤ 上限，fd 全部关闭）', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const bigFile = path.join(dir, 'bounded.ts');
      realWriteFileSync(bigFile, BIG_FILE_CONTENT, 'utf-8');
      const client = {
        session: {
          messages: async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: bigFile }, output: 'large file' } },
                ],
              },
            ],
          }),
        },
      };
      const engine = new ContextEngine(client, {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });
      const ctxId = engine.registerContext({ description: 'test' });

      await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
      const result = engine.formatContextDetails(ctxId);

      // ── 有界读取断言（open/read/close 路径）──
      const reads = fsOps.filter((o) => o.op === 'read' && o.path === bigFile);
      const totalRead = reads.reduce((s, o) => s + (o.bytes ?? 0), 0);
      // 防虚假通过：必须观测到实际 >0 读取（不允许实现改成不读文件后 fsOps 为空）
      expect(reads.length).toBeGreaterThan(0);
      expect(totalRead).toBeGreaterThan(0);

      const injected = result.match(/```text\n([\s\S]*?)```/)?.[1] ?? '';
      // 有界读期望：读取字节 ≤ max(注入字符 × 2, 16KB)。
      // 优化后：默认预算 2000 → 上限 16000 字节 + 4 字节 lookahead = 实际读取 16004 ≤ 16384 → 绿；
      // 优化前：全量 200000+ 字节 → 红。
      const bound = FIXTURE_BASELINE.boundedReadBoundOf(injected.length);
      console.log(`[Wave3 baseline] bounded-read fixture: readBytes=${totalRead} injectedChars=${injected.length} injectedTokens=${Math.ceil(injected.length / 4)} bound=${bound}`);
      expect(totalRead).toBeLessThanOrEqual(bound);

      // ── fd 关闭断言：每个 open 的 fd 都被 close（正常/异常路径均覆盖）──
      const opens = fsOps.filter((o) => o.op === 'open' && o.path === bigFile);
      const closes = fsOps.filter((o) => o.op === 'close' && o.path === bigFile);
      expect(opens.length).toBeGreaterThan(0);
      expect(closes.length).toBe(opens.length);
    } finally {
      cleanup();
    }
  });

  // ── D. 不同父会话并发隔离：inflight key 含 parentSessionId（旧实现 pass）──
  test('并发：不同 parentSessionId 各自独立 API 调用，数据不串', async () => {
    const { client, getCallCount } = createIncrementingMock();
    const engine = new ContextEngine(client, { strategy: { t: 'relevant' } });
    const ctxA = engine.registerContext({ description: 'A' });
    const ctxB = engine.registerContext({ description: 'B' });

    await Promise.all([
      engine.fillContextAsync(ctxA, 'ses_parent_a', { strategy: 'relevant' }),
      engine.fillContextAsync(ctxB, 'ses_parent_b', { strategy: 'relevant' }),
    ]);

    // 不同 key → 不共享 inflight → 2 次 API 调用
    expect(getCallCount()).toBe(2);

    // 并发下批次分配顺序不定，但 A/B 各拿一批、两批数据都出现且互不相同
    const resultA = engine.formatContextDetails(ctxA);
    const resultB = engine.formatContextDetails(ctxB);
    expect(resultA).not.toBe(resultB);
    const combined = resultA + resultB;
    expect(combined).toContain('/src/main-v1.ts');
    expect(combined).toContain('/src/main-v2.ts');
  });

  // ── E. fill 完成前保留主任务：标记可被消费（旧实现 pass）──
  test('fill 完成前消费标记保留主任务', async () => {
    const { client } = createMockClient();
    const engine = new ContextEngine(client, { strategy: { t: 'relevant' } });
    const ctxId = engine.registerContext({ description: '优化上下文注入' });

    // 未 await fill（模拟异步未完成时立即注入标记）
    const marker = engine.formatMarker(ctxId);
    const consumed = engine.consumeMarkedContext('前置文本' + marker);

    expect(consumed).toContain('优化上下文注入');
    expect(consumed).not.toContain('近期错误');
  });

  // ── F. fill 失败后保留最小上下文：主任务可消费、不抛错（旧实现 pass）──
  test('fill 失败后保留最小上下文（主任务可消费，不抛错）', async () => {
    const { client, getCallCount } = createFailingMock();
    const engine = new ContextEngine(client, { strategy: { t: 'relevant' } });
    const ctxId = engine.registerContext({ description: '失败保留主任务' });

    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'relevant' });

    // 失败那次调用发生了（inflight 在失败后已清理，见现有用例 7）
    expect(getCallCount()).toBe(1);
    // 失败后无文件/决策注入（最小上下文）
    expect(engine.formatContextDetails(ctxId)).toBe('');
    // 标记仍可消费出主任务，不抛错
    const consumed = engine.consumeMarkedContext('x' + engine.formatMarker(ctxId));
    expect(consumed).toContain('失败保留主任务');
  });

  // ── G. 极小预算下文件不丢失（预算保护，旧实现 pass）──
  test('极小预算（50 tokens）下相关文件仍全部保留', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const files = ['a.ts', 'b.ts', 'c.ts'].map((n) => path.join(dir, n));
      for (const f of files) realWriteFileSync(f, 'const x = 1;\n'.repeat(50), 'utf-8');
      const parts = files.map((f) => ({
        type: 'tool', tool: 'read',
        state: { status: 'completed', input: { filePath: f }, output: 'content' },
      }));
      const client = { session: { messages: async () => ({ data: [{ info: { role: 'assistant' }, parts }] }) } };
      const engine = new ContextEngine(client, { strategy: { t: 'summary' }, summarizeMaxTokens: 50 });
      const ctxId = engine.registerContext({ description: 'test' });

      await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
      const result = engine.formatContextDetails(ctxId);

      // 3 个文件路径都保留
      for (const f of files) {
        expect(result).toContain(f.split(path.sep).pop()!);
      }
      // 3 个正文块都在（预算均摊 max(1, floor(50/3)) = 16 tokens/文件，正文仍存在）
      expect((result.match(/```text/g) ?? []).length).toBe(3);
    } finally {
      cleanup();
    }
  });

  // ── H. summaryReadMode='full' 保留旧行为（全量读取 + 截断，可关闭激进裁剪）──
  test("summaryReadMode='full' 保留旧行为（readFileSync 全量读取，注入仍截断到预算）", async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const bigFile = path.join(dir, 'full.ts');
      realWriteFileSync(bigFile, BIG_FILE_CONTENT, 'utf-8');
      const client = {
        session: {
          messages: async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: bigFile }, output: 'large file' } },
                ],
              },
            ],
          }),
        },
      };
      const engine = new ContextEngine(client, {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
        summaryReadMode: 'full',
      });
      const ctxId = engine.registerContext({ description: 'test' });

      await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
      const result = engine.formatContextDetails(ctxId);

      // 走 readFileSync 全量路径（不产生 open/read/close 观测）
      const readFileOps = fsOps.filter((o) => o.op === 'readFile' && o.path === bigFile);
      expect(readFileOps.length).toBe(1);
      expect(fsOps.some((o) => o.op === 'open' && o.path === bigFile)).toBe(false);
      // 注入仍按预算截断（与旧行为一致）
      const injected = result.match(/```text\n([\s\S]*?)```/)?.[1] ?? '';
      expect(injected.length).toBeGreaterThan(0);
      expect(injected.length).toBeLessThan(BIG_FILE_CONTENT.length / 10);
    } finally {
      cleanup();
    }
  });

  // ── I. 中文大文件：bounded 与 full 注入正文准确等价（3 字节/字符窗口覆盖截断点）──
  test('中文大文件：bounded 与 full 注入正文准确等价', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const cjkFile = path.join(dir, 'cjk.ts');
      realWriteFileSync(cjkFile, CJK_FILE_CONTENT, 'utf-8');
      const bounded = new ContextEngine(singleFileMessagesClient(cjkFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });
      const full = new ContextEngine(singleFileMessagesClient(cjkFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
        summaryReadMode: 'full',
      });

      const boundedBody = injectedBodyOf(await fillSummary(bounded));
      const fullBody = injectedBodyOf(await fillSummary(full));

      // 窗口 16000 字节 = 5333 个'中'（5333 tokens）> 2000 预算截断点 → 注入与旧行为逐字节一致
      expect(boundedBody).toBe(fullBody);
      expect(boundedBody.startsWith('中'.repeat(2000))).toBe(true);
      expect(boundedBody).toContain('正文已按 token 预算截断');
      expect(hasLoneSurrogate(boundedBody)).toBe(false);
    } finally {
      cleanup();
    }
  });

  // ── J. 纯 emoji 大文件：bounded 有界读取 + 诚实标记；full token 截断；两者均无孤立代理 ──
  // 修正依据（集中验证独立实测，非代码推断）：纯 emoji 预算 1999 时旧 truncateByTokens 的
  // 截断点 cut = 4×预算 = 7996 codeunit = 3998 完整 emoji（恒为偶数 codeunit、恒落在字符边界），
  // 旧 full 行为本就不产生孤立 surrogate——不再声称 bounded 修复了本不存在的缺陷；
  // 真实差异是读取路径与截断标记：bounded 读取有界（15996 ≤ 15992+4）附读取截断标记，
  // full 全量读取附 token 预算截断标记。
  test('纯 emoji 大文件：bounded 有界读取+诚实标记、full token 截断，两者均无孤立代理', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const emojiFile = path.join(dir, 'emoji.ts');
      realWriteFileSync(emojiFile, EMOJI_FILE_CONTENT, 'utf-8');
      // 预算 1999（奇数）：bounded 窗口恰停在预算边界（estimate==预算不触发 token 截断），
      // 与 full 形成截断标记差异；实测 full 截断点仍落在完整 emoji 边界（cut=4×1999=7996 codeunit）
      const oddBudget = 1999;
      const bounded = new ContextEngine(singleFileMessagesClient(emojiFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: oddBudget,
      });
      const full = new ContextEngine(singleFileMessagesClient(emojiFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: oddBudget,
        summaryReadMode: 'full',
      });

      const boundedBody = injectedBodyOf(await fillSummary(bounded));
      const fullBody = injectedBodyOf(await fillSummary(full));

      // bounded：15992 字节 = 3998 个完整 emoji = 1999 tokens（estimate == 预算）→ token 截断不触发；
      // 字节级 utf8TrimIncomplete 保证完整 emoji，不产生孤立 surrogate 与 U+FFFD
      expect(hasLoneSurrogate(boundedBody)).toBe(false);
      expect(boundedBody).not.toContain('\uFFFD');
      expect(boundedBody.startsWith('😀'.repeat(100))).toBe(true);
      // 文件超出读取上限且预算未填满 → 诚实读取截断标记（区别于 token 截断标记）
      expect(boundedBody).toContain('正文已按读取上限截断');
      expect(boundedBody).not.toContain('正文已按 token 预算截断');

      // full（旧行为全量读）：estimate 100000 > 1999 → token 预算截断标记；
      // 同样不产生孤立 surrogate（cut=7996 codeunit = 完整 emoji 边界）
      expect(hasLoneSurrogate(fullBody)).toBe(false);
      expect(fullBody).toContain('正文已按 token 预算截断');
      expect(fullBody).not.toContain('正文已按读取上限截断');
      // 差异真实：bounded 附读取截断标记（无 token 标记）、full 附 token 标记（无读取标记），
      // 注入大小差异源于两路径标记不同（实测 bounded≈8011 / full≈8016 字符）
      expect(boundedBody).not.toBe(fullBody);
      console.log(`[Wave3 emoji] boundedBody=${boundedBody.length}chars fullBody=${fullBody.length}chars`);
    } finally {
      cleanup();
    }
  });

  // ── K. 混合大文件（ASCII+中文+emoji 都在读取窗口内）：bounded 与 full 注入正文准确等价 ──
  test('混合大文件：bounded 与 full 注入正文准确等价（窗口覆盖多语言截断点）', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const mixedFile = path.join(dir, 'mixed.ts');
      realWriteFileSync(mixedFile, MIXED_FILE_CONTENT, 'utf-8');
      const bounded = new ContextEngine(singleFileMessagesClient(mixedFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });
      const full = new ContextEngine(singleFileMessagesClient(mixedFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
        summaryReadMode: 'full',
      });

      const boundedBody = injectedBodyOf(await fillSummary(bounded));
      const fullBody = injectedBodyOf(await fillSummary(full));

      // 窗口 15999 字节 = 'a'*6000 + '中'*3333（estimate 4833 > 2000）→ token 截断点（6500 codeunit）
      // 在窗口内 → bounded 与 full 截到相同前缀（'a'*6000 + '中'*500）+ 相同 token 标记
      expect(boundedBody).toBe(fullBody);
      expect(boundedBody.startsWith('a'.repeat(6000) + '中'.repeat(500))).toBe(true);
      expect(boundedBody).toContain('正文已按 token 预算截断');
      expect(hasLoneSurrogate(boundedBody)).toBe(false);
    } finally {
      cleanup();
    }
  });

  // ── L. 有界读取失败：fd 仍关闭，按 summary 回退降级 ──
  test('有界读取 readSync 抛错：fd 关闭且按 summary 回退降级（fill 不抛错）', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const failFile = path.join(dir, 'fail.ts');
      realWriteFileSync(failFile, BIG_FILE_CONTENT, 'utf-8');
      forcedReadResult = { type: 'error', error: new Error('simulated read failure') };
      const engine = new ContextEngine(singleFileMessagesClient(failFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });

      // fill 静默降级（不抛错）
      const result = await fillSummary(engine);

      // fd 正常/异常路径都关闭：open 1 次 → close 1 次
      const opens = fsOps.filter((o) => o.op === 'open' && o.path === failFile);
      const closes = fsOps.filter((o) => o.op === 'close' && o.path === failFile);
      expect(opens.length).toBe(1);
      expect(closes.length).toBe(1);
      // 按既有 summary 降级：路径保留、正文不可用回退（无 ```text 块）
      expect(result).toContain('fail.ts');
      expect(result).not.toContain('```text');
      expect(result).toContain('large file'); // mock tool output → summary 回退文本
    } finally {
      cleanup();
    }
  });

  // ── M. partial-read（short-read）：首次只读 100 字节后循环续读，正常结束 ──
  test('partial-read：首次只读 100 字节后继续读满（16004），注入正常截断', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const partialFile = path.join(dir, 'partial.ts');
      realWriteFileSync(partialFile, BIG_FILE_CONTENT, 'utf-8');
      forcedReadResult = { type: 'partial', value: 100 };
      const engine = new ContextEngine(singleFileMessagesClient(partialFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });

      const result = await fillSummary(engine);

      // 至少两次 readSync（partial 100 + 续读 15904），总计 16004（byteLimit 16000 + lookahead 4）
      const reads = fsOps.filter((o) => o.op === 'read' && o.path === partialFile);
      expect(reads.length).toBeGreaterThanOrEqual(2);
      const totalRead = reads.reduce((s, o) => s + (o.bytes ?? 0), 0);
      expect(totalRead).toBe(FIXTURE_BASELINE.defaultByteLimit + 4);
      // short-read 正常结束：正文注入并被 token 预算截断
      const injected = injectedBodyOf(result);
      expect(injected.length).toBeGreaterThan(0);
      expect(injected).toContain('正文已按 token 预算截断');
    } finally {
      cleanup();
    }
  });

  // ── N. EOF=0：首次 readSync 返回 0，正常结束并回退（不抛错，fd 关闭）──
  test('EOF=0：首次 readSync 返回 0 时正常结束，正文回退且 fd 关闭', async () => {
    const { dir, cleanup } = createTempFileFixture();
    try {
      const eofFile = path.join(dir, 'eof.ts');
      realWriteFileSync(eofFile, BIG_FILE_CONTENT, 'utf-8');
      forcedReadResult = { type: 'partial', value: 0 };
      const engine = new ContextEngine(singleFileMessagesClient(eofFile), {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });

      const result = await fillSummary(engine);

      // readSync 被调用一次且返回 0（EOF 语义），循环正常结束
      const reads = fsOps.filter((o) => o.op === 'read' && o.path === eofFile);
      expect(reads.length).toBe(1);
      expect(reads[0].bytes).toBe(0);
      // fd 关闭
      const opens = fsOps.filter((o) => o.op === 'open' && o.path === eofFile);
      const closes = fsOps.filter((o) => o.op === 'close' && o.path === eofFile);
      expect(opens.length).toBe(1);
      expect(closes.length).toBe(1);
      // 空正文 → summary 回退（无 ```text 块），不抛错
      expect(result).toContain('eof.ts');
      expect(result).not.toContain('```text');
      expect(result).toContain('large file');
    } finally {
      cleanup();
    }
  });

  // ── O. 目录名含 ~（8.3 短名风格，不依赖 Windows 真短名）：结构化 + 文本同路径引用去重为单文件，
  // 预算不因 ~ 截断伪路径条目减半（修复前 text/output 扫描在 ~ 处断裂截出伪路径 → 2 文件
  // → 预算 2000/2=1000 → 累计 read 8004；修复后完整匹配同键去重 → 1 文件 → 累计 read 16004）──
  test('目录名含 ~（8.3 短名风格）：同路径引用去重为单文件，累计 read 16004（非 8004）、open/close 一次', async () => {
    const { dir, cleanup } = createTempFileFixture('cohub~ctx-');
    try {
      const shortNameFile = path.join(dir, 'big.ts');
      realWriteFileSync(shortNameFile, BIG_FILE_CONTENT, 'utf-8');
      // 同一路径三处引用：结构化 input.filePath + tool output 文本 + text part
      const client = {
        session: {
          messages: async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: shortNameFile }, output: `读取 ${shortNameFile} 完成` } },
                  { type: 'text', text: `已分析 ${shortNameFile} 文件` },
                ],
              },
            ],
          }),
        },
      };
      const engine = new ContextEngine(client, {
        strategy: { t: 'summary' },
        summarizeMaxTokens: FIXTURE_BASELINE.summaryBudgetTokens,
      });
      const ctxId = engine.registerContext({ description: 'test' });

      await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'summary' });
      const result = engine.formatContextDetails(ctxId);

      // 路径锚点只精确一个完整路径（无 ~ 截断后的后缀伪路径条目）
      const anchors = Array.from(result.matchAll(/^- `([^`]*)`:/gm), (m) => m[1]);
      expect(anchors).toEqual([shortNameFile]);
      // 单文件一次正文
      expect((result.match(/```text/g) ?? []).length).toBe(1);
      // 预算 2000 → 单文件 byteLimit 16000 + lookahead 4 = 16004（修复前 2 文件均摊 → 8004）
      const reads = fsOps.filter((o) => o.op === 'read' && o.path === shortNameFile);
      const totalRead = reads.reduce((s, o) => s + (o.bytes ?? 0), 0);
      expect(reads.length).toBeGreaterThan(0);
      expect(totalRead).toBe(FIXTURE_BASELINE.defaultByteLimit + 4);
      // open/close 各一次（单文件只读一次）
      const opens = fsOps.filter((o) => o.op === 'open' && o.path === shortNameFile);
      const closes = fsOps.filter((o) => o.op === 'close' && o.path === shortNameFile);
      expect(opens.length).toBe(1);
      expect(closes.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ===========================================================================
// Wave6：captureResult 有界读 + 复用预算采样（200K 软预算核心）
// ===========================================================================

/** 构造 captureResult 测试用 session.messages client（可捕获调用参数与调用次数） */
function captureResultClient(
  data: unknown[],
  onCall?: (args: { path?: { id?: string }; query?: Record<string, unknown> }) => void,
): { client: { session: { messages: (args: { path?: { id?: string }; query?: Record<string, unknown> }) => Promise<{ data: unknown[] }> } }; getCallCount: () => number } {
  let callCount = 0;
  const messages = async (args: { path?: { id?: string }; query?: Record<string, unknown> }) => {
    callCount++;
    onCall?.(args);
    return { data };
  };
  return { client: { session: { messages } }, getCallCount: () => callCount };
}

/** 快捷构造 assistant 消息（默认 text part 含决策关键词，供 decisions 计数） */
function asstMsg(info: Record<string, unknown>, parts?: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    info: { role: 'assistant', ...info },
    parts: parts ?? [{ type: 'text', text: '我们决定采用 TypeScript 严格模式' }],
  };
}

describe('captureResult 有界读与复用预算采样（Wave6）', () => {
  test('有界读：session.messages 传入 query.limit=20（防无界读）', async () => {
    let capturedQuery: { limit?: number } | undefined;
    const { client } = captureResultClient([], (args) => { capturedQuery = args.query; });
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(capturedQuery).toEqual({ limit: 20 });
    expect(result).not.toBeNull();
  });

  test('防无界读：超量消息只读一次 API（不因会话历史膨胀额外读取）', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      asstMsg({ time: { created: i }, id: `msg-${i}` }, [{ type: 'text', text: '我们决定采用方案B' }]),
    );
    const { client, getCallCount } = captureResultClient(many);
    const engine = new ContextEngine(client);
    await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(getCallCount()).toBe(1);
  });

  test('升序消息：output/tokens/reuseInput 取最近 assistant，摘要语义不回归', async () => {
    const messages = [
      asstMsg({ time: { created: 100 }, id: 'msg-old', tokens: { input: 50, output: 20, cache: { read: 10, write: 10 } } }, [{ type: 'text', text: '我们决定采用旧方案' }]),
      asstMsg({ time: { created: 200 }, id: 'msg-new', tokens: { input: 100, output: 30, cache: { read: 40, write: 60 } } }, [{ type: 'text', text: '我们决定采用 TypeScript 严格模式' }]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result).not.toBeNull();
    expect(result!.output).toContain('TypeScript 严格模式');
    expect(result!.tokens).toEqual({ input: 100, output: 30 });
    // 可信归一化：100 + 40 + 60 = 200（不含 output）
    expect(result!.reuseInput).toEqual({ inputTokens: 200, sampledAt: 200, messageId: 'msg-new' });
    expect(result!.decisions).toBe(1);
  });

  test('乱序消息：按 time.created 取最近（不按数组顺序，不挑旧数据当最新）', async () => {
    const messages = [
      asstMsg({ time: { created: 300 }, id: 'msg-3', tokens: { input: 300, output: 100, cache: { read: 10, write: 10 } } }, [{ type: 'text', text: '我们决定采用乱序第三条' }]),
      asstMsg({ time: { created: 100 }, id: 'msg-1', tokens: { input: 100, output: 50, cache: { read: 20, write: 20 } } }, [{ type: 'text', text: '我们决定采用乱序第一条' }]),
      asstMsg({ time: { created: 200 }, id: 'msg-2', tokens: { input: 200, output: 60, cache: { read: 30, write: 30 } } }, [{ type: 'text', text: '我们决定采用乱序第二条' }]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result!.output).toContain('乱序第三条');
    expect(result!.tokens).toEqual({ input: 300, output: 100 });
    expect(result!.reuseInput!.inputTokens).toBe(320); // 300+10+10
    expect(result!.reuseInput!.messageId).toBe('msg-3');
  });

  test('最大 time.created 并列：无法判定哪个更新 → reuseInput/tokens 未知（不按数组顺序判安全）', async () => {
    const messages = [
      asstMsg({ time: { created: 200 }, id: 'msg-a', tokens: { input: 100, output: 20, cache: { read: 30, write: 70 } } }, [{ type: 'text', text: '我们决定采用并列方案A' }]),
      asstMsg({ time: { created: 200 }, id: 'msg-b', tokens: { input: 10, output: 5, cache: { read: 5, write: 5 } } }, [{ type: 'text', text: '我们决定采用并列方案B' }]),
      asstMsg({ time: { created: 100 }, id: 'msg-old', tokens: { input: 999, output: 999, cache: { read: 999, write: 999 } } }, [{ type: 'text', text: '我们决定采用旧方案' }]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    // 并列最大无法判定哪个更新 → 未知；绝不捞并列/旧消息的带 tokens 回填（100+30+70 / 10+5+5 / 999…）
    expect(result!.reuseInput).toBeUndefined();
    expect(result!.tokens).toBeUndefined();
    // 摘要仍最佳努力：有 text 的 assistant 被取出（数组末尾向前 → msg-b）
    expect(result!.output).toContain('并列方案');
  });

  test('低值/高值并列且数组顺序互换：均未知（不取先遇到者的低值或高值）', async () => {
    const low = asstMsg({ time: { created: 300 }, id: 'msg-low', tokens: { input: 1, output: 1, cache: { read: 1, write: 1 } } }, [{ type: 'text', text: '我们决定采用低值方案' }]);
    const high = asstMsg({ time: { created: 300 }, id: 'msg-high', tokens: { input: 500000, output: 1, cache: { read: 200000, write: 200000 } } }, [{ type: 'text', text: '我们决定采用高值方案' }]);
    for (const messages of [[low, high], [high, low]]) {
      const { client } = captureResultClient(messages);
      const engine = new ContextEngine(client);
      const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
      expect(result!.reuseInput, '顺序: ' + messages[0].info.id + ' 前置').toBeUndefined();
    }
  });

  test('乱序 + 并列 + 数组尾为旧消息：摘要仍取最大时间候选，绝不回退数组尾旧结论', async () => {
    const messages = [
      asstMsg({ time: { created: 100 }, id: 'msg-old', tokens: { input: 999, output: 1, cache: { read: 1, write: 1 } } }, [{ type: 'text', text: '我们决定采用旧方案' }]),
      asstMsg({ time: { created: 300 }, id: 'msg-b', tokens: { input: 5, output: 1, cache: { read: 1, write: 1 } } }, [{ type: 'text', text: '我们决定采用并列方案B' }]),
      asstMsg({ time: { created: 300 }, id: 'msg-a', tokens: { input: 10, output: 1, cache: { read: 1, write: 1 } } }, [{ type: 'text', text: '我们决定采用并列方案A' }]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    // 摘要时间优先：取 300 并列候选之一（数组尾 msg-old=100 是旧消息，不得回退到它）
    expect(result!.output).toContain('并列方案');
    expect(result!.output).not.toContain('旧方案');
    // 并列仍不判安全：采样/原始 tokens 未知
    expect(result!.reuseInput).toBeUndefined();
    expect(result!.tokens).toBeUndefined();
  });

  test('最新 assistant 缺 tokens：reuseInput/原始 tokens 均未知，不回溯旧数据当最新安全用量', async () => {
    const messages = [
      asstMsg({ time: { created: 300 }, id: 'msg-latest-no-tokens' }, [{ type: 'text', text: '我们决定采用最新方案' }]),
      asstMsg({ time: { created: 100 }, id: 'msg-old-with-tokens', tokens: { input: 5000, output: 100, cache: { read: 500, write: 500 } } }, [{ type: 'text', text: '我们决定采用旧方案' }]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result!.tokens).toBeUndefined();
    expect(result!.reuseInput).toBeUndefined();
    // 摘要仍取最新消息（文本回退不受 tokens 缺失影响）
    expect(result!.output).toContain('最新方案');
  });

  test('字段缺失/无效：input 缺失、cache 缺失、cache.read 缺失、非有限数 → 未知而非 0', async () => {
    const cases = [
      { time: { created: 1 }, tokens: { output: 5, cache: { read: 1, write: 1 } } },                 // input 缺失
      { time: { created: 2 }, tokens: { input: 5, output: 5 } },                                     // cache 整体缺失
      { time: { created: 3 }, tokens: { input: 5, output: 5, cache: { write: 1 } } },                // cache.read 缺失
      { time: { created: 4 }, tokens: { input: 5, output: 5, cache: { read: NaN, write: 1 } } },     // 非有限数
      { time: { created: 5 }, tokens: { input: 5, output: 5, cache: { read: 1, write: Infinity } } }, // 非有限数
    ];
    for (const info of cases) {
      const { client } = captureResultClient([asstMsg(info, [{ type: 'text', text: '我们决定采用字段缺失方案' }])]);
      const engine = new ContextEngine(client);
      const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
      expect(result!.reuseInput, JSON.stringify(info)).toBeUndefined();
    }
  });

  test('可信归一化口径：input+cache.read+cache.write，不叠加 output（199999/200000/200001/480000）', async () => {
    const fixtures = [
      { input: 99999, read: 50000, write: 50000, output: 999999, expected: 199999 },
      { input: 100000, read: 50000, write: 50000, output: 999999, expected: 200000 },
      { input: 100001, read: 50000, write: 50000, output: 999999, expected: 200001 },
      { input: 250000, read: 150000, write: 80000, output: 999999, expected: 480000 },
    ];
    for (const f of fixtures) {
      const { client } = captureResultClient([
        asstMsg({ time: { created: 7 }, id: 'msg-b', tokens: { input: f.input, output: f.output, cache: { read: f.read, write: f.write } } }),
      ]);
      const engine = new ContextEngine(client);
      const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
      expect(result!.reuseInput!.inputTokens).toBe(f.expected);
      // output 绝不叠加进归一化输入
      expect(result!.reuseInput!.inputTokens).not.toBe(f.expected + f.output);
      // 原始 tokens 保留 output（质量回送口径不变）
      expect(result!.tokens).toEqual({ input: f.input, output: f.output });
    }
  });

  test('time.created 缺失：无法确认最新 → reuseInput/tokens 未知（sampledAt 不伪造新鲜度），摘要仍可取', async () => {
    const { client } = captureResultClient([
      asstMsg({ id: 'msg-no-time', tokens: { input: 10, output: 5, cache: { read: 2, write: 3 } } }),
    ]);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result!.reuseInput).toBeUndefined();
    expect(result!.tokens).toBeUndefined();
    // 摘要不被未知采样破坏（最佳努力取出）
    expect(result!.output).toContain('TypeScript 严格模式');
  });

  test('时间缺失消息在不同数组位置：均不产生 reuseInput（不按位置误判最新），摘要仍时间优先可取', async () => {
    const timed = asstMsg({ time: { created: 100 }, id: 'msg-timed', tokens: { input: 50, output: 5, cache: { read: 1, write: 1 } } }, [{ type: 'text', text: '我们决定采用有时间方案' }]);
    const untimed = asstMsg({ id: 'msg-untimed', tokens: { input: 999, output: 9, cache: { read: 9, write: 9 } } }, [{ type: 'text', text: '我们决定采用无时间方案' }]);
    for (const messages of [[timed, untimed], [untimed, timed]]) {
      const { client } = captureResultClient(messages);
      const engine = new ContextEngine(client);
      const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
      // 存在时间缺失消息 → 无法确认最新 → 未知（999+9+9 / 50+1+1 均不被采用）
      expect(result!.reuseInput, '顺序: ' + messages[0].info.id + ' 前置').toBeUndefined();
      // 摘要不因采样未知退化：仍优先最大有效 time.created 候选（msg-timed=100）
      expect(result!.output).toContain('有时间方案');
    }
  });

  test('负值/求和溢出：reuseInput 未知（仅非负有限数求和，溢出精度不可信不取）', async () => {
    const cases = [
      { time: { created: 1 }, tokens: { input: -5, output: 1, cache: { read: 1, write: 1 } } },      // 负 input
      { time: { created: 2 }, tokens: { input: 1, output: 1, cache: { read: -1, write: 1 } } },       // 负 cache.read
      { time: { created: 3 }, tokens: { input: 1, output: 1, cache: { read: 1, write: -2 } } },       // 负 cache.write
      { time: { created: 4 }, tokens: { input: Number.MAX_SAFE_INTEGER, output: 1, cache: { read: Number.MAX_SAFE_INTEGER, write: Number.MAX_SAFE_INTEGER } } }, // 和溢出
    ];
    for (const info of cases) {
      const { client } = captureResultClient([asstMsg(info, [{ type: 'text', text: '我们决定采用负值方案' }])]);
      const engine = new ContextEngine(client);
      const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
      expect(result!.reuseInput, JSON.stringify(info)).toBeUndefined();
    }
  });

  test('最近 assistant 无 text：摘要回退更早 assistant（摘要不回归），原始 tokens/采样仍取最近', async () => {
    const messages = [
      asstMsg({ time: { created: 200 }, id: 'msg-tool-only', tokens: { input: 100, output: 20, cache: { read: 30, write: 70 } } }, [
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'x' } },
      ]),
      asstMsg({ time: { created: 100 }, id: 'msg-text', tokens: { input: 50, output: 10, cache: { read: 5, write: 5 } } }, [
        { type: 'text', text: '我们决定采用回退方案' },
      ]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result!.output).toContain('回退方案');
    // 原始 tokens 与复用采样仍来自最近 assistant（不回退更旧消息）
    expect(result!.tokens).toEqual({ input: 100, output: 20 });
    expect(result!.reuseInput!.inputTokens).toBe(200);
  });

  test('降序消息 + 最新无正文：摘要按时间降序回退取次新结论，绝不回退数组尾旧结论', async () => {
    // 输入降序 [300 无正文(最新), 200 新结论, 100 旧结论]：旧实现按数组尾回退会误取 100 旧结论
    const messages = [
      asstMsg({ time: { created: 300 }, id: 'msg-new-no-text', tokens: { input: 300, output: 1, cache: { read: 10, write: 10 } } }, [
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'x' } },
      ]),
      asstMsg({ time: { created: 200 }, id: 'msg-mid', tokens: { input: 200, output: 1, cache: { read: 10, write: 10 } } }, [
        { type: 'text', text: '我们决定采用新结论' },
      ]),
      asstMsg({ time: { created: 100 }, id: 'msg-oldest', tokens: { input: 100, output: 1, cache: { read: 10, write: 10 } } }, [
        { type: 'text', text: '我们决定采用旧结论' },
      ]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    // 摘要时间优先：取 200 新结论，不回退 100 旧结论
    expect(result!.output).toContain('新结论');
    expect(result!.output).not.toContain('旧结论');
    // 采样仍取可确认最新（300）：采样可信与摘要 best effort 彻底分开
    expect(result!.reuseInput!.inputTokens).toBe(320); // 300+10+10
  });

  test('新鲜度边界：sampledAt 早于调用边界 → reuseInput 未知（不回填旧采样到本轮）', async () => {
    const messages = [
      asstMsg({ time: { created: 100 }, id: 'msg-stale', tokens: { input: 300, output: 50, cache: { read: 10, write: 10 } } }, [
        { type: 'text', text: '我们决定采用旧历史方案' },
      ]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    // notBefore = 本轮调用开始（job.createdAt）；消息 created=100 早于 200 → 不属于当前调用
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer', { notBefore: 200 });
    expect(result!.reuseInput).toBeUndefined();
    // 摘要仍 best effort（采样未知不破坏摘要）
    expect(result!.output).toContain('旧历史方案');
  });

  test('新鲜度边界：sampledAt 等于调用边界 → 属于当前调用，正常采样', async () => {
    const messages = [
      asstMsg({ time: { created: 200 }, id: 'msg-fresh', tokens: { input: 100, output: 50, cache: { read: 40, write: 60 } } }, [
        { type: 'text', text: '我们决定采用本轮方案' },
      ]),
    ];
    const { client } = captureResultClient(messages);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer', { notBefore: 200 });
    expect(result!.reuseInput).toEqual({ inputTokens: 200, sampledAt: 200, messageId: 'msg-fresh' });
  });
});

// ===========================================================================
// 依赖传播开关（默认关闭）：captureResult 捕获返回与采样不受开关影响，
// 仅 dependencyCache 写入受控——默认 false 不缓存，fill 不注入依赖；显式 true 才传播。
// ===========================================================================
describe('captureResult 依赖传播开关（默认关闭）', () => {
  test('默认（dependencyPropagation=false）：仍返回结果与采样，但不写依赖缓存、fill 不注入依赖', async () => {
    const { client } = captureResultClient([
      asstMsg({ time: { created: 300 }, id: 'msg-new', tokens: { input: 100, output: 30, cache: { read: 40, write: 60 } } }, [
        { type: 'text', text: '我们决定采用 TypeScript 严格模式' },
      ]),
    ]);
    const engine = new ContextEngine(client);
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    // 捕获返回与复用预算采样不受传播开关影响（captureResult 独立于传播策略）
    expect(result!.output).toContain('TypeScript 严格模式');
    expect(result!.decisions).toBe(1);
    expect(result!.reuseInput).toEqual({ inputTokens: 200, sampledAt: 300, messageId: 'msg-new' });
    // 依赖缓存未写入 → fill 后详情不含依赖结果
    const ctxId = engine.registerContext({ description: 'test' });
    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'relevant' });
    expect(engine.formatContextDetails(ctxId)).not.toContain('📦 依赖结果');
  });

  test('dependencyPropagation=true：captureResult 写依赖缓存，fill 注入依赖结果', async () => {
    const { client } = captureResultClient([
      asstMsg({ time: { created: 300 }, id: 'msg-new' }, [
        { type: 'text', text: '我们决定采用 TypeScript 严格模式' },
      ]),
    ]);
    const engine = new ContextEngine(client, { dependencyPropagation: true });
    const result = await engine.captureResult('ses_child', 'fix-1', 'co-fixer');
    expect(result!.output).toContain('TypeScript 严格模式');
    const ctxId = engine.registerContext({ description: 'test' });
    await engine.fillContextAsync(ctxId, 'ses_parent', { strategy: 'relevant' });
    const details = engine.formatContextDetails(ctxId);
    expect(details).toContain('📦 依赖结果');
    expect(details).toContain('**co-fixer**');
    expect(details).toContain('TypeScript 严格模式');
  });
});