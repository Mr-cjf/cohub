// test/review-compat.ts —— coverage / lastReport 兼容契约测试（旧报告/旧索引不得崩）
//
// 覆盖 4 个场景：
//   1. 旧报告 JSON：coverage 只有原 4 字段（0.10.1 生成）→ 反序列化 + 再序列化不崩，新字段读作 undefined
//   2. 旧 index.json：lastReport 无 lineageTotal/sessionsTruncated → loadIndex + renderIndexMarkdown 不崩，不编造字段
//   3. 新字段部分存在：只有 lineageTotal（无 sessionsTruncated）→ 不崩，按「未知」处理
//   4. 新字段全存在：coverage 4 个新字段齐全 + updateIndex 传入新字段 → 正常落盘并可读回
// 用法：node test/review-compat.ts（node >= 24 类型剥离）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离落盘根：dshHomePath 每次读 DSH_HOME（未 memoize），必须在 import 前设置
const homeRoot = mkdtempSync(join(tmpdir(), "cohub-compat-home-"));
process.env.DSH_HOME = homeRoot;

const { updateIndex, loadIndex, indexPath, indexMarkdownPath, renderIndexMarkdown, REVIEW_INDEX_VERSION } =
  await import("../src/review-index.ts");
const { cwdDirName } = await import("../src/review-store.ts");
type ReviewReport = import("../src/review-types.ts").ReviewReport;
type ReviewIndexFile = import("../src/review-index.ts").ReviewIndexFile;

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log("  " + name + ": PASS");
    pass++;
  } catch (err) {
    console.log("  " + name + ": FAIL — " + (err instanceof Error ? err.message : String(err)));
    fail++;
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const reportDir = join(homeRoot, "cohub", "reviews", "fake");

/** 0.10.1 真实报告的最小可辨识载荷：coverage 只有 throughSeq/complete/gaps/inputTruncated */
function legacyReportJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    project: { cwd: "C:\\work\\demo", key: "demo-677058fc9088a6b0" },
    rootSessionId: "root-1",
    coverage: {
      throughSeq: { "root-1": 88, "sub-1": 42 },
      complete: true,
      gaps: [],
      inputTruncated: false,
    },
    sessions: [
      { sessionId: "root-1", parentSessionId: null, turns: [] },
      { sessionId: "sub-1", parentSessionId: "root-1", turns: [] },
    ],
    attempts: [],
    findings: [],
    analysis: {
      requestId: "req-old",
      inputDigest: "deadbeef",
      provider: "deepseek",
      model: "deepseek-chat",
      invocations: 1,
      status: "completed",
    },
  }, null, 2);
}

// ---- 场景 1：旧报告 JSON（coverage 只有原 4 字段）→ 反序列化/再序列化不崩 ----
{
  console.log("===== 场景 1：旧报告 coverage 仅原 4 字段 =====");
  const raw = legacyReportJson();
  check("旧报告 JSON 可解析", () => {
    const r = JSON.parse(raw) as ReviewReport;
    assert(r.schemaVersion === 1, "schemaVersion 应为 1");
    assert(r.coverage.complete === true, "complete 原值应保留");
    assert(r.coverage.gaps.length === 0, "gaps 原值应保留");
    assert(r.coverage.inputTruncated === false, "inputTruncated 原值应保留");
    assert(r.coverage.throughSeq["root-1"] === 88, "throughSeq 原值应保留");
  });
  check("旧报告新字段全部为 undefined（不编造默认值）", () => {
    const c = (JSON.parse(raw) as ReviewReport).coverage;
    assert(c.lineageTotal === undefined, "lineageTotal 应为 undefined");
    assert(c.sessionsAnalyzed === undefined, "sessionsAnalyzed 应为 undefined");
    assert(c.sessionsTruncated === undefined, "sessionsTruncated 应为 undefined");
    assert(c.samplingNote === undefined, "samplingNote 应为 undefined");
  });
  check("旧报告读→写→读 往返无新增键、不崩", () => {
    const once = JSON.parse(raw) as ReviewReport;
    const out = JSON.stringify(once, null, 2);
    const back = JSON.parse(out) as ReviewReport;
    assert(Object.keys(back.coverage).length === 4, "coverage 键数应仍为 4");
    assert(!("lineageTotal" in back.coverage), "不应出现 lineageTotal 键");
    assert(out === raw, "往返序列化应逐字节一致");
  });
}

