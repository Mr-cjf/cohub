// dsh-port/src/index.ts
// CoHub DSH 插件行：中文指令注入 + 13 技能（12 专职代理 + orchestrator）+（M4）多模型共识工具
// + 内置 agent preset（co-orchestrator）自动安装到用户 preset root。
//
// 插件行导出约定（cordis 组合行）：
//   name    —— 插件名（重复检测 / 注入元数据）
//   inject  —— 依赖的服务 seam（systemPrompt / skills / tools）
//   Config  —— schemastery 运行时配置 schema（cordis.patch.yml 的 config 据此校验）
//   apply   —— 挂载时执行：注册系统提示词 section、runtime skills、内置 agent preset
import z from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { copyTree, installShippedPresets } from "./preset-install";
import { CHINESE_LANGUAGE_INSTRUCTION } from "./chinese";
import { COHUB_SKILLS } from "./skills";
import { createCouncilTool } from "./council";
import { createDelegateTool } from "./delegate";
import { createDelegateBatchTool } from "./delegate_batch.ts";

import { DEFAULT_ERROR_CATEGORIES } from "./env-signatures";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** 单个 councillor 配置（M4 council 工具使用） */
const Councillor = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string().default(undefined),
});

/** 单个 skill 的路由配置（delegate 工具使用） */
const SkillRoute = z.object({
  name: z.string(),
  provider: z.string().default(undefined),
  model: z.string().default(undefined),
  maxTokens: z.number().default(undefined),
});

/** delegate 执行器环境契约注入配置（P1-1）：默认开、可关闭、文本可覆盖 */
const EnvContractConfig = z.object({
  /** 是否在 delegate spawn prompt 前注入执行器环境契约；默认开 */
  enabled: z.boolean().default(true),
  /** 部署覆盖文本；缺省 = 通用探测式默认文本（DEFAULT_ENV_CONTRACT，不写死环境断言） */
  text: z.string().default(undefined),
}).default({});

/** N2 停滞检测器配置（P3-1）：默认关闭（保守），跨环境三态（探测/配置/降级） */
const StallDetector = z.object({
  /** 默认关闭（保守）：enabled=false 时看门狗完全不介入，走现有单次/重试逻辑 */
  enabled: z.boolean().default(false),
  /** S1 连续同类错误阈值（同一归一化错误签名连续出现且期间无成功工具结果） */
  consecutiveErrors: z.number().default(3),
  /** S2 无结果空转毫秒（距上次工具结果超过它且仍在产出推理块） */
  idleMs: z.number().default(180_000),
  /** S3 纯推理无动作阈值（连续推理块数，期间 0 次工具调用） */
  reasoningWithoutAction: z.number().default(50),
  /** S4 重复调用循环阈值（同工具名 + 归一化参数重复且结果均为错误/未变） */
  loopCount: z.number().default(3),
  /** 宽限窗口：距最近一次成功工具结果超过它才允许触发（最近成功过不触发） */
  graceMs: z.number().default(30_000),
  /** 触发后是否按可重试中止处理（进入 retryableReasons 判定与 maxRetries 预算） */
  recoverable: z.boolean().default(true),
}).default({});

/** delegate 中止/失败自动重试配置（P1-2）：默认不重试（maxRetries=0），保持现状 */
const DelegateRetry = z.object({
  /** 中止/可重试失败后的自动重试上限；0 = 不重试（保持现状） */
  maxRetries: z.number().default(0),
  /** 重试间隔（毫秒） */
  retryDelayMs: z.number().default(1000),
  /** 可自动重试的 stopReason 集合；默认仅 "aborted"；未知 reason 一律不重试（保守，跨版本安全） */
  retryableReasons: z.array(z.string()).default(["aborted"]),
  /** N2 停滞检测（P3-1）：默认关闭；启用后从运行期事件在线估计「停滞」并提前中止（复用本重试机制） */
  stall: StallDetector,
}).default({});

