// src/delegate_batch.ts —— 批量并行委派工具
// 在一次工具调用内部用 Promise.allSettled() 并行启动多个子代理任务，
// 每个 task 有独立的 AbortController 超时控制，超时时主动中止子代理。
// 跳过 N2 停滞检测和 P1-2 重试，保持简单可靠。
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  resolveSkillAndRoute,
  buildAgentOptions,
  budgetSubagentResult,
  resolveContractText,
  buildDelegatePrompt,
  createEnvContract,
  createEnvSig,
  resolveSkillToolFilter,
  resolveSkillAgentPreset,
  formatSkillLabel,
  formatDegradeNotes,
  DEFAULT_FALLBACK_SKILL,
  guardDelegationDepth,
  DELEGATE_PERSONA,
  DEFAULT_SPAWN_TRANSPORT,
  startSubagentRun,
  DELEGATE_OUTPUT_CONFIG,
  type SkillRouteSource,
  type DelegateConfig,
  type SkillRouteConfig,
  type DegradeNote,
} from "./delegate.ts";
import { applyResultBudget, approxTokens, resolveResultBudget, resolveSkillResultMaxChars } from "./result-budget.ts";
import type { CoHubSkill } from "./skills.ts";
import { contentText } from "./text-utils.ts";
import { WALL_CLOCK_BUDGET_MS } from "./shared/constants.ts";
import { maybeDeferTodoNudge } from "./todo-nudge.ts";

/** 单个批量委派任务 */
export interface DelegateBatchTask {
  /** 可选任务标识，用于结果映射；不提供时自动生成 task-0, task-1... */
  id?: string;
  /** 必填，专职代理技能名（必须是 co-* 代理名），如 co-fixer / co-explorer / co-oracle。
   *  漏传会被参数校验直接拒绝；万一绕过校验（旧调用 / 手写 args），运行时兜底到 co-fixer 并 warn。 */
  skill: string;
  /** 必填，给该代理的具体任务描述（自包含，写全目标、文件路径、约束） */
  prompt: string;
}

/** 规范化后的批量任务：skill 已 trim 并兜底，taskId 已生成 */
interface NormalizedBatchTask {
  task: DelegateBatchTask;
  taskId: string;
  /** 规范化后的 skill 名（空值已兜底为 DEFAULT_FALLBACK_SKILL） */
  requestedSkill: string;
  /** 是否为「未提供 skill → 兜底」的情形（决定 label 里是否带 (default:co-fixer)） */
  skillFallback: boolean;
}

/** 单个批量委派结果 */
export interface DelegateBatchResult {
  id: string;
  skill: string;
  status: "completed" | "failed" | "error";
  result?: string;
  error?: string;
  stopReason?: string;
  /** SubagentResult.diagnostic 原样透传（provider 侧失败详情） */
  diagnostic?: string;
  /** 本任务的降级提示（已 formatDegradeNotes 渲染；无降级时省略）。
   *  仅作结构化字段供程序化排查——返回文本里的降级提示统一在末尾合并输出一次，
   *  这里不再重复拼进 output，避免同一提示出现两遍。 */
  degrade?: string;
}

/** 批量委派最大任务数（硬上限，防止意外超量并行压垮系统） */
const MAX_BATCH_SIZE = 20;

/**
 * 创建 delegate_batch 工具。
 * 一次调用并行启动多个子代理任务，返回结构化结果。
 * 每个 task 有独立的 AbortController，超时时主动中止子代理。
 * 跳过 N2 停滞检测和 P1-2 重试。
 */
