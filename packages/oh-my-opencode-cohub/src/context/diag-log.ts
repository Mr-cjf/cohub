/**
 * 上下文注入诊断日志（opt-in，**默认关闭**）。
 *
 * 用途：排查「CoHub 注入的上下文是否真的到达了子代理」。
 * 历史（见 CHANGELOG 1.4.0 / 1.5.1）：曾连续出现「上下文未注入 / 详情未追加 /
 * 写入 description 而非 prompt」等 bug，该日志就是当时的排查手段，因此**保留字段与
 * 默认路径不变**，只把「每次委派无条件同步写盘」改成「显式开启后才写」。
 *
 * 开启方式（任一即可）：
 *   1. 环境变量 `COHUB_CTX_DIAG=1`（`=0` 可强制关闭，优先级最高）
 *   2. 用户配置 `~/.config/opencode/oh-my-opencode-cohub.json` → `{ "diag": { "enabled": true } }`
 *      或项目配置 `.opencode/oh-my-opencode-cohub.json` → 同上
 *
 * 设计要点（对比旧实现）：
 * - 旧：每次委派 = statSync + appendFileSync（同步阻塞事件循环），
 *   且「超 50KB → 读全文 → 重写末 30 行 → 立刻又 append」形成**反复全量读+全量写**的循环。
 * - 新：关闭时不产生任何 I/O；开启时用**异步串行队列** appendFile（不阻塞事件循环），
 *   仅在「自上次压缩以来累计写入 > MAX_BYTES」时触发一次压缩，且压缩**只读文件尾部窗口**
 *   （不读全文），压缩后计数器归零 → 需要再累积 MAX_BYTES 才会再次压缩，循环被消除。
 * - 文件创建时使用 mode 0o600（POSIX 收紧权限；Windows 上为 no-op）。
 *
 * 任务生命周期诊断（Wave3 扩展）：
 * - 新增 `appendTaskDiag(record, filePath)`：最小 task 诊断 record（白名单收窄，
 *   支持 call 关联 / event / duration / lastActivityAt / 宿主 retry / 限流 kind /
 *   注入预算估算），复用本文件同一异步串行队列与压缩/权限机制，不另建日志系统。
 * - 关闭路径零新增 I/O：调用方须用 `ctxDiag.enabled` 门控（与 appendCtxDiag 一致）。
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RateLimitKind } from '../orchestration/rate-limit';

/** 触发压缩的累计写入字节阈值（不同于旧的「当前文件 50KB」判定） */
const MAX_BYTES = 256 * 1024;

/** 压缩后保留的行数（与旧实现一致，保持在尾部 30 条） */
const KEEP_LINES = 30;

/** 压缩时读取的尾部窗口字节数（只读窗口，不读全文） */
const TAIL_WINDOW = 64 * 1024;

/** 诊断日志配置（全部可选，缺省即安全） */
export interface CtxDiagConfig {
  /** 是否开启上下文注入诊断日志（默认 false） */
  enabled?: boolean;
  /** 自定义日志文件路径（默认 os.tmpdir()/opencode/ctx-diag.log，保持历史路径不变） */
  path?: string;
}

/** 缺省配置：关闭。热路径零开销是缺省行为。 */
export const DEFAULT_CTX_DIAG_CONFIG: Required<Omit<CtxDiagConfig, 'path'>> = {
  enabled: false,
};

/** 解析后的诊断设置（在插件初始化时求值一次，热路径只读常量） */
export interface CtxDiagSettings {
  enabled: boolean;
  filePath: string;
}

/**
 * 是否开启诊断日志。
 * 优先级：环境变量（1/true 开，0/false 关）> 配置 > 缺省（关）。
 */