/** 已固化的执行器环境契约事实（manual 模式或自动学习缓存；moduleLoading=unknown 表示未固化，回退探针式） */
const EnvContractFacts = z.object({
  /** "await-import" | "require" | "static-import" | "unknown" */
  moduleLoading: z.string().default("unknown"),
  /** 顶层 await 是否可用（探测观测值；manual 模式部署可覆盖） */
  topLevelAwait: z.boolean().default(true),
  /** 单次执行墙钟上限毫秒（探测观测值；manual 模式部署可覆盖） */
  wallClockLimitMs: z.number().default(600_000),
  /** 后台任务跟踪（job）是否可用（探测观测值；manual 模式部署可覆盖） */
  hasJobTracking: z.boolean().default(false),
}).default(undefined);

/** P3-2（N1）环境契约持久化配置：默认 auto（无缓存时行为不变，回退探针式）；读写失败静默降级 */
const EnvSignatures = z.object({
  /** auto（缺省，无缓存时行为不变）/ off（完全关闭读写）/ manual（只读手动契约事实） */
  use: z.union(["auto", "off", "manual"]).default("auto"),
  /** 缓存 TTL（毫秒），缺省 7 天（到期重探，防环境静默升级） */
  ttlMs: z.number().default(604_800_000),
  /** 同一签名确认次数后才写入，缺省 2（观察一致才写入，防瞬态误判） */
  confirmCount: z.number().default(2),
  /** manual 模式部署直接给的契约事实（可选；moduleLoading=unknown 视为未提供） */
  contract: EnvContractFacts,
  /** 环境契约类错误分类子串（仅观测分类用，缺省 DEFAULT_ERROR_CATEGORIES） */
  errorCategories: z.array(z.string()).default(DEFAULT_ERROR_CATEGORIES),
}).default({});

/** P3-3（N3）调度参数配置（N3 小切片）：批大小 / 墙钟预算 / job 跟踪 / 批间自适应。
 * 跨环境三态：缺省值（3 / 600s）仅为本环境观测值，部署可调；useJobTracking 无 job 能力时前台逐批降级；
 * adaptiveBatch 为提示词级自适应（不在代码层调度，避免过度优化）。 */
const ScheduleConfig = z.object({
  /** 单批并行委派上限；缺省 3（本环境观测值，部署可调） */
  maxParallelBatch: z.number().default(3),
  /** 单次执行单元墙钟预算（毫秒）；600_000 仅为本环境观测值，部署可调 */
  wallClockBudgetMs: z.number().default(600_000),
  /** 后台任务跟踪：auto（有则轮询）/ on / off（前台逐批降级） */
  useJobTracking: z.union(["auto", "on", "off"]).default("auto"),
  /** 批间自适应：auto（提示词级，按本会话已观测错误/超时收放批大小）/ off（固定配置值） */
  adaptiveBatch: z.union(["auto", "off"]).default("auto"),
}).default({});

export const name = "cohub";
export const inject = ["systemPrompt", "skills", "tools", "sessionProjections", "llm", "subagents"];

export const Config = z.object({
  /** 多模型共识 councillors（M4：非空时注册 council_session 工具） */
  councillors: z.array(Councillor).default([]),
  /** 单 councillor 超时（毫秒） */
  councilTimeoutMs: z.number().default(180_000),
  /** 子代理 provider（spawn 为内置进程内后端） */
  councilProvider: z.string().default("spawn"),
  /** skill 路由表（delegate 工具）：按 skill 名覆盖 provider/model/maxTokens，缺省继承父模型 */
  skills: z.array(SkillRoute).default([]),
  /** delegate 执行器环境契约注入（P1-1）：默认开，文本可覆盖 */
  delegateEnvContract: EnvContractConfig,
  /** delegate 中止/失败自动重试（P1-2）：默认不重试 */
  delegateRetry: DelegateRetry,
  /** delegate 执行器环境契约持久化（P3-2/N1）：默认 auto（无缓存时行为不变） */
  envSignatures: EnvSignatures,
  /** 调度参数（P3-3/N3）：批大小 / 墙钟预算 / job 跟踪 / 批间自适应；settings 可覆盖 */
  schedule: ScheduleConfig,
  /** 是否把内置 agent preset 安装/升级到用户 preset root（~/.dsh/.agent-presets/）。
   *  默认 true。设为 false 后本插件不再动该目录（已安装的 preset 不会自动删除，
   *  需要时手动清理 ~/.dsh/.agent-presets/ 下对应目录）。 */
  installPresets: z.boolean().default(true),
});

