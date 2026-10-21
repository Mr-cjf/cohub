// dsh-port/src/council.ts —— 多模型共识工具（M4）
// 移植自 OpenCode 版 src/tools/council.ts 的聚合逻辑；
// 多模型并行不再手动建 session：直接走 ctx.subagents seam + agentOptions 路由覆盖。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { contentText } from "./text-utils.ts";
import { DEFAULT_SPAWN_TRANSPORT, startSubagentRun } from "./delegate.ts";
import { shortModelLabel } from "./shared/model.ts";
import { COUNCIL_TIMEOUT_MS } from "./shared/constants.ts";
import {
  type CouncillorResult,
  formatCouncillorPrompt,
  formatCouncillorResults,
} from "./shared/consensus.ts";
export { shortModelLabel };
export {
  type CouncillorResult,
  formatCouncillorPrompt,
  formatCouncillorResults,
} from "./shared/consensus.ts";

/** 单个 councillor 配置（来自 cordis.patch.yml 的 cohub 行 config） */
export interface CouncillorConfig {
  name: string;
  provider: string;
  model: string;
  prompt?: string;
}

/** council 工具运行时配置 */
export interface CouncilRuntimeConfig {
  councillors: CouncillorConfig[];
  councilTimeoutMs: number;
  councilProvider: string;
}

/**
 * 创建 council_session 工具。
 * 并行调用 ctx.subagents.start()，每个 councillor 通过 agentOptions 路由到自己的 provider/model；
 * 结果聚合为结构化文本返回给调用代理（co-council）综合。
 */
export function createCouncilTool(config: CouncilRuntimeConfig, ctx: any) {
  return defineTool({
    name: "council_session",
    description: "启动多模型共识会议：把同一 prompt 并行发送给所有 councillor 模型，返回带综合流程指引的格式化回复，供你逐一审查并综合。",

    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "发送给所有 councillor 的提示。",
      },
    },

    output: {
      schema: { type: "string" as const },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
    },

    isConcurrencySafe: () => true,

    async execute(args: { prompt: string }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("council_session requires a calling agent (exec.agent was undefined)");

      const councillors = config.councillors ?? [];
      if (councillors.length === 0) {
        throw new Error("council_session: no councillors configured (set councillors on the cohub row in $DSH_HOME/cordis.patch.yml)");
      }
      const provider = config.councilProvider ?? DEFAULT_SPAWN_TRANSPORT;
      const timeoutMs = config.councilTimeoutMs ?? COUNCIL_TIMEOUT_MS;

      // 并行启动所有 councillor
      const starts = await Promise.allSettled(councillors.map(c =>
        startSubagentRun(ctx, provider, {
          label: `council:${c.name}`,
          prompt: [{ type: "text", text: formatCouncillorPrompt(String(args.prompt), c.prompt) }],
          parent,
          agentOptions: { provider: c.provider, model: c.model },
          signal: exec.signal,
        }),
      ));

      const results: CouncillorResult[] = [];
      for (let i = 0; i < councillors.length; i++) {
        const c = councillors[i];
        const s = starts[i];
        if (s.status === "rejected") {
          results.push({
            name: c.name, model: c.model, status: "failed",
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          });
          continue;
        }
        const run = s.value;
        run.result.catch(() => {}); // dispose 后的拒绝不产生 unhandledRejection
        // 超时定时器必须显式清理：race 输掉的那个分支不会被取消，若 councillor 正常早返回，
        // 定时器会一直挂在事件循环上直到超时才 fire（缺省 180s），把宿主执行单元多钉住最多
        // 180 秒。这里用 finally 保证「谁先返回」都会清理（正常返回 / 超时 / 抛错三条路径）。
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            run.result,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);
          results.push({
            name: c.name,
            model: c.model,
            status: outcome.stopReason === "completed" ? "completed" : outcome.stopReason,
            result: contentText(outcome.output) || undefined,
          });
        } catch (e) {
          results.push({
            name: c.name, model: c.model, status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          try { run.dispose(); } catch { /* 已释放 */ }
        }
      }

      const text = formatCouncillorResults(String(args.prompt), results);
      const completedCount = results.filter(r => r.status === "completed").length;
      const composition = results.map(r => `${r.name}: ${shortModelLabel(r.model)}`).join(", ");
      return `${text}\n\n---\n*Council: ${completedCount}/${results.length} councillors responded (${composition})*`;
    },
  });
}
