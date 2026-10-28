// test/review-render.ts —— src/review-render.ts 单测（手写 report 对象，不依赖 review-report.ts）
// 覆盖：骨架、usage=null 渲染为 `—`（不得写 0）、无 attempts 不渲染委派树、
//       kind 分组顺序、锚点可追溯、无证据 finding 进「未验证」且不入正式分组、gaps 触发人工复核提示。
// 用法：node test/review-render.ts（node >= 24 类型剥离）
import { renderMarkdown } from "../src/review-render.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

/** 构造一份最小可用 report（可逐字段覆盖）。 */
function makeReport(over: any = {}) {
  return {
    schemaVersion: 1,
    project: { cwd: "C:\\proj\\demo", key: "demo-abc123" },
    rootSessionId: "sess-root",
    coverage: { throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false },
    sessions: [
      {
        sessionId: "sess-root",
        parentSessionId: null,
        turns: [
          {
            turn: 1,
            end: { seq: 12, time: 1000, kind: "completed" },
            usage: { inputTokens: 1200, outputTokens: 340, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
            usageEvidenceSeqs: [11],
            tools: [
              { callId: "c1", name: "read", callSeq: 5, resultSeq: 6, startedAt: 1, endedAt: 2, status: "success" },
            ],
          },
          {
            turn: 2,
            end: { seq: 33, time: 2000, kind: "completed" },
            usage: null, // 关键：无 usage 证据
            usageEvidenceSeqs: [],
            tools: [
              { callId: "c2", name: "bash", callSeq: 20, resultSeq: 21, startedAt: 3, endedAt: 4, status: "error" },
              { callId: "c3", name: "bash", callSeq: 22, resultSeq: null, startedAt: 5, endedAt: null, status: "pending" },
            ],
          },
        ],
      },
    ],
    attempts: [],
    findings: [],
    analysis: {
      requestId: "req-1", inputDigest: "sha256:aaa", provider: "deepseek",
      model: "deepseek-v4", invocations: 1, status: "completed",
    },
    ...over,
  };
}

/** 一条带证据的 finding。 */
function verifiedFinding(id: string, kind: string, text: string, seq = 10, extra: any = {}) {
  return {
    id, kind, text,
    evidence: [{ sessionId: "sess-root", turn: 1, seq, callId: null }],
    limitations: [],
    ...extra,
  };
}

// ---- 用例 1：骨架（标题/元信息/分轮总览）----
{
  const md = renderMarkdown(makeReport());
  check("骨架-标题", md.startsWith("# 会话复盘报告"));
  check("骨架-项目 cwd", md.includes("项目 cwd：C:\\proj\\demo"));
  check("骨架-root session id", md.includes("root session id：sess-root"));
  check("骨架-生成时间", md.includes("生成时间：20"));
  check("骨架-事件流完整性标记", md.includes("事件流完整性：complete"));
  check("骨架-旧误导文案已移除", !md.includes("采集完整性：complete（所有目标会话已读至末尾）"));
  check("骨架-会话集合覆盖行", md.includes("- 会话集合覆盖：未知（本报告由旧版本生成，未记录子会话总数）"));
  check("骨架-覆盖范围表", md.includes("## 覆盖范围") && md.includes("| sess-root | 42 |"));
  check("骨架-分轮总览表头", md.includes("| turn | 结束原因 | tokens(in/out) | 工具数 | 错误数 |"));
  check("骨架-turn1 行", md.includes("| 1 | completed | 1200/340 | 1 | 0 |"));
  check("骨架-turn2 行错误数", md.includes("| 2 | completed | — | 2 | 1 |"));
}

// ---- 用例 2：usage 为 null → `—`，全文无伪造 0 tokens ----
{
  const md = renderMarkdown(makeReport());
  const turn2Line = md.split("\n").find(l => l.startsWith("| 2 |")) ?? "";
  check("null-usage 单元格为 —", turn2Line.includes("| — |"));
  check("null-usage 不写 0/0", !turn2Line.includes("0/0"));
  check("全文不含伪造 0 tokens", !/0\s*tokens/i.test(md));
  check("空 sessions 也不崩", renderMarkdown(makeReport({ sessions: [] })).includes("## 分轮总览"));
}

// ---- 用例 3：attempts 为空 → 无「委派树」节 ----
{
  const noAttempt = renderMarkdown(makeReport({ attempts: [] }));
  check("无 attempts → 不含委派树", !noAttempt.includes("委派树"));
  const withAttempt = renderMarkdown(makeReport({
    attempts: [{
      parent: { sessionId: "sess-root", turn: 1, seq: 7, callId: "c9" },
      taskIndex: 0, attempt: 0, childSessionId: "sess-child",
      startedAt: 1000, endedAt: 3500, outcome: "completed",
    }],
  }));
  check("有 attempts → 含委派树", withAttempt.includes("## 委派树"));
  check("委派树行格式", withAttempt.includes("→ sess-child (completed, 2500ms)"));
}

// ---- 用例 4：findings 按 kind 分组顺序 ----
{
  const md = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "observation", "观察一", 11),
      verifiedFinding("f2", "suggestion", "建议一", 12),
      verifiedFinding("f3", "issue", "问题一", 13),
      verifiedFinding("f4", "praise", "表扬一", 14),
    ],
  }));
  const iPraise = md.indexOf("### praise");
  const iIssue = md.indexOf("### issue");
  const iSugg = md.indexOf("### suggestion");
  const iObs = md.indexOf("### observation");
  check("分组顺序 praise<issue", iPraise >= 0 && iPraise < iIssue);
  check("分组顺序 issue<suggestion", iIssue < iSugg);
  check("分组顺序 suggestion<observation", iSugg < iObs);
  check("发现节存在", md.includes("## 发现"));
}