export { ScheduleConfig, CohubSettingsSchema };
/** 兼容/测试导出：preset 安装台账与递归复制（实现位于 preset-install.ts） */
export { copyTree, installShippedPresets, hashTree, removeInstallRecord } from "./preset-install";

/** cohub 的 settings namespace（settings.yaml 的 cohub.* 段） */
const COHUB_NS = settingsNamespace("cohub");

/** cohub settings namespace schema：skills 路由表 + 调度参数 + delegate 重试。
 * 组合层（cordis.patch.yml）为 base，settings 用户段可覆盖；缺省保持与 Config 一致（行为不变）。 */
const CohubSettingsSchema = z.object({
  skills: z.array(SkillRoute).default([]),
  schedule: ScheduleConfig,
  delegateRetry: DelegateRetry,
});

/** P3-3（N3）：已弃用——不再通过全局 systemPrompt.section 注入调度参数。
 * 调度参数只对调度者（Orchestrator）有意义，子代理无需知晓。
 * 调度约束已在 presets 的 agent.cordis.yml persona 中声明，
 * 运行时的实际生效值由 delegate.ts/delegate_batch.ts 直接读取 settings 使用。 */
function renderScheduleParams(_schedule) { return ""; }

/** 本包内置的 agent preset 目录（随 files 字段打包进 npm 包） */
const SHIPPED_PRESETS_DIR = fileURLToPath(new URL("../presets/", import.meta.url));

/** 本包 package.json（与 lib/ 同级）——读取当前版本用于 preset 安装台账 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 安装 / 升级内置 agent preset 到用户 preset root（`~/.dsh/.agent-presets/`）。
 *
 * 语义（见 preset-install.ts）：
 *   - 首次安装：整目录复制（含 skills/ 等子目录）；
 *   - 版本升级：只覆盖**未被用户改动**的文件，用户改过的文件跳过并告警；
 *   - 无台账（首次或从旧版本升级上来）：退化为「仅新增」，不覆盖任何已存在目录。
 * 安装失败只告警，绝不拖垮插件挂载（preset 是可选增强，技能才是核心能力）。
 */
function installAgentPresets(logger) {
  return installShippedPresets(SHIPPED_PRESETS_DIR, dshHomePath(".agent-presets"), readPackageVersion(), logger);
}

export function apply(ctx, config) {
  // ① 中文语言指令 —— 注入到系统提示词（对应 OpenCode 的 experimental.chat.system.transform）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "cohub:language",
    order: 95,
    text: CHINESE_LANGUAGE_INSTRUCTION,
  }), "cohub.section()");

  // ② 13 技能（12 专职代理 + orchestrator）→ runtime skills
  //    主代理用 skill 工具按需加载，再通过 subagent 委派（DSH 原生），
  //    运行时技能目录中即出现 co-explorer / co-fixer / co-council 等条目。
  for (const skill of COHUB_SKILLS) {
    ctx.skills.register(skill);
  }

  // ③ 内置 agent preset（co-orchestrator / cohub-cordis）安装、升级与孤儿清理
  //    installPresets=false 时不触碰用户 preset root（B：给部署/用户一个干净出口）
  if (config.installPresets !== false) {
    try {
      const r = installAgentPresets(ctx.logger);
      if (r.skipped.length > 0) {
        ctx.logger?.warn?.(
          "cohub: " + r.skipped.length + " 个 preset 文件因本地修改而在升级时被跳过：" + r.skipped.join(", "),
        );
      }
    } catch (error) {
      // 防御：安装是可选增强，任何异常都不得拖垮插件挂载
      ctx.logger?.warn?.("cohub: agent preset 安装失败（忽略）", error);
    }
  }

