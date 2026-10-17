#!/usr/bin/env node
// 初始化用户配置；保留已有配置，包括旧版路径中的配置。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const example = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "cohub.example.json");
const bundledSchema = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "cohub.schema.json");
const target = process.env.COHUB_CONFIG || (process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, "oh-my-codex-cohub", "config.json")
  : join(homedir(), ".codex", "oh-my-codex-cohub", "config.json"));
const legacy = process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, ".config", "oh-my-codex-cohub", "config.json")
  : join(homedir(), ".config", "oh-my-codex-cohub", "config.json");

if (existsSync(target)) {
  console.log(`配置文件已存在：${target}`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(!process.env.COHUB_CONFIG && existsSync(legacy) ? legacy : example, target);
  console.log(`已创建配置文件：${target}`);
}

try {
  const config = JSON.parse(readFileSync(target, "utf8"));
  if (config?.["$schema"] === "./cohub.schema.json") {
    const targetSchema = join(dirname(target), "cohub.schema.json");
    if (!existsSync(targetSchema)) copyFileSync(bundledSchema, targetSchema);
  }
} catch {
  // Leave invalid or unreadable user configuration untouched.
}
