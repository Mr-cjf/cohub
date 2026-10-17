#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COHUB_ROLES = Object.freeze([
  "co-orchestrator", "co-planner", "co-oracle", "co-librarian", "co-explorer", "co-designer",
  "co-fixer", "co-observer", "co-council", "co-rule-user", "co-rule-project", "co-rule-app",
]);

const CONFIG_KEYS = new Set(["$schema", "title", "description", "council", "agents", "subagents"]);
const VALUE_KEYS = new Set(["model", "reasoning_effort"]);
const SUBAGENT_KEYS = new Set(["defaults", "roles"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a JSON object`);
  return value;
}

function checkKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${label} contains forbidden prototype key: ${key}`);
    if (!allowed.has(key)) fail(`${label} contains unknown field: ${key}`);
  }
}

function checkValueFields(value, label) {
  object(value, label);
  checkKeys(value, VALUE_KEYS, label);
  for (const key of VALUE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] !== null && (typeof value[key] !== "string" || value[key].trim() === "")) {
      fail(`${label}.${key} must be a non-empty string or null`);
    }
    if (key === "reasoning_effort" && value[key] !== null && !REASONING_EFFORTS.has(value[key])) {
      fail(`${label}.reasoning_effort must be one of ${[...REASONING_EFFORTS].join(", ")} or null`);
    }
  }
}

