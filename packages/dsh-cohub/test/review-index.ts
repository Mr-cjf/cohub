// test/review-index.ts —— 复盘索引层单测（index.json / INDEX.md / 项目内副本）
//
// 覆盖：
//   a. 首次更新 → 创建 index.json 与 INDEX.md
//   b. 同一项目第二次更新 → 覆盖 lastReport，项目数仍为 1
//   c. 不同项目第二次更新 → 两个项目都在
//   d. index.json 被写入非法内容 → 隔离为 .corrupt 并重建，不抛错
//   e. INDEX.md 按最近报告时间倒序（最近在前）
//   f. 项目内副本路径函数：cwd → <cwd>/.cohub/reviews/report-*.md
//   g. cwd 为 null 时跳过项目副本（path=null 且有 note）
//   h. 项目内副本真实落盘 + .cohub/.gitignore 内容为 "*"；已有含 * 的 .gitignore 不覆盖；
//      已有不含 * 的 .gitignore → 不覆盖且返回提示
//   i. INDEX.md 时间是本地时间（非 UTC 的 "T"/"Z" 形式）
// 用法：node test/review-index.ts（node >= 24 类型剥离）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离落盘根：dshHomePath 每次读 DSH_HOME（未 memoize），必须在 import 前设置
const homeRoot = mkdtempSync(join(tmpdir(), "cohub-index-home-"));
process.env.DSH_HOME = homeRoot;

const {
  updateIndex, loadIndex, indexPath, indexMarkdownPath, renderIndexMarkdown,
  projectCopyPath, projectReviewDir, writeProjectCopy, formatLocalTime, REVIEW_INDEX_VERSION,
} = await import("../src/review-index.ts");
const { cwdDirName } = await import("../src/review-store.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

const cwdA = join(homeRoot, "proj-alpha");
const cwdB = join(homeRoot, "proj-beta");
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });
const reportDir = join(homeRoot, "cohub", "reviews", "fake");

// ---- 用例 a：首次更新创建 index.json 与 INDEX.md ----
{
  console.log("===== 用例 a：首次更新创建两个索引文件 =====");
  const ok = updateIndex({
    cwd: cwdA, sessionId: "session-a1", status: "completed", findings: 7, sessions: 3,
    jsonPath: join(reportDir, "a1.json"), mdPath: join(reportDir, "a1.md"),
    projectCopyPath: join(cwdA, ".cohub", "reviews", "report-a1.md"),
    at: "2026-01-01T10:00:00.000Z",
  });
  check("updateIndex 返回 true", ok === true);
  check("index.json 已创建", existsSync(indexPath()));
  check("INDEX.md 已创建", existsSync(indexMarkdownPath()));
  const parsed = JSON.parse(readFileSync(indexPath(), "utf8"));
  check("version 正确", parsed.version === REVIEW_INDEX_VERSION);
  check("updatedAt 是 ISO 字符串", typeof parsed.updatedAt === "string" && parsed.updatedAt.includes("T"));
  const key = cwdDirName(cwdA);
  check("项目键为 cwdHash16", Object.prototype.hasOwnProperty.call(parsed.projects, key));
  const proj = parsed.projects[key];
  check("cwd 记录正确", proj.cwd.replace(/\\/g, "/") === cwdA.replace(/\\/g, "/"));
  check("name 为 basename", proj.name === "proj-alpha");
  check("lastReport.sessionId 正确", proj.lastReport.sessionId === "session-a1");
  check("lastReport.findings = 7", proj.lastReport.findings === 7);
  check("lastReport.sessions = 3", proj.lastReport.sessions === 3);
  check("lastReport.status = completed", proj.lastReport.status === "completed");
  check("projectCopyPath 非空", typeof proj.lastReport.projectCopyPath === "string");
  check("无 .tmp 残留", !existsSync(indexPath() + ".tmp"));
  const md = readFileSync(indexMarkdownPath(), "utf8");
  check("INDEX.md 含项目名", md.includes("proj-alpha"));
  check("INDEX.md 含完整 cwd", md.replace(/\\/g, "/").includes(cwdA.replace(/\\/g, "/")));
  check("INDEX.md 含 hash 目录键", md.includes(key));
}

