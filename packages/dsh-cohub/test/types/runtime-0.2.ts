// dsh-port/test/types/runtime-0.2.ts —— DSH 0.2 公共边界类型 fixture（strict/noEmit 编译检查）
// 用法：npm run typecheck:0.2（bunx tsc --noEmit -p test/tsconfig.runtime-0.2.json）
//
// 只检查「公共边界」：插件 Config 的 volatile 字段类型 + 实际用到的 DSH 0.2 导出。
// 不作为全仓类型审计（src 内部实现保持既有宽松风格）；验证依赖真实 0.2 包类型
// （peer/dev 已升 0.2.0-rc.2，lock 解析后 node_modules 即 0.2 类型）。
import type { Volatile } from "@deepseek-ai/cosmokit";
import type {
  SettingsConflictError,
  SettingsDescriptor,
  SettingsDescribeOptions,
  SettingsForms,
  SettingsNamespace,
  SettingsPathOp,
} from "@deepseek-ai/dsh-settings";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { defineTool, validateArgs } from "@deepseek-ai/dsh-tools";
import { Config, ScheduleConfig, inject, name } from "../../src/index.ts";

// ── 0.2 设置服务形态（dsh-settings 0.2 契约）──
// 0.2 起 installSettingsSection / settingsNamespace 已删除；导出面以 SettingsForms 为主，
// 设置页按活动 profile entry id 投影 Config 的 volatile 字段（volatileForm）。
const _ns: SettingsNamespace = "cohub" as SettingsNamespace;
const _desc: SettingsDescriptor = null as unknown as SettingsDescriptor;
const _opts: SettingsDescribeOptions = { redactSecrets: true };
const _op: SettingsPathOp = { op: "set", path: ["schedule", "maxParallelBatch"], value: 5 };
const _err: SettingsConflictError = null as unknown as SettingsConflictError;
const _forms: typeof SettingsForms = null as unknown as typeof SettingsForms;

// ── 插件 Config：skills / schedule / delegateRetry 必须是 Volatile<T>，get() 取快照 ──
type ParsedConfig = ReturnType<typeof Config>;
declare const parsed: ParsedConfig;
const _skills: Volatile<unknown> = parsed.skills;
const _schedule: Volatile<{ maxParallelBatch: number; wallClockBudgetMs: number }> = parsed.schedule;
const _delegateRetry: Volatile<{ maxRetries: number }> = parsed.delegateRetry;
const _snapshot: unknown = parsed.skills.get();
const _snapSchedule = parsed.schedule.get();
const _batch: number = _snapSchedule.maxParallelBatch;
// 普通字段仍是值（非 volatile）：councillors / installPresets 等
const _councillors: unknown[] = parsed.councillors;
const _installPresets: boolean = parsed.installPresets;

// ── 公共导出形态（组合行 + 兼容导出）──
const _name: string = name;
const _inject: string[] = inject;
const _sched: typeof ScheduleConfig = null as unknown as typeof ScheduleConfig;

// ── 实际用到 DSH 0.2 导出：dsh-tools defineTool / validateArgs（delegate 工具走真实实现）──
const _toolApi: typeof defineTool = defineTool;
const _validate: typeof validateArgs = validateArgs;
const _def: ToolDefinition = null as unknown as ToolDefinition;

// 防未使用告警（noUnusedLocals 已关，这里仅作显式出口）
export type {
  ParsedConfig,
  SettingsNamespace,
  SettingsDescriptor,
  SettingsDescribeOptions,
  SettingsPathOp,
  SettingsConflictError,
  SettingsForms,
};