// ---- 场景 2：旧 index.json（lastReport 无新字段）→ loadIndex + 渲染 INDEX.md 不崩 ----
{
  console.log("===== 场景 2：旧 index.json lastReport 无新字段 =====");
  const cwdOld = join(homeRoot, "proj-legacy");
  mkdirSync(cwdOld, { recursive: true });
  const key = cwdDirName(cwdOld);
  const legacyIndex = {
    version: REVIEW_INDEX_VERSION,
    updatedAt: "2026-10-27T09:34:04.242Z",
    projects: {
      [key]: {
        cwd: cwdOld.replace(/\\/g, "/"),
        name: "proj-legacy",
        lastReport: {
          at: "2026-10-27T09:34:04.242Z",
          sessionId: "root-legacy",
          status: "completed",
          findings: 9,
          sessions: 51, // 1 根 + 50 子（旧口径：含根）
          jsonPath: (join(reportDir, "report-old.json")).replace(/\\/g, "/"),
          mdPath: (join(reportDir, "report-old.md")).replace(/\\/g, "/"),
          projectCopyPath: null,
        },
      },
    },
  };
  mkdirSync(join(homeRoot, "cohub", "reviews"), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify(legacyIndex, null, 2), "utf8");

  check("旧 index.json 可被 loadIndex 读出（未隔离 .corrupt）", () => {
    const loaded = loadIndex();
    assert(Object.keys(loaded.projects).length === 1, "应读出 1 个项目");
    assert(!existsSync(indexPath() + ".corrupt"), "不应触发 .corrupt 隔离");
  });
  check("旧 lastReport 新字段为 undefined", () => {
    const r = loadIndex().projects[key]!.lastReport;
    assert(r.lineageTotal === undefined, "lineageTotal 应为 undefined");
    assert(r.sessionsTruncated === undefined, "sessionsTruncated 应为 undefined");
    assert(r.sessions === 51, "sessions 原义应保留");
  });
  check("旧条目渲染 INDEX.md 不崩且会话数照常显示", () => {
    const md = renderIndexMarkdown(loadIndex() as ReviewIndexFile);
    assert(md.includes("proj-legacy"), "应含项目名");
    assert(md.includes("51"), "应显示旧 sessions 值");
    assert(md.includes("root-legacy"), "应含 sessionId");
  });
}

// ---- 场景 3：新字段部分存在（只有 lineageTotal，无 sessionsTruncated）→ 不崩 ----
{
  console.log("===== 场景 3：只有 lineageTotal、无 sessionsTruncated =====");
  check("coverage 部分字段存在时可解析，缺失项为 undefined", () => {
    const r = JSON.parse(legacyReportJson()) as ReviewReport;
    (r.coverage as any).lineageTotal = 50;
    const round = JSON.parse(JSON.stringify(r)) as ReviewReport;
    assert(round.coverage.lineageTotal === 50, "lineageTotal 应保留");
    assert(round.coverage.sessionsAnalyzed === undefined, "sessionsAnalyzed 仍应缺失");
    assert(round.coverage.sessionsTruncated === undefined, "sessionsTruncated 仍应缺失（未知，不等于 false）");
  });
  check("lastReport 只有 lineageTotal 时可渲染 INDEX.md", () => {
    const md = renderIndexMarkdown({
      version: REVIEW_INDEX_VERSION,
      updatedAt: "2026-10-28T00:00:00.000Z",
      projects: {
        kPartial: {
          cwd: "C:/partial",
          name: "partial",
          lastReport: {
            at: "2026-10-28T00:00:00.000Z", sessionId: "s-partial", status: "completed",
            findings: 1, sessions: 11, lineageTotal: 10,
            jsonPath: "C:/partial.json", mdPath: null, projectCopyPath: null,
          },
        },
      },
    } as ReviewIndexFile);
    assert(md.includes("partial"), "应渲染项目名");
    assert(md.includes("11"), "应显示 sessions");
  });
  check("updateIndex 只传 lineageTotal 时只落该键", () => {
    const cwdPartial = join(homeRoot, "proj-partial");
    mkdirSync(cwdPartial, { recursive: true });
    const ok = updateIndex({
      cwd: cwdPartial, sessionId: "s-partial", status: "completed", findings: 1, sessions: 11,
      lineageTotal: 10,
      jsonPath: join(reportDir, "partial.json"), mdPath: null, projectCopyPath: null,
      at: "2026-10-28T04:00:00.000Z",
    });
    assert(ok === true, "updateIndex 应返回 true");
    const proj = JSON.parse(readFileSync(indexPath(), "utf8")).projects[cwdDirName(cwdPartial)];
    assert(proj.lastReport.lineageTotal === 10, "lineageTotal 应落盘");
    assert(!("sessionsTruncated" in proj.lastReport), "未传的 sessionsTruncated 不应出现键");
  });
}

