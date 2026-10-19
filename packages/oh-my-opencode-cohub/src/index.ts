import type { Plugin } from '@opencode-ai/plugin';
import type { AgentConfig } from '@opencode-ai/sdk';
import { ORCHESTRATOR_PROMPT } from './prompts/orchestrator';
import { ORCHESTRATOR_GPT_PROMPT } from './prompts/orchestrator-gpt';
import { ORACLE_PROMPT } from './prompts/oracle';
import { LIBRARIAN_PROMPT } from './prompts/librarian';
import { EXPLORER_PROMPT } from './prompts/explorer';
import { DESIGNER_PROMPT } from './prompts/designer';
import { FIXER_PROMPT } from './prompts/fixer';
import { OBSERVER_PROMPT } from './prompts/observer';
import { COUNCIL_PROMPT } from './prompts/council';
import { RULE_USER_PROMPT } from './prompts/rule-user';
import { RULE_PROJECT_PROMPT } from './prompts/rule-project';
import { RULE_APP_PROMPT } from './prompts/rule-app';
import { PLANNER_PROMPT } from './prompts/planner';
import { CHINESE_LANGUAGE_INSTRUCTION, PARALLEL_TOOL_INSTRUCTION } from './instructions/chinese';
import { TaskTracker } from './task-manager/tracker';
import type { JobRecord } from './task-manager/types';
import { assessQuality, isQualityEnabled } from './task-manager/quality';
import { ContextEngine } from './context/engine';
import { resolveStrategy } from './context/strategy';
import type { ContextStrategy } from './context/types';
import { loadCoHubConfig, resolveReuseBudget, type AgentOverride } from './config/loader';
import { appendCtxDiag, appendTaskDiag, resolveCtxDiagSettings } from './context/diag-log';
import { createCouncilTool, CouncilManager } from './tools/council';
import { createCloseJobTool } from './tools/job-control';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendLog, appendSafeLog } from './utils/log.js';
import { writeFileAtomic } from './shared/fs-atomic';
import { COUNCIL_TIMEOUT_MS, STALE_TASK_MS } from './shared/constants';
import { createOrchestrationLayer } from './orchestration';
import { classifyRateLimit } from './orchestration/rate-limit';
import { stripExistingContracts } from './orchestration/contract';
import { enforcePromptBudget } from './context/extractor';

/** 默认 prompt 最大 token 数（超过此值的 CoHub 注入将被整体降级为裸用户 prompt） */
const DEFAULT_PROMPT_MAX_TOKENS = 12_000;

/** 中文提示词映射表 */
const CHINESE_PROMPTS: Record<string, string> = {
  'co-orchestrator': ORCHESTRATOR_PROMPT,
  'co-orchestrator-gpt': ORCHESTRATOR_GPT_PROMPT,
  'co-oracle': ORACLE_PROMPT,
  'co-librarian': LIBRARIAN_PROMPT,
  'co-explorer': EXPLORER_PROMPT,
  'co-designer': DESIGNER_PROMPT,
  'co-fixer': FIXER_PROMPT,
  'co-observer': OBSERVER_PROMPT,
  'co-council': COUNCIL_PROMPT,
  'co-rule-user': RULE_USER_PROMPT,
  'co-rule-project': RULE_PROJECT_PROMPT,
  'co-rule-app': RULE_APP_PROMPT,
  'co-planner': PLANNER_PROMPT,
};

/** 提示词覆盖映射 */
interface PromptOverrides {
  [agentName: string]: {
    replace?: string; // 完全替换
    append?: string;  // 追加
  };
}

/**
 * 从文件系统加载提示词覆盖
 * 优先级：项目级 > 用户级
 */
function loadFileOverrides(projectDir?: string): PromptOverrides {
  const overrides: PromptOverrides = {};
  const agentNames = [
    'co-orchestrator', 'co-orchestrator-gpt', 'co-oracle', 'co-librarian', 'co-explorer',
    'co-designer', 'co-fixer', 'co-observer', 'co-council',
    'co-rule-user', 'co-rule-project', 'co-rule-app', 'co-planner',
  ];

  const searchDirs: string[] = [];
  // 项目级优先
  if (projectDir) {
    searchDirs.push(path.join(projectDir, '.opencode', 'oh-my-opencode-cohub'));
  }
  // 用户级
  searchDirs.push(path.join(os.homedir(), '.config', 'opencode', 'oh-my-opencode-cohub'));

  for (const agent of agentNames) {
    for (const dir of searchDirs) {
      // 检查 {agent}.md（替换）
      const replacePath = path.join(dir, `${agent}.md`);
      if (!overrides[agent]?.replace && fs.existsSync(replacePath)) {
        try {
          overrides[agent] = { ...overrides[agent], replace: fs.readFileSync(replacePath, 'utf-8') };
        } catch (err) {
          appendLog('loadFileOverrides', '读取replace文件失败', err);
        }
      }
      // 检查 {agent}_append.md（追加）
      const appendPath = path.join(dir, `${agent}_append.md`);
      if (!overrides[agent]?.append && fs.existsSync(appendPath)) {
        try {
          overrides[agent] = { ...overrides[agent], append: fs.readFileSync(appendPath, 'utf-8') };
        } catch (err) {
          appendLog('loadFileOverrides', '读取append文件失败', err);
        }
      }
    }
  }

  return overrides;
}

/**
 * 合并提示词：base + replace + append
 */
function resolvePrompt(base: string, replace?: string, append?: string): string {
  if (replace) {
    return replace + (append ? `\n\n${append}` : '');
  }
  if (append) {
    return `${base}\n\n${append}`;
  }
  return base;
}

/** Agent 定义：name + description + config */
interface AgentDefinition {
  name: string;
  description?: string;
  config: AgentConfig;
}

/**
 * 中文语言指令 —— 可注入到 AGENTS.md 或 instructions
 */
const CHINESE_INSTRUCTION = CHINESE_LANGUAGE_INSTRUCTION;

