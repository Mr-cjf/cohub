#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const START_MARKER = "<!-- COHUB_ORCHESTRATOR_START -->";
export const END_MARKER = "<!-- COHUB_ORCHESTRATOR_END -->";

const BLOCK = `${START_MARKER}\nCoHub 默认编排入口（指导模式）。\n- 工程、代码库、部署状态、故障排查、测试、远程检查和服务操作先加载 CoHub 编排技能。\n- 主代理负责理解目标、拆分任务、准备完整任务包、派发、等待、复核和汇总；实际代码搜索、文件读取、命令、SSH、测试、部署和验证交给子代理。\n- 普通工程任务至少派发一个相关 worker；独立任务并行，简单任务合并为一个 worker；只有用户明确不委派、普通闲聊/改写，或更高优先级规则禁止时才豁免。\n- 不得把主代理直接执行的业务操作包装成已委派；工具或技能不可用时明确报告编排未生效。子代理不得递归启动 CoHub。\n${END_MARKER}`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

function inspect(text) {
  const starts = count(text, START_MARKER);
  const ends = count(text, END_MARKER);
  if (starts !== ends || starts > 1) return { malformed: true, configured: false, block: null };
  if (!starts) return { malformed: false, configured: false, block: null };
  const match = text.match(new RegExp(`${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`));
  if (!match) return { malformed: true, configured: false, block: null };
  return { malformed: false, configured: true, block: match[0] };
}

function readTarget(path) {
  if (!existsSync(path)) return { path, exists: false, text: "", hash: null };
  const text = readFileSync(path, "utf8");
  return { path, exists: true, text, hash: createHash("sha256").update(text).digest("hex") };
}

function codexHome(options = {}) {
  return resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"));
}

function targets(options = {}) {
  const home = codexHome(options);
  return {
    home,
    base: join(home, "AGENTS.md"),
    override: join(home, "AGENTS.override.md"),
  };
}

function activeTarget(base, override) {
  return override.exists && override.text.trim().length > 0 ? override : base;
}

function lineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function removeBlock(text) {
  const inspected = inspect(text);
  if (inspected.malformed) throw new Error("AGENTS 文件中的 CoHub 编排标记不完整或重复，已拒绝修改");
  if (!inspected.configured) return text;
  const ending = lineEnding(text);
  const start = text.indexOf(inspected.block);
  const end = start + inspected.block.length;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const leading = before.endsWith(ending) ? ending : "";
  const trailing = after.startsWith(ending) ? ending : "";
  return `${before.slice(0, before.length - leading.length)}${after.slice(trailing.length)}`;
}

function addBlock(text) {
  const cleaned = removeBlock(text);
  const ending = lineEnding(text);
  const block = BLOCK.replaceAll("\n", ending);
  return `${cleaned}${ending}${block}${ending}`;
}

function backupPath(path, home) {
  const backupDir = join(home, "orchestrator-backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(backupDir, `${path.split(/[\\/]/).pop()}.${stamp}.bak`);
}

function writeChecked(target, expected, home) {
  const current = readTarget(target.path);
  if (current.hash !== target.hash) throw new Error(`AGENTS 文件在修改前发生变化：${target.path}`);
  if (target.exists) writeFileSync(backupPath(target.path, home), target.text, "utf8");
  mkdirSync(dirname(target.path), { recursive: true });
  const temporary = `${target.path}.cohub-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, expected, "utf8");
  try {
    const beforeRename = readTarget(target.path);
    if (beforeRename.hash !== target.hash) throw new Error(`AGENTS 文件在提交前发生变化：${target.path}`);
    renameSync(temporary, target.path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}

function load(options = {}) {
  const paths = targets(options);
  const base = readTarget(paths.base);
  const override = readTarget(paths.override);
  const baseInfo = inspect(base.text);
  const overrideInfo = inspect(override.text);
  if (baseInfo.malformed || overrideInfo.malformed) throw new Error("AGENTS 文件中的 CoHub 编排标记不完整或重复，已拒绝继续");
  return { ...paths, base, override, baseInfo, overrideInfo, active: activeTarget(base, override) };
}

export function status(options = {}) {
  const state = load(options);
  const configured = state.baseInfo.configured || state.overrideInfo.configured;
  const shadowed = state.baseInfo.configured && state.active.path === state.override.path;
  return {
    configured,
    mode: configured ? "guidance-only" : "disabled",
    sessionState: "unknown",
    protection: "guidance-only",
    activeTarget: state.active.path,
    shadowed,
    managedFiles: [state.baseInfo.configured && state.base.path, state.overrideInfo.configured && state.override.path].filter(Boolean),
  };
}

export function enable(options = {}) {
  const state = load(options);
  const desiredBase = state.active.path === state.base.path ? addBlock(state.base.text) : removeBlock(state.base.text);
  const desiredOverride = state.active.path === state.override.path ? addBlock(state.override.text) : removeBlock(state.override.text);
  const changes = [];
  if (desiredBase !== state.base.text) changes.push([state.base, desiredBase]);
  if (desiredOverride !== state.override.text) changes.push([state.override, desiredOverride]);
  for (const [target, desired] of changes) writeChecked(target, desired, state.home);
  return { ...status(options), changedFiles: changes.map(([target]) => target.path) };
}

export function disable(options = {}) {
  const state = load(options);
  const desiredBase = removeBlock(state.base.text);
  const desiredOverride = removeBlock(state.override.text);
  const changes = [];
  if (desiredBase !== state.base.text) changes.push([state.base, desiredBase]);
  if (desiredOverride !== state.override.text) changes.push([state.override, desiredOverride]);
  for (const [target, desired] of changes) writeChecked(target, desired, state.home);
  return { ...status(options), changedFiles: changes.map(([target]) => target.path) };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (rest[index] !== "--codex-home" || !rest[index + 1]) throw new Error("用法：orchestrator-policy.mjs status|enable|disable [--codex-home PATH]");
    options.codexHome = rest[index + 1];
  }
  const result = command === "status" ? status(options) : command === "enable" ? enable(options) : command === "disable" ? disable(options) : (() => { throw new Error("用法：orchestrator-policy.mjs status|enable|disable"); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
