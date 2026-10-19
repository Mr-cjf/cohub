/**
 * 跨会话构建互斥锁（同一 worktree 并发 npm run build 互斥）。
 *
 * 背景：oh-my-opencode-cohub 的构建会写 src/prompts/*.ts（generate-prompts）
 * 与 dist/（bun build + tsc）。若同一 worktree 上多个会话并行构建，
 * 两个进程会互相覆盖生成物，产生撕裂的中间态。
 *
 * 锁文件放在 stateDir/build-locks/{lockKey}.lock（用户级状态目录，
 * 不依赖仓库内路径，避免污染构建产物目录）：
 * - 锁键 = sha256(path.resolve(projectDir)).slice(0, 16)：不同 worktree 不互斥；
 * - 获取 = openSync(lockPath, 'wx') 原子创建（EEXIST 即被占用），内容含唯一 token；
 * - 陈旧锁 = pid 不存活（kill(pid, 0) 抛 ESRCH）或超 TTL（默认 30 分钟）；
 * - 陈旧清理 = 原子 rename 抢占到唯一 stalePath + token 二次校验（杜绝
 *   「A 清理后建新锁、B 再删 A 新锁」竞态，绝不误删他人新锁）；
 * - 释放 = 仅当锁记录的 sessionID 与 callID 均匹配才删除，绝不删他人锁；
 * - 兜底 = TTL + pid 存活检测（不依赖 dispose 一定被调用）。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 构建锁冲突错误：上抛给宿主/会话感知（不静默吞掉） */
export class BuildLockError extends Error {}

/** 锁默认 TTL：30 分钟（超过即视为陈旧，可由新持有者接管） */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 锁文件内记录的内容（JSON 序列化） */
interface LockRecord {
  pid: number;
  sessionID: string;
  callID: string;
  command: string;
  acquiredAt: number;
  /** 唯一持有令牌：陈旧清理原子抢占后二次校验用（旧格式锁/损坏文件为 null） */
  token: string | null;
}

/** 计算锁文件路径：stateDir/build-locks/{sha256(projectDir)前16位}.lock */
export function resolveLockPath(stateDir: string, projectDir: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 16);
  return path.join(stateDir, 'build-locks', `${key}.lock`);
}

/** pid 存活检测：kill(pid, 0) 抛 ESRCH → 不存活；EPERM → 存在但无权发信号，视为存活 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读取锁 JSON；读取失败 / JSON 解析失败 / 关键字段缺失 → undefined（视为陈旧） */
function readLock(lockPath: string): LockRecord | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const rec = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof rec.pid !== 'number' || typeof rec.acquiredAt !== 'number') return undefined;
    // token 缺失/非法 → null（旧格式锁无 token，读取方按 null 处理）
    return { ...rec, token: typeof rec.token === 'string' ? rec.token : null } as LockRecord;
  } catch {
    return undefined;
  }
}

/** 陈旧判定：无法解析 / pid 不存活 / 超过 TTL */
function isStaleLock(rec: LockRecord | undefined, now: number, ttlMs: number): boolean {
  if (!rec) return true;
  if (!isPidAlive(rec.pid)) return true;
  return now - rec.acquiredAt > ttlMs;
}

/**
 * 原子接管陈旧锁（消除「A unlink 后建新锁、B 再 unlink 删 A 新锁」竞态）：
 * 1. renameSync(lockPath, stalePath) 原子抢占——同一时刻只有一个进程能把锁
 *    移到自己的唯一 stalePath，先到者得；
 * 2. 二次校验 stalePath 内 token：与读取时一致 → 清理的正是那个陈旧锁，unlink；
 *    不一致 → 抢到的是别人刚创建的新锁，立即 renameSync 恢复原状，绝不误删；
 * 3. ENOENT（锁已被他人清理）→ 视为可重试。
 * 返回 'retryable'：可重新尝试获取；'not-retryable'：抢到了他人新锁（已恢复），
 * 调用方应直接判冲突，不再重试。
 */
function reclaimStaleLock(lockPath: string, expectedToken: string | null): 'retryable' | 'not-retryable' {
  const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  let moved = false;
  try {
    try {
      fs.renameSync(lockPath, stalePath);
      moved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'retryable'; // 已被他人清理，直接重试
      throw err;
    }
    const movedToken = readLock(stalePath)?.token ?? null;
    if (movedToken !== expectedToken) {
      // 抢到了别人刚创建的新锁：立即恢复原状，报告不可重试
      try { fs.renameSync(stalePath, lockPath); } catch { /* 恢复失败：极端竞态，不强行覆盖 */ }
      return 'not-retryable';
    }
    fs.unlinkSync(stalePath);
    return 'retryable';
  } catch (err) {
    // 清理失败：尽力把锁放回原处，避免丢锁；放不回也绝不掩盖原始错误
    if (moved) {
      try { fs.renameSync(stalePath, lockPath); } catch { /* 恢复失败不掩盖原始错误 */ }
    }
    throw err;
  }
}

