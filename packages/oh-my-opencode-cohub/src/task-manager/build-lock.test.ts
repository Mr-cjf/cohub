// src/task-manager/build-lock.test.ts
// 验证跨会话构建互斥锁（build-lock.ts）：
//   1. 获取/释放生命周期（锁文件内容、释放后消失）
//   2. 同一 worktree 并发冲突抛 BuildLockError（含持有者信息）
//   3. 陈旧锁接管：pid 不存活 / 超 TTL / 损坏 JSON
//   4. 不同 worktree 锁路径隔离
//   5. 释放匹配守卫（sessionID/callID 不匹配不删他人锁）
//   6. isBuildCommand 正/反例
//   7. 真实跨进程并发：两个独立 bun 进程同时获取同一锁，恰好一个成功
// 隔离策略：每个用例用 fs.mkdtempSync(os.tmpdir()/cohub-lock-) 创建独立的
// stateDir 与 projectDir，测试结束后递归清理，不触碰任何真实用户路径。
// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供（对齐 stats.test.ts 写法）

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireBuildLock,
  releaseBuildLock,
  resolveLockPath,
  isBuildCommand,
  BuildLockError,
} from './build-lock';

/** 创建独立临时目录（stateDir / projectDir 通用） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cohub-lock-'));
}

/** 用例包装：创建独立 stateDir + projectDir，finally 必清理 */
function withDirs(fn: (dirs: { stateDir: string; projectDir: string }) => void): void {
  const dirs = { stateDir: makeTempDir(), projectDir: makeTempDir() };
  try {
    fn(dirs);
  } finally {
    for (const d of [dirs.stateDir, dirs.projectDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不吞业务结果 */ }
    }
  }
}

/** 手动写一个锁文件（模拟陈旧/他方持有状态），返回 lockPath */
function writeLockFile(
  lockPath: string,
  rec: { pid: number; sessionID: string; callID: string; command: string; acquiredAt: number },
): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(rec), 'utf-8');
}

/** 读取锁文件 JSON 并断言是合法记录 */
function readLockRec(lockPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
}

