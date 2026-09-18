// Cross-source drift check for the「并行工具纪律（强制）」text.
//
// The same 17-line discipline block lives in TWO hand-maintained places:
//   1. skills/<role>/SKILL.md  — the authoritative source; generate-agents copies
//      it verbatim into agents-template/co-*.md, which becomes the subagent
//      system prompt.
//   2. src/tools/delegate.ts   — the PARALLEL_DISCIPLINE constant, appended to
//      the *task prompt* (specialized path) and to inline_prompt (general-purpose
//      fallback).
//
// A subagent therefore receives this text TWICE, through two independent paths.
// Nothing else in the toolchain compares the two: generate-agents.ts --check only
// diffs agents-template/ against skills/, so editing one side alone would drift
// silently and hand the model two near-identical but differently-worded
// instructions.
//
// Usage:
//   bun scripts/check-parallel-discipline.ts   # exit 1 on any drift
//   npm run check:sync                         # same thing
//
// Also invoked from `bun scripts/generate-agents.ts --check` so the existing
// drift-detection entry point covers it.
//
// Normalization: SKILL.md is Markdown and may be checked out with CRLF on
// Windows while delegate.ts uses join("\n"), so both sides are CRLF→LF
// normalized before comparison (same approach as the frontmatter extractor in
// scripts/shared/frontmatter.ts). Only the final trailing newline(s) are
// ignored; every interior byte must match.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
const DELEGATE_FILE = path.join(PROJECT_ROOT, "src", "tools", "delegate.ts");

/** The heading that opens the discipline block, in both sources. */
const SECTION_HEADING = "## 并行工具纪律（强制）";

/** Roles that are never spawned, so they carry no discipline block. */
const ROLES_WITHOUT_SECTION = new Set(["orchestrator"]);

/** CRLF → LF, then drop trailing blank lines. Interior content stays byte-exact. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Bold-label openers that belong to the discipline block itself. Any OTHER
 * bolded label line — `**约束**`, `**语言要求**`, `**要求的输出格式**`, … — marks
 * the start of trailing role-specific prose and therefore the end of the block.
 *
 * This allowlist exists because a plain "next `## ` heading" boundary is not
 * enough: several skills (council, librarian, planner, oracle, fixer, …) place
 * `**约束**` / `**要求的输出格式**` prose between the discipline block and the
 * *next* `## ` heading, so the naive rule would swallow role-specific text into
 * the compared region and report false drift.
 */
const BLOCK_OPENER_PREFIXES = [
  "**一条消息",
  "**发送前自检门",
  "**批量配方",
  "**违规样例",
];

/** Does this line open a new top-level section (and thus end the block)? */
function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) return true;
  // A bolded label line, unless it is one of the block's own paragraph openers.
  if (/^\*\*[^*]+\*\*/.test(trimmed)) {
    return !BLOCK_OPENER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  }
  return false;
}

/**
 * Extract the discipline block from a SKILL.md: from the exact heading line up
 * to the line before the next top-level section (a `## `/`### ` heading or a
 * non-block bold label), or to end of file.
 */
function extractSection(skillContent: string): string | null {
  const lines = skillContent.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isSectionBoundary(lines[i])) {
      end = i;
      break;
    }
  }

  return normalize(lines.slice(start, end).join("\n"));
}

/**
 * Extract PARALLEL_DISCIPLINE from delegate.ts.
 *
 * The constant is a template-literal ARRAY joined with "\n" (NOT one big
 * template string), so we cannot read it via a single regex on the value: we
 * slice the array body between `const PARALLEL_DISCIPLINE = [` and the
 * `].join("\n")` terminator, then decode each `...`, entry. Escaped backticks
 * (\`) inside the entries are unescaped so the result is real text.
 *
 * This is deliberately a text parse rather than an import: importing the module
 * would pull in the whole delegate/MCP dependency graph, and a drift inside the
 * text must still be *reported* rather than crash the import.
 */
function extractConstant(delegateSource: string): string[] {
  const text = delegateSource.replace(/\r\n/g, "\n");
  const startMarker = "const PARALLEL_DISCIPLINE = [";
  const endMarker = '].join("\\n")';

  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`未能在 ${rel(DELEGATE_FILE)} 中找到 \`${startMarker}\``);
  }
  const bodyStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, bodyStart);
  if (endIdx === -1) {
    throw new Error(`未能在 ${rel(DELEGATE_FILE)} 中找到 \`${endMarker}\` 终止符`);
  }

  const entries = text
    .slice(bodyStart, endIdx)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return entries.map((line, index) => {
    const match = line.match(/^`([\s\S]*)`,?$/);
    if (!match) {
      throw new Error(
        `无法解析 PARALLEL_DISCIPLINE 第 ${index + 1} 个数组项（应为反引号模板字符串）: ${line}`,
      );
    }
    return match[1].replace(/\\`/g, "`").replace(/\\{2}/g, "\\");
  });
}