export function createDelegateBatchTool(
  ctx: any,
  getRoutes: SkillRouteSource,
  config: DelegateConfig = {},
  getSettings?: () => any,
) {
  const envContract = createEnvContract(config);
  const envSig = createEnvSig(config);

  function resolveRuntimeConfig() {
    const settingsNow = getSettings ? (getSettings() ?? {}) : {};
    const scheduleCfg = settingsNow.schedule ?? config.schedule;
    // maxParallelBatch：从 settings 读取（默认 3），与硬上限 MAX_BATCH_SIZE 取小值；
    // 保留 MAX_BATCH_SIZE 作为绝对安全上限（防止配置错误导致超量并行）。
    const rawMaxParallel = Math.max(1, scheduleCfg?.maxParallelBatch ?? 3);
    // P1-3（子代理结果预算）：settings 优先，config 兜底；缺省值即生效
    const budget = resolveResultBudget(settingsNow.resultBudget ?? config.resultBudget);
    // P1-1（子代理工具表裁剪）：默认开启；settings 未提供时回落 config
    const toolFilterEnabled = (settingsNow.toolFilter ?? config.toolFilter)?.enabled ?? true;
    // 子代理独立精简 preset：默认开启（settings 优先，config 兜底）
    const presetEnabled = (settingsNow.delegateSubagentPreset ?? config.delegateSubagentPreset)?.enabled ?? true;
    return {
      wallClockBudgetMs: Math.max(0, scheduleCfg?.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS),
      maxParallelBatch: Math.min(rawMaxParallel, MAX_BATCH_SIZE),
      budget,
      toolFilterEnabled,
      presetEnabled,
    };
  }

  return defineTool({
    name: "delegate_batch",
    description: "并发执行多个子代理任务：一次调用并行派发 N 个无依赖任务，返回各自结果。"
      + "每项 skill/prompt 必填，单批默认 3（上限 20），不重试。",

    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "任务列表，每项 skill/prompt 必填；上限 schedule.maxParallelBatch（默认 3，最大 20）",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "可选任务标识，用于结果映射" },
            skill: {
              type: "string",
              required: true,
              description: "必填，co-* 代理名（如 co-fixer/co-explorer/co-oracle）",
            },
            prompt: { type: "string", required: true, description: "必填，给该代理的具体任务（自包含）" },
          },
        },
      },
    },

    output: DELEGATE_OUTPUT_CONFIG,

    isConcurrencySafe: () => true,

    async execute(args: { tasks: DelegateBatchTask[] }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate_batch requires a calling agent (exec.agent was undefined)");

      // 嵌套委派守卫（与 delegate 同一判定）：子代理不可再派子代理。
      // 整批拒绝而非逐条跳过——一批全是同层子代理，跳过只会让调用方误判为「任务失败」。
      const depthRejection = guardDelegationDepth(parent, ctx.logger);
      if (depthRejection !== undefined) {
        ctx.logger?.warn?.("[cohub depth-guard] delegate_batch：" + depthRejection);
        throw new Error(depthRejection);
      }

      const { wallClockBudgetMs, maxParallelBatch, budget, toolFilterEnabled, presetEnabled } = resolveRuntimeConfig();
      const tasks = args.tasks ?? [];

      if (tasks.length === 0) {
        return "delegate_batch: 无任务";
      }

      if (tasks.length > maxParallelBatch) {
        return `delegate_batch: 任务数 ${tasks.length} 超过上限 ${maxParallelBatch}，请分批执行。`;
      }

      // 批次计时起点：统计行「总耗时」的两个时间点之一（并发的 Promise.allSettled 从这里之后启动）
      const batchStartedAt = Date.now();

      // 所有 task 共享同一份环境契约文本（只计算一次，避免重复 I/O）
      const contractText = envContract.enabled ? resolveContractText(envContract, envSig, ctx).text : "";

      // 规范化每个 task 的 skill（schema 必填之外的**第二道防线**）：
      // 旧调用（改必填之前的 args）或手写 args 仍可能漏传——绝不把 undefined 带进
      // label / preset 解析 / 结果字段，一律 trim 后兜底 co-fixer 并打一条 warn。
      const normalized: NormalizedBatchTask[] = tasks.map((task, index) => {
        const taskId = task.id ?? `task-${index}`;
        const raw = typeof task.skill === "string" ? task.skill.trim() : "";
        const skillFallback = raw.length === 0;
        if (skillFallback) {
          ctx.logger?.warn?.(
            "[cohub delegate_batch] task \"" + taskId + "\" 缺少 skill（收到 "
            + JSON.stringify(task.skill ?? null) + "），已兜底为 " + DEFAULT_FALLBACK_SKILL
            + "；schema 已要求 skill 必填，出现本告警说明调用绕过了参数校验",
          );
        }
        return { task, taskId, requestedSkill: skillFallback ? DEFAULT_FALLBACK_SKILL : raw, skillFallback };
      });

      // 并行启动所有子代理
      const starts = await Promise.allSettled(
        normalized.map(async ({ task, taskId, requestedSkill, skillFallback }) => {
          // spawn 起算时刻：单个 task 的超时预算从这里开始计（见下方 Promise.race），
          // 而不是从「逐个收集结果」的 await 时刻开始计——后者会让第 i 个 task 拿到
          // 从第 i-1 个 settle 起算的完整预算，整批最坏退化为 N × wallClockBudgetMs。
          const startedAt = Date.now();
          const { skill, route, note: skillNote } = resolveSkillAndRoute(requestedSkill, getRoutes, ctx, ctx.logger);
          // 降级原因收集槽：**每个 task 独立一个数组**（对应 delegate 的单次 execute）。
          // 若整批共用一个数组，同一 id（如 "skill"）的 note 会被后一个 task 覆盖，
          // 前面任务的降级就再也回不到返回文本里了。
          const taskNotes: DegradeNote[] = [];
          // ① skill 名未命中 / skill 缺失兜底：resolveSkillAndRoute 已把原因写进 note，
          //    这里登记一条，确保「skill 拼错」这类静默降级出现在 batch 返回文本里。
          //    （upsertDegradeNote 未导出，且每任务只登记一条，直接 push 等价。）
          if (skillNote !== undefined) {
            taskNotes.push({
              id: "skill",
              what: "skill 名未命中",
              effect: "子代理已按兜底角色 " + skill.name + " 执行",
              reason: skillNote,
            });
          }
          // label / 结果里的 skill 片段：兜底时显式标 (default:co-fixer)，绝不出现 ":undefined"
          const skillTag = formatSkillLabel(skill, skillFallback);
          const promptText = buildDelegatePrompt({
            skill,
            contractText,
            userPrompt: task.prompt,
          });
          const agentOptions = await buildAgentOptions(route, ctx, skill.name);
          // P1-1：按角色裁剪子代理工具表（deny 减法；构造失败已 fail-soft 成全量工具）
          const toolFilter = resolveSkillToolFilter(skill.name, toolFilterEnabled, ctx.logger);
          // 子代理独立精简 preset：每个 task 按各自的 skill 解析（undefined = 继承父 preset）
          const agentPreset = resolveSkillAgentPreset(skill.name, presetEnabled);

          // 每个 task 独立的 AbortController
          const ac = new AbortController();
          let onExecAbort: (() => void) | null = null;

          if (exec.signal) {
            if (exec.signal.aborted) {
              ac.abort();
            } else {
              onExecAbort = () => { if (!ac.signal.aborted) ac.abort(); };
              exec.signal.addEventListener("abort", onExecAbort, { once: true });
            }
          }

          try {
            const run = await startSubagentRun(ctx, DEFAULT_SPAWN_TRANSPORT, {
              label: `delegate_batch:${taskId}:${skillTag}`,
              prompt: [{ type: "text", text: promptText }],
              parent,
              persona: DELEGATE_PERSONA,
              // P1-1：工具表裁剪（undefined 时不透传，等价于全量工具）
              ...(toolFilter !== undefined ? { toolFilter } : {}),
              // 子代理独立精简 preset（undefined 时不透传 = 继承父 preset）
              ...(agentPreset !== undefined ? { agentPreset } : {}),
              ...(agentOptions ? { agentOptions } : {}),
              signal: ac.signal,
              // 降级原因收集槽：preset / toolFilter 的 fail-soft 会往这里登记原因，
              // 少了这一行，batch 路径的 preset/toolFilter 降级就只剩 warn（等同静默）。
              degradeNotes: taskNotes,
            });
            return { taskId, skillName: skill.name, skillTag, task, taskNotes, run, ac, onExecAbort, startedAt, startError: undefined };
          } catch (startError) {
            // start 失败：清理 onExecAbort 监听器，返回带错误标记的对象
            if (onExecAbort && exec.signal) {
              try { exec.signal.removeEventListener("abort", onExecAbort); } catch { /* 可能已释放 */ }
            }
            return { taskId, skillName: skill.name, skillTag, task, taskNotes, run: undefined, ac, onExecAbort: null, startedAt, startError };
          }
        }),
      );

      // 收集结果（最外层 try-finally 确保所有 runs 被清理）
      const results: DelegateBatchResult[] = [];
      const runs: Array<{ run: any; ac: AbortController; onExecAbort: (() => void) | null; taskId: string; skillName: string; skillTag: string; taskNotes: DegradeNote[]; startedAt: number }> = [];
      // 每任务的降级原因（按 starts 顺序），供末尾统一合并成一段提示
      const perTaskNotes: Array<{ taskId: string; notes: DegradeNote[] }> = [];
      // 结果对象上的 degrade 字段：渲染后逐字 trim（末尾合并提示另走 formatDegradeNotes 原样前缀）
      const degradeField = (notes: DegradeNote[]): { degrade?: string } => {
        const text = formatDegradeNotes(notes).trim();
        return text.length > 0 ? { degrade: text } : {};
      };

      try {
        for (const s of starts) {
          if (s.status === "rejected") {
            // 理论上不会到这里（内部 catch 已处理），防御性跳过
            continue;
          }
          const val = s.value as any;
          if (val.startError) {
            // start 失败：记录失败结果，不加入 runs 列表（没有 run 对象）
            perTaskNotes.push({ taskId: val.taskId, notes: val.taskNotes ?? [] });
            results.push({
              id: val.taskId,
              skill: val.skillTag,
              status: "error",
              error: val.startError instanceof Error ? val.startError.message : String(val.startError),
              ...degradeField(val.taskNotes ?? []),
            });
            continue;
          }
          const { run, taskId, skillName, skillTag, taskNotes, ac, onExecAbort, startedAt } = val;
          runs.push({ run, taskId, skillName, skillTag, taskNotes, ac, onExecAbort, startedAt });
          perTaskNotes.push({ taskId, notes: taskNotes });

          // 防 unhandledRejection
          run.result.catch(() => {});
        }

        // 逐个 await run.result（带独立超时和独立 AbortController）
        for (const { run, taskId, skillName, skillTag, taskNotes, ac, startedAt } of runs) {
          let outcome: any;
          let timer: ReturnType<typeof setTimeout> | null = null;

          // 超时预算以 spawn 时刻为起点：扣除该 task 已耗时（含 start 前的 route/agentOptions 解析
          // 与前面 task 的等待）。若已耗尽则立即走超时分支（delay=0）。
          // 错误文本保持原样（仍是完整预算值），避免改变调用方可见语义。
          const remainingMs = Math.max(0, wallClockBudgetMs - (Date.now() - startedAt));

          try {
            outcome = await Promise.race([
              run.result,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  // 超时时主动 abort 子代理
                  if (!ac.signal.aborted) ac.abort();
                  reject(new Error(`超时：${wallClockBudgetMs}ms`));
                }, remainingMs);
                // 如果 exec.signal 先触发，清理 timer
                if (exec.signal && !exec.signal.aborted) {
                  exec.signal.addEventListener("abort", () => { if (timer) clearTimeout(timer); }, { once: true });
                }
              }),
            ]);

            if (outcome?.stopReason === "completed") {
              // P1-3：每个任务结果先各自预算裁剪（超预算时落盘定位），之后才参与总串拼接
              // 改动 3 同款：按 skill 分档取更小上限（co-planner 1500 字符；契约段仍优先保留）
              const resultText = await budgetSubagentResult(ctx, exec, contentText(outcome.output), {
                maxChars: Math.min(budget.batchTaskMaxChars, resolveSkillResultMaxChars(budget, skillName)),
                scope: "batch:task",
                label: taskId + ":" + skillTag,
                enabled: budget.enabled,
                toolName: "delegate_batch",
              });
              results.push({
                id: taskId,
                skill: skillTag,
                status: "completed",
                result: resultText,
                ...degradeField(taskNotes),
              });
            } else {
              const diag = typeof outcome?.diagnostic === "string" ? outcome.diagnostic : undefined;
              results.push({
                id: taskId,
                skill: skillTag,
                status: "failed",
                error: `stopReason: ${outcome?.stopReason ?? "unknown"}`
                  + (diag === undefined ? "" : `; diagnostic: ${diag}`),
                stopReason: outcome?.stopReason,
                ...(diag === undefined ? {} : { diagnostic: diag }),
                ...degradeField(taskNotes),
              });
            }
          } catch (e) {
            results.push({
              id: taskId,
              skill: skillTag,
              status: "error",
              error: e instanceof Error ? e.message : String(e),
              ...degradeField(taskNotes),
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      } finally {
        // 统一清理所有 runs
        for (const { run, ac, onExecAbort } of runs) {
          if (onExecAbort && exec.signal) {
            try { exec.signal.removeEventListener("abort", onExecAbort); } catch { /* 可能已释放 */ }
          }
          if (!ac.signal.aborted) ac.abort();
          try { run.dispose(); } catch { /* 已释放 */ }
        }
      }

      // 批次计时终点：所有 task 均已 settle（成功/失败/超时/启动失败）后的时间点
      const batchElapsedMs = Date.now() - batchStartedAt;

      // 格式化输出
      const completed = results.filter(r => r.status === "completed");
      const failed = results.filter(r => r.status !== "completed");

      // 统计行：自报并行度与总耗时，让「到底并行没并行」当场可见。
      // **独立前置、不参与 result-budget 裁剪**：下方 output 才进 applyResultBudget，
      // 本行在裁剪完成后才拼到最终返回值最前面，因此任何裁剪路径都切不到它。
      const statsLine = `并发 ${tasks.length} 个子代理 · ${completed.length}/${tasks.length} 完成 · 总耗时 ${(batchElapsedMs / 1000).toFixed(1)}s\n\n`;

      let output = "--- delegate_batch 结果 ---\n";
      output += `总计: ${results.length} 个任务 | 完成: ${completed.length} | 失败: ${failed.length}\n\n`;

      if (completed.length > 0) {
        output += "## 已完成任务\n\n";
        for (const r of completed) {
          output += `### ${r.id} (${r.skill})\n${r.result}\n\n`;
        }
      }

      if (failed.length > 0) {
        output += "## 失败/错误任务\n\n";
        for (const r of failed) {
          output += `### ${r.id} (${r.skill})\n`;
          output += `状态: ${r.status}\n`;
          if (r.error) output += `错误: ${r.error}\n`;
          if (r.stopReason) output += `stopReason: ${r.stopReason}\n`;
          if (r.diagnostic) output += `diagnostic: ${r.diagnostic}\n`;
          output += "\n";
        }
      }

      // P1-3：拼装后对总串再做一次总体预算（**不落盘**——各任务全文已各自落盘，
      // 重复写盘只产生无用副本）；失败任务保持上面的简短格式，不参与长文本回传。
      if (budget.enabled && output.length > budget.batchTotalMaxChars) {
        const fullChars = output.length;
        output = applyResultBudget(output, {
          maxChars: budget.batchTotalMaxChars,
          scope: "batch:total",
          label: "total",
          locatorFallback: "见各任务 locator",
        }).text;
        ctx?.logger?.warn?.(
          "[cohub budget] batch:total：拼装结果 " + fullChars + " 字符 ≈ " + approxTokens(fullChars)
          + " tokens 超过总预算 " + budget.batchTotalMaxChars
          + " 字符，已裁剪；各任务全文见各自的 locator。仅告警，不阻断。",
        );
      }

      // 批量结果已成型 → 注入「立刻 todo_write 回写」提醒（fail-soft，宿主不支持就静默跳过）
      maybeDeferTodoNudge(exec);

      // 降级提示合并：**逐任务**渲染（每任务独立 notes，不会互相覆盖），并在每个
      // what 前带 taskId，让「哪个任务降级了」在返回文本里可见。
      // 关键：本段拼在 statsLine + output **之后**，即 applyResultBudget 已裁剪完毕——
      // 因此 batchTotalMaxChars 再小也切不到它（若放进 output 内会被从尾部裁掉，
      // 等于把本次修复的静默降级缺陷原样搬到小预算场景）。
      // formatDegradeNotes 无降级时返回空串，故正常路径的返回文本逐字不变。
      const allNotes: DegradeNote[] = [];
      for (const { taskId, notes } of perTaskNotes) {
        for (const note of notes) {
          allNotes.push({ id: note.id, what: taskId + " " + note.what, effect: note.effect, reason: note.reason });
        }
      }

      return statsLine + output + formatDegradeNotes(allNotes);
    },
  });
}