export function parseAgentConfig(text, label = "configuration") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON in ${label}: ${error.message}`);
  }
  return validateAgentConfig(parsed, label);
}

export function validateAgentConfig(config, label = "configuration") {
  object(config, label);
  checkKeys(config, CONFIG_KEYS, label);
  for (const key of ["$schema", "title", "description"]) {
    if (Object.hasOwn(config, key) && typeof config[key] !== "string") fail(`${label}.${key} must be a string`);
  }
  if (Object.hasOwn(config, "subagents")) {
    const subagents = object(config.subagents, `${label}.subagents`);
    checkKeys(subagents, SUBAGENT_KEYS, `${label}.subagents`);
    if (Object.hasOwn(subagents, "defaults")) checkValueFields(subagents.defaults, `${label}.subagents.defaults`);
    if (Object.hasOwn(subagents, "roles")) {
      const roleEntries = object(subagents.roles, `${label}.subagents.roles`);
      for (const [role, settings] of Object.entries(roleEntries)) {
        if (!COHUB_ROLES.includes(role)) fail(`${label}.subagents.roles contains unknown role: ${role}`);
        checkValueFields(settings, `${label}.subagents.roles.${role}`);
      }
    }
  }
  return config;
}

export function readAgentConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`Cannot read configuration ${path}: ${error.message}`);
  }
  return parseAgentConfig(text, path);
}

function validateOverrides(overrides) {
  if (overrides === undefined) return {};
  checkValueFields(overrides, "task overrides");
  return overrides;
}

function apply(target, values, fieldSources, sourceInfo) {
  for (const key of VALUE_KEYS) {
    if (Object.hasOwn(values, key)) {
      target[key] = values[key];
      fieldSources[key] = sourceInfo;
    }
  }
}

function validateCapabilities(capabilities) {
  if (capabilities === undefined) fail("Explicit subagent model or reasoning effort requires runtime capabilities");
  object(capabilities, "capabilities");
  checkKeys(capabilities, new Set(["models", "inherited", "supports"]), "capabilities");
  if (!Array.isArray(capabilities.models)) fail("capabilities.models must be an array");
  const models = new Map();
  for (const entry of capabilities.models) {
    object(entry, "capabilities model");
    checkKeys(entry, new Set(["id", "reasoning_efforts"]), "capabilities model");
    if (typeof entry.id !== "string" || !entry.id.trim() || !Array.isArray(entry.reasoning_efforts) ||
        entry.reasoning_efforts.some((effort) => typeof effort !== "string")) {
      fail("Each capability model requires an id and reasoning_efforts string array");
    }
    if (models.has(entry.id)) fail(`Duplicate capability model: ${entry.id}`);
    models.set(entry.id, new Set(entry.reasoning_efforts));
  }
  const inherited = object(capabilities.inherited, "capabilities.inherited");
  checkKeys(inherited, new Set(["model", "reasoning_effort"]), "capabilities.inherited");
  for (const key of ["model", "reasoning_effort"]) {
    if (Object.hasOwn(inherited, key) && inherited[key] !== null && typeof inherited[key] !== "string") {
      fail(`capabilities.inherited.${key} must be a string or null`);
    }
  }
  const supports = object(capabilities.supports, "capabilities.supports");
  checkKeys(supports, new Set(["model", "reasoning_effort", "fork_turns_none"]), "capabilities.supports");
  for (const key of ["model", "reasoning_effort", "fork_turns_none"]) {
    if (typeof supports[key] !== "boolean") fail(`capabilities.supports.${key} must be boolean`);
  }
  return { models, inherited, supports };
}

function finalizeResult(role, values, source, fieldSources, warnings, capabilities) {
  const explicitModel = values.model !== null && values.model !== undefined;
  const explicitEffort = values.reasoning_effort !== null && values.reasoning_effort !== undefined;
  const spawnArgs = {};
  if (explicitModel || explicitEffort) {
    const caps = validateCapabilities(capabilities);
    if (!caps.supports.fork_turns_none) fail("Runtime does not support fork_turns: 'none' required for explicit subagent settings");
    if (explicitModel) {
      if (!caps.supports.model) fail("Runtime does not support explicit subagent model selection");
      if (!caps.models.has(values.model)) fail(`Unknown model in runtime capabilities: ${values.model}`);
      spawnArgs.model = values.model;
    }
    if (explicitEffort) {
      if (!caps.supports.reasoning_effort) fail("Runtime does not support explicit reasoning_effort selection");
      const targetModel = explicitModel ? values.model : caps.inherited.model;
      if (!targetModel) fail("An inherited model is required to validate an explicit reasoning_effort");
      const efforts = caps.models.get(targetModel);
      if (!efforts) fail(`Unknown inherited model in runtime capabilities: ${targetModel}`);
      if (!efforts.has(values.reasoning_effort)) {
        fail(`Runtime model ${targetModel} does not support reasoning_effort '${values.reasoning_effort}'`);
      }
      spawnArgs.reasoning_effort = values.reasoning_effort;
    }
    spawnArgs.fork_turns = "none";
  } else {
    spawnArgs.fork_turns = "all";
  }

  const result = { source: source ?? "default", role };
  if (explicitModel) result.model = values.model;
  if (explicitEffort) result.reasoning_effort = values.reasoning_effort;
  if (Object.keys(fieldSources).length) result.fieldSources = fieldSources;
  result.spawnArgs = spawnArgs;
  result.warnings = warnings;
  return result;
}

export function resolveAgentConfig(role, layers, { overrides, capabilities } = {}) {
  if (!COHUB_ROLES.includes(role)) fail(`Unknown role: ${role}`);
  if (!Array.isArray(layers)) fail("Configuration layers must be an array");
  const values = {};
  const fieldSources = {};
  let source;
  const warnings = [];
  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || typeof layer.source !== "string") fail("Each configuration layer requires a source and config");
    const config = validateAgentConfig(layer.config, layer.source);
    if (Object.hasOwn(config, "agents")) {
      warnings.push(`${layer.source}: legacy agents model settings are ignored; use subagents instead`);
    }
    const subagents = config.subagents ?? {};
    let applied = false;
    const sourceInfo = { source: layer.source };
    if (layer.path) sourceInfo.path = layer.path;
    if (subagents.defaults) {
      apply(values, subagents.defaults, fieldSources, sourceInfo);
      applied = Object.keys(subagents.defaults).length > 0;
    }
    const roleSettings = subagents.roles?.[role];
    if (roleSettings) {
      apply(values, roleSettings, fieldSources, sourceInfo);
      applied ||= Object.keys(roleSettings).length > 0;
    }
    if (applied) source = layer.source;
  }
  const taskOverrides = validateOverrides(overrides);
  if (Object.keys(taskOverrides).length) {
    apply(values, taskOverrides, fieldSources, { source: "task" });
    source = "task";
  }
  return finalizeResult(role, values, source, fieldSources, warnings, capabilities);
}

function readLayer(path, source) {
  return existsSync(path) ? { source, config: readAgentConfig(path), path } : undefined;
}

function discoverLayers({ cwd = process.cwd(), homeDir, env = process.env, configPath, config } = {}) {
  const userRoot = homeDir !== undefined ? join(homeDir, ".codex") : (env.CODEX_HOME || join(homedir(), ".codex"));
  const legacyRoot = homeDir !== undefined ? join(homeDir, ".config") : (env.CODEX_HOME ? join(env.CODEX_HOME, ".config") : join(homedir(), ".config"));
  const layers = [];
  const legacy = readLayer(join(legacyRoot, "oh-my-codex-cohub", "config.json"), "legacy");
  if (legacy) layers.push(legacy);
  const user = readLayer(join(userRoot, "oh-my-codex-cohub", "config.json"), "user");
  if (user) layers.push(user);

  const globalPath = configPath ?? env.COHUB_CONFIG;
  if (globalPath) {
    const label = configPath ? "config" : "env";
    const absolute = resolve(globalPath);
    if (!existsSync(absolute)) fail(`${label === "env" ? "COHUB_CONFIG" : "--config"} file does not exist: ${absolute}`);
    layers.push({ source: label, config: readAgentConfig(absolute), path: absolute });
  } else if (config !== undefined) {
    layers.push({ source: "config", config: validateAgentConfig(config, "provided config") });
  }

  const project = readLayer(join(resolve(cwd), ".codex", "cohub.json"), "project");
  if (project) layers.push(project);
  return layers;
}

export function resolveAgent(role, options = {}) {
  const layers = options.layers ?? discoverLayers(options);
  return resolveAgentConfig(role, layers, options);
}

export function resolveAgents(roles, options = {}) {
  if (!Array.isArray(roles) || roles.length === 0) fail("At least one role is required");
  const layers = options.layers ?? discoverLayers(options);
  const overrideMap = options.overrides === undefined ? undefined : object(options.overrides, "overrides");
  const directOverrides = overrideMap && Object.keys(overrideMap).some((key) => VALUE_KEYS.has(key));
  if (overrideMap && !directOverrides) {
    for (const [role, values] of Object.entries(overrideMap)) {
      if (!COHUB_ROLES.includes(role)) fail(`overrides contains unknown role: ${role}`);
      validateOverrides(values);
    }
  } else if (overrideMap) {
    validateOverrides(overrideMap);
  }
  const results = roles.map((role) => {
    const overrides = directOverrides ? overrideMap : overrideMap?.[role];
    return resolveAgentConfig(role, layers, { overrides, capabilities: options.capabilities });
  });
  return results;
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Cannot parse ${label} file ${path}: ${error.message}`);
  }
}

function parseArgs(args) {
  const values = {};
  const allowed = new Set(["--roles", "--cwd", "--config", "--capabilities", "--overrides"]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.has(flag)) fail(`Unknown option: ${flag}`);
    if (values[flag] !== undefined) fail(`Duplicate option: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    values[flag] = value;
  }
  if (!values["--roles"]) fail("--roles is required");
  const roles = values["--roles"].split(",").map((role) => role.trim()).filter(Boolean);
  if (!roles.length || new Set(roles).size !== roles.length) fail("--roles must contain unique comma-separated roles");
  return { values, roles };
}

function main() {
  try {
    const { values, roles } = parseArgs(process.argv.slice(2));
    const capabilities = values["--capabilities"] ? readJsonFile(values["--capabilities"], "capabilities") : undefined;
    const overrides = values["--overrides"] ? readJsonFile(values["--overrides"], "overrides") : undefined;
    const results = resolveAgents(roles, {
      cwd: values["--cwd"] ? resolve(values["--cwd"]) : process.cwd(),
      configPath: values["--config"],
      capabilities,
      overrides,
    });
    const warnings = [...new Set(results.flatMap((result) => result.warnings))];
    process.stdout.write(`${JSON.stringify({ results, warnings }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`resolve-agents: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
