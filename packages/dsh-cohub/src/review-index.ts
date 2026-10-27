// 复盘索引层：把「某项目最近一次复盘」汇总成可辨认的全局索引
//
// 要解决的问题：报告落在 <dshHome>/cohub/reviews/<cwd 的 sha256 前 16 位>/<sessionId hash>/，
// 目录名是 hash，人无法辨认属于哪个项目，路径又深又长（终端里常被截断）。
//
// 两层产物：
//   1. 项目内副本：<cwd>/.cohub/reviews/report-<stamp>.md —— 就在项目里，随手能打开；
//      同时自动建 <cwd>/.cohub/.gitignore（内容 "*"），让整个 .cohub/ 被 git 忽略，
//      **不改用户已有的 .gitignore**；已有 .gitignore 且内容不含 "*" 时不覆盖，只返回提示。
//   2. 全局索引：<dshHome>/cohub/reviews/index.json（机器读）+ INDEX.md（人读，本地时间）。
//
// 纪律（与 review-store.ts 同风格）：
//   · 全部 fail-soft：任何失败返回 false/null 并给出提示字符串，绝不抛错影响报告落盘；
//   · 写文件一律 .tmp → rename 原子替换；多会话并发按「最后写入者胜」，但不会写出损坏 JSON；
//   · index.json 解析失败 → 改名 .corrupt 隔离后重建，绝不静默覆盖成空表；
//   · 时间：文件名里的 stamp 是 UTC，展示给人看时转**本地时间**。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { cwdDirName } from "./review-store.ts";

/** index.json 结构版本（不兼容时整体作废，不静默迁移） */
export const REVIEW_INDEX_VERSION = 1;

/** 一次复盘的摘要（index.json 里 projects[key].lastReport） */
export interface ReviewIndexReport {
  /** ISO 时间（UTC 存储，展示时转本地） */
  at: string;
  sessionId: string;
  status: "completed" | "failed" | "interrupted";
  findings: number;
  sessions: number;
  /** 报告 JSON 绝对路径（失败时为 error-*.json 的绝对路径） */
  jsonPath: string;
  /** 报告 MD 绝对路径；失败记录没有 MD → null */
  mdPath: string | null;
  /** 项目内副本绝对路径；未写成功或 cwd 为空 → null */
  projectCopyPath: string | null;
  /** 未写项目内副本的原因 / 与用户既有 .gitignore 冲突的提示（有才写） */
  note?: string;
}

/** index.json 里一个项目的记录 */
export interface ReviewIndexProject {
  cwd: string;
  name: string;
  lastReport: ReviewIndexReport;
}

/** index.json 整体结构 */
export interface ReviewIndexFile {
  version: number;
  updatedAt: string;
  projects: Record<string, ReviewIndexProject>;
}

/** updateIndex 的入参 */
export interface ReviewIndexEntry {
  cwd: string | null | undefined;
  sessionId: string;
  status: ReviewIndexReport["status"];
  findings: number;
  sessions: number;
  jsonPath: string;
  mdPath?: string | null;
  projectCopyPath?: string | null;
  note?: string;
  /** 缺省取当前时间（测试可注入，用于验证排序） */
  at?: string;
}

/** 写项目内副本的结果 */
export interface ProjectCopyResult {
  path: string | null;
  note: string | null;
}

/** 索引根：<dshHome>/cohub/reviews */
export function reviewIndexDir(): string {
  return dshHomePath("cohub", "reviews");
}

/** index.json 路径 */
export function indexPath(): string {
  return join(reviewIndexDir(), "index.json");
}

/** INDEX.md 路径 */
export function indexMarkdownPath(): string {
  return join(reviewIndexDir(), "INDEX.md");
}

/** 项目内复盘目录：<cwd>/.cohub/reviews */
export function projectReviewDir(cwd: string): string {
  return join(cwd, ".cohub", "reviews");
}

/**
 * 项目内副本路径：<cwd>/.cohub/reviews/report-<stamp>.md
 * cwd 为空 → null（不猜工作目录）。
 */
export function projectCopyPath(cwd: string | null | undefined, stamp: string): string | null {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  return join(projectReviewDir(cwd), "report-" + stamp + ".md");
}

