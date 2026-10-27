// cohub 会话复盘报告 —— 公共 DTO 契约（纯类型，无运行期逻辑）
//
// 设计事实依据（宿主 0.2.1-rc.2）：
//   · SessionEvent 信封 = { type, seq, time, data, ignorable? }；seq/time 只在信封上，
//     不在 payload 里（dsh-session types.d.ts:489-512），因此 traceability 一律用
//     (sessionId, seq) 二元组定位，time 只作展示/排序辅助，不作证据键。
//   · turn/end payload 仅 { turn, reason }（dsh-session types.d.ts:273-276）——
//     统计所需的 usage / 工具调用必须从 turn 区间内的其他事件回读。
//   · SubagentResult 无 usage 字段（dsh-subagent types.d.ts:256-282），
//     子代理用量须读子会话日志里的 assistant/message.usage。
//
// 【硬性报告纪律】每条 Finding 必须带 evidence；无证据不得进入正式结论区。
//   findings[].evidence 至少 1 条（sessionId + turn + seq，可选 callId 精确定位工具调用）。
//   纯推断/经验性内容只能作为 limitations 说明或排除在正式结论之外，不允许「裸结论」。
//   analysis.inputDigest 记录喂给模型的输入指纹，inputTruncated 表示输入被裁剪过——
//   两者共同界定本报告的结论适用范围（不可超出输入边界下断言）。

/** 报告顶层结构（schemaVersion=1，后续变更须升版本号）。 */
export interface ReviewReport {
  /** 报告结构版本；破坏性字段变更时递增，消费端按此路由解析逻辑。 */
  schemaVersion: 1;
  /** 项目身份：cwd 取会话 header.cwd（可空），key 为规范化项目键（如目录 basename + hash）。 */
  project: { cwd: string | null; key: string };
  /** 本次复盘覆盖的根会话（主会话）id；其子代理会话在 sessions 中按 parentSessionId 挂接。 */
  rootSessionId: string;
  /** 采集覆盖度：哪些会话、读到第几个 seq，是否存在缺口或被裁剪。 */
  coverage: {
    /** sessionId → 已完整消费到的最后一个 seq（含）；缺失即视为未覆盖。 */
    throughSeq: Record<string, number>;
    /** 是否所有目标会话都读到末尾且无缺口；false 时报告结论须降级。 */
    complete: boolean;
    /** 缺口描述（如 "session-x: seq 40..46 缺失"），空数组表示无缺口。 */
    gaps: string[];
    /** 喂给 LLM 的输入是否被裁剪（超预算截断）；true 时 analysis 结论不得外推到未读区间。 */
    inputTruncated: boolean;
  };
  /** 参与复盘的会话摘要（根会话 + 其可达子代理会话）。 */
  sessions: SessionSummary[];
  /** 委派尝试记录（parent → child 的每次 spawn/重试），用于评估调度行为。 */
  attempts: AttemptRecord[];
  /** 分析结论；每条必须带 evidence。 */
  findings: Finding[];
  /** 上一次 LLM 分析的元数据（谁、用哪个模型、跑了几次、结果状态）。 */
  analysis: {
    /** 分析请求 id（幂等/去重与日志关联用）。 */
    requestId: string;
    /** 输入指纹（对规范化输入做内容哈希），用于判断结论是否对应当前日志。 */
    inputDigest: string;
    /** LLM provider 名（如 deepseek）。 */
    provider: string;
    /** 模型名。 */
    model: string;
    /** 本次分析发起的模型调用次数（含重试）。 */
    invocations: number;
    /** completed=正常完成；interrupted=被取消；failed=失败（此时 findings 可能不完整）。 */
    status: "completed" | "interrupted" | "failed";
    /**
     * 失败/降级原因（可读中文）。status='failed' 时必填——
     * 过去只 logger.warn，用户在报告里毫无线索（B-2）。仅作说明，不影响结论证据纪律。
     */
    error?: string;
    /**
     * 模型原始输出前 2000 字（仅解析失败或疑似截断时保留）。
     * 只存 error 里的一小段无法区分「截断」与「格式错误」，故把原始输出留档定位问题。
     */
    rawOutput?: string;
    /** 模型原始输出的完整字符长度；与 rawOutput.length 对比即可判断是否被裁剪过。 */
    rawOutputLength?: number;
  };
}