export interface AcquireLockOptions {
  stateDir: string;
  projectDir: string;
  sessionID: string;
  callID: string;
  command: string;
  /** 测试/调试用：当前时间（毫秒），默认 Date.now() */
  now?: number;
  /** 锁 TTL（毫秒），默认 30 分钟 */
  ttlMs?: number;
}

/**
 * 获取构建锁：openSync('wx') 原子创建锁文件并写入持有者记录（含唯一 token）。
 * - 成功 → 返回 lockPath；
 * - EEXIST 且锁陈旧（pid 不存活或超 TTL）→ 原子 rename 抢占 + token 二次校验后重试一次；
 * - EEXIST 且锁非陈旧 / 抢占到他人新锁 → 抛 BuildLockError（含持有者信息与建议）。
 */
export function acquireBuildLock(opts: AcquireLockOptions): string {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const lockPath = resolveLockPath(opts.stateDir, opts.projectDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // 最多两次尝试：首次 EEXIST 且陈旧 → 原子清理后重试一次；重试仍 EEXIST → 重新读取并抛错（不无限循环）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        const record: LockRecord = {
          pid: process.pid,
          sessionID: opts.sessionID,
          callID: opts.callID,
          command: opts.command,
          acquiredAt: now,
          token: crypto.randomUUID(),
        };
        fs.writeSync(fd, JSON.stringify(record));
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const rec = readLock(lockPath);
      if (isStaleLock(rec, now, ttlMs)) {
        // 陈旧锁：原子 rename 抢占 + token 二次校验；'retryable' 才重试
        if (reclaimStaleLock(lockPath, rec?.token ?? null) === 'retryable') continue;
        // 'not-retryable'：抢到了他人刚创建的新锁（已恢复原状）→ 直接判冲突，不再重试
      }
      const holder = readLock(lockPath);
      throw new BuildLockError(
        `构建互斥：worktree ${path.resolve(opts.projectDir)} 上已有进行中的构建（` +
        `sessionID=${holder?.sessionID ?? '未知'}, callID=${holder?.callID ?? '未知'}, command="${holder?.command ?? '未知'}", ` +
        `acquiredAt=${holder ? new Date(holder.acquiredAt).toISOString() : '未知'}）。` +
        `请等待其完成（TTL ${Math.round(ttlMs / 60000)} 分钟，持有进程退出后自动失效）或改用独立 worktree 执行构建。`,
      );
    }
  }
  // 两次尝试均失败（理论上不可达：陈旧锁已原子清理后 openSync 应成功）
  throw new BuildLockError(`构建互斥：无法获取锁 ${lockPath}`);
}

export interface ReleaseLockOptions {
  stateDir: string;
  projectDir: string;
  sessionID: string;
  callID: string;
}

/**
 * 释放构建锁：仅当锁记录的 sessionID 与 callID 均匹配才删除。
 * 不匹配 / 锁不存在 / 锁文件损坏 → 返回 false，绝不删除他人锁。
 */
export function releaseBuildLock(opts: ReleaseLockOptions): boolean {
  const lockPath = resolveLockPath(opts.stateDir, opts.projectDir);
  const rec = readLock(lockPath);
  if (!rec) return false;
  if (rec.sessionID !== opts.sessionID || rec.callID !== opts.callID) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** 构建命令匹配正则（仅匹配命令开头，避免误拦 echo "npm run build" 等文本） */
const BUILD_COMMAND_PATTERNS: RegExp[] = [
  // npm|pnpm|yarn [+ run] + build（含 build: 子任务）
  /^(?:npm|pnpm|yarn)(?:\s+run)?\s+build(?::[\w-]*)?(?:\s|$)/,
  // bun [+ run] + build（覆盖 bun build 与 bun run build[:*]）
  /^bun(?:\s+run)?\s+build(?::[\w-]*)?(?:\s|$)/,
  // bun [+ run] + scripts/generate-prompts（构建脚本第 1 步，含 .ts 后缀）
  /^bun(?:\s+run)?\s+\S*generate-prompts\S*(?:\s|$)/,
  // npx tsc / tsc
  /^(?:npx\s+)?tsc(?:\s|$)/,
  // generate-prompts（构建脚本第 1 步）
  /^generate-prompts(?:\s|$)/,
  // npm run prepublishOnly
  /^npm\s+run\s+prepublishOnly(?:\s|$)/,
];

/**
 * 判断命令是否为构建类命令：按 &&、||、;、换行拆分成子命令，
 * 任一子命令（trim 后）以构建命令开头即返回 true。
 */
export function isBuildCommand(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const segments = command.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*|\r?\n/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '') continue;
    for (const re of BUILD_COMMAND_PATTERNS) {
      if (re.test(trimmed)) return true;
    }
  }
  return false;
}