// ---- 用例 b：同一项目第二次更新覆盖 lastReport ----
{
  console.log("===== 用例 b：同一项目第二次更新覆盖 lastReport =====");
  updateIndex({
    cwd: cwdA, sessionId: "session-a2", status: "failed", findings: 0, sessions: 1,
    jsonPath: join(reportDir, "a2.json"), mdPath: null, projectCopyPath: null,
    at: "2026-01-02T10:00:00.000Z",
  });
  const parsed = JSON.parse(readFileSync(indexPath(), "utf8"));
  check("项目数仍为 1", Object.keys(parsed.projects).length === 1);
  const proj = parsed.projects[cwdDirName(cwdA)];
  check("lastReport 已覆盖为 a2", proj.lastReport.sessionId === "session-a2");
  check("覆盖后 status = failed", proj.lastReport.status === "failed");
  check("覆盖后 mdPath = null", proj.lastReport.mdPath === null);
}

// ---- 用例 c：不同项目 → 两个项目都在 ----
{
  console.log("===== 用例 c：不同项目并存 =====");
  updateIndex({
    cwd: cwdB, sessionId: "session-b1", status: "interrupted", findings: 3, sessions: 9,
    jsonPath: join(reportDir, "b1.json"), mdPath: join(reportDir, "b1.md"), projectCopyPath: null,
    at: "2026-01-03T10:00:00.000Z",
  });
  const loaded = loadIndex();
  check("两个项目都在", Object.keys(loaded.projects).length === 2);
  check("项目 A 仍在", Object.prototype.hasOwnProperty.call(loaded.projects, cwdDirName(cwdA)));
  check("项目 B 已加入", loaded.projects[cwdDirName(cwdB)]?.name === "proj-beta");
}

// ---- 用例 d：index.json 损坏 → 隔离 .corrupt 并重建 ----
{
  console.log("===== 用例 d：损坏 index.json 的隔离与重建 =====");
  const corruptPath = indexPath() + ".corrupt";
  if (existsSync(corruptPath)) rmSync(corruptPath);
  writeFileSync(indexPath(), "{ 这不是 JSON ", "utf8");
  let threw = false;
  try {
    const loaded = loadIndex();
    check("loadIndex 不抛错且返回空 projects", Object.keys(loaded.projects).length === 0);
  } catch { threw = true; }
  check("loadIndex 未抛异常", !threw);
  check("损坏文件已隔离为 .corrupt", existsSync(corruptPath));
  check(".corrupt 保留了原始内容", readFileSync(corruptPath, "utf8") === "{ 这不是 JSON ");
  const ok = updateIndex({
    cwd: cwdB, sessionId: "session-b2", status: "completed", findings: 5, sessions: 2,
    jsonPath: join(reportDir, "b2.json"), mdPath: join(reportDir, "b2.md"), projectCopyPath: null,
    at: "2026-01-04T10:00:00.000Z",
  });
  check("重建后 updateIndex 返回 true", ok === true);
  const parsed = JSON.parse(readFileSync(indexPath(), "utf8"));
  check("重建后 JSON 可解析", parsed.version === REVIEW_INDEX_VERSION);
  check("重建后只含本次项目", Object.keys(parsed.projects).length === 1);
}