// ④ delegate 工具（核心）：按 skill 名路由到配置的 provider/model 并委派专职代理
  //    始终注册，不依赖 councillors 是否配置。路由表可由 DSH settings（settings.yaml 的
  //    cohub.skills）覆盖，组合层（cordis.patch.yml 的 skills）作为 base；settings 未挂载时回落组合层。
  const entry = {
    skills: config.skills ?? [],
    schedule: config.schedule,
    delegateRetry: config.delegateRetry,
  };
  // 当前生效 settings：返回整个 cohub section（schema 默认 + 组合层 base + 用户段）。
  // 未挂载 settings 服务时回落 entry（= Config 值，行为与现状一致）。
  let currentSettings = () => entry;
  let currentSkills = () => entry.skills;
  installSettingsSection(ctx, COHUB_NS, CohubSettingsSchema, entry, {
    setSource: (src) => {
      currentSettings = () => src() ?? {};
      currentSkills = () => (src() ?? {}).skills ?? [];
    },
    onChange: () => {},
  });

  // 防御性 subagents 检测：使用 ctx.reflect.get('subagents', false) 而不是直接读 ctx.subagents。
  // 原因：宿主 loader（如 @cordisjs/plugin-loader 的 cordis:include）可能把本插件 wrap 成新的
  // plugin 对象，导致 cordis 仅以包装层的 inject 解析依赖；若包装层未声明 subagents，
  // 直接读 ctx.subagents 会触发 cordis proxy 的 "cannot get property "subagents" without inject"
  // 错误（启动期 plugin tree failed to load）。reflect 是 cordis 内置 accessor，始终存在；
  // get(name, false) 不走 inject 强校验，缺失返回 undefined，于是我们落到自己的明确错误。
  const subagentsService = ctx.reflect?.get?.('subagents', false);
  if (!subagentsService) {
    throw new Error("cohub: delegate tool requires the subagents service (@deepseek-ai/dsh-subagent)");
  }
  ctx.tools.register(createDelegateTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
    envSignatures: config.envSignatures,
  }, () => currentSettings()));

  // ④c delegate_batch 工具（批量并行委派）：一次调用并行启动多个子代理
  //    复用 delegate 的共享函数（skill 匹配、路由、契约注入），跳过 stalled 和重试。
  //    始终注册，不依赖任何可选配置。
  ctx.tools.register(createDelegateBatchTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
    envSignatures: config.envSignatures,
  }, () => currentSettings()));

// ④b 调度参数注入：已移除（2026-09-01）。
  //    之前通过 systemPrompt.section("cohub:schedule") 全局注入，但子代理不需要调度参数。
  //    约束改为在 presets/*/agent.cordis.yml persona 中声明，运行时代码直接读取 settings。
  //    renderScheduleParams 保留（空函数）以兼容外部引用。

  

  // ⑤ council_session 工具（M4）：配置了 councillors 时注册
  if ((config.councillors ?? []).length > 0) {
    // 防御性检测：同上一处（delegate 工具）。cordis:include 等包装 loader 可能剥离 inject，
    // 直接读 ctx.subagents 会抛 cordis 框架错误；用 reflect.get 走非强校验通道。
    if (!ctx.reflect?.get?.('subagents', false)) {
      throw new Error("cohub: council tool requires the subagents service (@deepseek-ai/dsh-subagent)");
    }
    ctx.tools.register(createCouncilTool(
      {
        councillors: config.councillors,
        councilTimeoutMs: config.councilTimeoutMs ?? 180_000,
        councilProvider: config.councilProvider ?? "spawn",
      },
      ctx,
    ));
  }

  // ⑥ tokenMeter：把「当前 agent 的系统提示 + 工具 schema」的 token 用量输出到诊断日志
  //    监听 session/event 的 request/header 事件，读取 sessionProjections 的 contextBreakdown；
  //    effect 返回 off，插件卸载时自动撤销监听。
  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      if (event.type !== "request/header") return;
      const snap = ctx.sessionProjections.snapshot(session);
      const cb = snap.values.contextBreakdown;
      if (cb) {
        const total = cb.systemTokens + cb.toolsTokens + cb.messageTokens;
        ctx.logger.info("[cohub token] session=" + session.id + " system=" + cb.systemTokens + " tools=" + cb.toolsTokens + " messages=" + cb.messageTokens + " total=" + total);
      }
    });
    return off;
  }, "cohub.tokenMeter()");
}
