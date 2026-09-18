#!/usr/bin/env node
/**
 * zcode-cohub MCP Server
 *
 * Registers co_delegate, co_council, and co_close_job tools for ZCode.
 * Internal services: TaskTracker, ContextEngine.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createDelegateTool,
  delegateHandler,
  type DelegateInput,
} from "./tools/delegate.js";
import {
  createCouncilTool,
  councilHandler,
  type CouncilInput,
} from "./tools/council.js";
import {
  createCloseJobTool,
  closeJobHandler,
  type CloseJobInput,
} from "./tools/job-control.js";
import {
  createScanTool,
  scanHandler,
  type ScanInput,
} from "./tools/scan.js";
import { TaskTracker } from "./tracker.js";
import { ContextEngine } from "./context/engine.js";
import { resolveStrategy } from "./context/strategy.js";

// --- Internal services ---
const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT || "";

const tracker = new TaskTracker(pluginRoot);
const contextEngine = new ContextEngine();

/**
 * ContextEngine 兜底清理定时器。
 *
 * 主清理路径是 delegateHandler 内的 removeContext（确定性、每次委派都执行）；
 * 此处仅兜住"注册了但未走 removeContext 收尾"的异常路径，防止 contexts 在
 * 常驻 MCP Server 中无界增长。
 *
 * ⚠️ 刻意**不**在此处调用 tracker.pruneTerminalJobs()：
 * 本进程的 tracker.jobs 是构造时从文件载入的一份快照，而真正写入任务的是
 * 独立的 hook 进程（每次 Agent 调用启新进程）。定时 persist() 会用这份
 * 陈旧快照覆盖 hook 刚落盘的任务数据，把面板清空。tracker 侧的清理改由
 * writeTrackerState()（hook 写盘路径）与 persist()（本进程写盘路径）承担。
 *
 * unref()：MCP Server 是 stdio 长进程，定时器不得阻止进程正常退出
 * （与 dsh-cohub/src/delegate.ts 的写法一致，并对非 Node 环境做存在性判断）。
 */
const CONTEXT_CLEANUP_INTERVAL_MS = 300_000;
const contextCleanupTimer = setInterval(() => {
  contextEngine.cleanupStale();
}, CONTEXT_CLEANUP_INTERVAL_MS);
if (typeof contextCleanupTimer?.unref === "function") contextCleanupTimer.unref();

// Tool definitions
const delegateDef = createDelegateTool();
const councilDef = createCouncilTool();
const closeJobDef = createCloseJobTool();
const scanDef = createScanTool();

const toolDefs = [delegateDef, councilDef, closeJobDef, scanDef];

// --- MCP Server ---

const server = new Server(
  {
    name: "zcode-cohub",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = args ?? {};

  switch (name) {
    case "co_delegate": {
      const result = await delegateHandler(input as unknown as DelegateInput, {
        tracker,
        contextEngine,
        projectDir,
        resolveStrategy,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "co_council": {
      const result = await councilHandler(input as unknown as CouncilInput, {
        tracker,
        projectDir,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "co_close_job": {
      const result = await closeJobHandler(input as unknown as CloseJobInput, { tracker });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "co_scan": {
      const result = await scanHandler(input as unknown as ScanInput, {
        projectDir,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[zcode-cohub] MCP Server started");
}

main().catch((err) => {
  console.error("[zcode-cohub] Fatal error:", err);
  process.exit(1);
});