// ---- 用例 e：INDEX.md 排序（最近在前）----
{
  console.log("===== 用例 e：INDEX.md 按最近报告时间倒序 =====");
  updateIndex({
    cwd: cwdA, sessionId: "session-a3", status: "completed", findings: 4, sessions: 4,
    jsonPath: join(reportDir, "a3.json"), mdPath: join(reportDir, "a3.md"), projectCopyPath: null,
    at: "2026-01-05T10:00:00.000Z",
  });
  const md = readFileSync(indexMarkdownPath(), "utf8");
  const iA = md.indexOf("proj-alpha");
  const iB = md.indexOf("proj-beta");
  check("两个项目都在 INDEX.md", iA >= 0 && iB >= 0);
  check("A（2026-01-05）排在 B（2026-01-04）之前", iA < iB);
  // 反向再验一次：把 B 推到最新
  updateIndex({
    cwd: cwdB, sessionId: "session-b3", status: "completed", findings: 6, sessions: 8,
    jsonPath: join(reportDir, "b3.json"), mdPath: join(reportDir, "b3.md"), projectCopyPath: null,
    at: "2026-01-06T10:00:00.000Z",
  });
  const md2 = readFileSync(indexMarkdownPath(), "utf8");
  check("B 变成最新后排在 A 之前", md2.indexOf("proj-beta") < md2.indexOf("proj-alpha"));
  // 直接验渲染函数（不落盘）
  const rendered = renderIndexMarkdown({
    version: REVIEW_INDEX_VERSION,
    updatedAt: "2026-01-06T10:00:00.000Z",
    projects: {
      kOld: { cwd: "C:/old", name: "old", lastReport: { at: "2025-01-01T00:00:00.000Z", sessionId: "s-old", status: "completed", findings: 0, sessions: 0, jsonPath: "C:/old.json", mdPath: null, projectCopyPath: null } },
      kNew: { cwd: "C:/new", name: "new", lastReport: { at: "2026-06-01T00:00:00.000Z", sessionId: "s-new", status: "failed", findings: 0, sessions: 0, jsonPath: "C:/new.json", mdPath: null, projectCopyPath: null } },
    },
  });
  check("渲染结果 new 在 old 之前", rendered.indexOf("## new") < rendered.indexOf("## old"));
}

// ---- 用例 f：项目内副本路径函数 ----
{
  console.log("===== 用例 f：项目内副本路径函数 =====");
  const p = projectCopyPath(cwdA, "2026-01-05T10-00-00-000Z");
  check("路径落在 <cwd>/.cohub/reviews/", p === join(cwdA, ".cohub", "reviews", "report-2026-01-05T10-00-00-000Z.md"));
  check("projectReviewDir 正确", projectReviewDir(cwdA) === join(cwdA, ".cohub", "reviews"));
  check("文件名以 report- 开头、.md 结尾", !!p && p.endsWith(".md") && p.includes("report-"));
  check("cwd=null → null", projectCopyPath(null, "x") === null);
  check("cwd=\"\" → null", projectCopyPath("", "x") === null);
  check("cwd=undefined → null", projectCopyPath(undefined, "x") === null);
}

// ---- 用例 g：cwd 为 null 时跳过项目副本 ----
{
  console.log("===== 用例 g：cwd=null 跳过项目副本 =====");
  const r = writeProjectCopy(null, "# 报告\n", "stamp-x");
  check("path 为 null", r.path === null);
  check("有提示（含 cwd）", typeof r.note === "string" && r.note.includes("cwd"));
  const r2 = writeProjectCopy("", "# 报告\n", "stamp-x");
  check("cwd=\"\" 同样跳过", r2.path === null);
}

