// src/context/engine.ts — 上下文引擎核心

import type { ContextStrategy, TaskContext, ContextConfig, DependencyResult, RelevantFile, ReuseInputSample } from './types';
import { DEFAULT_CONTEXT_CONFIG } from './types';
import * as fs from 'node:fs';
import { extractRelevantFiles, extractDecisions, extractErrors, truncateByTokens, estimateTokens } from './extractor';
import { formatContextMarker, replaceMarkerWithContext, CONTEXT_MARKER_PATTERN } from './formatter';
import { tokenBudgetToByteLimit, utf8TrimIncomplete, SUMMARY_READ_LOOKAHEAD_BYTES } from './prompt-budget';
import type { createOpencodeClient } from '@opencode-ai/sdk';

type SdkClient = ReturnType<typeof createOpencodeClient>;

/** 读取上限截断的诚实提示后缀（区别于 truncateByTokens 的 token 预算截断标记） */
const READ_LIMIT_TRUNCATION_SUFFIX = '\n… [正文已按读取上限截断]';

/**
 * captureResult 有界读取上限：SDK v1 session.messages 支持 limit 但不保证顺序，
 * 只取最近 limit 条；绝不在复用会话历史无限膨胀时无界读全量。
 * 与既有 verifyChildTerminal(limit=10) / fillContextAsync(relevantMessageWindow=20) 同级有界。
 */
const CAPTURE_RESULT_MESSAGE_LIMIT = 20;

export class ContextEngine {
  /** contextId → TaskContext */
  private registry = new Map<string, TaskContext>();
  /**
   * contextId → 最后一次被读写的时间戳（ms）。
   * registry 的唯二读取者是 `formatContextDetails()`（index.ts 注入详情）与
   * `consumeMarkedContext()`（消息标记替换）；两者都会刷新本时间戳。
   * 定时清理据此判断条目是否已「过期未被合法消费」——
   * 时间戳只在读写时更新，因此不会误删仍在被后续读取的条目。
   */
  private registryTouchedAt = new Map<string, number>();
  /** alias → 前置子代理结果 */
  // 缓存语义（诚实边界）：本缓存是「同 Instance 内各父会话的近期任务摘要」，不是真实任务
  // 依赖图——alias 实例级全局唯一，跨父会话不碰撞；读端按 parentSessionId 过滤，只隔离
  // 同 Instance 跨父会话的摘要串注入，不扩展到任务级相关性分析，也不虚构 task deps 参数。
  private dependencyCache = new Map<string, DependencyResult>();
  /**
   * In-flight promise 去重 map：key = `${parentSessionId}::${windowSize}`。
   * 同批次并发调用共享同一次 API 调用；promise settle 后自动从 Map 删除，
   * 确保跨批次串行调用重新调 API（无脏读）。
   */
  private inflight = new Map<string, Promise<{ files: RelevantFile[]; decisions: string[]; errors: string[] }>>();
  private client: SdkClient;
  private config: ContextConfig;

