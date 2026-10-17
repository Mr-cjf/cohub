// src/context/types.ts — 上下文共享系统所有类型定义

/** 上下文注入策略 */
export type ContextStrategy = 'none' | 'relevant' | 'summary' | 'full';

/** 任务相关文件描述 */
export interface RelevantFile {
  path: string;
  lines?: string;       // 如 "42-87"
  summary: string;       // 一句话说明该文件与任务的关系
  body?: string;       // summary 策略下按 token 预算截断后的文件正文
}

/** 前置子代理的完成结果 */
export interface DependencyResult {
  alias: string;         // 如 "exp-1"
  agent: string;         // 如 "co-explorer"
  keyOutput: string;     // 子代理结果中的关键信息
  capturedAt: number;    // Date.now()
  /** 捕获时所在的父会话 ID（读端按此过滤，隔离跨父会话的摘要串注入） */
  parentSessionId: string;
}

/**
 * 复用预算采样：最近一次可信归一化输入（tokens.input + cache.read + cache.write）。
 * 仅在能确认「最新且有可信 tokens」的 assistant 时产生；时间缺失/最大时间并列/
 * 字段无效/求和溢出 → 不写本字段（未知而非 0，绝不捞旧数据回填）。
 */
export interface ReuseInputSample {
  /** 归一化输入 token 数（input + cache.read + cache.write，不叠加 output/reasoning） */
  inputTokens: number;
  /**
   * 来源消息真实创建时间（time.created）；只在可确认最新时写入，
   * 绝不回退当前时间伪装老用量新鲜度。
   */
  sampledAt: number;
  /** 来源 assistant 消息 ID（缺失时省略） */
  messageId?: string;
}

/** 注入到子代理的结构化上下文 */
export interface TaskContext {
  goal: string;                        // 任务目标
  relevantFiles: RelevantFile[];       // 相关文件列表
  decisions: string[];                 // 父 session 中做出的关键决策
  errors: string[];                    // 需要修复的错误信息
  dependencies: DependencyResult[];    // 前置子代理的完成结果
  strategy?: ContextStrategy;  // 本次注入策略（summary 模板分道用）
}

/** 上下文系统配置 */
export interface ContextConfig {
  /** 各代理的默认上下文策略 */
  strategy: Record<string, ContextStrategy>;
  /** 最多注入多少个相关文件 */
  maxFiles: number;
  /** 最多注入多少条决策 */
  maxDecisions: number;
  /** 最多注入多少条错误 */
  maxErrors: number;
  /** 最多注入多少条依赖结果 */
  maxDependencies: number;
  /** 是否启用依赖传播（子代理结果自动注入到后续子代理） */
  dependencyPropagation: boolean;
  /** LLM 摘要最大 token 数 */
  summarizeMaxTokens: number;
  /**
   * summary 文件正文读取模式（可选，缺省即 'bounded'）：
   * - 'bounded'：按 token 预算推导字节上限有界读取（默认，注入结果与全量读+截断等价，读取成本大幅下降）；
   * - 'full'：保留旧行为——全量 readFileSync 后再按预算截断（保守选项，可关闭激进裁剪）。
   */
  summaryReadMode?: 'bounded' | 'full';
  /** 从父 session 中扫描最近多少条消息 */
  relevantMessageWindow: number;
  /** 错误列表总字符上限 */
  maxErrorTotalChars: number;
  /** 依赖结果 keyOutput 截断字符数 */
  dependencyKeyOutputChars: number;
}

/** 默认配置 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  /**
   * 默认全部 'none'：历史上下文默认不注入，避免每次委派自动读取父会话历史。
   * 需要注入时由调度者显式传递 context_override 或在用户配置 context.strategy 中 opt-in。
   */
  strategy: {
    'co-explorer': 'none',
    'co-librarian': 'none',
    'co-observer': 'none',
    'co-fixer': 'none',
    'co-designer': 'none',
    'co-planner': 'none',
    'co-oracle': 'none',
    'co-council': 'none',
    'co-rule-user': 'none',
    'co-rule-project': 'none',
    'co-rule-app': 'none',
  },
  maxFiles: 5,
  maxDecisions: 10,
  maxErrors: 5,
  maxDependencies: 8,
  dependencyPropagation: false,
  summarizeMaxTokens: 2000,
  summaryReadMode: 'bounded',
  relevantMessageWindow: 20,
  maxErrorTotalChars: 600,
  dependencyKeyOutputChars: 200,
};

/**
 * 软复用预算配置（仅提示不建议复用，不强制切换会话/清空历史/降低模型 context）。
 * 默认阈值 200_000 输入 token；严格「超过」才警告，预算不是硬限制。
 */
export interface ReuseBudgetConfig {
  /** 是否启用复用预算提示（关闭时 Board 不显示建议，也不影响既有任务追踪） */
  enabled: boolean;
  /** 软阈值：最近输入（input + cache.read + cache.write）超过此值 → 标注不建议复用 */
  maxInputTokens: number;
}

/** 默认复用预算配置 */
export const DEFAULT_REUSE_BUDGET_CONFIG: ReuseBudgetConfig = {
  enabled: true,
  maxInputTokens: 200_000,
};
