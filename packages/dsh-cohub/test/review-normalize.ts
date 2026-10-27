// test/review-normalize.ts —— src/review-command.ts 的 normalizeFindings 单测（只测规整逻辑，不碰 LLM/宿主）
// 覆盖：issue + 合法 severity → 保留；issue + 缺/非法 severity → 降级 medium 并记 warn；
//       非 issue + severity → severity 被丢弃（且不记 finding 的 severity 字段）。
// 用法：node test/review-normalize.ts（node >= 24 类型剥离）
import { normalizeFindings } from "../src/review-command.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

/** 构造最小证据索引：sessionId → (seq → { turn, callId })。 */
function makeIndex() {
  const bySeq = new Map<number, { turn: number | null; callId: string | null }>();
  for (const seq of [10, 11, 12, 13, 14]) bySeq.set(seq, { turn: 1, callId: null });
  return new Map([["s1", bySeq]]);
}

const ev = (seq: number) => [{ sessionId: "s1", turn: 1, seq, callId: null }];

// ---- 用例 1：issue + 合法 severity → 原样保留 ----
{
  const warns: string[] = [];
  const out = normalizeFindings(
    [
      { kind: "issue", severity: "high", text: "高危问题", evidence: ev(10), limitations: [] },
      { kind: "issue", severity: "low", text: "低危问题", evidence: ev(11), limitations: [] },
    ],
    makeIndex(), "s1", m => warns.push(m),
  );
  check("合法 severity 保留 high", out[0].severity === "high");
  check("合法 severity 保留 low", out[1].severity === "low");
  check("合法 severity 不告警", warns.length === 0);
}

// ---- 用例 2：issue 缺 severity / 非法值 → 降级 medium 并记 warn（不丢弃整条）----
{
  const warns: string[] = [];
  const out = normalizeFindings(
    [
      { kind: "issue", text: "缺 severity", evidence: ev(10), limitations: [] },
      { kind: "issue", severity: "urgent", text: "非法 severity", evidence: ev(11), limitations: [] },
    ],
    makeIndex(), "s1", m => warns.push(m),
  );
  check("缺 severity 不丢弃该条", out.length === 2);
  check("缺 severity → 降级 medium", out[0].severity === "medium");
  check("非法 severity → 降级 medium", out[1].severity === "medium");
  check("降级时记 2 条 warn", warns.length === 2);
  check("warn 文案指明降级", warns[0].includes("降级为 medium"));
}

// ---- 用例 3：非 issue 带 severity → severity 被丢弃（不产生该字段）----
{
  const warns: string[] = [];
  const out = normalizeFindings(
    [
      { kind: "praise", severity: "high", text: "表扬一", evidence: ev(10), limitations: [] },
      { kind: "observation", severity: "low", text: "观察一", evidence: ev(11), limitations: [] },
      { kind: "suggestion", severity: "medium", text: "建议一", evidence: ev(12), limitations: [] },
    ],
    makeIndex(), "s1", m => warns.push(m),
  );
  check("praise 不带 severity 字段", !("severity" in out[0]));
  check("observation 不带 severity 字段", !("severity" in out[1]));
  check("suggestion 不带 severity 字段", !("severity" in out[2]));
  check("非 issue 的 finding 本身保留", out.length === 3);
  check("乱给 severity 记 3 条 warn", warns.length === 3);
}

// ---- 用例 4：未知 kind 归为 observation，且 severity 一并丢弃 ----
{
  const out = normalizeFindings(
    [{ kind: "unknown-kind", severity: "high", text: "未知类型", evidence: ev(10), limitations: [] }],
    makeIndex(), "s1", () => {},
  );
  check("未知 kind → observation", out[0].kind === "observation");
  check("未知 kind 丢弃 severity", !("severity" in out[0]));
}

// ---- 用例 5：evidence 校验与 id 编号行为不变（回归）----
{
  const out = normalizeFindings(
    [
      { kind: "issue", severity: "high", text: "有效证据", evidence: ev(10), limitations: [] },
      { kind: "issue", severity: "high", text: "伪造 seq", evidence: ev(999), limitations: [] },
    ],
    makeIndex(), "s1", () => {},
  );
  check("无有效 evidence 仍产出 finding（进未验证区）", out.length === 2);
  check("伪造 seq 被丢弃 → evidence 为空", out[1].evidence.length === 0);
  check("id 连续编号 f-001/f-002", out[0].id === "f-001" && out[1].id === "f-002");
}

// ---- 用例 6：warn 缺省时不得抛错 ----
{
  let threw = false;
  try {
    normalizeFindings([{ kind: "issue", text: "无 warn 回调", evidence: ev(10), limitations: [] }], makeIndex(), "s1");
  } catch {
    threw = true;
  }
  check("省略 warn 参数不抛错", !threw);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
