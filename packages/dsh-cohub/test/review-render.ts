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
function verifiedFinding(id: string, kind: string, text: string, seq = 10) {
  return {
    id, kind, text,
    evidence: [{ sessionId: "sess-root", turn: 1, seq, callId: null }],
    limitations: [],
  };
}

// ---- 用例 1：骨架（标题/元信息/分轮总览）----
{
  const md = renderMarkdown(makeReport());
  check("骨架-标题", md.startsWith("# 会话复盘报告"));
  check("骨架-项目 cwd", md.includes("项目 cwd：C:\\proj\\demo"));
  check("骨架-root session id", md.includes("root session id：sess-root"));
  check("骨架-生成时间", md.includes("生成时间：20"));
  check("骨架-完整性标记", md.includes("采集完整性：complete"));
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
  check("限制说明为末段", md.trimEnd().endsWith("结论不得外推到未读区间。"));
  const clean = renderMarkdown(makeReport());
  check("无缺口时不给人工复核提示", !clean.includes("需人工复核"));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
