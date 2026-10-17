#!/usr/bin/env node
/**
 * CoHub council_session MCP 服务器（零依赖，仅用 Node 内置模块与全局 fetch）。
 *
 * 提供工具：
 *  - council_session(prompt, preset?, context?)
 *      并行咨询多位 councillor（不同模型），再用可选的 chair 模型综合成共识。
 *  - council_presets()
 *      列出当前配置中可用的预设与 councillor。
 *
 * 配置读取顺序：
 *  1. $COHUB_CONFIG 指向的 JSON 文件
 *  2. ~/.codex/oh-my-codex-cohub/config.json
 *  3. ~/.config/oh-my-codex-cohub/config.json（兼容旧配置）
 * 配置示例见 config/cohub.example.json。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const SERVER_NAME = "cohub-council";
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PROTOCOL_VERSION = "2024-11-05";

const VARIANT_TEMPERATURE = { max: 0.2, high: 0.4, medium: 0.6, low: 0.8 };

/* ---------------- 配置 ---------------- */

function configCandidates() {
  const paths = [];
  if (process.env.COHUB_CONFIG) paths.push(process.env.COHUB_CONFIG);
  paths.push(join(homedir(), ".codex", "oh-my-codex-cohub", "config.json"));
  paths.push(join(homedir(), ".config", "oh-my-codex-cohub", "config.json"));
  return paths;
}