const CoHubPlugin: Plugin = async (input, options) => {
  // 插件级 client 闭包：event hook 的参数（{ event: Event }）会遮蔽插件外层 input，
  // 后台终态证据验证（verifyChildTerminal）必须用本闭包引用，避免 undefined 导致读取失败。
  const pluginClient = input.client;

  // 方式一：从文件系统加载覆盖
  const projectDir = input.directory || process.cwd();
  const fileOverrides = loadFileOverrides(projectDir);

  // 方式二：从 plugin config 读取覆盖
  const configOverrides: PromptOverrides = {};
  if (options?.overrides && typeof options.overrides === 'object') {
    Object.assign(configOverrides, options.overrides as PromptOverrides);
  }

  // 合并（文件优先，config 补充）
  const promptOverrides = { ...configOverrides, ...fileOverrides };

  const tracker = new TaskTracker();
  const orchestrationLayer = createOrchestrationLayer(tracker, {});
  // 任务精确关联：before/after 均通过 hook input 的 (sessionID, callID) 精确配对（SDK 1.17.15），
  // 不再使用共享 _lastAlias —— 并发乱序 / 复用场景由 tracker callIndex 精确定位，绝不回退"最近"。

  // ===== TUI 状态同步 =====
  const STATE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'oh-my-opencode-cohub');
  const STATE_FILE = path.join(STATE_DIR, 'tracker-state.json');

  // 定时写入 tracker 状态供 TUI 面板轮询
  function syncTrackerState(sessionId: string) {
    try {
      const state = {
        updatedAt: Date.now(),
        runningAgents: tracker.getRunningAgents(sessionId),
        runningCount: tracker.getRunningCount(sessionId),
      };
      writeFileAtomic(STATE_FILE, JSON.stringify(state));
    } catch { /* 静默失败 */ }
  }

  // ===== Agent 配置写入（供 TUI 面板读取） =====
  const AGENT_CONFIG_FILE = path.join(STATE_DIR, 'cohub-state.json');
  function syncAgentConfig() {
    try {
      const configs = agents.filter(a => (a.config as Record<string, unknown>).model).map(a => {
        const modelStr = (a.config as Record<string, unknown>).model as string;
        const parts = modelStr.split('/');
        const provider = parts.length > 1 ? parts[0] : 'default';
        const shortModel = parts.length > 1 ? parts.slice(1).join('/') : modelStr;
        return {
          name: a.name,
          description: a.description,
          model: shortModel,
          variant: (a.config as Record<string, unknown>).variant || null,
          provider,
        };
      });
      writeFileAtomic(AGENT_CONFIG_FILE, JSON.stringify({ updatedAt: Date.now(), agents: configs }));
      void appendLog('syncAgentConfig', `已同步 ${configs.length} 个 agent: ${JSON.stringify(
        configs.map(c => ({ name: c.name, model: c.model, variant: c.variant })),
      )}`);
    } catch { /* 静默失败 */ }
  }

  // ===== Agent 定义（co-orchestrator 双注册：opencode.json<TAB> + return<ACP>） =====
  const agents = [
    {
      name: 'co-orchestrator',
      config: { mode: 'primary', prompt: ORCHESTRATOR_PROMPT },
    },
    {
      name: 'co-orchestrator-gpt',
      config: { mode: 'primary', prompt: ORCHESTRATOR_GPT_PROMPT },
    },
    {
      name: 'co-oracle',
      config: { mode: 'subagent', temperature: 0.1, prompt: ORACLE_PROMPT },
    },
    {
      name: 'co-librarian',
      config: { mode: 'subagent', prompt: LIBRARIAN_PROMPT },
    },
    {
      name: 'co-explorer',
      config: { mode: 'subagent', prompt: EXPLORER_PROMPT },
    },
    {
      name: 'co-designer',
      config: { mode: 'subagent', prompt: DESIGNER_PROMPT },
    },
    {
      name: 'co-fixer',
      mode: 'subagent',
      description: '执行者——代码修改、构建、测试',
      config: { mode: 'subagent', prompt: FIXER_PROMPT },
    },
    {
      name: 'co-observer',
      description: '观察者——图片/PDF/截图视觉分析',
      config: { mode: 'subagent', prompt: OBSERVER_PROMPT },
    },
    {
      name: 'co-council',
      description: '多模型共识——并行 LLM 综合',
      config: {
        mode: 'subagent',
        prompt: COUNCIL_PROMPT,
        permission: { council_session: 'allow' as const },
      },
    },
    {
      name: 'co-rule-user',
      description: '用户规范分析——~/.config/opencode/AGENTS.md',
      config: { mode: 'subagent', prompt: RULE_USER_PROMPT },
    },
    {
      name: 'co-rule-project',
      description: '项目规范分析——项目 AGENTS.md',
      config: { mode: 'subagent', prompt: RULE_PROJECT_PROMPT },
    },
    {
      name: 'co-rule-app',
      description: '应用规则分析——.opencode/rules/*.md',
      config: { mode: 'subagent', prompt: RULE_APP_PROMPT },
    },
    {
      name: 'co-planner',
      description: '方案制定——综合需求+信息+规范输出任务分解',
      config: { mode: 'subagent', prompt: PLANNER_PROMPT },
    },
  ];

  // ===== 加载用户配置覆盖 =====
  const userConfig = loadCoHubConfig(projectDir);
  // 软复用预算（默认开启 200K；非法字段消费侧回退默认；关闭时不影响既有任务追踪）
  const reuseBudget = resolveReuseBudget(userConfig.reuseBudget);
  /**
   * 采样代次守卫：alias → 最近一次 idle 发起的采样序号。
   * 同 alias/callID/childID 的并发 capture 中，仅最新采样请求可提交（未知亦遵守）——
   * 旧请求迟到不得覆盖新结果。序号随采样发起递增；job 被 prune 后对应条目惰性清理
   * （见 idle 分支），避免映射无界增长；dispose 时整体清空（尊重插件生命周期）。
   */
  const samplingSeq = new Map<string, number>();
  // 诊断开关（缺省关闭）：在初始化时求值一次，热路径只读常量
  const ctxDiag = resolveCtxDiagSettings(userConfig.diag);
  if (userConfig.agents) {
    for (const agent of agents) {
      const override = userConfig.agents[agent.name];
      if (override) {
        if (override.model) (agent.config as Record<string, unknown>).model = override.model;
        if (override.variant) (agent.config as Record<string, unknown>).variant = override.variant;
        if (override.prompt) agent.config.prompt = override.prompt;
      }
    }
  }

  syncAgentConfig();  // 写入 agent 配置供 TUI 面板读取（覆盖完成后执行）

  // ===== 应用文件级覆盖（优先级：文件替换 > 文件追加 > JSON 配置 > 内置常量） =====
  for (const agent of agents) {
    const override = fileOverrides[agent.name];
    if (override) {
      agent.config.prompt = resolvePrompt(
        agent.config.prompt as string,
        override.replace,
        override.append,
      );
    }
  }

  // ===== Council 初始化（无配置时使用内置默认预设） =====
  const DEFAULT_COUNCIL_CONFIG = {
    default_preset: 'default',
    timeout: COUNCIL_TIMEOUT_MS,
    councillor_execution_mode: 'parallel' as const,
    councillor_retries: 3,
    presets: {
      default: {},  // 空预设，完全依赖 oh-my-opencode-cohub.json 配置
    },
  };
  // 初始化上下文引擎
  const contextConfig = userConfig.context ?? {};
  const contextEngine = new ContextEngine(input.client, contextConfig);

  const councilConfig = userConfig.council ?? DEFAULT_COUNCIL_CONFIG;
  const councilManager = new CouncilManager(input.client, input.directory, councilConfig);
  const councilTools = createCouncilTool(input, councilManager);
  // close_job 真实取消落地（底层保证第4回调仅首次真实取消时调用一次）：
  // alias → getJobByAlias → engine 镜像 cancelled + 按 job.parentSessionId 精确刷新（不用 currentParentSessionId 回退）
  const jobTools = createCloseJobTool(
    input,
    tracker,
    undefined, // onClosed 保留兼容位：不误刷其他 parent
    (alias) => {
      const job = tracker.getJobByAlias(alias);
      if (job && orchestrationLayer) {
        orchestrationLayer.engine.applyLifecycleEvent(alias, 'cancelled');
        syncTrackerState(job.parentSessionId);
      }
    },
  );
  /**
   * 从 tool.execute.after 的 output 对象中提取子会话 session ID。
   * output 形态（SDK 1.17.15）：{ title, output, metadata }。
   * 红线：非 ses_ 前缀的值绝不当作 childID（防止把任意文本/别名误绑定为子会话）。
   */
  function extractChildSessionId(output: unknown): string | undefined {
    if (!output || typeof output !== 'object') return undefined;
    const o = output as Record<string, unknown>;
    // metadata 中可能包含 sessionId / taskId（仅接受 ses_ 前缀的真实子会话 ID）
    const meta = o.metadata as Record<string, unknown> | undefined;
    if (meta) {
      for (const key of ['sessionId', 'taskId', 'task_id', 'id']) {
        const v = meta[key];
        if (typeof v === 'string' && v.startsWith('ses_')) return v;
      }
    }
    // 输出文本中可能包含 session ID（如 "session id: ses_xxx"），同样要求 ses_ 前缀
    const text = typeof o.output === 'string' ? o.output : '';
    const m = text.match(/\b(?:session|task)[_\s]?id[:\s]+(ses_\S+)/i);
    if (m) return m[1];
    return undefined;
  }

  // ===== 辅助：从 event 中安全提取 sessionId =====
  function extractSessionIdFromEvent(props: unknown): string | undefined {
    if (!props || typeof props !== 'object') return undefined;
    const p = props as Record<string, unknown>;
    // 尝试多个可能的路径
    const info = p.info as Record<string, unknown> | undefined;
    if (info?.id) return info.id as string;
    if (typeof p.sessionID === 'string') return p.sessionID;
    if (typeof p.sessionId === 'string') return p.sessionId;
    return undefined;
  }

  /**
   * 后台终态证据验证：session.idle 只能说明子会话暂时空闲，不是成功证据。
   * 通过一次有界 session.messages 读取（limit=10），验证最新 assistant 消息的明确结局：
   * - info.error 存在 → 'cancelled'（MessageAbortedError/中止）或 'errored'（其余最终错误）；
   * - 未闭合工具轮（tool state pending/running/缺失，未产生最终结果）→ 'unknown'（仍在执行）；
   *   —— 已 completed/error 的 tool parts 不阻止判定（completed tool parts + 最终 stop 合法）；
   * - finish 明确：tool-calls 中间轮 → 'unknown'；abort/cancel → 'cancelled'；
   *   length/content-filter → 'errored'（不成功结局）；已知成功值 → 'completed'；未知值 → 'unknown'（不臆测成功）；
   * - 无 finish：time.completed 无法单独证明成功 → 'unknown'（保守）。
   * 宿主重试不以非最终消息/retry part 判断：以 session.status(retry) 事件观测；最新消息缺终态信号即 'unknown'。
   * 新鲜度边界：最新 assistant 消息创建时间晚于调用开始（job.createdAt）——复用会话的旧完成消息
   * 不当作本轮完成证据，防止终态旧调用抢新调用。
   */
  async function verifyChildTerminal(
    client: typeof input.client,
    sessionId: string,
    jobCreatedAt: number,
  ): Promise<'completed' | 'errored' | 'cancelled' | 'unknown'> {
    try {
      const res = await client.session.messages({ path: { id: sessionId }, query: { limit: 10 } });
      if (res.error) return 'unknown'; // 读失败：保持未知，不假成功
      const msgs = res.data;
      if (!Array.isArray(msgs) || msgs.length === 0) return 'unknown'; // 空记录：保持未知
      // 挑最新 assistant 消息：优先 time.created 最大（明确时序），兜底取数组最后一个 assistant
      let latest: { info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> } | undefined;
      let latestCreated = -1;
      for (const item of msgs) {
        const info = item?.info as Record<string, unknown> | undefined;
        if (!info || info.role !== 'assistant') continue;
        const t = info.time as Record<string, unknown> | undefined;
        const created = typeof t?.created === 'number' ? t.created : -1;
        if (created > latestCreated) { latestCreated = created; latest = item; }
      }
      if (!latest) return 'unknown';

      const info = latest.info as Record<string, unknown>;
      const time = info.time as Record<string, unknown> | undefined;
      const created = typeof time?.created === 'number' ? time.created : undefined;
      // 新鲜度边界：最新 assistant 消息创建时间早于本轮调用开始 → 旧会话历史，不作为本轮证据
      if (created !== undefined && created < jobCreatedAt) return 'unknown';

      // 消息级最终错误：中止/取消 → cancelled，其余最终错误 → errored
      if (info.error) return isAbortLikeError(info.error) ? 'cancelled' : 'errored';

      const parts = latest.parts ?? [];
      // 未闭合工具轮：tool state 非 completed/error（pending/running/缺失）→ 仍在执行，不终结
      const hasOpenTool = parts.some((p) => {
        if (p.type !== 'tool') return false;
        const st = p.state as Record<string, unknown> | undefined;
        return st?.status !== 'completed' && st?.status !== 'error';
      });
      if (hasOpenTool) return 'unknown';

      // finish 值域判定：不成功结局 / 中间轮 / 未知值都不当作成功。
      // 已核实的已知值用【精确】映射（未知值如 'mystery-stop' 不因含 'stop' 子串误判成功，
      // 也不会把 'not-cancelled' 之类未知文本误判终态）；未核实值一律 unknown。
      const finish = info.finish;
      if (typeof finish === 'string' && finish !== '') {
        const f = finish.toLowerCase();
        if (f === 'tool-calls' || f === 'tool_calls') return 'unknown'; // 中间轮
        if (f === 'abort' || f === 'cancel' || f === 'cancelled') return 'cancelled';
        if (f === 'length' || f === 'content-filter' || f === 'content_filter') return 'errored';
        if (KNOWN_SUCCESS_FINISH.some((m) => m === f)) return 'completed';
        return 'unknown'; // 未知 finish：不臆测成功
      }
      // 无 finish：time.completed 无法单独证明成功（可能截断/异常结束），保守未知
      return 'unknown';
    } catch {
      return 'unknown'; // 网络异常：保持未知，不假成功
    }
  }

  /** SDK 已知成功 finish 值（小写【精确】匹配：未知值绝不因子串误判成功）；'end_turn' 为常见 LLM 停靠值 */
  const KNOWN_SUCCESS_FINISH = ['finish', 'stop', 'end_turn', 'end', 'success', 'done', 'completed'] as const;

  /** 识别中止/取消类错误（SDK 类型已枚举：仅 MessageAbortedError 精确匹配；未知 name 不臆测） */
  function isAbortLikeError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    return (err as Record<string, unknown>).name === 'MessageAbortedError';
  }

  /** 仅诊断开启时追加任务生命周期记录（白名单字段由 appendTaskDiag 内部收紧/截断） */
  function taskDiag(record: Parameters<typeof appendTaskDiag>[0]): void {
    if (ctxDiag.enabled) appendTaskDiag(record, ctxDiag.filePath);
  }

  /**
   * 分类 task 工具 after 的显式结局。output 为 SDK 1.17.15 形态 { title, output, metadata }：
   * - metadata 显式 status='cancelled' 或 cancelled=true → cancelled；
   * - metadata 显式 status='failed'/'error'/'errored' 或 error 字段存在 → errored；
   * - metadata 显式 status='running'/'pending' → running（后台未完成）；
   * - 无显式标记 → unknown（正常工具返回，由入口按前台/后台语义处理）。
   * 绝不从任意 output 文本（如用户正文含 error 词）推断失败。
   */
  function classifyTaskAfter(output: unknown): { status: 'cancelled' | 'errored' | 'running' | 'unknown' } {
    if (output && typeof output === 'object') {
      const meta = (output as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta === 'object') {
        if (meta.status === 'cancelled' || meta.cancelled === true) return { status: 'cancelled' };
        if (
          meta.status === 'failed' || meta.status === 'error' || meta.status === 'errored' ||
          meta.error !== undefined
        ) {
          return { status: 'errored' };
        }
        if (meta.status === 'running' || meta.status === 'pending') return { status: 'running' };
      }
    }
    return { status: 'unknown' };
  }

  /**
   * 共用收尾核验（session.idle 与 tool.execute.after 首次 child 绑定后补核验共用）：
   * 对候选 job 做一次有界终态证据验证（verifyChildTerminal），再按 (parent,callID)+预期 childID
   * 竞态复核后落真实终态。保证：
   * - 正常 after 时 child 尚未产生终态消息（messages=[]）→ 'unknown' → 保持 running，零副作用；
   * - 已明确 completed 的任务重复核验 → finalizeByCall 幂等（stats 只记一次）；
    * - await 读取期间绑定对象变更 / job 已被 cancel / 已新开调用 → 不更新新调用。
    * 不新增轮询 timer、不缓存事件、不启动第二次 task。
    * 返回值契约：仅"本次实际完成 running→completed"返回 true（after 据此决定是否补捕获）；
    * 失败 / 无终态证据保持 running / 非 completed 终态 / 竞态拦截（含已被其他调用者收尾）→ false。
    * 其他调用者可忽略返回值；调用方不得以本返回替代自身对 job 终态的复核。
    */
  async function reconcileJobTerminal(job: JobRecord): Promise<boolean> {
    const parentAtCall = job.parentSessionId;
    const callAtCall = job.callID;
    const aliasAtCall = job.alias;
    const childId = job.sessionId;
    if (!childId) return false; // 未绑定 childID 无法做有界核验

    const verdict = await verifyChildTerminal(pluginClient, childId, job.createdAt);

    // 竞态复核：await 读取期间绑定对象可能已变更 / job 已被 cancel / 已新开调用
    const nowJob = callAtCall ? tracker.getJobByCall(parentAtCall, callAtCall) : tracker.getJobBySessionId(childId);
    if (!nowJob || nowJob.alias !== aliasAtCall || nowJob.sessionId !== childId || nowJob.status !== 'running') {
      appendSafeLog('event', `收尾竞态：候选已变更，不更新新调用 (session=${childId.slice(0, 20)})`);
      return false; // 未由本次收尾：候选已变更 / job 已被 cancel / 已被其他调用者收尾为终态
    }

    if (verdict === 'completed' || verdict === 'errored' || verdict === 'cancelled') {
      const term = verdict === 'completed' ? 'completed' : verdict === 'cancelled' ? 'cancelled' : 'errored';
      const up = callAtCall
        ? tracker.finalizeByCall(parentAtCall, callAtCall, childId, term)
        : tracker.updateByChildSessionId(childId, term);
      syncTrackerState(tracker.currentParentSessionId);
      const alias = up.ok ? up.alias : aliasAtCall;
      if (up.ok && up.alias && orchestrationLayer) {
        orchestrationLayer.engine.applyLifecycleEvent(up.alias, verdict === 'completed' ? 'completed' : verdict === 'cancelled' ? 'cancelled' : 'failed');
      }
      taskDiag({
        t: 'task',
        session: childId.slice(0, 20),
        alias,
        event: verdict === 'completed' ? 'task_completed' : verdict === 'cancelled' ? 'task_cancelled' : 'task_failed',
        status: verdict === 'completed' ? 'completed' : verdict === 'cancelled' ? 'cancelled' : 'failed',
        durationMs: Date.now() - job.createdAt,
        lastActivityAt: Date.now(),
      });
      // 返回值契约：仅本次实际完成 running→completed 为 true；finalize 失败（up.ok=false，
      // 含幂等/ambiguous/no-match）/ 非 completed 终态（cancelled/errored）→ false
      // （不触发补捕获、不空耗采样代次）。
      return verdict === 'completed' && up.ok;
    } else {
      // 无终态证据（中间轮 / 未知 finish / 读失败）：保持 running + 诊断，绝不假成功
      appendSafeLog('event', `无终态证据，保持 running (session=${childId.slice(0, 20)})`);
      taskDiag({
        t: 'task',
        session: childId.slice(0, 20),
        alias: aliasAtCall,
        event: 'state_changed',
        status: 'running',
        lastActivityAt: Date.now(),
      });
      return false; // 无终态证据保持 running：未完成，不触发补捕获
    }
  }

  /**
   * 捕获子代理结果并写回质量/复用预算采样（session.idle 与 after 首次绑定补核验共用）。
   * 调用方须在第一个 await 前固定快照（alias/parent/call/child/createdAt/agent）并持有
   * 已分配的采样代次 seq；本函数内部沿用：
   * - 代次守卫：发起捕获后 samplingSeq 已被更新的采样请求推进 → 本请求过期，不写回
   *   （未知亦遵守，旧采样迟到不覆盖新结果）；
   * - 快照复核：捕获返回后候选 job 已变更（alias/sessionId 不匹配）→ 不写回新调用；
   * - 新鲜度边界：采样消息创建时间早于本轮调用开始（notBefore=createdAt）→ 标未知，
   *   不回填旧 low/high（与 captureResult 内 notBefore 写回层双保险）。
   * 不改变任务终态（终态由调用方 reconcile 决定，绝不凭猜测）；质量与复用预算开关独立
   * （captureResult 仍承载显式 dependencyPropagation，不受两开关影响）。
   */
  function captureAndWriteBack(opts: {
    alias: string;
    parentSessionId: string;
    callID: string | undefined;
    childSessionId: string;
    agent: string;
    createdAt: number;
    seq: number;
  }): void {
    void contextEngine
      .captureResult(opts.childSessionId, opts.alias, opts.agent, { notBefore: opts.createdAt, parentSessionId: opts.parentSessionId })
      .then((captured) => {
        // 代次守卫：已有更新的采样请求 → 本请求过期，不提交任何写回（未知亦遵守）
        if (samplingSeq.get(opts.alias) !== opts.seq) return;
        if (!captured) return;
        // 质量评分与复用预算开关独立：quality 关闭不阻止预算采样写回；
        // 两者皆关闭 → 不回写（captureResult 仍承载依赖传播，不受影响）。
        const wantQuality = isQualityEnabled(userConfig.quality);
        const wantReuse = reuseBudget.enabled;
        if (!wantQuality && !wantReuse) return;
        // 快照复核：仍同一 job（允许 terminal completed 后回写自己——不检查 status==='running'）
        const now = opts.callID ? tracker.getJobByCall(opts.parentSessionId, opts.callID) : tracker.getJobBySessionId(opts.childSessionId);
        if (!now || now.alias !== opts.alias || now.sessionId !== opts.childSessionId) {
          appendSafeLog('event', '质量回送竞态：候选已变更，不写回复用/新调用');
          return;
        }
        // 采样新鲜度边界（写回层双保险，与 captureResult 内 notBefore 一致）：
        // sampledAt 早于本轮调用边界（createdAt）→ 旧会话历史，标未知，不回填旧 low/high。
        const freshSample =
          wantReuse && captured.reuseInput && captured.reuseInput.sampledAt >= opts.createdAt
            ? captured.reuseInput
            : undefined;
        if (wantQuality) {
          const quality = assessQuality({
            output: captured.output,
            decisions: captured.decisions,
            latencyMs: Date.now() - opts.createdAt,
            tokens: captured.tokens,
          });
          tracker.updateQualityByAlias(opts.alias, {
            score: quality.score,
            ...(quality.failureCategory ? { failureCategory: quality.failureCategory } : {}),
            ...(quality.latencyMs !== undefined ? { latencyMs: quality.latencyMs } : {}),
            ...(quality.tokens ? { tokens: quality.tokens } : {}),
            // 复用预算采样：仅启用时写回（随既有 idle/quality 更新路径采样，
            // 不另建缓存；关闭策略时字段保持未采样 → Board 不显示建议）
            ...(freshSample ? { reuseInput: freshSample } : {}),
          });
        } else if (wantReuse) {
          // 质量评分关闭但预算开启：写回采样（fresh → 新样本；最新未知 → 提交清空
          // reuseInput，不保留旧样本、不虚构 score，其余既有质量字段保留）。
          const prev = tracker.getJobByAlias(opts.alias)?.quality;
          tracker.updateQualityByAlias(opts.alias, { ...(prev ?? {}), reuseInput: freshSample });
        }
        syncTrackerState(tracker.currentParentSessionId);
      })
      .catch((err) => appendSafeLog('event', '质量回送失败', err));
  }

  // ===== 兜底：定时清理过期背景任务（30 分钟超时，阈值来自共享层 STALE_TASK_MS） =====
  const cleanupTimer = setInterval(() => {
    try {
      const staleSessions = tracker.cleanupStaleJobs(STALE_TASK_MS);
      for (const sid of staleSessions) {
        // SDK 默认 ThrowOnError=false：HTTP 失败会 resolve 出 { data, error } 而非 reject，
        // 显式检查 res.error；catch 仅兜底网络层异常
        void (async () => {
          try {
            const res = await input.client.session.abort({ path: { id: sid } });
            if (res.error) {
              appendLog('cleanupStaleJobs', `abort stale session ${sid} 失败`, res.error);
            }
          } catch (err) {
            appendLog('cleanupStaleJobs', `abort stale session ${sid} 失败`, err);
          }
        })();
      }
    } catch (err) {
      appendLog('cleanupStaleJobs', '定时清理过期任务失败', err);
    }
  }, 30_000);
  // 定时器不应钉住宿主进程（dispose 不被调用时的兜底；Node 下 Timeout 才有 unref）
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  const contextCleanupTimer = setInterval(() => {
    try {
      contextEngine.cleanupStaleDependencies();
      // registry 兜底回收：正常路径已在注入完成后释放（见下方 releaseContext），
      // 此处仅回收异常路径遗留的条目，防止长驻进程内存无限增长
      contextEngine.cleanupStaleContexts();
    } catch (err) {
      appendLog('contextCleanupTimer', '定时清理上下文失败', err);
    }
  }, 60_000);
  if (typeof contextCleanupTimer.unref === 'function') contextCleanupTimer.unref();

  // ===== 构建 agent 对象（供直接返回 + config hook 双重注册） =====
  const agentConfigs: Record<string, unknown> = {};
  const COUNCIL_ONLY_TOOLS = { council_session: 'deny' as const };
  // close_job 仅 co-orchestrator / co-orchestrator-gpt 可用；co-council 不可调用（co-council 用 council_session）
  const ORCHESTRATOR_ONLY_TOOLS = { close_job: 'deny' as const };
  for (const agent of agents) {
    const base = {
      ...agent.config,
      name: agent.name,
      description: agent.description,
    } as Record<string, unknown>;
    // 权限管控：
    // - council_session 仅 co-council 可用，非 co-council 显式 deny
    // - close_job 仅 co-orchestrator / co-orchestrator-gpt 可用，其余显式 deny
    // 若 config 已有 permission 则合并（保留已有键）。
    const existingPermission = (base.permission as Record<string, unknown> | undefined) ?? {};
    if (agent.name !== 'co-council') {
      base.permission = { ...existingPermission, ...COUNCIL_ONLY_TOOLS };
    }
    if (!['co-orchestrator', 'co-orchestrator-gpt'].includes(agent.name)) {
      base.permission = { ...(base.permission as Record<string, unknown>), ...ORCHESTRATOR_ONLY_TOOLS };
    } else {
      // co-orchestrator / co-orchestrator-gpt 显式写回 allow：不依赖"无条目默认放行"，防未来全局权限策略收紧时误拦
      base.permission = { ...(base.permission as Record<string, unknown>), close_job: 'allow' as const };
    }
    agentConfigs[agent.name] = base;
  }

  return {
    name: 'oh-my-opencode-cohub',

    // 方式一：直接返回 agent 字段（HTTP 服务器模式更可靠）
    agent: agentConfigs,

    // 工具：council_session（多模型并行共识）+ close_job（中止卡住子任务）
    tool: { ...councilTools, ...jobTools },

    // 方式二：config hook 再次写入（确保兼容所有模式）
    config: async (cfg: Record<string, unknown>) => {
      const c = cfg as { agent?: Record<string, unknown>; default_agent?: string };
      c.agent ??= {};

      // 兜底设置默认代理（与 opencode.json 的 default_agent 互补）
      if (!c.default_agent) {
        c.default_agent = 'co-orchestrator';
      }

      // 合并策略：
      // - opencode.json 优先（用户手动字段：mode/tools/temperature 等）
      // - hub config 的 model/variant 优先（oh-my-opencode-cohub.json 是配置源）
      // install 会将 hub config 同步写入 opencode.json，但用户可能只更新 hub config 未重装
      for (const [name, pluginConfig] of Object.entries(agentConfigs)) {
        const existing = c.agent[name] as Record<string, unknown> | undefined;
        const pc = pluginConfig as Record<string, unknown>;
        const merged: Record<string, unknown> = existing
          ? { ...pc, ...existing }
          : { ...pc };
        // hub config 的 model/variant 总是覆盖 opencode.json 中的值
        if (pc.model) merged.model = pc.model;
        if (pc.variant) merged.variant = pc.variant;
        // permission 键级合并：保留用户对具体工具（如 bash）的授权，
        // 但 council_session / close_job 按代理身份键级强制修正（防浅合并误覆盖）：
        // - co-orchestrator / co-orchestrator-gpt：council_session deny、close_job allow
        // - co-council：council_session allow、close_job deny
        // - 其余代理：双 deny
        const existingPerm0 = (merged.permission as Record<string, unknown>) ?? {};
        if (name === 'co-council') {
          merged.permission = { ...existingPerm0, council_session: 'allow' as const, ...ORCHESTRATOR_ONLY_TOOLS };
        } else if (['co-orchestrator', 'co-orchestrator-gpt'].includes(name)) {
          merged.permission = {
            ...existingPerm0,
            ...COUNCIL_ONLY_TOOLS,
            close_job: 'allow' as const,
          };
        } else {
          merged.permission = { ...existingPerm0, ...COUNCIL_ONLY_TOOLS, ...ORCHESTRATOR_ONLY_TOOLS };
        }
        c.agent[name] = merged;
      }

      try { writeFileAtomic(path.join(STATE_DIR, 'config-hook-ran.json'), JSON.stringify({ ran: true, count: agents.length })); } catch (err) {
        void appendLog('config', '双重注册写入文件失败', err);
      }
      void appendLog('config.hook', `config hook 注入完成: ${JSON.stringify(
        Object.entries(agentConfigs).map(([name, cfg]) => {
          const c = cfg as Record<string, unknown>;
          const prompt = typeof c.prompt === 'string' ? c.prompt : '';
          return {
            name,
            promptLen: prompt.length,
            promptPreview: prompt.slice(0, 120),
            hasModel: !!c.model,
            hasVariant: !!c.variant,
          };
        }),
      )}`);
    },

    'tool.execute.before': async (input, output) => {
      try {
        if (input.tool === 'task') {
          // 在一切注入前捕获原始用户 prompt（用于后续预算兜底降级）
          const rawPrompt = typeof output.args?.prompt === 'string' ? output.args.prompt : '';
          const rawDesc = typeof output.args?.description === 'string' ? output.args.description : '';
          const basePrompt = rawPrompt || rawDesc || '';
          const args = output.args ?? {};
          const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
          const description = typeof args.description === 'string' ? args.description : '';

          // 现有：注册任务
          // 防御：拦截非法 task_id（非 ses_ 前缀），同时从 output.args 删除避免 OpenCode 校验失败
          if (typeof args.task_id === 'string' && args.task_id !== '' && !args.task_id.startsWith('ses_')) {
            delete output.args.task_id;
          }
          const alias = tracker.registerBeforeTask(input.sessionID, {
            description,
            subagent_type: subagentType,
            task_id: (typeof output.args.task_id === 'string' && output.args.task_id.startsWith('ses_')) ? output.args.task_id : undefined,
            background: typeof args.background === 'boolean' ? args.background : undefined,
          }, input.callID); // 按 (parentSessionID, callID) 精确关联，不再依赖共享 _lastAlias
          syncTrackerState(input.sessionID ?? '');
          tracker.pruneTerminalJobs(STALE_TASK_MS); // 清理超 30 分钟未更新的终态 job，防止 jobs Map 无限膨胀

          // 注册到 orchestration engine（诚实镜像原生 task，不自动派发/重试）
          if (orchestrationLayer && subagentType && description) {
            try {
              // 重复 before：tracker 按 (parent,callID) 幂等返回原 alias；engine 侧先查重避免
              // registerTask 的 duplicate 异常（不用 catch 当正常控制流）
              if (!orchestrationLayer.engine.getTask(alias)) {
                orchestrationLayer.engine.registerTask(
                  alias,
                  subagentType,
                  description,
                  [], // deps — 由 orchestrator 通过 prompt 指定
                );
              }
              // 注入契约上下文到 prompt：
              // 仅清理插件自生成的 goal-only 空壳契约块（含其他内容的契约块保守保留），
              // 新契约非空才追加，且文本中已保留契约块时不重复追加（简单保守去重）
              const targetField = output.args?.prompt ? 'prompt' : 'description';
              if (output.args?.[targetField] && typeof output.args[targetField] === 'string') {
                output.args[targetField] = stripExistingContracts(output.args[targetField]);
                const contractText = orchestrationLayer.contractMgr.buildPrompt({
                  goal: description,
                  prerequisites: [],
                  constraints: [],
                });
                if (contractText && !output.args[targetField].includes('<!-- CONTRACT_BEGIN -->')) {
                  output.args[targetField] += '\n' + contractText;
                }
              }
              // 原生 task 调用已被接受并启动：ready → running（异常情况结构化记录，不吞错、不假 started；
              // 未接线 DAG 依赖时 deps 为空正常 ready→running，pending 仅理论上存在）
              const lr = orchestrationLayer.engine.applyLifecycleEvent(alias, 'running');
              if (!lr.ok) {
                appendLog('orchestration', `before: applyLifecycleEvent(running) ${lr.reason} for ${alias}（状态来自实际原生生命周期，未接线 DAG 依赖不强制推进）`);
                taskDiag({
                  t: 'task',
                  callID: input.callID,
                  session: input.sessionID?.slice(0, 20),
                  alias,
                  event: 'state_changed',
                  status: orchestrationLayer.engine.getState(alias) ?? 'pending',
                  lastActivityAt: Date.now(),
                });
              } else {
                taskDiag({
                  t: 'task',
                  callID: input.callID,
                  session: input.sessionID?.slice(0, 20),
                  alias,
                  event: 'task_started',
                  status: 'running',
                  lastActivityAt: Date.now(),
                });
              }
            } catch (e) {
              appendSafeLog('orchestration', 'registerTask error', e);
            }
          }

          // 新增：构建上下文（默认不注入——所有代理默认策略均为 none，不注册/
          // 填充/读取父历史；仅显式 context_override 或用户配置 context.strategy
          // opt-in 后才会注册并注入历史详情）
          if (subagentType) {
            const strategy = typeof args.context_override === 'string'
              ? (args.context_override as ContextStrategy)
              : contextEngine.getStrategy(subagentType);
            if (strategy !== 'none') {
              const contextId = contextEngine.registerContext({ description });
              output.args ??= {};
              // prompt 是子代理实际看到的消息，description 只是 session 标题
              const targetField = typeof output.args.prompt === 'string' ? 'prompt' : 'description';

              // 填充上下文（同步等待完成，确保子代理启动前上下文已就绪）
              await contextEngine.fillContextAsync(contextId, input.sessionID, {
                strategy,
              });

              // 追加详细上下文（文件、决策、错误、依赖）；详情非空才附加——
              // 不再重复输出任务目标（目标已在本任务 prompt/契约中，避免重复膨胀）
              const details = contextEngine.formatContextDetails(contextId);
              if (details) {
                output.args[targetField] = ((targetField === 'prompt' ? output.args.prompt : description) ?? '') + details;
              }
              // 注入即消费完毕：显式释放 registry 条目（本 contextId 不会再被读取——
              // 标记消费路径 consumeMarkedContext 全仓库零调用，注入走的就是上面这次 formatContextDetails）
              contextEngine.releaseContext(contextId);

              // 诊断日志（opt-in，默认关闭）：开启后异步记录上下文注入结果，不阻塞事件循环。
              // 开启方式：COHUB_CTX_DIAG=1 或配置 diag.enabled=true；详见 context/diag-log.ts
              if (ctxDiag.enabled) {
                const finalPrompt = typeof output.args?.prompt === 'string' ? output.args.prompt : '';
                appendCtxDiag({
                  time: new Date().toISOString(),
                  session: input.sessionID?.slice(0, 20) ?? '?',
                  subagent: subagentType,
                  strategy,
                  targetField,
                  hasDetails: !!details,
                  detailsLen: details ? details.length : 0,
                  detailsPreview: details ? details.replace(/\n/g, '\\n').slice(0, 120) : '',
                  promptEnd: finalPrompt.slice(-80),
                }, ctxDiag.filePath);
              }

            }
          }
          // 全局预算兜底：超限时自动降级为裸用户 prompt，保证 JSON 永不超限
          const targetField = typeof output.args?.prompt === 'string' ? 'prompt' : 'description';
          if (output.args?.[targetField] && typeof output.args[targetField] === 'string') {
            output.args[targetField] = enforcePromptBudget(basePrompt, output.args[targetField], DEFAULT_PROMPT_MAX_TOKENS);
          }
        }
      } catch (err) {
        appendLog('tool.execute.before', 'hook 失败', err);
      }
    },

    // 🆕 拦截 task 工具执行后 — 更新任务状态
    'tool.execute.after': async (input, output) => {
      try {
        // cancel_task 集成：按 alias 或 sessionId 定位任务并中止（幂等守卫在 abortJob 内）
        if (input.tool === 'cancel_task') {
          const args = input.args as Record<string, unknown> | undefined;
          const taskId = args?.task_id;
          if (typeof taskId === 'string') {
            const aborted = tracker.abortJob(taskId);
            if (aborted && orchestrationLayer) {
              orchestrationLayer.engine.applyLifecycleEvent(aborted.job.alias, 'cancelled');
              taskDiag({
                t: 'task',
                session: input.sessionID?.slice(0, 20),
                alias: aborted.job.alias,
                event: 'task_cancelled',
                status: 'cancelled',
                lastActivityAt: Date.now(),
              });
            }
          }
          syncTrackerState(input.sessionID ?? '');
        }
        if (input.tool === 'task') {
          // after output 形态（SDK 1.17.15）：{ title, output, metadata }，
          // 从 metadata / 文本中提取子会话 session ID（仅接受 ses_ 前缀）。
          const childSessionId = extractChildSessionId(output);
          const job0 = tracker.getJobByCall(input.sessionID, input.callID);
          if (!job0) {
            // 未知 callID：不回退最近任务，仅诊断观测
            appendSafeLog('tool.execute.after', `after 未知 callID，no-op (parent=${input.sessionID?.slice(0, 20)})`);
            syncTrackerState(input.sessionID ?? '');
            return;
          }

          // P1-3 宿主 subtask 失败路径：result 可 undefined（v1.17.15 SessionPrompt.handleSubtask 失败）。
          // 没有有效工具结果不能当成功——保留 running/unknown 等原生精确终态，不访问 undefined 崩溃，
          // 后续由原生 task part error/abort 或 idle 证据精确收尾。
          if (output === undefined || output === null) {
            appendSafeLog('tool.execute.after', `after 无有效输出，不假成功 (parent=${input.sessionID?.slice(0, 20)})`);
            syncTrackerState(input.sessionID ?? '');
            return;
          }

          // P1-1 宿主 promotion：before 可能未标记 background，但 after 的原生 metadata 明确
          // background:true（宿主 shape {sessionId, background, jobId}）→ 先精确升级为后台。
          // 仅读 metadata 布尔值，绝不从 output 文本（如正文含 'background' 词）推断。
          const meta = (output as Record<string, unknown> | null)?.metadata as Record<string, unknown> | undefined;
          const metaBg = meta && typeof meta === 'object' ? meta.background : undefined;
          if (metaBg === true && !job0.background) {
            tracker.setBackgroundByCall(input.sessionID, input.callID, true);
            // job0 与 tracker 内为同一对象引用，background 已同步
          }

          // 显式结局分类：metadata 显式 status/error 优先；不从任意 output 文本推断失败
          const outcome = classifyTaskAfter(output);
          if (outcome.status === 'cancelled' || outcome.status === 'errored') {
            // task 工具调用明确失败/取消：按 (parent,callID) 精确落真实终态（前台/后台均适用），
            // 不经过后台"只绑定不终结"的 applyCallUpdate 路径
            const term = outcome.status === 'cancelled' ? 'cancelled' : 'errored';
            const up = tracker.finalizeByCall(input.sessionID, input.callID, (childSessionId ?? job0.sessionId) || undefined, term);
            syncTrackerState(input.sessionID ?? '');
            if (up.ok && up.alias && orchestrationLayer) {
              orchestrationLayer.engine.applyLifecycleEvent(up.alias, term === 'cancelled' ? 'cancelled' : 'failed');
            }
            taskDiag({
              t: 'task',
              callID: input.callID,
              session: input.sessionID?.slice(0, 20),
              alias: up.ok ? up.alias : job0.alias,
              event: term === 'cancelled' ? 'task_cancelled' : 'task_failed',
              status: term === 'cancelled' ? 'cancelled' : 'failed',
              durationMs: Date.now() - job0.createdAt,
              lastActivityAt: Date.now(),
            });
            return;
          }
          // 正常工具返回（或后台显式 running）：前台终结 / 后台仅绑定 childID 保持 running
          const up = tracker.updateAfterTaskByCall(input.sessionID, input.callID, 'completed', childSessionId);
          syncTrackerState(input.sessionID ?? '');
          if (up.ok && orchestrationLayer) {
            try {
              if (!job0.background) {
                // 前台：task 工具同步返回即明确完成 → 引擎镜像 completed（矛盾终态不覆盖）
                const lr = orchestrationLayer.engine.applyLifecycleEvent(job0.alias, 'completed');
                if (!lr.ok) appendLog('orchestration', `after: applyLifecycleEvent(completed) ${lr.reason} for ${job0.alias}`);
                // 从 output.output 文本提取契约（output 为对象，不假设 string）
                const text = typeof output === 'string'
                  ? output
                  : (typeof (output as Record<string, unknown> | null)?.output === 'string'
                    ? (output as Record<string, string>).output
                    : '');
                if (text) {
                  const contract = orchestrationLayer.contractMgr.extract(text);
                  if (contract) orchestrationLayer.engine.setResult(job0.alias, contract.keyResult, contract);
                }
                taskDiag({
                  t: 'task',
                  callID: input.callID,
                  session: input.sessionID?.slice(0, 20),
                  alias: job0.alias,
                  event: 'task_completed',
                  status: 'completed',
                  durationMs: Date.now() - job0.createdAt,
                  lastActivityAt: Date.now(),
                });
              } else {
                // 后台：after 只确认"调用已派发"，不证明子会话完成——先绑定 childID 保持 running，
                // 再补一次有界终态核验（P1-2：首次 child 绑定前 idle 可能已丢失，这里兜底收尾）。
                // 正常情况 child 尚无终态消息（messages=[]）→ reconcile 返回 'unknown' → 仍 running。
                // P2-2 早到 idle 结果捕获补回：快照（alias/parent/call/child/createdAt/agent）与
                // 本次调用身份（wasRunningAtAfter）须在第一个 await（reconcileJobTerminal）前固定，
                // 确认 completed 后补捕获（质量/token/复用预算/显式依赖传播随 idle 共用路径写回）。
                const snapAlias = job0.alias;
                const snapParent = job0.parentSessionId;
                const snapCall = job0.callID;
                const snapChild = childSessionId ?? job0.sessionId;
                const snapCreatedAt = job0.createdAt;
                const snapAgent = job0.agent;
                const wasRunningAtAfter = job0.status === 'running';
                taskDiag({
                  t: 'task',
                  callID: input.callID,
                  session: input.sessionID?.slice(0, 20),
                  alias: job0.alias,
                  event: 'state_changed',
                  status: 'running',
                  lastActivityAt: Date.now(),
                });
                // 第一个 await（reconcile）前仅观察当前采样代次、不递增：await 期间并发 idle
                // 若已收尾 completed 并分配新代次，本 after 不得借用其 completed 状态额外捕获
                // （递增代次会使 idle 有效采样失效，Board 变输入未知）。
                const seqAtAfter = samplingSeq.get(snapAlias) ?? 0;
                // reconcile 返回"本次实际完成 running→completed"才补捕获：
                // 由并发 idle 收尾（竞态复核拦截，本次未实际收尾）/ 无终态证据保持 running /
                // finalize 失败 / 非 completed 终态 → false → 不补捕获、不递增代次。
                const finalizedByThis = await reconcileJobTerminal(job0);
                // 仅本次 after 负责收尾（wasRunningAtAfter 防重复 after 重复捕获）且确认 completed、
                // 已绑定 childID 时才补捕获；failed/权限终态/仍 running 不捕获、不虚构质量数据。
                if (finalizedByThis && wasRunningAtAfter && snapChild) {
                  // 代次未变：await 期间无更新的采样请求 → 本捕获仍为最新；已变 → 过期不采样
                  // （首次 after 时 Map 尚无条目：左侧必须与 await 前初始化一致用 ??0，
                  // 否则 undefined !== seqAtAfter(0) 会让早到 idle 补捕获全部失效）
                  if ((samplingSeq.get(snapAlias) ?? 0) === seqAtAfter) {
                    const nowJob = snapCall
                      ? tracker.getJobByCall(snapParent, snapCall)
                      : tracker.getJobBySessionId(snapChild);
                    if (nowJob && nowJob.status === 'completed' && nowJob.alias === snapAlias && nowJob.sessionId === snapChild) {
                      // 代次在确认后分配：本捕获为最新采样请求（先于本 after 的并发 idle 捕获将被拦截），
                      // 与 idle 共用同一 samplingSeq 守卫——旧请求迟到不覆盖新结果。
                      const seq = seqAtAfter + 1;
                      samplingSeq.set(snapAlias, seq);
                      captureAndWriteBack({
                        alias: snapAlias,
                        parentSessionId: snapParent,
                        callID: snapCall,
                        childSessionId: snapChild,
                        agent: snapAgent,
                        createdAt: snapCreatedAt,
                        seq,
                      });
                    }
                  }
                }
              }
            } catch (e) {
              appendSafeLog('orchestration', 'afterTask engine 同步失败', e);
            }
          }
        }
      } catch (err) {
        appendSafeLog('tool.execute.after', 'hook 失败', err);
      }
    },

    // 🆕 监听 session 事件 — 背景任务完成时更新状态
    event: async (input) => {
      try {
        const e = input.event as { type: string; properties?: unknown };
        const props = e.properties as Record<string, unknown> | undefined;
        const sessionId = extractSessionIdFromEvent(props);

        if (e.type === 'session.idle') {
          if (!sessionId) return;
          // 唯一活动归属定位：已结束历史不参与计数（修复复用场景新调用永不收尾）
          const active = tracker.findActiveByChildSessionId(sessionId);
          syncTrackerState(tracker.currentParentSessionId);
          if (!active.ok) {
            // no-match（无 running）或 ambiguous（多个 running 共享 childID）：保守不操作
            appendSafeLog('event', `session.idle ${active.reason} 不操作 (session=${sessionId.slice(0, 20)})`);
            return;
          }
          const job = active.job;

          // 有界终态证据验证 + 竞态复核 + 落真实终态（与 after 绑定后补核验共用同一 reconcile）
          // 代次守卫：每 alias 采样序号递增，仅最新采样请求可提交（未知亦遵守），
          // 同 alias/callID/childID 并发 idle 的旧 capture 迟到不得覆盖新结果。
          // 先惰性清理已回收 job（被 prune）的序号条目，避免映射无界增长。
          for (const [a] of samplingSeq) {
            if (!tracker.getJobByAlias(a)) samplingSeq.delete(a);
          }
          // 快照与序号必须在第一个 await（reconcileJobTerminal）之前捕获分配：
          // 旧 idle verify 迟到若在 await 后才分配序号，会取得更大序号使新采样失效（旧采样反而写回）。
          const qAlias = job.alias;
          const qParent = job.parentSessionId;
          const qCall = job.callID;
          const qCreatedAt = job.createdAt;
          const qAgent = job.agent;
          const seq = (samplingSeq.get(qAlias) ?? 0) + 1;
          samplingSeq.set(qAlias, seq);

          await reconcileJobTerminal(job);

          // await 后立刻检查是否过期：期间已有更新的采样请求（新 idle 已注册）→ 本请求过期，
          // 不发起采样/写回——旧 verify 迟到不得采样，也不撤销最新 unknown 写回。
          if (samplingSeq.get(qAlias) !== seq) return;

          // 捕获子代理结果用于依赖传播 + 质量回送（P0-1 负反馈闭环）。
          // 必须持有 alias+parent+call+child+createdAt 快照，异步 then 回来复核仍同一 job 再写回
          // （两次同 child 复用输出不同 quality：旧记录不能被新结果覆盖，且不按 sessionId 首条匹配）。
          captureAndWriteBack({
            alias: qAlias,
            parentSessionId: qParent,
            callID: qCall,
            childSessionId: sessionId,
            agent: qAgent,
            createdAt: qCreatedAt,
            seq,
          });
        } else if (e.type === 'session.deleted') {
          if (!sessionId) return;
          // 明确结局（宿主删除/中断会话）：按真实结局收尾，不自动重试、不假成功。
          // 优先按唯一 active 的 (parent,callID) 精确终结；legacy 无 callID 走唯一关联兜底。
          const active = tracker.findActiveByChildSessionId(sessionId);
          const up = active.ok && active.job.callID
            ? tracker.finalizeByCall(active.job.parentSessionId, active.job.callID, sessionId, 'errored')
            : tracker.updateByChildSessionId(sessionId, 'errored');
          syncTrackerState(tracker.currentParentSessionId);
          if (up.ok && up.alias && orchestrationLayer) {
            orchestrationLayer.engine.applyLifecycleEvent(up.alias, 'failed');
          }
          taskDiag({
            t: 'task',
            session: sessionId.slice(0, 20),
            alias: up.alias,
            event: 'task_failed',
            status: 'failed',
            lastActivityAt: Date.now(),
          });
        } else if (e.type === 'message.part.updated') {
          // 原生 task part 明确失败/取消结局：按父 session + 调用精确映射。
          // 关联优先 (parent, part.callID)；兼容已登记 (parent, part.id)（宿主 subtask 失败路径
          // 用 part.id 作调用标识，后续错误 part.callID 可能不同）。两键分别命中不同 alias → 拒绝歧义不猜。
          // 仅对已登记的确切 part id 回退，不建立任意错误关联。
          // part.completed 不代表子会话完成（后台调用返回即 completed），交 idle+证据收尾。
          const part = props?.part as Record<string, unknown> | undefined;
          if (!part || part.type !== 'tool' || part.tool !== 'task') return;
          const pstate = part.state as Record<string, unknown> | undefined;
          const pstatus = pstate?.status;
          if (pstatus !== 'error' && pstatus !== 'cancelled') return; // 仅明确失败/取消结局
          const parentSessionID = typeof part.sessionID === 'string' ? part.sessionID : undefined;
          if (!parentSessionID) return; // 缺 sessionID 不关联
          const partCallID = typeof part.callID === 'string' ? part.callID : undefined;
          const partID = typeof part.id === 'string' ? part.id : undefined;
          const byCall = partCallID ? tracker.getJobByCall(parentSessionID, partCallID) : undefined;
          const byId = partID ? tracker.getJobByCall(parentSessionID, partID) : undefined;
          if (byCall && byId && byCall.alias !== byId.alias) return; // 歧义：两键命中不同 alias，拒绝不猜
          const job = byCall ?? byId;
          if (!job || job.status !== 'running') return; // 未知关联不回退；已终态幂等
          const term = pstatus === 'cancelled' ? 'cancelled' : 'errored';
          const up = tracker.finalizeByCall(parentSessionID, job.callID!, job.sessionId || undefined, term);
          syncTrackerState(tracker.currentParentSessionId);
          if (up.ok && up.alias && orchestrationLayer) {
            orchestrationLayer.engine.applyLifecycleEvent(up.alias, term === 'cancelled' ? 'cancelled' : 'failed');
          }
          taskDiag({
            t: 'task',
            session: parentSessionID.slice(0, 20),
            alias: up.ok ? up.alias : job.alias,
            event: term === 'cancelled' ? 'task_cancelled' : 'task_failed',
            status: term === 'cancelled' ? 'cancelled' : 'failed',
            lastActivityAt: Date.now(),
          });
        } else if (e.type === 'session.status') {
          if (!sessionId) return;
          const status = props?.status as Record<string, unknown> | undefined;
          // 宿主 retry：仅观测 attempt/next，不终结（重试中的临时错误不是最终结局）
          if (status?.type === 'retry') {
            taskDiag({
              t: 'task',
              session: sessionId.slice(0, 20),
              event: 'retry_scheduled',
              status: 'running',
              retryAttempt: typeof status.attempt === 'number' ? status.attempt : undefined,
              retryNextMs: typeof status.next === 'number' ? status.next - Date.now() : undefined,
              lastActivityAt: Date.now(),
            });
            appendLog('event', `session.status retry 观测 (session=${sessionId.slice(0, 20)} attempt=${String(status.attempt)})`);
          }
        } else if (e.type === 'session.error') {
          // sessionID 缺失：不归给任何任务
          if (!sessionId) {
            appendSafeLog('event', 'session.error 缺少 sessionID，不关联任何任务', props?.error);
            return;
          }
          // 不凭 isRetryable 推断必成功：API 错误可能只是宿主重试中的临时错误，
          // 保守仅观测不终结；最终结局由 session.deleted / idle+终态证据确认。
          if (ctxDiag.enabled) {
            const info = classifyRateLimit(props?.error);
            taskDiag({
              t: 'task',
              session: sessionId.slice(0, 20),
              event: 'rate_limit_detected',
              status: 'running',
              rateLimitKind: info.kind,
              retryAfterMs: info.retryAfterMs,
              lastActivityAt: Date.now(),
            });
          }
          appendSafeLog('event', `session.error 仅观测不终结 (session=${sessionId.slice(0, 20)})`, props?.error);
        }
      } catch (err) {
        appendSafeLog('event', '事件处理失败', err);
      }
    },

    // 🆕 注入 Background Job Board
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages || !Array.isArray(output.messages)) return;

        // 诊断 + 修复：对所有 user 消息确保有 text part（防止 API 报 empty content）
        if (output.messages) {
          for (let d = 0; d < output.messages.length; d++) {
            const msg = output.messages[d];
            if (msg.info?.role !== 'user') continue; // 不碰 assistant/system 消息
            const parts = msg.parts;
            if (!parts || !Array.isArray(parts) || parts.length === 0) {
              msg.parts = [{ type: 'text', text: ' ' }] as any;
              void appendLog('messages.transform',
                `⚠️ 消息[${d}] role=user parts为空，已推入占位text part`);
            } else {
              const hasTextPart = parts.some(p => p.type === 'text');
              if (!hasTextPart) {
                (msg.parts as any[]).push({ type: 'text', text: ' ' });
                void appendLog('messages.transform',
                  `⚠️ 消息[${d}] role=user parts无text类型(types=[${parts.map(p => p.type).join(',')}])，已推入占位text part`);
              }
            }
          }
        }

        // 从最后一条 user 消息提取 sessionID
        let lastUserMsg: (typeof output.messages)[number] | undefined;
        let sessionID: string | undefined;
        for (let i = output.messages.length - 1; i >= 0; i--) {
          const m = output.messages[i];
          if (m.info?.role === 'user') {
            lastUserMsg = m;
            sessionID = m.info?.sessionID as string | undefined;
            break;
          }
        }

        if (!lastUserMsg) return;

        // 防御：parts 不存在、非数组、或为空数组时，推入占位 text part
        if (!lastUserMsg.parts || !Array.isArray(lastUserMsg.parts) || lastUserMsg.parts.length === 0) {
          lastUserMsg.parts = [{ type: 'text', text: ' ' }] as any;
          void appendLog('messages.transform',
            `⚠️ lastUserMsg parts为空，已推入占位text part (session=${sessionID?.slice(0,20) ?? '?'})`);
        } else if (!lastUserMsg.parts.some(p => p.type === 'text')) {
          // parts 存在但没有任何 text 类型，推入一个空 text part
          lastUserMsg.parts.push({ type: 'text', text: ' ' } as any);
          void appendLog('messages.transform',
            `⚠️ lastUserMsg parts无text类型，已推入占位text part (session=${sessionID?.slice(0,20) ?? '?'})`);
        }

        // 1. 注入 Background Job Board（仅当 sessionID 为有效非空字符串时注入，
        //    否则跳过注入——避免 tracker 全局回退导致跨会话泄漏）
        if (typeof sessionID === 'string' && sessionID.length > 0) {
          // 复用建议：仅策略启用时传入预算（关闭/非法回退默认时不传 → Board 与旧版一致）
          const board = tracker.getBoardText(
            sessionID,
            reuseBudget.enabled ? { maxInputTokens: reuseBudget.maxInputTokens } : undefined,
          );
          if (board) {
            for (let j = lastUserMsg.parts.length - 1; j >= 0; j--) {
              const part = lastUserMsg.parts[j];
              if (part.type === 'text') {
                part.text = (part.text || '') + '\n\n' + board;
                break;
              }
            }
          }
        }


        // 兜底：注入完成后若 lastUserMsg content 仍为空，设非空占位
        {
          let userContent = '';
          for (const p of lastUserMsg.parts ?? []) {
            if (p.type === 'text') userContent += (p.text ?? '');
          }
          if (!userContent.trim()) {
            for (const p of lastUserMsg.parts ?? []) {
              if (p.type === 'text') { p.text = ' '; break; }
            }
            void appendLog('messages.transform',
              `⚠️ 注入后 content 为空，已设空格占位 (session=${sessionID?.slice(0,20) ?? '?'})`);
          }
        }

      } catch (err) {
        appendLog('messages.transform', 'hook 失败', err);
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      // 将中文语言指令和并行工具调用指令注入到系统提示词中
      try {
        if (output?.system && Array.isArray(output.system)) {
          output.system.push(CHINESE_LANGUAGE_INSTRUCTION);
          output.system.push(PARALLEL_TOOL_INSTRUCTION);
        }
      } catch (err) {
        appendLog('system.transform', 'hook 失败', err);
      }
    },

    dispose: async () => {
      clearInterval(cleanupTimer);
      clearInterval(contextCleanupTimer);
      samplingSeq.clear(); // 采样代次守卫随插件生命周期释放
    },
  };
};

export const server = CoHubPlugin;
export default CoHubPlugin;