/** 单个会话的摘要（根会话或子代理会话）。 */
export interface SessionSummary {
  sessionId: string;
  /** 父会话 id；根会话为 null。 */
  parentSessionId: string | null;
  /** 按 turn 升序的轮次摘要。 */
  turns: TurnSummary[];
}

/** 单轮摘要：以 turn/end 事件为界（seq/time 取自信封）。 */
export interface TurnSummary {
  /** 轮次号（turn/end payload 的 turn）。 */
  turn: number;
  /** 本轮结束事件的信封定位；kind 为事件类型或 reason（如 "completed"/"aborted"）。 */
  end: { seq: number; time: number; kind: string };
  /** 本轮用量汇总；无任何 usage 证据时为 null（不得编造 0）。 */
  usage: UsageRecord | null;
  /** 汇总到 usage 的证据事件 seq 列表（可追溯：每个数字都能回指日志）。 */
  usageEvidenceSeqs: number[];
  /** 本轮的工调用记录。 */
  tools: ToolRecord[];
}

/** 一次模型调用的 token 用量（字段语义同宿主 llm usage；缺省用 null 而非 0）。 */
export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  /** 宿主未给 totalTokens 时为 null，由消费端决定是否按 input+output 显示。 */
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

/** 一次工具调用的记录（call/result 配对；无 result 时 status=pending）。 */
export interface ToolRecord {
  /** 工具调用 id（tool/call 与 tool/result 的配对键）。 */
  callId: string;
  /** 工具名。 */
  name: string;
  /** tool/call 事件 seq（证据键）。 */
  callSeq: number;
  /** tool/result 事件 seq；未返回时 null。 */
  resultSeq: number | null;
  /** 调用开始时间（tool/call 信封 time）。 */
  startedAt: number;
  /** 结束时间（tool/result 信封 time）；未返回时 null。 */
  endedAt: number | null;
  /** success/error 由 result 判定；pending 表示无结果事件。 */
  status: "success" | "error" | "pending";
}

/** 一次子代理委派尝试（parent 侧定位 + child 会话关联）。 */
export interface AttemptRecord {
  /** 发起方定位：哪个会话、哪一轮、哪个 seq、哪个工具调用。 */
  parent: { sessionId: string; turn: number; seq: number; callId: string };
  /** 批内任务序号（delegate_batch）；单次委派为 0。 */
  taskIndex: number;
  /** 同一 parent 调用下的重试序号（0 起）。 */
  attempt: number;
  /** 子代理会话 id（subagent/start 的 childId 或会话 header.id）。 */
  childSessionId: string;
  startedAt: number;
  endedAt: number;
  /** 结果（stopReason / 失败分类），自由文本，便于跨版本容纳新 reason。 */
  outcome: string;
}

/** 一条分析结论（observation/praise/issue/suggestion 四类）。 */
export interface Finding {
  /** 报告内唯一 id（如 "f-001"），供客户端引用与去重。 */
  id: string;
  kind: "observation" | "praise" | "issue" | "suggestion";
  /** 结论文本（自然语言）。 */
  text: string;
  /** 证据列表；**不得为空**——无证据的结论不得进入正式结论区。 */
  evidence: Evidence[];
  /** 本条结论的局限（如「仅基于前 40 条事件」「子会话 usage 缺失」）。 */
  limitations: string[];
}

/** 一条可追溯证据（sessionId + seq 必填，callId 可选精确定位工具调用）。 */
export interface Evidence {
  sessionId: string;
  turn: number;
  seq: number;
  callId: string | null;
}
