// dsh-port/src/council.ts —— 多模型共识工具（M4）
// 移植自 OpenCode 版 src/tools/council.ts 的聚合逻辑；
// 多模型并行不再手动建 session：直接走 ctx.subagents seam + agentOptions 路由覆盖。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { contentText } from "./text-utils.ts";

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

/** "provider/model" → "model"（展示用短名） */
export function shortModelLabel(model: string): string {
  return model.split("/").pop() ?? model;
}

/** 合并用户 prompt 与 councillor 专属前缀 */
export function formatCouncillorPrompt(userPrompt: string, councillorPrompt?: string): string {
  if (!councillorPrompt) return userPrompt;
  return `${councillorPrompt}\n\n---\n\n${userPrompt}`;
}

export interface CouncillorResult {
  name: string;
  model: string;
  status: string;
  result?: string;
  error?: string;
}

/** 聚合各 councillor 结果（纯函数，移植自 cohub） */
export function formatCouncillorResults(
  originalPrompt: string,
  results: CouncillorResult[],
): string {
  const completed = results.filter(r => r.status === "completed" && r.result);
  const failed = results.filter(r => r.status !== "completed" || !r.result);

  if (completed.length === 0) {
    const errors = results
      .map(r => `**${r.name}** (${shortModelLabel(r.model)}): ${r.status} — ${r.error ?? "Unknown"}`)
      .join("\n");
    return [
      "---", "", "**Original Prompt**:", originalPrompt, "", "---", "",
      "**Councillor Responses**:",
      "All councillors failed to produce output:",
      errors, "",
      "Please generate a response based on the original prompt alone.",
    ].join("\n");
  }

  const parts: string[] = [
    "---", "", "**Original Prompt**:", originalPrompt, "", "---", "",
    "**Councillor Responses**:",
    completed.map(r => `**${r.name}** (${shortModelLabel(r.model)}):\n${r.result}`).join("\n\n"),
  ];

  if (failed.length > 0) {
    parts.push("", "---", "", "**Failed/Timed-out Councillors**:",
      failed.map(r => `**${r.name}**: ${r.status} — ${r.error ?? "Unknown"}`).join("\n"));
  }

  parts.push(
    "", "---", "",
    "You MUST follow the Synthesis Process steps before producing output: " +
      "review each councillor response individually, then produce the required output " +
      "with a synthesized Council Response, per-councillor details using their exact names, " +
      "and a Council Summary with consensus confidence rating (unanimous, majority, or split).",
  );

  return parts.join("\n");
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
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },

    isConcurrencySafe: () => true,

    async execute(args: { prompt: string }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("council_session requires a calling agent (exec.agent was undefined)");

      const councillors = config.councillors ?? [];
      if (councillors.length === 0) {
        throw new Error("council_session: no councillors configured (set councillors on the cohub row in $DSH_HOME/cordis.patch.yml)");
      }
      const provider = config.councilProvider ?? "spawn";
      const timeoutMs = config.councilTimeoutMs ?? 180_000;

      // 并行启动所有 councillor
      const starts = await Promise.allSettled(councillors.map(c =>
        ctx.subagents.start(provider, {
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
        try {
          const outcome = await Promise.race([
            run.result,
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
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