describe('acquireBuildLock / releaseBuildLock', () => {
  test('获取后锁文件存在（pid/sessionID/callID/command/acquiredAt），释放后文件消失', () => {
    withDirs(({ stateDir, projectDir }) => {
      const lockPath = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1', command: 'npm run build',
      });
      expect(lockPath).toBe(resolveLockPath(stateDir, projectDir));
      expect(fs.existsSync(lockPath)).toBe(true);

      const rec = readLockRec(lockPath);
      expect(rec.pid).toBe(process.pid);
      expect(rec.sessionID).toBe('ses_1');
      expect(rec.callID).toBe('call_1');
      expect(rec.command).toBe('npm run build');
      expect(typeof rec.acquiredAt).toBe('number');
      expect(rec.acquiredAt as number).toBeGreaterThan(0);

      expect(releaseBuildLock({ stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1' })).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  test('同一 worktree 第二个 session/callID 获取抛 BuildLockError（错误含持有 sessionID/时间/command）', () => {
    withDirs(({ stateDir, projectDir }) => {
      acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_holder', callID: 'call_holder', command: 'npm run build',
      });
      let err: unknown;
      try {
        acquireBuildLock({
          stateDir, projectDir, sessionID: 'ses_other', callID: 'call_other', command: 'npm run build:cli',
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BuildLockError);
      const msg = (err as Error).message;
      expect(msg).toContain('构建互斥');
      expect(msg).toContain('ses_holder');       // 持有 sessionID
      expect(msg).toContain('call_holder');       // 持有 callID
      expect(msg).toContain('npm run build');     // 持有 command
      expect(msg).toContain('acquiredAt=');       // 持有时间（ISO 串前缀）
    });
  });

  test('pid 不存活（伪造 pid 999999）：下次获取清理陈旧锁后成功', () => {
    withDirs(({ stateDir, projectDir }) => {
      const lockPath = resolveLockPath(stateDir, projectDir);
      // 陈旧锁：pid 999999 必然不存活（写入方已退出）
      writeLockFile(lockPath, {
        pid: 999999, sessionID: 'ses_dead', callID: 'call_dead', command: 'npm run build', acquiredAt: Date.now(),
      });
      const got = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_new', callID: 'call_new', command: 'npm run build',
      });
      expect(got).toBe(lockPath);
      const rec = readLockRec(lockPath);
      expect(rec.pid).toBe(process.pid);         // 已被新持有者接管
      expect(rec.sessionID).toBe('ses_new');
    });
  });

  test('超过 TTL（acquiredAt = now - ttlMs - 1，pid 存活）：清理后成功', () => {
    withDirs(({ stateDir, projectDir }) => {
      const ttlMs = 60_000;
      const lockPath = resolveLockPath(stateDir, projectDir);
      // 持有进程仍存活（当前进程），但记录时间已超 TTL → 视为陈旧
      writeLockFile(lockPath, {
        pid: process.pid, sessionID: 'ses_old', callID: 'call_old',
        command: 'npm run build', acquiredAt: Date.now() - ttlMs - 1,
      });
      const got = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_new', callID: 'call_new', command: 'bun run build', ttlMs,
      });
      expect(got).toBe(lockPath);
      const rec = readLockRec(lockPath);
      expect(rec.sessionID).toBe('ses_new');
      expect(rec.command).toBe('bun run build');
    });
  });

  test('未超 TTL 且 pid 存活：仍抛 BuildLockError', () => {
    withDirs(({ stateDir, projectDir }) => {
      const ttlMs = 60_000;
      const lockPath = resolveLockPath(stateDir, projectDir);
      writeLockFile(lockPath, {
        pid: process.pid, sessionID: 'ses_holder', callID: 'call_holder',
        command: 'npm run build', acquiredAt: Date.now() - ttlMs + 1000, // 仍在 TTL 内
      });
      expect(() => acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_other', callID: 'call_other', command: 'npm run build', ttlMs,
      })).toThrow(BuildLockError);
    });
  });

  test('不同 projectDir：锁路径不同，互不影响', () => {
    const stateDir = makeTempDir();
    const projA = makeTempDir();
    const projB = makeTempDir();
    try {
      expect(resolveLockPath(stateDir, projA)).not.toBe(resolveLockPath(stateDir, projB));

      const lockA = acquireBuildLock({ stateDir, projectDir: projA, sessionID: 'ses_a', callID: 'call_a', command: 'npm run build' });
      const lockB = acquireBuildLock({ stateDir, projectDir: projB, sessionID: 'ses_b', callID: 'call_b', command: 'bun run build' });
      // 两个 worktree 可同时持有锁
      expect(fs.existsSync(lockA)).toBe(true);
      expect(fs.existsSync(lockB)).toBe(true);

      expect(releaseBuildLock({ stateDir, projectDir: projA, sessionID: 'ses_a', callID: 'call_a' })).toBe(true);
      expect(releaseBuildLock({ stateDir, projectDir: projB, sessionID: 'ses_b', callID: 'call_b' })).toBe(true);
      expect(fs.existsSync(lockA)).toBe(false);
      expect(fs.existsSync(lockB)).toBe(false);
    } finally {
      for (const d of [stateDir, projA, projB]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不吞业务结果 */ }
      }
    }
  });

  test('释放时 sessionID/callID 不匹配：返回 false 且锁仍存在；匹配后删除', () => {
    withDirs(({ stateDir, projectDir }) => {
      const lockPath = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1', command: 'npm run build',
      });
      // sessionID 不匹配
      expect(releaseBuildLock({ stateDir, projectDir, sessionID: 'ses_wrong', callID: 'call_1' })).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      // callID 不匹配
      expect(releaseBuildLock({ stateDir, projectDir, sessionID: 'ses_1', callID: 'call_wrong' })).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      // 双匹配 → 删除
      expect(releaseBuildLock({ stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1' })).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  test('损坏的锁 JSON（非法 JSON / 关键字段缺失）：视为陈旧并接管', () => {
    withDirs(({ stateDir, projectDir }) => {
      const lockPath = resolveLockPath(stateDir, projectDir);
      // 非法 JSON：readLock 解析失败 → undefined → 陈旧
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, '{not-valid-json', 'utf-8');
      const got1 = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1', command: 'npm run build',
      });
      expect(got1).toBe(lockPath);
      expect(readLockRec(lockPath).sessionID).toBe('ses_1');

      // 关键字段缺失（pid 非 number）→ readLock 返回 undefined → 陈旧
      releaseBuildLock({ stateDir, projectDir, sessionID: 'ses_1', callID: 'call_1' });
      fs.writeFileSync(lockPath, JSON.stringify({ sessionID: 'x', callID: 'y', command: 'z' }), 'utf-8');
      const got2 = acquireBuildLock({
        stateDir, projectDir, sessionID: 'ses_2', callID: 'call_2', command: 'bun run build',
      });
      expect(got2).toBe(lockPath);
      expect(readLockRec(lockPath).sessionID).toBe('ses_2');
    });
  });

  test('真实跨进程并发：两个独立 bun 进程同时获取同一锁，恰好一个 ok、一个 lock', async () => {
    const stateDir = makeTempDir();
    const projectDir = makeTempDir();
    const runnerDir = makeTempDir();
    const runnerPath = path.join(runnerDir, 'runner.ts');
    const buildLockPath = path.resolve(import.meta.dir, 'build-lock.ts');
    try {
      // runner：import 绝对路径的 build-lock.ts，从环境变量读锁参数；
      // 成功 → 输出 ok 并保持 800ms 再退出（确保另一进程尝试时本进程 pid 仍存活）；
      // 失败 → 输出 lock
      fs.writeFileSync(runnerPath, [
        `import { acquireBuildLock } from ${JSON.stringify(buildLockPath)};`,
        `const env = process.env as Record<string, string>;`,
        `(async () => {`,
        `  try {`,
        `    acquireBuildLock({ stateDir: env.LOCK_STATE_DIR, projectDir: env.LOCK_PROJECT_DIR, sessionID: env.LOCK_SESSION_ID, callID: env.LOCK_CALL_ID, command: 'npm run build' });`,
        `    console.log('ok');`,
        `    await new Promise((resolve) => setTimeout(resolve, 800));`,
        `  } catch {`,
        `    console.log('lock');`,
        `  }`,
        `})();`,
        ``,
      ].join('\n'));

      const spawnRunner = (sessionID: string, callID: string) =>
        Bun.spawn(['bun', runnerPath], {
          env: {
            ...(process.env as Record<string, string>),
            LOCK_STATE_DIR: stateDir,
            LOCK_PROJECT_DIR: projectDir,
            LOCK_SESSION_ID: sessionID,
            LOCK_CALL_ID: callID,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });

      // 同时启动两个进程，共享同一 stateDir/projectDir
      const pA = spawnRunner('ses_cross_a', 'call_cross_a');
      const pB = spawnRunner('ses_cross_b', 'call_cross_b');
      const outs = await Promise.all(
        [pA, pB].map(async (p) => (await new Response(p.stdout)).text().then((t) => t.trim())),
      );
      await Promise.all([pA.exited, pB.exited]);

      // 恰好一个成功、一个冲突（不能两个都成功——持锁进程保持 800ms，pid 存活 → 锁非陈旧）
      expect(outs.slice().sort()).toEqual(['lock', 'ok']);
      expect(outs.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outs.filter((o) => o === 'lock')).toHaveLength(1);
    } finally {
      for (const d of [stateDir, projectDir, runnerDir]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不吞业务结果 */ }
      }
    }
  });
});

describe('isBuildCommand 正例', () => {
  const positives = [
    'npm run build',
    'pnpm build',
    'pnpm run build',
    'yarn build',
    'npm run build:cli',
    'bun run build',
    'bun build src/index.ts',
    'tsc --emitDeclarationOnly',
    'npx tsc',
    'bun run scripts/generate-prompts.ts',
    'cd x && npm run build',
    'npm run prepublishOnly',
  ];
  for (const cmd of positives) {
    test(JSON.stringify(cmd) + ' → true', () => {
      expect(isBuildCommand(cmd)).toBe(true);
    });
  }
});

describe('isBuildCommand 反例', () => {
  const negatives = [
    'bun test ./src',
    'npm run test',
    'npm run buildx',
    'echo "npm run build"',
    'git commit -m "build"',
    'npm run dev',
  ];
  for (const cmd of negatives) {
    test(JSON.stringify(cmd) + ' → false', () => {
      expect(isBuildCommand(cmd)).toBe(false);
    });
  }
});
