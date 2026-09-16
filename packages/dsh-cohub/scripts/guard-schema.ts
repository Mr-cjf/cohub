/**
 * 构建期 schema 守卫脚本
 *
 * 检查 defineTool 的 parameters 是否符合 @deepseek-ai/dsh-tools 的 Value Schema DSL 约束。
 * DSH 的 DSL 与完整 JSON Schema 有显著差异，违反约束不会在 bun build 时报错，
 * 但会导致运行时 plugin tree failed to load。
 *
 * 规则来源: .opencode/rules/defineTool-schema.md
 *
 * 用法: bun run scripts/guard-schema.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '..', 'src');

interface Violation {
  file: string;
  line: number;
  snippet: string;
  rule: string;
  message: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 花括号配对 + 字符串感知工具（核心解析基础设施）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 从 startIdx 开始查找下一个平衡花括号块。
 * 自动跳过字符串字面量内的 { }。
 * 返回 { block, offset }：
 *   - block: 匹配的完整 { ... } 子串
 *   - offset: block 在 text 中的起始偏移 (即 { 的位置)
 */
function extractBraceBlock(
  text: string,
  startIdx: number,
): { block: string; offset: number } | null {
  let i = startIdx;
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;

  const blockStart = i;
  let depth = 0;
  let inStr = false;
  let strChar = '';

  for (i = blockStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return { block: text.substring(blockStart, i + 1), offset: blockStart };
    }
  }
  return null;
}

/**
 * 从 pos 位置往回找到最近的 {，然后返回匹配的 { ... } 块。
 * 用于定位某个关键词所属的外层对象块。
 */
function findEnclosingBraceBlock(
  text: string,
  pos: number,
): { block: string; start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = pos; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') {
      depth--;
      if (depth < 0) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return null;

  depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) return { block: text.substring(start, i + 1), start, end: i };
    }
  }
  return null;
}

/** 获取 text 中 pos 处的行号（1-indexed） */
function getLineNum(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

/** 判断 pos 是否处于字符串字面量（" / ' / `）内部 */
function isInsideStringLiteral(text: string, pos: number): boolean {
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strChar = ch;
    }
  }
  return inStr;
}

/** 判断 pos 是否处于单行注释（//）内部 */
function isInSingleLineComment(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const linePrefix = text.substring(lineStart, pos);

  let inStr = false;
  let strChar = '';
  for (let i = 0; i < linePrefix.length; i++) {
    const ch = linePrefix[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; continue; }
    if (ch === '/' && i + 1 < linePrefix.length && linePrefix[i + 1] === '/') return true;
  }
  return false;
}

/** 递归收集目录下所有文件 */
function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllFiles(fullPath));
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// 规则检查器
// ═══════════════════════════════════════════════════════════════════════

// ── 规则 1: 禁止 required: false ──────────────────────────────────────
//
// 实现方式：全文正则扫描，最可靠。DSL 不允许 required: false，
// 可选参数应直接省略 required 字段。
function checkRequiredFalse(filePath: string, content: string, violations: Violation[]): void {
  const relPath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  const re = /\brequired\s*:\s*false\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (isInsideStringLiteral(content, m.index)) continue;
    if (isInSingleLineComment(content, m.index)) continue;
    const line = getLineNum(content, m.index);
    const start = Math.max(0, m.index - 15);
    const end = Math.min(content.length, m.index + 20);
    violations.push({
      file: `src/${relPath}`,
      line,
      snippet: content.substring(start, end).replace(/\n/g, '\\n'),
      rule: '1',
      message: '禁止 required: false。可选参数应直接省略 required 字段，而非显式标记为 false。',
    });
  }
}

// ── 规则 2: items 内部禁止 required 数组 ──────────────────────────────
//
// 实现方式：在 parameters 对象内找到每个 items: 的值块（花括号配对），
// 在该值块内搜索 required: [...]。
function checkItemsRequired(
  filePath: string,
  paramsBlock: string,
  blockOffsetInFile: number,
  content: string,
  violations: Violation[],
): void {
  const relPath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  const itemsRe = /\bitems\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = itemsRe.exec(paramsBlock)) !== null) {
    if (isInsideStringLiteral(paramsBlock, m.index)) continue;

    const itemsVal = extractBraceBlock(paramsBlock, m.index + m[0].length);
    if (!itemsVal) continue;

    const requiredRe = /\brequired\s*:\s*\[/g;
    let rm: RegExpExecArray | null;
    while ((rm = requiredRe.exec(itemsVal.block)) !== null) {
      if (isInsideStringLiteral(itemsVal.block, rm.index)) continue;
      const globalPos = blockOffsetInFile + itemsVal.offset + rm.index;
      const line = getLineNum(content, globalPos);
      violations.push({
        file: `src/${relPath}`,
        line,
        snippet: itemsVal.block
          .substring(Math.max(0, rm.index - 5), Math.min(itemsVal.block.length, rm.index + 35))
          .replace(/\n/g, '\\n'),
        rule: '2',
        message: 'items 内部禁止使用 required 数组。应在 description 中说明必填，在 execute 中运行时检查。',
      });
    }
  }
}

