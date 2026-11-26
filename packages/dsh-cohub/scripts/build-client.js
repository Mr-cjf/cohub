/**
 * 构建阶段拼接客户端 bundle：
 *
 *   src/client/index.js（源码，`// BEGIN/END ROLE_CATALOG` 之间只有空结构占位）
 * + src/client/role-catalog.data.js（生成物，真实目录数据 + content 全文）
 *   → lib/client.js（产物，标记块被替换为真实 `const ROLE_CATALOG = {...};`）
 *
 * 数据缺失或标记块缺失都直接构建失败：绝不静默产出空数据/空目录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "src/client/index.js");
const dataPath = resolve(root, "src/client/role-catalog.data.js");
const output = resolve(root, "lib/client.js");

/** 标记块整行匹配（BEGIN 行允许后缀说明，END 行允许尾随空白） */
const BEGIN_RE = /^[ \t]*\/\/ BEGIN ROLE_CATALOG.*$/m;
const END_RE = /^[ \t]*\/\/ END ROLE_CATALOG[ \t]*$/m;
/** data 文件里目录数据的开头 */
const DATA_HEAD = "export const ROLE_CATALOG = ";
/** 内置角色数：拼装后必须完整（防止误拼空目录） */
const EXPECTED_ROLES = 16;

if (!existsSync(sourcePath)) {
  throw new Error(`构建失败：缺少客户端源文件 ${sourcePath}`);
}
if (!existsSync(dataPath)) {
  throw new Error(
    `构建失败：缺少角色目录数据 ${dataPath}\n` +
      `请先运行 \`bun run scripts/generate-role-catalog.ts\`（\`bun run build\` 已包含该步骤）`,
  );
}

// ── 1. 从 data 文件取出 ROLE_CATALOG 的 JSON 文本与 generatedAt ──────────────
const dataText = readFileSync(dataPath, "utf8");
const headAt = dataText.indexOf(DATA_HEAD);
if (headAt < 0) {
  throw new Error(`构建失败：${dataPath} 里找不到 \`${DATA_HEAD}\` 导出`);
}
const rawJson = dataText.slice(headAt + DATA_HEAD.length).trim();
if (!rawJson.endsWith(";")) {
  throw new Error(`构建失败：${dataPath} 的 ROLE_CATALOG 赋值未以分号结尾`);
}
const jsonText = rawJson.slice(0, -1).trimEnd();
if (jsonText.length === 0 || !jsonText.startsWith("{")) {
  throw new Error(`构建失败：${dataPath} 的 ROLE_CATALOG 不是对象字面量`);
}

let catalog;
try {
  catalog = JSON.parse(jsonText);
} catch (error) {
  throw new Error(`构建失败：${dataPath} 的 ROLE_CATALOG 不是合法 JSON —— ${(error).message}`);
}
const generatedAt = typeof catalog?.generatedAt === "string" ? catalog.generatedAt : "";
if (generatedAt === "") {
  throw new Error(`构建失败：${dataPath} 的 ROLE_CATALOG 缺少 generatedAt`);
}
const roleNames = Object.keys(catalog?.roles ?? {});
if (roleNames.length !== EXPECTED_ROLES) {
  throw new Error(`构建失败：目录角色数 ${roleNames.length}，期望 ${EXPECTED_ROLES}`);
}
const noContent = roleNames.filter((name) => typeof catalog.roles[name]?.content !== "string" || catalog.roles[name].content.trim() === "");
if (noContent.length > 0) {
  throw new Error(`构建失败：以下角色缺少 content 正文：${noContent.join(", ")}`);
}

// ── 2. 把 index.js 的标记块替换成真实数据 ────────────────────────────────────
const source = readFileSync(sourcePath, "utf8");
if (!source.includes("window.__ModuleLoader__.load")) {
  throw new Error(`Invalid client bundle source: ${sourcePath} must emit window.__ModuleLoader__.load`);
}

const beginMatch = BEGIN_RE.exec(source);
if (beginMatch === null) {
  throw new Error(`构建失败：${sourcePath} 缺少 \`// BEGIN ROLE_CATALOG\` 标记行`);
}
const endMatch = END_RE.exec(source);
if (endMatch === null) {
  throw new Error(`构建失败：${sourcePath} 缺少 \`// END ROLE_CATALOG\` 标记行`);
}
if (endMatch.index < beginMatch.index) {
  throw new Error(`构建失败：${sourcePath} 的 ROLE_CATALOG 标记顺序反了（END 在 BEGIN 之前）`);
}

const block = `    const ROLE_CATALOG = ${jsonText};`;
const outputText =
  `${source.slice(0, beginMatch.index + beginMatch[0].length)}\n${block}\n    ${source.slice(endMatch.index)}`;
if (outputText.includes("const ROLE_CATALOG = { tiers: {}, roles: {}, builtinTeams: [] };")) {
  throw new Error("构建失败：占位块未被替换，产物会呈现空目录");
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, outputText, "utf8");

console.log(
  `✅ built ${output}（${Buffer.byteLength(outputText, "utf8")} 字节；` +
    `${roleNames.length} 角色包含 content 全文；generatedAt=${generatedAt}）`,
);
