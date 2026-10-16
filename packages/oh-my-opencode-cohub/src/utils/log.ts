/**
 * oh-my-opencode-cohub 诊断日志工具（共享层适配壳）。
 *
 * 实现已上移到 cohub-shared/src/log.ts（sync 到 src/shared/log.ts），
 * 此处仅做工厂实例化，以维持既有 import 路径与调用签名不变。
 *
 * 日志路径：~/.local/share/opencode/log/oh-my-opencode-cohub.YYYYMMDD.log
 * 保留天数：7 天
 * 格式：[ISO时间] [oh-my-opencode-cohub] [tag] message
 */

import * as os from 'os';
import * as path from 'path';
import { createLogger, type LogFn } from '../shared/log';
import { classifyRateLimit } from '../orchestration/rate-limit';

const LOG_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'log');

/** 追加一条诊断日志（异步，失败静默）。 */
export const appendLog: LogFn = createLogger({
  logDir: LOG_DIR,
  prefix: 'oh-my-opencode-cohub',
  linePrefix: 'oh-my-opencode-cohub',
  dailyRotate: true,
  keepDays: 7,
  async: true,
});

/**
 * 安全观测辅助：记录错误摘要而非原始错误对象。
 *
 * 原始 err 可能携带 SDK ApiError 的 responseBody / responseHeaders（含密钥），
 * 若直接 `appendLog(tag, msg, err)` 会把敏感内容写入 ~/.local 日志。
 * 本函数先用 classifyRateLimit 生成脱敏固定摘要（maskedMessage），
 * 仅记录摘要文本，不把原始 err 传给底层 logger（避免 String(err)/err.stack 泄漏）。
 *
 * 用法（Wave4 接线）：
 *   try { ... } catch (e) { appendSafeLog('orchestration', 'session.idle 处理失败', e); }
 */
export function appendSafeLog(tag: string, message: string, err?: unknown): void {
  if (err === undefined) {
    appendLog(tag, message);
    return;
  }
  const { maskedMessage } = classifyRateLimit(err);
  appendLog(tag, `${message} — ${maskedMessage}`);
}