// ---- 用例 5：每条 finding 含 seq 锚点 ----
{
  const md = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "praise", "表扬一", 11),
      verifiedFinding("f2", "issue", "问题一", 13),
    ],
  }));
  check("锚点-seq 11", md.includes("seq 11"));
  check("锚点-seq 13", md.includes("seq 13"));
  check("锚点-含 sessionId 与 turn", md.includes("[sess-root · turn 1 · seq 11]"));
  // callId 存在时追加
  const md2 = renderMarkdown(makeReport({
    findings: [{
      id: "f9", kind: "issue", text: "带 callId",
      evidence: [{ sessionId: "sess-root", turn: 1, seq: 5, callId: "call-77" }],
      limitations: [],
    }],
  }));
  check("锚点-追加 callId", md2.includes("[sess-root · turn 1 · seq 5 · call call-77]"));
  // 摘录只应在 excerptLookup 给值时出现
  const md3 = renderMarkdown(makeReport({
    findings: [verifiedFinding("f1", "issue", "问题一", 11)],
  }), { excerptLimit: 5, excerptLookup: (sid, seq) => (seq === 11 ? "abcdefghij" : null) });
  check("摘录-截断到 excerptLimit", md3.includes("摘录：`abcde…`"));
  const md4 = renderMarkdown(makeReport({
    findings: [verifiedFinding("f1", "issue", "问题一", 11)],
  }), { excerptLookup: () => null });
  check("摘录-null 时不渲染摘录行", !md4.includes("摘录："));
}