// ── 规则 3: type: "object" 必须显式声明 additionalProperties ─────────
//
// 实现方式：在 parameters 块中找出每个 type: "object"，用花括号配对定位
// 其所属的外层对象块，检查块内是否存在 additionalProperties。
function checkObjectAdditionalProperties(
  filePath: string,
  paramsBlock: string,
  blockOffsetInFile: number,
  content: string,
  violations: Violation[],
): void {
  const relPath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  const re = /\btype\s*:\s*["']object["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paramsBlock)) !== null) {
    if (isInsideStringLiteral(paramsBlock, m.index)) continue;

    const enclosing = findEnclosingBraceBlock(paramsBlock, m.index);
    if (!enclosing) continue;

    // additionalProperties 在 enclosing.block 中存在即合规
    if (!/\badditionalProperties\s*:/.test(enclosing.block)) {
      const globalPos = blockOffsetInFile + m.index;
      const line = getLineNum(content, globalPos);
      violations.push({
        file: `src/${relPath}`,
        line,
        snippet: enclosing.block.substring(0, Math.min(70, enclosing.block.length)).replace(/\n/g, '\\n'),
        rule: '3',
        message: 'type: "object" 必须显式声明 additionalProperties (true 或 false)。',
      });
    }
  }
}

// ── 规则 5: type: "array" 必须配套 items ──────────────────────────────
//
// 实现方式：在 parameters 块中找出每个 type: "array"，用花括号配对定位
// 其所属的外层对象块，检查块内是否存在 items。
function checkArrayItems(
  filePath: string,
  paramsBlock: string,
  blockOffsetInFile: number,
  content: string,
  violations: Violation[],
): void {
  const relPath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  const re = /\btype\s*:\s*["']array["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paramsBlock)) !== null) {
    if (isInsideStringLiteral(paramsBlock, m.index)) continue;

    const enclosing = findEnclosingBraceBlock(paramsBlock, m.index);
    if (!enclosing) continue;

    if (!/\bitems\s*:/.test(enclosing.block)) {
      const globalPos = blockOffsetInFile + m.index;
      const line = getLineNum(content, globalPos);
      violations.push({
        file: `src/${relPath}`,
        line,
        snippet: enclosing.block.substring(0, Math.min(70, enclosing.block.length)).replace(/\n/g, '\\n'),
        rule: '5',
        message: 'type: "array" 必须配套 items 定义元素类型。',
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 主逻辑
// ═══════════════════════════════════════════════════════════════════════

function main(): void {
  const violations: Violation[] = [];
  let checkedFiles = 0;
  let checkedDtFiles = 0;

  const allFiles = getAllFiles(SRC_DIR).filter((f) => f.endsWith('.ts'));

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    checkedFiles++;

    // 规则 1：全文范围（独立正则，不受 defineTool 范围限制）
    checkRequiredFalse(filePath, content, violations);

    // 规则 2/3/5：需要定位 defineTool 的 parameters 对象块
    const dtRe = /\bdefineTool\s*\(/g;
    let dtM: RegExpExecArray | null;
    while ((dtM = dtRe.exec(content)) !== null) {
      if (isInsideStringLiteral(content, dtM.index)) continue;

      const callBody = extractBraceBlock(content, dtM.index + dtM[0].length);
      if (!callBody) continue;

      // 在 defineTool 调用体内找 parameters:
      const paramsIdx = callBody.block.indexOf('parameters:');
      if (paramsIdx === -1) continue;

      const paramsVal = extractBraceBlock(callBody.block, paramsIdx + 'parameters:'.length);
      if (!paramsVal) continue;

      checkedDtFiles++;
      // paramsVal.offset 是相对于 callBody.block 的偏移；
      // callBody.offset 是 callBody.block 在 content 中的偏移
      const paramsBlockFileOffset = callBody.offset + paramsVal.offset;

      checkItemsRequired(filePath, paramsVal.block, paramsBlockFileOffset, content, violations);
      checkObjectAdditionalProperties(
        filePath,
        paramsVal.block,
        paramsBlockFileOffset,
        content,
        violations,
      );
      checkArrayItems(filePath, paramsVal.block, paramsBlockFileOffset, content, violations);
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`❌ [规则 ${v.rule}] ${v.file}:${v.line}`);
      console.error(`   违规代码: ${v.snippet}`);
      console.error(`   修复建议: ${v.message}`);
      console.error();
    }
    console.error(`❌ schema guard: 共扫描 ${checkedFiles} 个文件，发现 ${violations.length} 个违规`);
    process.exit(1);
  } else {
    console.log(`✅ schema guard: ${checkedDtFiles} 个文件（含 defineTool 调用）/ 共 ${checkedFiles} 个 .ts 文件检查通过`);
    process.exit(0);
  }
}

main();