// ---- 场景 4：新字段全存在 → 正常 ----
{
  console.log("===== 场景 4：新字段全存在 =====");
  check("coverage 4 个新字段齐全可往返", () => {
    const r = JSON.parse(legacyReportJson()) as ReviewReport;
    Object.assign(r.coverage, {
      lineageTotal: 200,
      sessionsAnalyzed: 50,
      sessionsTruncated: true,
      samplingNote: "按创建时间倒序取最新 50 个",
    });
    const round = JSON.parse(JSON.stringify(r)) as ReviewReport;
    assert(round.coverage.lineageTotal === 200, "lineageTotal 应保留");
    assert(round.coverage.sessionsAnalyzed === 50, "sessionsAnalyzed 应保留");
    assert(round.coverage.sessionsTruncated === true, "sessionsTruncated 应保留");
    assert(round.coverage.samplingNote === "按创建时间倒序取最新 50 个", "samplingNote 应保留");
    // complete 与 sessionsTruncated 独立：事件流自洽但子会话被取样截断
    assert(round.coverage.complete === true && round.coverage.sessionsTruncated === true,
      "complete 与 sessionsTruncated 应是两个独立维度");
  });
  check("updateIndex 传全部新字段 → 落盘并可读回", () => {
    const cwdFull = join(homeRoot, "proj-full");
    mkdirSync(cwdFull, { recursive: true });
    const ok = updateIndex({
      cwd: cwdFull, sessionId: "root-full", status: "completed", findings: 4, sessions: 51,
      lineageTotal: 200, sessionsTruncated: true,
      jsonPath: join(reportDir, "full.json"), mdPath: join(reportDir, "full.md"), projectCopyPath: null,
      at: "2026-10-29T00:00:00.000Z",
    });
    assert(ok === true, "updateIndex 应返回 true");
    const proj = JSON.parse(readFileSync(indexPath(), "utf8")).projects[cwdDirName(cwdFull)];
    assert(proj.lastReport.lineageTotal === 200, "lineageTotal 应为 200");
    assert(proj.lastReport.sessionsTruncated === true, "sessionsTruncated 应为 true");
    assert(proj.lastReport.sessions === 51, "sessions 原义（含根）应保留");
    const md = readFileSync(indexMarkdownPath(), "utf8");
    assert(md.includes("51"), "INDEX.md 仍显示 sessions");
  });
  check("新字段不污染旧条目：旧条目渲染后仍无新键", () => {
    const r = loadIndex().projects[cwdDirName(join(homeRoot, "proj-legacy"))]!.lastReport;
    assert(r.lineageTotal === undefined, "旧条目 lineageTotal 不应被补写");
    assert(!("sessionsTruncated" in r), "旧条目不应出现 sessionsTruncated 键");
  });
}

// 清理
try { rmSync(homeRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n通过 " + pass + " / 失败 " + fail);
if (fail > 0) process.exit(1);