// ---- 用例 6：无证据 finding 只在「未验证」，不进正式分组（最关键）----
{
  const md = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "issue", "有证据的问题", 13),
      { id: "f2", kind: "issue", text: "裸结论问题", evidence: [], limitations: ["仅凭经验"] },
      { id: "f3", kind: "praise", text: "裸结论表扬", evidence: [] },
    ],
  }));
  const iUnverified = md.indexOf("## 未验证");
  const iLimits = md.indexOf("## 限制说明");
  check("未验证节存在", iUnverified >= 0);
  check("未验证节在发现节之后", iUnverified > md.indexOf("## 发现"));
  check("未验证节在限制说明之前", iUnverified < iLimits);
  const formal = md.slice(md.indexOf("## 发现"), iUnverified);
  const unverifiedSec = md.slice(iUnverified, iLimits);
  check("裸结论不在正式分组", !formal.includes("裸结论问题") && !formal.includes("裸结论表扬"));
  check("裸结论在未验证节", unverifiedSec.includes("裸结论问题") && unverifiedSec.includes("裸结论表扬"));
  check("未验证后缀标记", unverifiedSec.includes("（无证据，未验证）"));
  check("有证据结论仍在正式分组", formal.includes("有证据的问题"));
  check("有证据结论不进未验证", !unverifiedSec.includes("有证据的问题"));
  // 全部无证据时也应工作
  const mdAll = renderMarkdown(makeReport({
    findings: [{ id: "f1", kind: "observation", text: "全裸", evidence: [] }],
  }));
  check("全部无证据-正式区为空占位", mdAll.includes("本报告没有带证据的结论"));
  // 没有未验证 finding → 整节省略
  const mdClean = renderMarkdown(makeReport({ findings: [verifiedFinding("f1", "issue", "干净", 13)] }));
  check("无未验证 finding → 省略整节", !mdClean.includes("## 未验证"));
}

// ---- 用例 7：gaps 非空 → 末段出现「需人工复核」----
{
  const md = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 },
      complete: false,
      gaps: ["sess-root: seq 40..46 缺失"],
      inputTruncated: true,
    },
  }));
  check("覆盖不完整告警块", md.includes("## ⚠️ 覆盖不完整"));
  check("缺口逐条列出", md.includes("sess-root: seq 40..46 缺失"));
  check("限制说明含需人工复核", md.includes("结论需人工复核"));
  // 原意图：限制说明是报告最后一段（其后不得再出现任何二级章节）
  const iLimits7 = md.indexOf("## 限制说明");
  check("限制说明为末段", iLimits7 > 0 && !/\n## /.test(md.slice(iLimits7 + 1)));
  check("限制说明含输入裁剪警告", md.includes("结论不得外推到未读区间。"));
  const clean = renderMarkdown(makeReport());
  check("无缺口时不给人工复核提示", !clean.includes("需人工复核"));
}