export function isCtxDiagEnabled(config?: Partial<CtxDiagConfig> | null, env?: string): boolean {
  const flag = env ?? process.env.COHUB_CTX_DIAG;
  if (flag !== undefined) {
    const v = String(flag).trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return config?.enabled ?? DEFAULT_CTX_DIAG_CONFIG.enabled;
}

/** 诊断日志文件路径（默认保持历史 tmpdir 路径，可被配置覆盖） */
export function resolveCtxDiagPath(config?: Partial<CtxDiagConfig> | null): string {
  const custom = config?.path;
  if (typeof custom === 'string' && custom.trim() !== '') return custom;
  return path.join(os.tmpdir(), 'opencode', 'ctx-diag.log');
}

/** 一次性解析设置（插件初始化时调用，避免热路径重复读 process.env） */
export function resolveCtxDiagSettings(
  config?: Partial<CtxDiagConfig> | null,
  env?: NodeJS.ProcessEnv,
): CtxDiagSettings {
  return {
    enabled: isCtxDiagEnabled(config, env?.COHUB_CTX_DIAG),
    filePath: resolveCtxDiagPath(config),
  };
}

// ============================================================
// 写入侧：异步串行队列 + 尾部窗口压缩
// ============================================================

/** 串行队列尾（保证 append 顺序，且不阻塞事件循环） */
let queue: Promise<void> = Promise.resolve();

/** 自上次压缩以来累计追加的字节数（进程内估算，替代每次 statSync） */
let bytesSinceCompact = 0;

/**
 * 只读文件尾部窗口并保留最后 keepLines 行，避免旧实现的「读全文 + 重写全文」。
 * @returns 压缩后文件的近似字节数
 */
async function compactTail(filePath: string, keepLines: number): Promise<number> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return 0;

    const start = Math.max(0, size - TAIL_WINDOW);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let filled = 0;
    let offset = start;
    while (filled < len) {
      const { bytesRead } = await fh.read(buf, filled, len - filled, offset);
      if (bytesRead === 0) break;
      filled += bytesRead;
      offset += bytesRead;
    }

    const lines = buf.subarray(0, filled).toString('utf-8').split('\n').filter(l => l.trim() !== '');
    // 窗口从文件中段开始 → 首行很可能是被切断的半行，丢弃
    if (start > 0 && lines.length > 0) lines.shift();
    const kept = lines.slice(-keepLines);
    const text = kept.length > 0 ? kept.join('\n') + '\n' : '';
    await fsp.writeFile(filePath, text, { encoding: 'utf-8', mode: 0o600 });
    return Buffer.byteLength(text, 'utf-8');
  } finally {
    await fh.close();
  }
}

/**
 * 追加一条诊断记录（异步，失败静默）。
 * 调用方应先判断 `settings.enabled`；本函数自身不做开关判断，便于复用。
 */
export function appendCtxDiag(record: unknown, filePath: string): void {
  const line = JSON.stringify(record) + '\n';
  bytesSinceCompact += Buffer.byteLength(line, 'utf-8');
  const shouldCompact = bytesSinceCompact > MAX_BYTES;
  // 归零放在入队前：压缩后文件已缩到尾部窗口，需要再累积 MAX_BYTES 才会再次压缩
  if (shouldCompact) bytesSinceCompact = 0;

  queue = queue.then(async () => {
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      if (shouldCompact) await compactTail(filePath, KEEP_LINES);
      await fsp.appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // 诊断日志自身失败静默忽略（与 utils/log.ts 的策略一致）
    }
  });
}

/** 测试/诊断辅助：等待队列落盘 */
export function flushCtxDiag(): Promise<void> {
  return queue;
}

/** 测试辅助：重置进程内计数器 */
export function __resetCtxDiagState(): void {
  bytesSinceCompact = 0;
  queue = Promise.resolve();
}

/** 供测试断言用的常量导出 */
export const CTX_DIAG_LIMITS = { MAX_BYTES, KEEP_LINES, TAIL_WINDOW } as const;

/** 诊断日志目录（供排查指引使用） */
export function ctxDiagDir(filePath?: string): string {
  return path.dirname(filePath ?? resolveCtxDiagPath());
}