function rel(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath).split(path.sep).join("/");
}

/** Print the first differing line of two normalized texts along with its index. */
function printDiff(label: string, expected: string, actual: string) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const total = Math.max(expectedLines.length, actualLines.length);

  for (let i = 0; i < total; i++) {
    const exp = i < expectedLines.length ? expectedLines[i] : "<无此行>";
    const act = i < actualLines.length ? actualLines[i] : "<无此行>";
    if (exp === act) continue;

    console.error(`    ✗ ${label} 首处不同：第 ${i + 1} 行`);
    console.error(`      SKILL.md 侧: ${JSON.stringify(exp)}`);
    console.error(`      delegate 侧: ${JSON.stringify(act)}`);
    return;
  }

  console.error(`    ✗ ${label} 内容相同但归一化后长度不同（${expected.length} vs ${actual.length}）`);
}

export interface DisciplineCheckResult {
  ok: boolean;
  /** Skill dirs that carry the discipline block, in sorted order. */
  sectionSources: string[];
}

/**
 * Verify that every spawnable skill's「并行工具纪律（强制）」block is identical
 * to every other one, and identical to delegate.ts's PARALLEL_DISCIPLINE.
 *
 * Returns ok=false and prints diagnostics on any drift; never throws for drift
 * (extraction failures do throw — those mean the source shape changed).
 */
export function checkParallelDiscipline(): DisciplineCheckResult {
  console.log("🔍 交叉校验「并行工具纪律（强制）」：skills/*/SKILL.md ↔ src/tools/delegate.ts");

  if (!fs.existsSync(DELEGATE_FILE)) {
    console.error(`✗ 缺失源文件: ${rel(DELEGATE_FILE)}`);
    return { ok: false, sectionSources: [] };
  }

  const constant = normalize(extractConstant(fs.readFileSync(DELEGATE_FILE, "utf-8")).join("\n"));

  // --- Collect the block from every skill that should carry it ---
  const sections: { dir: string; text: string }[] = [];
  const missing: string[] = [];

  const dirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of dirs) {
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    const section = extractSection(fs.readFileSync(skillFile, "utf-8"));

    if (section === null) {
      if (!ROLES_WITHOUT_SECTION.has(dir)) missing.push(dir);
      continue;
    }
    sections.push({ dir, text: section });
  }

  let ok = true;

  if (sections.length === 0) {
    console.error(`✗ 没有任何 SKILL.md 含「${SECTION_HEADING}」小节`);
    return { ok: false, sectionSources: [] };
  }

  if (missing.length > 0) {
    for (const dir of missing) {
      console.error(`✗ ${rel(path.join(SKILLS_DIR, dir, "SKILL.md"))} 缺少「${SECTION_HEADING}」小节`);
    }
    ok = false;
  }

  // --- 1. Cross-check the SKILL.md copies against each other ---
  const reference = sections[0];
  for (const other of sections.slice(1)) {
    if (other.text === reference.text) continue;
    console.error(
      `✗ SKILL.md 之间不一致：skills/${other.dir}/SKILL.md 与 skills/${reference.dir}/SKILL.md`,
    );
    printDiff(`skills/${other.dir} vs skills/${reference.dir}`, reference.text, other.text);
    ok = false;
  }

  // --- 2. Cross-check SKILL.md against the delegate.ts constant ---
  if (reference.text !== constant) {
    console.error(
      `✗ skills/${reference.dir}/SKILL.md 与 ${rel(DELEGATE_FILE)} 的 PARALLEL_DISCIPLINE 不一致`,
    );
    printDiff("SKILL.md vs PARALLEL_DISCIPLINE", reference.text, constant);
    console.error(
      `    → 两处必须逐字一致（权威源：skills/*/SKILL.md）。修改任一侧后请同步另一侧。`,
    );
    ok = false;
  }

  if (!ok) {
    console.error(`\n❌ 并行工具纪律文本漂移`);
    return { ok: false, sectionSources: sections.map((s) => s.dir) };
  }

  console.log(
    `✅ 并行工具纪律一致（${sections.length} 份 SKILL.md ↔ ${rel(DELEGATE_FILE)} PARALLEL_DISCIPLINE，${reference.text.split("\n").length} 行）`,
  );
  return { ok: true, sectionSources: sections.map((s) => s.dir) };
}

function main() {
  const result = checkParallelDiscipline();
  if (!result.ok) process.exit(1);
}

// Only run when executed directly — importing this module (e.g. from
// generate-agents.ts --check) must not exit the process.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