// ---- 用例 7b：会话集合覆盖（新字段全有 + 截断 / 全量 / 旧报告未知）----
{
  // 截断：complete=true 与 sessionsTruncated=true 可共存（两维度独立）
  const truncated = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 95, sessionsAnalyzed: 50, sessionsTruncated: true, samplingNote: "按创建时间倒序取最新",
    },
  }));
  check("截断-首页显示已分析 50 / 共 95", truncated.includes("- 会话集合覆盖：已分析 50 / 共 95 个子会话"));
  // 【嵌套括号回归】samplingNote 只存规则、渲染层拼数量 → 只能是单层括号
  check("截断-首页规则平铺成一层括号", truncated.includes("- 会话集合覆盖：已分析 50 / 共 95 个子会话（按创建时间倒序取最新）"));
  check("截断-全报告无嵌套括号", !/（[^（）]*（/.test(truncated));
  check("截断-覆盖范围有取样警告", truncated.includes("⚠️ 子会话取样截断：共 95 个，只分析了 50 个"));
  check("截断-警告规则平铺成一层括号", truncated.includes("只分析了 50 个（按创建时间倒序取最新）。未分析的子会话"));
  check("截断-警告含取样规则", truncated.includes("按创建时间倒序取最新"));
  check("截断-事件流仍标 complete", truncated.includes("事件流完整性：complete"));
  check("截断-限制说明有取样条目", truncated.includes("- 子会话取样截断：共 95 个，只分析了 50 个"));
  // 全量：不得出现任何截断警告
  const full = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 50, sessionsAnalyzed: 50, sessionsTruncated: false,
    },
  }));
  check("全量-首页显示全部 50 个子会话", full.includes("- 会话集合覆盖：全部 50 个子会话"));
  check("全量-无取样警告", !full.includes("⚠️ 子会话取样截断"));
  check("全量-限制说明不提取样", !full.includes("子会话取样截断"));
  check("全量-无缺口时不出需人工复核", !full.includes("需人工复核"));
  // 旧报告：字段全缺 → 「未知」，既不能说全量也不能说截断
  const legacy = renderMarkdown(makeReport());
  check("旧报告-显示未知", legacy.includes("会话集合覆盖：未知"));
  check("旧报告-不禁称全量", !legacy.includes("全部 50 个子会话") && !legacy.includes("（子会话全量）"));
  check("旧报告-不显示截断警告", !legacy.includes("⚠️ 子会话取样截断"));
  check("旧报告-限制说明不提取样截断", !legacy.includes("子会话取样截断"));
  // P2-3：sessionsTruncated 缺失但 lineageTotal + sessionsAnalyzed 都在 → 读取时按契约推断
  const inferredTrunc = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 95, sessionsAnalyzed: 50, samplingNote: "按创建时间倒序取最新",
    },
  }));
  check("P2-3 推断-已分析 50/95 视为截断", inferredTrunc.includes("- 会话集合覆盖：已分析 50 / 共 95 个子会话"));
  check("P2-3 推断-出取样警告", inferredTrunc.includes("⚠️ 子会话取样截断：共 95 个，只分析了 50 个"));
  check("P2-3 推断-限制说明也带截断条目", inferredTrunc.includes("- 子会话取样截断：共 95 个"));
  const inferredFull = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 50, sessionsAnalyzed: 50,
    },
  }));
  check("P2-3 推断-50/50 视为全量", inferredFull.includes("- 会话集合覆盖：全部 50 个子会话"));
  check("P2-3 推断-全量不出警告", !inferredFull.includes("⚠️ 子会话取样截断"));
  // 只有 lineageTotal（无 sessionsAnalyzed）→ 不得推断，仍说未知
  const halfInfo = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 95,
    },
  }));
  check("P2-3 只有 lineageTotal → 仍显示未知，不凭空断定截断", halfInfo.includes("会话集合覆盖：未知"));
  // 只有读失败（无取样截断）：警告文案换成「部分子会话读取失败」，不说「只分析了」
  const readFailed = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: false,
      lineageTotal: 108, sessionsAnalyzed: 105, sessionsTruncated: true, samplingNote: "存在读取失败的子会话",
    },
  }));
  check("读失败-首页显示已分析 105 / 共 108", readFailed.includes("- 会话集合覆盖：已分析 105 / 共 108 个子会话（存在读取失败的子会话）"));
  check("读失败-警告用「读取失败」文案", readFailed.includes("⚠️ 部分子会话读取失败：共 108 个，成功分析 105 个。"));
  check("读失败-不出「取样截断」字样", !readFailed.includes("子会话取样截断"));
  check("读失败-限制说明也提读取失败", readFailed.slice(readFailed.indexOf("## 限制说明")).includes("- 部分子会话读取失败：共 108 个，成功分析 105 个"));
  check("读失败-无嵌套括号", !/（[^（）]*（/.test(readFailed.split("## 覆盖范围")[0]));
}

// ---- 用例 7c：快照边界提示 ----
{
  const md = renderMarkdown(makeReport());
  check("快照边界-带根会话 seq", md.includes("> 本报告是快照：根会话截至 seq 42。"));
  check("快照边界-含需重新生成提示", md.includes("此后的新 turn 与委派不在本报告范围内，需要重新生成。"));
  check("快照边界-在覆盖范围内", md.indexOf("> 本报告是快照") > md.indexOf("## 覆盖范围")
    && md.indexOf("> 本报告是快照") < md.indexOf("## 分轮总览"));
  const other = renderMarkdown(makeReport({
    rootSessionId: "sess-root",
    coverage: { throughSeq: { "sess-root": 777 }, complete: true, gaps: [], inputTruncated: false },
  }));
  check("快照边界-seq 随 throughSeq 变化", other.includes("根会话截至 seq 777"));
}

