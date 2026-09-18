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