  constructor(client: SdkClient, config?: Partial<ContextConfig>) {
    this.client = client;
    // 修复 I2: 深度合并 strategy
    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      ...config,
      strategy: { ...DEFAULT_CONTEXT_CONFIG.strategy, ...config?.strategy },
    };
  }

  /**
   * 同步注册上下文占位并返回 contextId。
   * 标记可立即注入到 output.args.description。
   */
  registerContext(args: { description: string }): string {
    const contextId = crypto.randomUUID();
    this.registry.set(contextId, {
      goal: args.description,
      relevantFiles: [],
      decisions: [],
      errors: [],
      dependencies: [],
    });
    this.registryTouchedAt.set(contextId, Date.now());
    return contextId;
  }

  /**
   * 异步填充已注册的上下文（不阻塞工具启动）。
   */
  async fillContextAsync(
    contextId: string,
    parentSessionId: string,
    args: { strategy: ContextStrategy },
  ): Promise<void> {
    const context = this.registry.get(contextId);
    if (!context) return;

    if (args.strategy === 'none') return;
    context.strategy = args.strategy;
    this.touch(contextId);

    try {
      const windowSize = this.config.relevantMessageWindow;
      const cacheKey = `${parentSessionId}::${windowSize}`;

      // In-flight promise 去重：同批次并发调用共享同一次 API 调用，
      // promise settle 后自动从 Map 删除，确保跨批次重新调 API（无脏读）
      let pending = this.inflight.get(cacheKey);
      if (!pending) {
        const p = (async () => {
          const messagesResult = await this.client.session.messages({
            path: { id: parentSessionId },
            query: { limit: windowSize },
          });
          const messages = (messagesResult.data ?? []) as Array<{
            info?: { role?: string };
            parts?: Array<{ type?: string; text?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string } }>;
          }>;

          if (args.strategy === 'relevant' || args.strategy === 'summary' || args.strategy === 'full') {
            const files = extractRelevantFiles(messages, this.config.maxFiles, windowSize);
            const decisions = extractDecisions(messages, this.config.maxDecisions, windowSize);
            const errors = extractErrors(messages, this.config.maxErrors, windowSize);
            return { files, decisions, errors };
          }
          return { files: [] as RelevantFile[], decisions: [] as string[], errors: [] as string[] };
        })();
        this.inflight.set(cacheKey, p);
        // 无论成功或失败，完成后从 Map 删除（避免脏读 + 避免 unhandled rejection）
        void p.then(() => this.inflight.delete(cacheKey), () => this.inflight.delete(cacheKey));
        pending = p;
      }

      const result = await pending;
      context.relevantFiles = result.files;
      context.decisions = result.decisions;
      context.errors = result.errors;

      // 'summary' 策略：提取之后、inflight 之外执行（每个调用者各自执行）
      if (args.strategy === 'summary') {
        this.attachTruncatedBodies(context.relevantFiles);
      }

      if (this.config.dependencyPropagation && this.dependencyCache.size > 0) {
        // 父会话隔离：先按 parentSessionId 过滤出本父会话的结果，再取最近 maxDependencies 条。
        // 先 filter 后 limit——其他父会话的结果不占用本父会话的注入限额；
        // 同 parent 内顺序 / TTL / 截断等既有行为保持不变。
        context.dependencies = Array.from(this.dependencyCache.values())
          .filter((dep) => dep.parentSessionId === parentSessionId)
          .slice(-this.config.maxDependencies);
      }
    } catch {
      // SDK 调用失败时保留最小上下文
    } finally {
      // 填充结束（成功或失败）刷新时间戳：真正的"可被消费"起点在填充完成后
      this.touch(contextId);
    }
  }

  /**
   * summary 策略：读取相关文件正文并按 token 预算截断。
   * 预算按文件数均摊，总注入不超过 summarizeMaxTokens；读取失败的文件保留 summary 回退。
   *
   * 读取模式（config.summaryReadMode，缺省 'bounded'）：
   * - 'bounded'（默认）：按预算推导字节上限（见 prompt-budget.ts，默认 2000 tokens → 16KB），
   *   open/read/close 部分读取 + 4 字节 lookahead 判定「是否超出读取上限」+ UTF-8 边界修正，
   *   再 truncateByTokens。ASCII/CJK 常规场景注入结果与旧全量读+截断**等价**；
   *   当文件超出读取上限且预算未触发 token 截断时（如纯 emoji 恰停在预算边界、或预算触发 1MiB 硬 cap），
   *   附加诚实读取截断标记「… [正文已按读取上限截断]」，不再宣称逐字节等价；
   *   与旧 truncateByTokens 的差异仅源于修复其在 4 字节非 CJK 字符边界切出孤立 surrogate 的缺陷。
   * - 'full'：保留旧行为——全量 readFileSync 后再按预算截断（保守选项，关闭激进裁剪）。
   */
  private attachTruncatedBodies(files: RelevantFile[]): void {
    if (files.length === 0) return;
    const budgetPerFile = Math.max(1, Math.floor(this.config.summarizeMaxTokens / files.length));
    for (const file of files) {
      try {
        if (this.config.summaryReadMode === 'full') {
          const content = fs.readFileSync(file.path, 'utf-8');
          file.body = truncateByTokens(content, budgetPerFile);
        } else {
          // 有界读取：字节上限由 token 预算推导（见 prompt-budget.ts），UTF-8 边界修正后再截断
          const { text, truncatedByReadLimit } = this.readBoundedUtf8(file.path, tokenBudgetToByteLimit(budgetPerFile));
          file.body = truncateByTokens(text, budgetPerFile);
          // 诚实提示：文件超出读取上限且预算内未填满（token 截断未触发）→ 正文被读取上限截断
          if (truncatedByReadLimit && estimateTokens(file.body) <= budgetPerFile) {
            file.body += READ_LIMIT_TRUNCATION_SUFFIX;
          }
        }
      } catch {
        // 文件不存在/不可读：保留 summary 回退，不中断
      }
    }
  }

  /**
   * 按字节上限有界读取 UTF-8 文本（默认 summary 模式使用）。
   * 读取 min(size, byteLimit + SUMMARY_READ_LOOKAHEAD_BYTES) 字节：
   * - 实际读到的字节数 > byteLimit → 文件超出读取上限（lookahead 判定，比 fstat size 更诚实，
   *   覆盖读取期间文件被修改等边缘）；
   * - 返回文本始终先 utf8TrimIncomplete 修正字符边界（避免 U+FFFD 与末尾未配对 surrogate）。
   * fd 在正常与异常路径都会关闭（try/finally）；open 失败由调用方 catch 兜底。
   */
  private readBoundedUtf8(filePath: string, byteLimit: number): { text: string; truncatedByReadLimit: boolean } {
    const fd = fs.openSync(filePath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const toRead = Math.min(size, byteLimit + SUMMARY_READ_LOOKAHEAD_BYTES);
      const buf = Buffer.allocUnsafe(Math.max(0, toRead));
      let filled = 0;
      while (filled < toRead) {
        const n = fs.readSync(fd, buf, filled, toRead - filled, filled);
        if (n <= 0) break; // short-read 后继续循环；EOF（0）正常结束
        filled += n;
      }
      const truncatedByReadLimit = filled > byteLimit;
      const raw = buf.subarray(0, Math.min(filled, byteLimit));
      // 先修正 UTF-8 字符边界再解码，避免窗口末尾出现 U+FFFD 乱码
      return { text: utf8TrimIncomplete(raw).toString('utf-8'), truncatedByReadLimit };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Phase B: 消费标记文本。
   * 从消息文本中提取 contextId → 查 registry → 替换标记为格式化上下文。
   * 返回替换后的完整文本，或 null（无标记或未找到上下文）。
   */
  consumeMarkedContext(messageText: string): string | null {
    const markerMatch = messageText.match(CONTEXT_MARKER_PATTERN);
    if (!markerMatch) return null;

    const contextId = markerMatch[1];
    const context = this.registry.get(contextId);
    if (!context) {
      // 上下文已过期或被清理，移除标记
      this.registryTouchedAt.delete(contextId);
      return messageText.replace(CONTEXT_MARKER_PATTERN, '');
    }

    const result = replaceMarkerWithContext(messageText, context);
    // 消费后清理（读取即消费：标记只出现一次，替换后不可能再被合法消费）
    this.registry.delete(contextId);
    this.registryTouchedAt.delete(contextId);
    return result;
  }

  /**
   * 格式化上下文详情（文件、决策、错误、依赖），不含主标题。
   * 用于在 tool.execute.before 中直接追加到子代理 prompt。
   */
  formatContextDetails(contextId: string): string {
    const context = this.registry.get(contextId);
    if (!context) return '';
    this.touch(contextId);

    const parts: string[] = [];

    const isSummary = context.strategy === 'summary';

    if (context.relevantFiles.length > 0) {
      if (isSummary) {
        // P2-1: summary 注入模板——保留文件路径锚点，正文按 token 预算截断
        parts.push('### 📁 相关文件（正文按 token 预算截断）');
        for (const file of context.relevantFiles) {
          const loc = file.lines ? ':' + file.lines : '';
          if (file.body) {
            parts.push('- `' + file.path + loc + '`:\n```text\n' + file.body + '\n```');
          } else {
            parts.push('- `' + file.path + loc + '` — ' + (file.summary || '(正文不可用)'));
          }
        }
      } else {
        parts.push('### 📁 相关文件');
        for (const file of context.relevantFiles) {
          parts.push('- `' + file.path + '`' + (file.summary ? ' — ' + file.summary : ''));
        }
      }
    }

    if (context.decisions.length > 0) {
      parts.push('### 💡 前置决策');
      for (const d of context.decisions) {
        parts.push(`- ${d}`);
      }
    }

    if (context.errors.length > 0) {
      parts.push('### ⚠️ 近期错误');
      let totalChars = 0;
      let omitted = 0;
      for (const e of context.errors) {
        const line = `- ${e}`;
        if (totalChars + line.length > this.config.maxErrorTotalChars) {
          omitted++;
        } else {
          parts.push(line);
          totalChars += line.length;
        }
      }
      if (omitted > 0) {
        parts.push(`…（错误已省略 ${omitted} 条）`);
      }
    }

    if (context.dependencies.length > 0) {
      parts.push('### 📦 依赖结果');
      for (const dep of context.dependencies) {
        const output = dep.keyOutput.length > this.config.dependencyKeyOutputChars
          ? dep.keyOutput.slice(0, this.config.dependencyKeyOutputChars) + '…'
          : dep.keyOutput;
        parts.push(`- **${dep.agent}**: ${output}`);
      }
    }

    return parts.length > 0 ? '\n' + parts.join('\n') + '\n' : '';
  }

  /**
   * Phase C: 捕获子代理结果。
   * 读取子 session 的最近 limit 条消息（有界）→ 提取关键信息 → 存入 dependencyCache。
   * 同时返回质量判定输入（output / decisions / tokens）与复用预算采样（reuseInput）。
   * dependencyPropagation 为 false 时跳过 dependencyCache 写入，不影响质量数据提取。
   *
   * 有界/时序安全（复用预算核心）：
   * - limit 20 防无界读；SDK 不保证顺序 → 仅当「可确认最新」时才有最近 assistant：
   *   · 存在缺失 time.created 的 assistant（无法排序）→ 不可确认；
   *   · 最大 time.created 并列多条 → 无法判定哪个更新 → 不可确认；
   *   · 全部缺失 / 无 assistant → 不可确认。
   *   不可确认 → reuseInput/tokens 均未知（绝不按数组顺序判安全，绝不捞旧带 tokens 消息回填）；
   * - reuseInput 仅从可确认最新消息计算可信归一化输入（input+cache.read+cache.write，
   *   不叠加 output/reasoning）；三字段均须为非负有限数，求和溢出 → 未知（绝不虚报 0）；
   * - sampledAt 只取消息真实 time.created（可确认最新时必为数值），
   *   绝不回退当前时间伪装老用量新鲜；
   * - keyOutput 优先取可确认最新 assistant 的 text，无法确认/无 text 时
   *   按 time.created 降序回退更早 assistant（摘要保持有界内最佳努力，不被未知采样破坏）；
   * - 新鲜度边界（opts.notBefore = 本轮调用开始时间）：采样消息创建时间早于调用边界 →
   *   该消息不属于当前调用（复用会话旧历史）→ reuseInput 标未知，绝不回填旧 low/high 到本轮。
   *   仅在能确认最新时才有 sampledAt；样本时间不伪造。
   */
  async captureResult(
    childSessionId: string,
    alias: string,
    agent: string,
    opts?: { notBefore?: number; parentSessionId?: string },
  ): Promise<{ output: string; decisions: number; tokens?: { input: number; output: number }; reuseInput?: ReuseInputSample } | null> {
    try {
      const messagesResult = await this.client.session.messages({
        path: { id: childSessionId },
        query: { limit: CAPTURE_RESULT_MESSAGE_LIMIT },
      });
      const messages = (messagesResult.data ?? []) as Array<{
        info?: {
          role?: string;
          id?: string;
          time?: { created?: number };
          tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
        };
        parts?: Array<{ type?: string; text?: string }>;
      }>;

      // 「可确认最新」判定：仅当存在带数值 time.created 的 assistant、无时间缺失消息、
      // 且最大 created 唯一（无并列）时才能确定哪条最新；否则保守未知。
      // 哨兵用 -Infinity：负值时间戳也能参与比较；时间缺失消息不参与比较但显式
      // 标记 hasUntimedAssistant（整体不可确认）——绝不因哨兵而让含糊记录误判安全。
      let latestAssistant: (typeof messages)[number] | undefined;
      let latestCreated = -Infinity;
      let latestTie = false;
      let hasUntimedAssistant = false;
      for (const m of messages) {
        const info = m.info;
        if (!info || info.role !== 'assistant') continue;
        const created = typeof info.time?.created === 'number' ? info.time.created : -1;
        if (created === -1) {
          hasUntimedAssistant = true; // 时间缺失：无法参与排序，整体不可确认最新
          continue;
        }
        if (created > latestCreated) {
          latestCreated = created;
          latestAssistant = m;
          latestTie = false;
        } else if (created === latestCreated) {
          latestTie = true; // 最大时间并列：无法判定哪个更新
        }
      }
      const latestConfirmed = !hasUntimedAssistant && latestAssistant !== undefined && !latestTie;

      // keyOutput（摘要最佳努力，时间优先；不因采样未知而退化）：
      // 1. 优先「最大有效 time.created 候选组」——所有 created === latestCreated 的
      //    assistant（时间并列可任选一致候选取摘要；乱序时绝不回退到数组尾的旧消息）；
      // 2. 候选组无 text → 剩余带 time.created 候选按时间降序找首个有 text
      //    （降序输入 [最新无正文, 次新结论, 最旧结论] 取次新，不误取数组尾最旧）；
      // 3. 全部缺失 time.created（无法比时间）→ 稳定兜底：数组尾向前取任意可得 text；
      //    无论何种回退，reuseInput/tokens 仍由 latestConfirmed 严格控制（不恢复可信采样）。
      const maxCreatedCandidates: (typeof messages)[number][] = [];
      if (latestAssistant !== undefined) {
        for (const m of messages) {
          const info = m.info;
          if (!info || info.role !== 'assistant') continue;
          const created = typeof info.time?.created === 'number' ? info.time.created : -1;
          if (created === latestCreated) maxCreatedCandidates.push(m);
        }
      }
      // 提取 assistant 消息首个 text part（截断 + 单行化；无 text 返回 ''）
      const firstTextOf = (m: (typeof messages)[number]): string => {
        for (const part of m.parts ?? []) {
          if (part.type === 'text' && part.text) {
            return part.text.slice(0, this.config.dependencyKeyOutputChars).replace(/\n/g, ' ');
          }
        }
        return '';
      };

      let keyOutput = '';
      for (const cand of maxCreatedCandidates) {
        const text = firstTextOf(cand);
        if (text) {
          keyOutput = text;
          break;
        }
      }
      if (!keyOutput) {
        // 时间降序回退：跳过已尝试候选（最大时间候选组），按 time.created 从大到小
        // 找首个有 text 的 assistant——乱序/降序输入时绝不按数组尾误取最旧结论。
        const tried = new Set(maxCreatedCandidates);
        const timed: Array<{ msg: (typeof messages)[number]; created: number }> = [];
        const untimed: (typeof messages)[number][] = [];
        for (const m of messages) {
          const info = m.info;
          if (!info || info.role !== 'assistant' || tried.has(m)) continue;
          const created = typeof info.time?.created === 'number' ? info.time.created : -1;
          if (created === -1) untimed.push(m);
          else timed.push({ msg: m, created });
        }
        timed.sort((a, b) => b.created - a.created);
        for (const { msg } of timed) {
          const text = firstTextOf(msg);
          if (text) {
            keyOutput = text;
            break;
          }
        }
        // 缺 time 候选（全部无法排序）→ 稳定兜底：数组尾向前找首个有 text（跳过已尝试）。
        // 采样是否可信与摘要 best effort 彻底分开：此处回退不影响 reuseInput/tokens 判定。
        if (!keyOutput) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (tried.has(messages[i])) continue;
            const info = messages[i].info;
            if (!info || info.role !== 'assistant') continue;
            const text = firstTextOf(messages[i]);
            if (text) {
              keyOutput = text;
              break;
            }
          }
        }
      }

      // 原始 tokens（质量回送）：仅可确认最新时取（乱序时时间最新；不可确认 → 未知）
      let tokens: { input: number; output: number } | undefined;
      let reuseInput: ReuseInputSample | undefined;
      if (latestConfirmed && latestAssistant) {
        const info = latestAssistant.info;
        const t = info?.tokens;
        if (t && typeof t.input === 'number' && typeof t.output === 'number') {
          tokens = { input: t.input, output: t.output };
        }
        // 可信归一化最近输入：input + cache.read + cache.write。
        // 三字段均须为非负有限数（缺 cache/负值/非有限 → 口径不能确定 → 未知）；
        // 求和溢出（> MAX_SAFE_INTEGER）→ 精度不可信 → 未知；不回退旧数据、不虚报 0。
        // 新鲜度边界：采样消息创建时间早于本轮调用边界（opts.notBefore，即 job.createdAt）→
        // 属复用会话旧历史，不属于当前调用 → 标未知，不回填旧 low/high（同 job 复用同理）。
        const belongsToCall = opts?.notBefore === undefined || latestCreated >= opts.notBefore;
        const isNonNegFinite = (v: unknown): v is number =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0;
        const cache = t?.cache;
        if (belongsToCall && t && isNonNegFinite(t.input) && cache && isNonNegFinite(cache.read) && isNonNegFinite(cache.write)) {
          const sum = t.input + cache.read + cache.write;
          if (Number.isFinite(sum) && sum <= Number.MAX_SAFE_INTEGER) {
            reuseInput = {
              inputTokens: sum,
              // 可确认最新 → created 必为数值；只用消息真实创建时间，不伪造新鲜度
              sampledAt: latestCreated,
              ...(typeof info?.id === 'string' && info.id !== '' ? { messageId: info.id } : {}),
            };
          }
        }
      }

      // 捕获决策数（与 fillContextAsync 相同的提取逻辑，作用于有界 messages）
      const decisions = extractDecisions(messages, this.config.maxDecisions, this.config.relevantMessageWindow);

      // P2-1: dependencyPropagation 关闭时不写 dependencyCache（避免多余缓存污染）；
      // fillContextAsync 读取侧已有 gate，恢复后无用户可见回归。
      // 父会话隔离：仅当显式传播启用且 parentSessionId 存在（非空）时才把带 parent 的条目
      // 写入传播缓存；parent 缺失时正常捕获/返回/原有回写结果，但不进入传播缓存——
      // 绝不回退到其他 parent / 全局最近（避免跨父会话摘要串注入）。
      if (keyOutput && this.config.dependencyPropagation && opts?.parentSessionId) {
        this.dependencyCache.set(alias, {
          alias,
          agent,
          keyOutput,
          capturedAt: Date.now(),
          parentSessionId: opts.parentSessionId,
        });
      }

      return {
        output: keyOutput,
        decisions: decisions.length,
        ...(tokens ? { tokens } : {}),
        ...(reuseInput ? { reuseInput } : {}),
      };
    } catch {
      // SDK 调用失败时静默跳过
      return null;
    }
  }

  /**
   * 生成上下文标记文本，追加到 task description 末尾。
   */
  formatMarker(contextId: string): string {
    return formatContextMarker(contextId);
  }

  /**
   * 暴露合并后的 strategy 供 index.ts 使用
   */
  getStrategy(agentType: string): ContextStrategy {
    return this.config.strategy[agentType] ?? 'none';
  }

  /**
   * 清理过期的依赖缓存（超过 10 分钟的条目）。
   */
  cleanupStaleDependencies(maxAgeMs: number = 10 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, value] of this.dependencyCache) {
      if (now - value.capturedAt > maxAgeMs) {
        this.dependencyCache.delete(key);
      }
    }
  }

  /** 刷新 registry 条目的「最后读写时间」（内部使用） */
  private touch(contextId: string): void {
    if (this.registry.has(contextId)) this.registryTouchedAt.set(contextId, Date.now());
  }

  /**
   * 显式释放一个已消费完的上下文（供调用方在注入完成后主动回收）。
   * 未注册的 contextId 为无害 no-op。
   */
  releaseContext(contextId: string): void {
    this.registry.delete(contextId);
    this.registryTouchedAt.delete(contextId);
  }

  /**
   * 清理长期未被读写的 registry 条目（默认 20 分钟）。
   *
   * 背景：`registry` 的唯一删除点原本在 `consumeMarkedContext()` 内，而该方法全仓库零调用
   * （真实注入路径是 `formatContextDetails()`），于是每次委派都新增一条 TaskContext 且永不回收。
   *
   * 为何用「最后读写时间」而非 `createdAt`：TaskContext 类型上没有任何时间字段
   * （见 `context/types.ts`），故另开 `registryTouchedAt` 侧表记录；且清理**不能早于消费**——
   * 时间戳在 `fillContextAsync` 结束时刷新、并在每次 `formatContextDetails()` / `consumeMarkedContext()`
   * 读取时刷新，因此仍会被读取的条目不会因登记时间久远而被误删。
   * 阈值取 20 分钟（两倍于依赖缓存 TTL）：一次委派从登记到注入详情是秒级，
   * 20 分钟已远超任何合法读写窗口，仅回收真正的泄漏。
   *
   * @returns 被回收的条目数
   */
  cleanupStaleContexts(maxAgeMs: number = 20 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const contextId of this.registry.keys()) {
      const touchedAt = this.registryTouchedAt.get(contextId);
      if (touchedAt === undefined) {
        // 侧表缺失（异常路径）→ 视为刚登记，留给下一轮，避免误删活跃上下文
        this.registryTouchedAt.set(contextId, now);
        continue;
      }
      if (now - touchedAt > maxAgeMs) {
        this.registry.delete(contextId);
        this.registryTouchedAt.delete(contextId);
        removed++;
      }
    }
    return removed;
  }

  /** 当前 registry 条目数（诊断/测试用，只读） */
  get registrySize(): number {
    return this.registry.size;
  }
}