/** 统一的原子写：mkdir -p → .tmp → rename；失败返回 false（并把 .tmp 收拾成 .failed） */
function writeTextAtomic(file: string, text: string): boolean {
  const tmp = file + ".tmp";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) renameSync(tmp, tmp + ".failed");
    } catch { /* 清理失败不影响主流程 */ }
    return false;
  }
}

/**
 * 确保 <cwd>/.cohub/.gitignore 存在且内容为 "*"。
 * 已存在且内容**不含** "*" → 不覆盖，返回提示（避免破坏用户既有配置）。
 */
function ensureProjectGitignore(cwd: string): string | null {
  const file = join(cwd, ".cohub", ".gitignore");
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("*")) {
        return "已存在 " + file + " 且内容不含 \"*\"，未覆盖；如需忽略整个 .cohub/ 请手动加入一行 *";
      }
      return null;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "*\n", "utf8");
    return null;
  } catch (error) {
    return "写入 " + file + " 失败（" + String((error as any)?.message ?? error) + "），项目内副本可能被 git 跟踪";
  }
}

/**
 * 把已渲染好的 MD 额外写一份到项目目录：<cwd>/.cohub/reviews/report-<stamp>.md
 * 复用调用方已渲染的字符串（不二次渲染）。fail-soft：失败返回 path=null + 提示。
 */
export function writeProjectCopy(
  cwd: string | null | undefined,
  markdown: string,
  stamp: string,
): ProjectCopyResult {
  const file = projectCopyPath(cwd, stamp);
  if (file === null) return { path: null, note: "cwd 为空，跳过项目内副本" };
  const notes: string[] = [];
  try {
    if (!writeTextAtomic(file, markdown)) {
      return { path: null, note: "项目内副本写入失败（目录只读或无权限）：" + file };
    }
  } catch (error) {
    return {
      path: null,
      note: "项目内副本写入失败（目录只读或无权限）：" + String((error as any)?.message ?? error),
    };
  }
  const gitignoreNote = ensureProjectGitignore(cwd as string);
  if (gitignoreNote !== null) notes.push(gitignoreNote);
  return { path: file, note: notes.length > 0 ? notes.join("；") : null };
}

/** 空索引 */
function emptyIndex(): ReviewIndexFile {
  return { version: REVIEW_INDEX_VERSION, updatedAt: new Date().toISOString(), projects: {} };
}

/**
 * 读 index.json。缺失 → 空索引；解析失败/版本不符/结构损坏 → 改名 .corrupt 隔离后返回空索引（不抛错）。
 */
export function loadIndex(): ReviewIndexFile {
  const file = indexPath();
  try {
    if (!existsSync(file)) return emptyIndex();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ReviewIndexFile;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("index.json 结构不合法");
    if (parsed.version !== REVIEW_INDEX_VERSION) throw new Error("index.json 版本不符");
    if (parsed.projects === null || typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) {
      throw new Error("index.json projects 不合法");
    }
    return {
      version: REVIEW_INDEX_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      projects: parsed.projects,
    };
  } catch {
    isolateCorrupt(file);
    return emptyIndex();
  }
}

/** 损坏文件改名隔离（.corrupt）；失败静默 —— 无论隔离成功与否都不覆盖原内容 */
function isolateCorrupt(file: string): void {
  try {
    if (!existsSync(file)) return;
    renameSync(file, file + ".corrupt");
  } catch { /* 隔离失败也不抛 */ }
}

/** 路径统一成正斜杠（index.json 里跨平台可读，Windows 上 fs 同样接受） */
function slashed(p: string | null | undefined): string | null {
  return typeof p === "string" && p.length > 0 ? p.replace(/\\/g, "/") : null;
}

/**
 * 更新索引：读 → 改 → 原子写 index.json，再全量重写 INDEX.md。
 * 同一项目只覆盖 lastReport（不新增条目）；并发下「最后写入者胜」，但不会产生损坏 JSON。
 * 返回是否写成功（失败静默，不影响报告落盘）。
 */
