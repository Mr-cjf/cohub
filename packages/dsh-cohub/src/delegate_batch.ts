// src/delegate_batch.ts —— 批量并行委派工具
// 在一次工具调用内部用 Promise.allSettled() 并行启动多个子代理任务，
// 每个 task 有独立的 AbortController 超时控制，超时时主动中止子代理。
// 跳过 N2 停滞检测和 P1-2 重试，保持简单可靠。
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  resolveSkillAndRoute,
  buildAgentOptions,
  resolveContractText,
  buildDelegatePrompt,
  createEnvContract,
  createEnvSig,
  DELEGATE_PERSONA,
  DEFAULT_SPAWN_TRANSPORT,
  DELEGATE_OUTPUT_CONFIG,
  type SkillRouteSource,
  type DelegateConfig,
  type SkillRouteConfig,
} from "./delegate.ts";
import type { CoHubSkill } from "./skills.ts";
import { contentText } from "./text-utils.ts";
import { WALL_CLOCK_BUDGET_MS } from "./shared/constants.ts";

/** 单个批量委派任务 */
export interface DelegateBatchTask {
  /** 可选任务标识，用于结果映射；不提供时自动生成 task-0, task-1... */
  id?: string;
  /** 必填，专职代理技能名，如 co-fixer / co-explorer / co-oracle */
  skill: string;
  /** 必填，给该代理的具体任务描述（自包含，写全目标、文件路径、约束） */
  prompt: string;
}

/** 单个批量委派结果 */
export interface DelegateBatchResult {
  id: string;
  skill: string;
  status: "completed" | "failed" | "error";
  result?: string;
  error?: string;
  stopReason?: string;
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
    return {
      wallClockBudgetMs: Math.max(0, scheduleCfg?.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS),
      maxParallelBatch: Math.min(rawMaxParallel, MAX_BATCH_SIZE),
    };
  }

  return defineTool({
    name: "delegate_batch",
    description: "批量并行委派：一次调用同时启动多个子代理任务，返回每个任务的结构化结果。适合并行派发多个无依赖的独立任务（如同时让多个 co-explorer 探索不同目录，或多个 co-fixer 修改不同文件）。每个 task 只尝试一次，不重试。上限由 `schedule.maxParallelBatch` 配置（默认 3，最大 20）。",

    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "任务列表，每个任务包含 id（可选，用于结果映射）、skill（代理名）、prompt（具体任务描述）。上限由 schedule.maxParallelBatch 限制（默认 3，最大 20）。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "可选任务标识，用于结果映射" },
            skill: { type: "string", description: "必填，专职代理技能名，如 co-fixer / co-explorer / co-oracle" },
            prompt: { type: "string", description: "必填，给该代理的具体任务描述" },
          },
        },
      },
    },

    output: DELEGATE_OUTPUT_CONFIG,

    isConcurrencySafe: () => true,

    async execute(args: { tasks: DelegateBatchTask[] }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate_batch requires a calling agent (exec.agent was undefined)");

      const { wallClockBudgetMs, maxParallelBatch } = resolveRuntimeConfig();
      const tasks = args.tasks ?? [];

      if (tasks.length === 0) {
        return "delegate_batch: 无任务";
      }

      if (tasks.length > maxParallelBatch) {
        return `delegate_batch: 任务数 ${tasks.length} 超过上限 ${maxParallelBatch}，请分批执行。`;
      }

      // 所有 task 共享同一份环境契约文本（只计算一次，避免重复 I/O）
      const contractText = envContract.enabled ? resolveContractText(envContract, envSig, ctx).text : "";

      // 并行启动所有子代理
      const starts = await Promise.allSettled(
        tasks.map(async (task, index) => {
          // spawn 起算时刻：单个 task 的超时预算从这里开始计（见下方 Promise.race），
          // 而不是从「逐个收集结果」的 await 时刻开始计——后者会让第 i 个 task 拿到
          // 从第 i-1 个 settle 起算的完整预算，整批最坏退化为 N × wallClockBudgetMs。
          const startedAt = Date.now();
          const taskId = task.id ?? `task-${index}`;
          const { skill, route } = resolveSkillAndRoute(task.skill, getRoutes, ctx, ctx.logger);
          const promptText = buildDelegatePrompt({
            skill,
            contractText,
            userPrompt: task.prompt,
          });
          const agentOptions = await buildAgentOptions(route, ctx);

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
            const run = await ctx.subagents.start(DEFAULT_SPAWN_TRANSPORT, {
              label: `delegate_batch:${taskId}:${task.skill}`,
              prompt: [{ type: "text", text: promptText }],
              parent,
              persona: DELEGATE_PERSONA,
              ...(agentOptions ? { agentOptions } : {}),
              signal: ac.signal,
            });
            return { taskId, task, run, ac, onExecAbort, startedAt, startError: undefined };
          } catch (startError) {
            // start 失败：清理 onExecAbort 监听器，返回带错误标记的对象
            if (onExecAbort && exec.signal) {
              try { exec.signal.removeEventListener("abort", onExecAbort); } catch { /* 可能已释放 */ }
            }
            return { taskId, task, run: undefined, ac, onExecAbort: null, startedAt, startError };
          }
        }),
      );

      // 收集结果（最外层 try-finally 确保所有 runs 被清理）
      const results: DelegateBatchResult[] = [];
      const runs: Array<{ run: any; ac: AbortController; onExecAbort: (() => void) | null; taskId: string; task: DelegateBatchTask; startedAt: number }> = [];

      try {
        for (const s of starts) {
          if (s.status === "rejected") {
            // 理论上不会到这里（内部 catch 已处理），防御性跳过
            continue;
          }
          const val = s.value as any;
          if (val.startError) {
            // start 失败：记录失败结果，不加入 runs 列表（没有 run 对象）
            results.push({
              id: val.taskId,
              skill: val.task.skill,
              status: "error",
              error: val.startError instanceof Error ? val.startError.message : String(val.startError),
            });
            continue;
          }
          const { run, taskId, task, ac, onExecAbort, startedAt } = val;
          runs.push({ run, taskId, task, ac, onExecAbort, startedAt });

          // 防 unhandledRejection
          run.result.catch(() => {});
        }

        // 逐个 await run.result（带独立超时和独立 AbortController）
        for (const { run, taskId, task, ac, onExecAbort, startedAt } of runs) {
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
              results.push({
                id: taskId,
                skill: task.skill,
                status: "completed",
                result: contentText(outcome.output),
              });
            } else {
              results.push({
                id: taskId,
                skill: task.skill,
                status: "failed",
                error: `stopReason: ${outcome?.stopReason ?? "unknown"}`,
                stopReason: outcome?.stopReason,
              });
            }
          } catch (e) {
            results.push({
              id: taskId,
              skill: task.skill,
              status: "error",
              error: e instanceof Error ? e.message : String(e),
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

      // 格式化输出
      const completed = results.filter(r => r.status === "completed");
      const failed = results.filter(r => r.status !== "completed");

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
          output += "\n";
        }
      }

      return output;
    },
  });
}