// ---- 用例 7d：限制说明的四个分支分别成立 ----
{
  // 输入裁剪 + 取样截断同时成立 → 两条分别列出
  const both = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: true, gaps: [], inputTruncated: true,
      lineageTotal: 95, sessionsAnalyzed: 50, sessionsTruncated: true, samplingNote: "按创建时间倒序取最新",
    },
  }));
  const limitsSec = both.slice(both.indexOf("## 限制说明"));
  check("限制-输入裁剪条目存在", limitsSec.includes("模型摘要超过 12000 字被裁剪"));
  check("限制-取样截断条目存在", limitsSec.includes("子会话取样截断：共 95 个，只分析了 50 个"));
  check("限制-两条分别列出（各占一行）",
    limitsSec.includes("- 分析输入被裁剪") && limitsSec.includes("- 子会话取样截断"));
  // complete=false 且未截断 → 只提事件缺口
  const gapOnly = renderMarkdown(makeReport({
    coverage: {
      throughSeq: { "sess-root": 42 }, complete: false, gaps: [], inputTruncated: false,
      lineageTotal: 50, sessionsAnalyzed: 50, sessionsTruncated: false,
    },
  }));
  const limitsGap = gapOnly.slice(gapOnly.indexOf("## 限制说明"));
  check("限制-事件流缺口条目", limitsGap.includes("coverage.complete 为 false"));
  check("限制-未截断时不提取样", !limitsGap.includes("子会话取样截断"));
  check("限制-未裁剪时不提输入裁剪", !limitsGap.includes("模型摘要超过 12000 字"));
  // 无缺口时「无缺口」结论不得出现（因为确实不完整）
  check("限制-complete=false 时不出无缺口结论", !gapOnly.includes("覆盖范围内无已知缺口"));
}

// ---- 用例 8：issue 的 severity（排序 / 渲染 / 统计 / 兼容）----
{
  const md = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "issue", "低危问题", 11, { severity: "low" }),
      verifiedFinding("f2", "issue", "高危问题", 12, { severity: "high" }),
      verifiedFinding("f3", "issue", "中危问题", 13, { severity: "medium" }),
      verifiedFinding("f4", "issue", "另一个高危", 14, { severity: "high" }),
    ],
  }));
  const iHigh1 = md.indexOf("高危问题");
  const iHigh2 = md.indexOf("另一个高危");
  const iMedium = md.indexOf("中危问题");
  const iLow = md.indexOf("低危问题");
  check("issue 按 severity 降序（high 先）", iHigh1 >= 0 && iHigh1 < iMedium && iMedium < iLow);
  check("同 severity 保持原顺序（稳定排序）", iHigh1 < iHigh2);
  check("issue 标题行含等级", md.includes("- **issue · high** — 高危问题"));
  check("issue 标题行 medium", md.includes("- **issue · medium** — 中危问题"));
  check("issue 标题行 low", md.includes("- **issue · low** — 低危问题"));
  check("问题分布统计行", md.includes("- 问题分布：high 2 / medium 1 / low 1"));
  // 无 issue → 无统计行
  const noIssue = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "praise", "表扬一", 11),
      verifiedFinding("f2", "observation", "观察一", 12),
    ],
  }));
  check("无 issue → 不显示问题分布", !noIssue.includes("问题分布"));
  // non-issue 即使带了 severity 也不显示等级（防御旧数据/脏数据）
  const dirty = renderMarkdown(makeReport({
    findings: [
      verifiedFinding("f1", "praise", "脏表扬", 11, { severity: "high" }),
      verifiedFinding("f2", "observation", "脏观察", 12, { severity: "low" }),
    ],
  }));
  check("non-issue 不显示等级", !dirty.includes("issue · ") && !dirty.includes("praise · "));
  check("non-issue 不计入问题分布", !dirty.includes("问题分布"));
  // 向后兼容：旧报告 JSON 完全没有 severity 字段 → 不崩、不显示统计
  const legacy = renderMarkdown(makeReport({
    findings: [
      { id: "f1", kind: "issue", text: "旧数据问题", evidence: [{ sessionId: "sess-root", turn: 1, seq: 11, callId: null }], limitations: [] },
    ],
  }));
  check("旧数据（无 severity）不崩", legacy.includes("旧数据问题"));
  check("旧数据不显示统计行", !legacy.includes("问题分布"));
  check("旧数据不渲染等级后缀", !legacy.includes("issue · "));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