// ---- 用例 h：项目内副本真实落盘 + .gitignore 处理 ----
{
  console.log("===== 用例 h：项目内副本与 .cohub/.gitignore =====");
  const cwdC = join(homeRoot, "proj-gamma");
  mkdirSync(cwdC, { recursive: true });
  const content = "# 复盘报告\n\n- findings: 2\n";
  const r = writeProjectCopy(cwdC, content, "2026-02-01T00-00-00-000Z");
  check("返回了路径", typeof r.path === "string" && r.path === join(cwdC, ".cohub", "reviews", "report-2026-02-01T00-00-00-000Z.md"));
  check("文件已存在", !!r.path && existsSync(r.path));
  check("内容就是传入的 MD", !!r.path && readFileSync(r.path, "utf8") === content);
  const gi = join(cwdC, ".cohub", ".gitignore");
  check(".cohub/.gitignore 已创建", existsSync(gi));
  check(".gitignore 含 *", readFileSync(gi, "utf8").includes("*"));
  check("首次写入无 note", r.note === null);

  // 已存在含 * 的 .gitignore → 视为满足，不覆盖
  writeFileSync(gi, "*.log\n*\n", "utf8");
  const r2 = writeProjectCopy(cwdC, content, "2026-02-02T00-00-00-000Z");
  check("已含 * 时不覆盖", readFileSync(gi, "utf8") === "*.log\n*\n");
  check("已含 * 无 note", r2.note === null);

  // 已存在不含 * 的 .gitignore → 不覆盖 + 提示
  const cwdD = join(homeRoot, "proj-delta");
  mkdirSync(join(cwdD, ".cohub"), { recursive: true });
  const giD = join(cwdD, ".cohub", ".gitignore");
  writeFileSync(giD, "!keep.md\n", "utf8");
  const r3 = writeProjectCopy(cwdD, content, "2026-02-03T00-00-00-000Z");
  check("不含 * 时不覆盖用户文件", readFileSync(giD, "utf8") === "!keep.md\n");
  check("返回提示（含不含 * 说明）", typeof r3.note === "string" && r3.note.includes("*"));
  check("副本仍然写入成功", r3.path !== null && existsSync(r3.path));

  // 项目目录不可写 → fail-soft（用一个不存在的父路径的非法设备名模拟极难，改用文件占位当目录）
  const cwdE = join(homeRoot, "proj-blocked");
  mkdirSync(cwdE, { recursive: true });
  writeFileSync(join(cwdE, ".cohub"), "我是文件不是目录", "utf8"); // .cohub 是文件 → mkdir 必失败
  let threw = false;
  let r4: any = null;
  try { r4 = writeProjectCopy(cwdE, content, "2026-02-04T00-00-00-000Z"); } catch { threw = true; }
  check("不可写时不抛错", !threw);
  check("不可写时 path=null", r4 !== null && r4.path === null);
  check("不可写时有提示", r4 !== null && typeof r4.note === "string" && r4.note.length > 0);
}

// ---- 用例 i：INDEX.md 显示本地时间（不是 UTC 的 T/Z） ----
{
  console.log("===== 用例 i：INDEX.md 使用本地时间 =====");
  const md = readFileSync(indexMarkdownPath(), "utf8");
  check("不含 UTC 的 Z 结尾时间戳", !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(md));
  check("含 YYYY-MM-DD HH:mm:ss 形式", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(md));
  const local = formatLocalTime("2026-01-05T10:00:00.000Z");
  const d = new Date("2026-01-05T10:00:00.000Z");
  const pad = (n: number) => String(n).padStart(2, "0");
  check("formatLocalTime 按本地时区换算",
    local === d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()));
  check("非法时间原样返回", formatLocalTime("not-a-time") === "not-a-time");
}

// ---- 用例 j：updateIndex 对空 cwd 的容错 ----
{
  console.log("===== 用例 j：updateIndex 空 cwd 容错 =====");
  const ok = updateIndex({
    cwd: null, sessionId: "session-nocwd", status: "completed", findings: 1, sessions: 1,
    jsonPath: join(reportDir, "nocwd.json"), mdPath: join(reportDir, "nocwd.md"), projectCopyPath: null,
    at: "2026-01-07T10:00:00.000Z",
  });
  check("空 cwd 不抛错且返回 true", ok === true);
  const loaded = loadIndex();
  check("nocwd 键已记录", Object.prototype.hasOwnProperty.call(loaded.projects, "nocwd"));
}

// 清理
try { rmSync(homeRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n通过 " + pass + " / 失败 " + fail);
if (fail > 0) process.exit(1);