// ============================================================
// 任务生命周期诊断（最小 record，白名单收窄，复用同一串行队列）
// ============================================================
//
// 与上下文注入诊断（appendCtxDiag）共用同一队列/压缩/0600/静默失败机制，
// 不另建独立日志系统。关闭路径：调用方先用 `ctxDiag.enabled` 门控，
// 不调用则零新增 I/O（本模块自身不做开关判断，与 appendCtxDiag 风格一致）。
//
// Wave4 index.ts 接线例：
//   const ctxDiag = resolveCtxDiagSettings(userConfig.diag);   // 已有
//   if (ctxDiag.enabled) {
//     const info = classifyRateLimit(e);
//     appendTaskDiag({
//       t: 'task',
//       callID: `${input.sessionID ?? ''}:${callId}`,
//       session: input.sessionID?.slice(0, 20),
//       event: 'rate_limit_detected',
//       status: job?.state,
//       retryAttempt: task?.retryCount,
//       retryAfterMs: info.retryAfterMs,
//       rateLimitKind: info.kind,
//       lastActivityAt: Date.now(),
//     }, ctxDiag.filePath);
//   }

/** 建议的任务生命周期事件值（record 白名单以字段为准，值仅作约定） */
export type TaskDiagEvent =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'retry_scheduled'
  | 'rate_limit_detected'
  | 'state_changed';

/**
 * 任务诊断最小 record（白名单字段；调用方只允许传这些键，
 * 未知字段会在 sanitize 时被丢弃——天然阻断 apiKey/body/headers 等敏感内容）。
 */
export interface TaskDiagRecord {
  /** 记录类型标记：task 诊断（区别于上下文注入诊断） */
  t: 'task';
  /** 调用关联标识（如 `(parentSessionID, callID)` 组合串） */
  callID?: string;
  /** 会话 ID（建议调用方传入截断值） */
  session?: string;
  /** 任务 alias */
  alias?: string;
  /** 生命周期事件（见 TaskDiagEvent 约定值） */
  event?: string;
  /** 引擎侧任务状态 */
  status?: string;
  /** 任务耗时（毫秒） */
  durationMs?: number;
  /** 最近活动时间戳（调用方传 Date.now()，不新增轮询 timer） */
  lastActivityAt?: number;
  /** 宿主重试尝试次数 */
  retryAttempt?: number;
  /** 宿主计划下次重试的等待毫秒 */
  retryNextMs?: number;
  /** 限流分类（classifyRateLimit 的 kind） */
  rateLimitKind?: RateLimitKind;
  /** 服务端 Retry-After 毫秒 */
  retryAfterMs?: number;
  /** 注入预算估算（字符数，仅必要元数据） */
  budgetChars?: number;
  /** 注入预算估算（token 数，仅必要元数据） */
  budgetTokens?: number;
}

/** 单值长度上限：防超长输入撑爆日志文件 */
const TASK_DIAG_STRING_MAX = 64;

const TASK_DIAG_STRING_KEYS = ['callID', 'session', 'alias', 'event', 'status'] as const;
const TASK_DIAG_NUMBER_KEYS = [
  'durationMs',
  'lastActivityAt',
  'retryAttempt',
  'retryNextMs',
  'retryAfterMs',
  'budgetChars',
  'budgetTokens',
] as const;

/** 白名单收窄：只保留允许字段并做类型/长度校验；非对象输入返回 null */
export function sanitizeTaskDiagRecord(input: unknown): TaskDiagRecord | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: TaskDiagRecord = { t: 'task' };

  for (const key of TASK_DIAG_STRING_KEYS) {
    const v = src[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed !== '') out[key] = trimmed.slice(0, TASK_DIAG_STRING_MAX);
    }
  }
  for (const key of TASK_DIAG_NUMBER_KEYS) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  const kind = src['rateLimitKind'];
  if (kind === 'rate_limit' || kind === 'retryable_network' || kind === 'other') {
    out.rateLimitKind = kind;
  }
  return out;
}

/**
 * 追加一条任务生命周期诊断（异步串行，失败静默，复用 ctxDiag 队列）。
 * 调用方须先判断 `settings.enabled`；无效输入直接返回（零 I/O）。
 */
export function appendTaskDiag(record: unknown, filePath: string): void {
  const safe = sanitizeTaskDiagRecord(record);
  if (!safe) return;
  appendCtxDiag(safe, filePath);
}