function loadConfig() {
  for (const path of configCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

function resolveCouncillor(cfg, entry) {
  if (!entry || typeof entry !== "object") return null;
  const provider = entry.provider ? cfg?.council?.providers?.[entry.provider] : null;
  const merged = { ...(provider || {}), ...entry };
  const apiKeyEnvName = merged.api_key_env || "COHUB_API_KEY";
  const apiKey = (apiKeyEnvName && process.env[apiKeyEnvName]) || process.env.COHUB_API_KEY || "";
  const variant = merged.variant || "medium";
  return {
    baseUrl: merged.base_url || "",
    model: merged.model || "",
    apiKey,
    apiKeyEnvName,
    temperature: typeof merged.temperature === "number" ? merged.temperature : (VARIANT_TEMPERATURE[variant] ?? 0.6),
    timeoutMs: typeof merged.timeout_ms === "number" ? merged.timeout_ms : (cfg?.council?.timeout_ms ?? 180000),
    retries: typeof merged.retries === "number" ? merged.retries : (cfg?.council?.retries ?? 3),
  };
}

/* ---------------- LLM 调用 ---------------- */

async function chatCompletion(councillor, messages, signal) {
  const base = String(councillor.baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${councillor.apiKey}`,
    },
    body: JSON.stringify({
      model: councillor.model,
      messages,
      temperature: councillor.temperature,
    }),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

async function callWithRetry(councillor, messages) {
  let lastError = null;
  for (let attempt = 0; attempt <= councillor.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), councillor.timeoutMs);
    try {
      const text = await chatCompletion(councillor, messages, controller.signal);
      if (text) return { ok: true, text };
      lastError = new Error("空响应");
    } catch (err) {
      lastError = err;
      if (err.name === "AbortError") break; // 超时不重试
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: String(lastError?.message || lastError).slice(0, 500) };
}

async function runCouncillor(cfg, label, entry, prompt) {
  const resolved = resolveCouncillor(cfg, entry);
  if (!resolved) return { name: label, status: "error", error: "councillor 配置无效" };
  if (!resolved.baseUrl) return { name: label, status: "skipped", error: "缺少 base_url" };
  if (!resolved.model) return { name: label, status: "skipped", error: "缺少 model" };
  if (!resolved.apiKey) {
    return { name: label, status: "skipped", error: `缺少 API Key（请设置环境变量 ${resolved.apiKeyEnvName}）` };
  }
  const result = await callWithRetry(resolved, [{ role: "user", content: prompt }]);
  return result.ok
    ? { name: label, model: resolved.model, status: "ok", response: result.text }
    : { name: label, model: resolved.model, status: "error", error: result.error };
}

async function runChair(cfg, prompt, results) {
  const chair = cfg?.council?.chair;
  if (!chair) return null;
  const resolved = resolveCouncillor(cfg, { ...chair, label: "chair" });
  if (!resolved.baseUrl || !resolved.model) return { status: "skipped", error: "chair 配置不完整" };
  if (!resolved.apiKey) return { status: "skipped", error: `chair 缺少 API Key（请设置 ${resolved.apiKeyEnvName}）` };
  const transcript = results
    .map((r) => r.status === "ok" ? `### ${r.name}\n${r.response}` : `### ${r.name}\n（未取得回复：${r.error || r.status}）`)
    .join("\n\n");
  const messages = [
    {
      role: "system",
      content: "你是 CoHub 共识主席。请综合以下多位模型专家的观点，严格输出三部分：1) 共识点 2) 分歧点 3) 推荐结论。始终使用中文。",
    },
    { role: "user", content: `原始问题：\n${prompt}\n\n各位专家观点：\n${transcript}` },
  ];
  const result = await callWithRetry(resolved, messages);
  return result.ok
    ? { status: "ok", response: result.text }
    : { status: "error", error: result.error };
}

/* ---------------- 工具实现 ---------------- */

function formatPresets() {
  const cfg = loadConfig();
  const council = cfg?.council;
  if (!council?.presets) return "未配置 council.presets（请参考 config/cohub.example.json 创建配置文件）。";
  const lines = [`默认预设：${council.default_preset || "default"}`];
  for (const [name, preset] of Object.entries(council.presets)) {
    const parts = Object.entries(preset || {}).map(([label, e]) => `${label}=${e?.model || e?.provider || "?"}`);
    lines.push(`- ${name}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

async function runCouncilSession(args) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return "错误：缺少 prompt 参数。";
  const cfg = loadConfig();
  if (!cfg?.council) {
    return "未找到 CoHub 配置。请创建 $COHUB_CONFIG 或 ~/.codex/oh-my-codex-cohub/config.json，参考 config/cohub.example.json 配置 council.presets 与 providers。";
  }
  const council = cfg.council;
  const presets = council.presets || {};
  const presetName = args.preset || council.default_preset || "default";
  const preset = presets[presetName];
  if (!preset) {
    return `未知预设 "${presetName}"。可用预设：${Object.keys(presets).join(", ") || "（无）"}。`;
  }
  const fullPrompt = args.context ? `${String(args.context).trim()}\n\n${prompt}` : prompt;
  const resultMode = args.result_mode === "summary" ? "summary" : "full";
  const entries = Object.entries(preset);
  const mode = council.execution_mode === "serial" ? "serial" : "parallel";
  let results;
  if (mode === "serial") {
    results = [];
    for (const [label, entry] of entries) results.push(await runCouncillor(cfg, label, entry, fullPrompt));
  } else {
    results = await Promise.all(entries.map(([label, entry]) => runCouncillor(cfg, label, entry, fullPrompt)));
  }
  // chair 始终基于完整成员结果综合，result_mode 只影响最终回传视图，不先截成员再送 chair
  const chairResult = await runChair(cfg, fullPrompt, results);
  // summary 仅当 chair 成功且有非空白可用综合时才允许省略成员正文；
  // 否则显式回退 full 视图，完整返回所有成员观点与主席错误/skip 信息，避免新观点损失。
  const summaryRequested = resultMode === "summary";
  const chairUsable = !!chairResult && chairResult.status === "ok"
    && typeof chairResult.response === "string" && chairResult.response.trim().length > 0;
  const fallbackReason = summaryRequested && !chairUsable
    ? !chairResult
      ? "未配置 chair 模型"
      : chairResult.status === "skipped"
        ? chairResult.error || "chair 配置不完整或缺少凭据"
        : chairResult.status === "ok"
          ? "chair 返回空白综合"
          : `chair 调用失败：${chairResult.error || "未知错误"}`
    : null;
  const effectiveMode = fallbackReason ? "full" : resultMode;
  const lines = [`# Council 共识分析（预设：${presetName}，模式：${mode}${effectiveMode === "summary" ? "，视图：summary" : ""}）`];
  if (fallbackReason) {
    lines.push(`\n> 注意：请求视图为 summary，但 ${fallbackReason}，无法提供可用综合；已回退为 full 视图，完整返回所有成员观点与主席信息。`);
  }
  for (const r of results) {
    if (r.status === "ok") {
      if (effectiveMode === "summary") {
        // summary 视图：省略成员长篇正文，但保留名称、模型、状态、原始长度与省略标记等可核验元信息
        lines.push(`\n## ${r.name}（模型：${r.model || "未知模型"}）`);
        lines.push("- 状态：成功");
        lines.push(`- 原始长度：${r.response.length} 字符`);
        lines.push('- 正文：已省略（如需全文请以 result_mode="full" 重新请求）');
      } else {
        lines.push(`\n## ${r.name}（${r.model || "未知模型"}）\n${r.response}`);
      }
    } else {
      // 失败或跳过完整保留错误信息，不省略、不把失败标记为成功
      lines.push(`\n## ${r.name}（未取得回复）\n${r.error || r.status}`);
    }
  }
  if (chairResult) {
    if (chairResult.status === "ok") lines.push(`\n## 共识主席综合\n${chairResult.response}`);
    else lines.push(`\n## 共识主席（未取得回复）\n${chairResult.error || chairResult.status}`);
  } else {
    lines.push("\n> 未配置 chair 模型，请由主代理综合以上观点形成共识。");
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "council_session",
    description: "并行调用多个配置好的模型（councillors）就同一问题进行多模型共识分析，并用可选的 chair 模型综合成共识。需要先在配置文件中配置 council.presets 与 providers。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "需要共识分析的问题或任务描述" },
        preset: { type: "string", description: "预设名称（默认取 council.default_preset）" },
        context: { type: "string", description: "可选的附加上下文（代码、方案、文档等）" },
        result_mode: {
          type: "string",
          description: "回传视图：summary 省略各成员正文但完整保留 chair 综合与全部错误（推荐，节省上下文）；full 保留各成员与 chair 全部正文。省略时保持旧行为，默认 full。",
          enum: ["summary", "full"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "council_presets",
    description: "列出当前配置中可用的 council 预设及其 councillor 模型。",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ---------------- MCP 协议 ---------------- */

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "ping") {
    respond(msg.id, {});
    return;
  }
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: VERSION },
    });
    return;
  }
  if (msg.method === "tools/list") {
    respond(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === "tools/call") {
    try {
      const params = msg.params || {};
      const name = params.name;
      const args = params.arguments || {};
      let result;
      if (name === "council_presets") {
        result = { content: [{ type: "text", text: formatPresets() }], isError: false };
      } else if (name === "council_session") {
        if (args.result_mode !== undefined && args.result_mode !== "summary" && args.result_mode !== "full") {
          // 枚举参数非法：与现有 server 请求错误结构一致（content + isError: true）
          result = {
            content: [{ type: "text", text: `无效 result_mode "${String(args.result_mode)}"：仅支持 "summary" 与 "full"。` }],
            isError: true,
          };
        } else {
          result = { content: [{ type: "text", text: await runCouncilSession(args) }], isError: false };
        }
      } else {
        result = { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
      }
      respond(msg.id, result);
    } catch (err) {
      respond(msg.id, {
        content: [{ type: "text", text: String(err?.message || err) }],
        isError: true,
      });
    }
    return;
  }
  respondError(msg.id, -32601, `未知方法：${msg.method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(() => handleLine(line)).catch(() => {});
});