export function updateIndex(entry: ReviewIndexEntry): boolean {
  try {
    const index = loadIndex();
    const key = cwdDirName(entry.cwd);
    const cwd = typeof entry.cwd === "string" && entry.cwd.length > 0 ? entry.cwd : null;
    const at = typeof entry.at === "string" && entry.at.length > 0 ? entry.at : new Date().toISOString();
    const prev = index.projects[key];
    const lastReport: ReviewIndexReport = {
      at,
      sessionId: entry.sessionId,
      status: entry.status,
      findings: Number.isFinite(entry.findings) ? entry.findings : 0,
      sessions: Number.isFinite(entry.sessions) ? entry.sessions : 0,
      jsonPath: slashed(entry.jsonPath) ?? "",
      mdPath: slashed(entry.mdPath ?? null),
      projectCopyPath: slashed(entry.projectCopyPath ?? null),
    };
    if (typeof entry.note === "string" && entry.note.length > 0) lastReport.note = entry.note;
    index.projects[key] = {
      cwd: slashed(cwd) ?? prev?.cwd ?? "",
      name: cwd !== null ? basename(cwd) : (prev?.name ?? "(未知项目)"),
      lastReport,
    };
    index.version = REVIEW_INDEX_VERSION;
    index.updatedAt = new Date().toISOString();

    const jsonOk = writeTextAtomic(indexPath(), JSON.stringify(index, null, 2));
    // INDEX.md 每次都全量重写（数据量小，简单可靠）；写失败不影响 index.json 已落盘的事实
    writeTextAtomic(indexMarkdownPath(), renderIndexMarkdown(index));
    return jsonOk;
  } catch {
    return false;
  }
}

/** ISO → 本地时间字符串（YYYY-MM-DD HH:mm:ss）；无法解析时原样返回 */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

/** 按最近报告时间倒序的项目条目（同时间按项目名稳定排序） */
function sortedProjects(index: ReviewIndexFile): Array<[string, ReviewIndexProject]> {
  const rows = Object.entries(index.projects);
  rows.sort((a, b) => {
    const ta = Date.parse(a[1]?.lastReport?.at ?? "") || 0;
    const tb = Date.parse(b[1]?.lastReport?.at ?? "") || 0;
    if (tb !== ta) return tb - ta;
    return String(a[1]?.name ?? "").localeCompare(String(b[1]?.name ?? ""));
  });
  return rows;
}

/** 渲染 INDEX.md（人读：本地时间 + 完整 cwd + 两份报告绝对路径，按最近报告时间倒序） */
export function renderIndexMarkdown(index: ReviewIndexFile): string {
  const rows = sortedProjects(index);
  const lines: string[] = [];
  lines.push("# CoHub 复盘索引");
  lines.push("");
  lines.push("自动生成，勿手工编辑（每次 `/cohub-review` 落盘后全量重写）。");
  lines.push("");
  lines.push("索引更新时间：" + formatLocalTime(index.updatedAt) + "（本地时间）　项目数：" + rows.length);
  lines.push("");
  if (rows.length === 0) {
    lines.push("_暂无复盘记录。_");
    lines.push("");
    return lines.join("\n");
  }
  // 总览表：最近报告时间倒序
  lines.push("| 项目 | 状态 | findings | 会话数 | 最近报告（本地时间） |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [, p] of rows) {
    const r = p.lastReport;
    lines.push("| " + p.name + " | " + r.status + " | " + r.findings + " | " + r.sessions
      + " | " + formatLocalTime(r.at) + " |");
  }
  lines.push("");
  // 明细：一个项目一节
  for (const [key, p] of rows) {
    const r = p.lastReport;
    lines.push("## " + p.name + "（" + key + "）");
    lines.push("");
    lines.push("- 项目路径：`" + (p.cwd.length > 0 ? p.cwd : "(未知)") + "`");
    lines.push("- 最近报告：" + formatLocalTime(r.at) + "（本地时间）");
    lines.push("- 状态：" + r.status + "　findings：" + r.findings + "　会话数：" + r.sessions);
    lines.push("- 会话：" + r.sessionId);
    lines.push("- 报告（DSH）：`" + (r.jsonPath.length > 0 ? r.jsonPath : "(无)") + "`");
    lines.push("- 报告 MD：`" + (r.mdPath ?? "(无)") + "`");
    lines.push("- 项目内副本：" + (r.projectCopyPath !== null ? "`" + r.projectCopyPath + "`" : "(无)"));
    if (typeof r.note === "string" && r.note.length > 0) lines.push("- 提示：" + r.note);
    lines.push("");
  }
  return lines.join("\n");
}
