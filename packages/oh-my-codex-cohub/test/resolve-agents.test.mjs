import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgent, resolveAgents, readAgentConfig } from "../scripts/resolve-agents.mjs";

const script = fileURLToPath(new URL("../scripts/resolve-agents.mjs", import.meta.url));
const roles = ["co-orchestrator", "co-planner", "co-oracle", "co-librarian", "co-explorer", "co-designer", "co-fixer", "co-observer", "co-council", "co-rule-user", "co-rule-project", "co-rule-app"];
// 最小合成夹具：刻意不含真实模型的 ultra/max 高档，仅用于覆盖合并/校验/拒绝逻辑，不代表真实 catalog 能力。
const capabilities = {
  models: [
    { id: "gpt-6.1-sol", reasoning_efforts: ["low", "medium", "high"] },
    { id: "ccs-minimax/MiniMax-M3", reasoning_efforts: ["low", "high"] },
  ],
  inherited: { model: "gpt-6.1-sol", reasoning_effort: "medium" },
  supports: { model: true, reasoning_effort: true, fork_turns_none: true },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cohub-agent-config-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, home };
}

function save(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function projectConfig(f, value) {
  return save(join(f.cwd, ".codex", "cohub.json"), value);
}

function userConfig(f, value) {
  return save(join(f.home, ".codex", "oh-my-codex-cohub", "config.json"), value);
}

function options(f, extra = {}) {
  return { cwd: f.cwd, homeDir: f.home, env: {}, ...extra };
}

test("resolves one role and only emits explicit spawn fields", (t) => {
  const f = fixture(t);
  const result = resolveAgent("co-explorer", options(f, {
    config: { subagents: { roles: { "co-explorer": { model: "ccs-minimax/MiniMax-M3" } } } },
    capabilities,
  }));
  assert.equal(result.model, "ccs-minimax/MiniMax-M3");
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.spawnArgs, { model: "ccs-minimax/MiniMax-M3", fork_turns: "none" });
});

test("merges role values over defaults within each source and higher source defaults over lower roles", (t) => {
  const f = fixture(t);
  userConfig(f, { subagents: { roles: { "co-explorer": { model: "ccs-minimax/MiniMax-M3", reasoning_effort: "low" } } } });
  projectConfig(f, { subagents: { defaults: { reasoning_effort: "high" }, roles: { "co-explorer": { model: "gpt-6.1-sol" } } } });
  const result = resolveAgent("co-explorer", options(f, { capabilities }));
  assert.equal(result.source, "project");
  assert.equal(result.model, "gpt-6.1-sol");
  assert.equal(result.reasoning_effort, "high");
  assert.deepEqual(result.fieldSources, {
    model: { source: "project", path: join(f.cwd, ".codex", "cohub.json") },
    reasoning_effort: { source: "project", path: join(f.cwd, ".codex", "cohub.json") },
  });
});

test("applies default, project, user, environment, and one-time override precedence", (t) => {
  const f = fixture(t);
  userConfig(f, { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3" } } });
  projectConfig(f, { subagents: { defaults: { model: "gpt-6.1-sol" } } });
  const envPath = save(join(f.root, "env.json"), { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3" } } });
  const result = resolveAgent("co-fixer", options(f, {
    env: { COHUB_CONFIG: envPath },
    config: { subagents: { defaults: { reasoning_effort: "high" } } },
    overrides: { model: "gpt-6.1-sol", reasoning_effort: "low" },
    capabilities,
  }));
  assert.equal(result.source, "task");
  assert.equal(result.model, "gpt-6.1-sol");
  assert.equal(result.reasoning_effort, "low");
});

test("null at a higher source resets inherited values", (t) => {
  const f = fixture(t);
  userConfig(f, { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3", reasoning_effort: "low" } } });
  projectConfig(f, { subagents: { defaults: { model: null }, roles: { "co-explorer": { reasoning_effort: null } } } });
  const result = resolveAgent("co-explorer", options(f));
  assert.equal(result.model, undefined);
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.spawnArgs, { fork_turns: "all" });
});

test("one-time null override resets configured fields to native inheritance", (t) => {
  const f = fixture(t);
  const result = resolveAgent("co-fixer", {
    homeDir: f.home,
    cwd: f.cwd,
    config: { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3", reasoning_effort: "high" } } },
    overrides: { model: null, reasoning_effort: null },
  });
  assert.deepEqual(result.spawnArgs, { fork_turns: "all" });
});

test("requires capabilities for explicit fields and validates model and effort support", (t) => {
  const f = fixture(t);
  for (const config of [
    { model: "ccs-minimax/MiniMax-M3" },
    { reasoning_effort: "high" },
  ]) assert.throws(() => resolveAgent("co-fixer", options(f, { overrides: config })), /capabilit/i);
  assert.throws(() => resolveAgent("co-fixer", options(f, { overrides: { model: "unknown-model" }, capabilities })), /unknown model/i);
  assert.throws(() => resolveAgent("co-fixer", options(f, { overrides: { model: "ccs-minimax/MiniMax-M3", reasoning_effort: "medium" }, capabilities })), /does not support reasoning/i);
  assert.throws(() => resolveAgent("co-fixer", options(f, { overrides: { reasoning_effort: "high" }, capabilities: { ...capabilities, inherited: { model: null } } })), /inherited model/i);
  assert.throws(() => resolveAgent("co-fixer", options(f, { overrides: { model: "ccs-minimax/MiniMax-M3" }, capabilities: { ...capabilities, supports: { ...capabilities.supports, model: false } } })), /support.*model/i);
});

test("effort-only config validates against the inherited model and keeps model implicit", (t) => {
  const f = fixture(t);
  const result = resolveAgent("co-explorer", {
    homeDir: f.home,
    cwd: f.cwd,
    config: { subagents: { defaults: { reasoning_effort: "high" } } },
    capabilities,
  });
  assert.equal(result.model, undefined);
  assert.equal(result.reasoning_effort, "high");
  assert.deepEqual(result.spawnArgs, { reasoning_effort: "high", fork_turns: "none" });
});

test("model-only config leaves reasoning effort to the platform", (t) => {
  const f = fixture(t);
  const result = resolveAgent("co-explorer", { homeDir: f.home, cwd: f.cwd, overrides: { model: "ccs-minimax/MiniMax-M3" }, capabilities });
  assert.deepEqual(result.spawnArgs, { model: "ccs-minimax/MiniMax-M3", fork_turns: "none" });
});

test("unknown roles, unknown fields, legacy variants in subagents, and invalid data fail", () => {
  assert.throws(() => resolveAgent("co-not-a-role", {}), /unknown role/i);
  for (const config of [
    { subagents: { defaults: { variant: "high" } } },
    { subagents: { roles: { "co-fixer": { variant: "high" } } } },
    { subagents: { typo: {} } },
    { unexpected: true },
    { subagents: { roles: { "co-fixer": { model: 4 } } } },
  ]) assert.throws(() => resolveAgent("co-fixer", { config }), /unknown|invalid|variant|field|must be/i);
  assert.throws(() => resolveAgent("co-fixer", { config: JSON.parse('{"subagents":{"defaults":{"__proto__":{"polluted":true}}}}') }), /unknown|prototype/i);
  assert.equal({}.polluted, undefined);
});

test("reads the shipped full config and standalone subagent examples", () => {
  const full = readAgentConfig(new URL("../config/cohub.example.json", import.meta.url));
  const subagents = readAgentConfig(new URL("../config/subagents.example.json", import.meta.url));
  assert.equal(subagents.title, "Subagent model override example");
  // council 段含真实模型名，刻意不做 null 断言；仅校验 subagents 段的 12 角色默认全为 null。
  for (const example of [full, subagents]) {
    assert.equal(example.subagents.defaults.model, null);
    assert.equal(example.subagents.defaults.reasoning_effort, null);
    for (const role of roles) {
      assert.equal(example.subagents.roles[role].model, null);
      assert.equal(example.subagents.roles[role].reasoning_effort, null);
    }
  }
});

test("rejects unknown reasoning effort enum values even for another role", () => {
  assert.throws(() => resolveAgent("co-explorer", {
    config: { subagents: { roles: { "co-observer": { reasoning_effort: "custom" } } } },
  }), /reasoning_effort.*(must be|one of|invalid)/i);
});

test("does not execute legacy agents variants and warns when subagents is absent", (t) => {
  const f = fixture(t);
  userConfig(f, { agents: { "co-explorer": { model: "deepseek/deepseek-v4-flash", variant: "low" } } });
  const result = resolveAgent("co-explorer", options(f));
  assert.deepEqual(result.spawnArgs, { fork_turns: "all" });
  assert.match(result.warnings.join(" "), /legacy.*agents/i);
});

test("warns about ignored legacy agents when subagents are also present", (t) => {
  const f = fixture(t);
  const result = resolveAgent("co-explorer", options(f, {
    config: {
      agents: { "co-explorer": { model: "deepseek/deepseek-v4-flash", variant: "low" } },
      subagents: { roles: { "co-explorer": { model: "ccs-minimax/MiniMax-M3" } } },
    },
    capabilities,
  }));
  assert.equal(result.model, "ccs-minimax/MiniMax-M3");
  assert.doesNotMatch(result.model, /deepseek/i);
  assert.match(result.warnings.join(" "), /legacy.*agents/i);
});

test("discovers no-file, project, user, and legacy sources in the documented order", (t) => {
  const f = fixture(t);
  assert.equal(resolveAgent("co-explorer", options(f)).source, "default");
  userConfig(f, { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3" } } });
  assert.equal(resolveAgent("co-explorer", options(f, { capabilities })).source, "user");
  projectConfig(f, { subagents: { defaults: { model: "gpt-6.1-sol" } } });
  assert.equal(resolveAgent("co-explorer", options(f, { capabilities })).source, "project");
  rmSync(join(f.cwd, ".codex"), { recursive: true });
  rmSync(join(f.home, ".codex"), { recursive: true });
  save(join(f.home, ".config", "oh-my-codex-cohub", "config.json"), { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3" } } });
  assert.equal(resolveAgent("co-explorer", options(f, { capabilities })).source, "legacy");
});

test("an explicit environment or --config path must exist and parse without fallback", (t) => {
  const f = fixture(t);
  userConfig(f, { subagents: { defaults: { model: "ccs-minimax/MiniMax-M3" } } });
  assert.throws(() => resolveAgent("co-explorer", options(f, { env: { COHUB_CONFIG: join(f.root, "missing.json") } })), /COHUB_CONFIG|not found|exist/i);
  const bad = join(f.root, "bad.json");
  writeFileSync(bad, "{");
  assert.throws(() => readAgentConfig(bad), /JSON|parse/i);
  assert.throws(() => resolveAgent("co-explorer", options(f, { configPath: bad })), /JSON|parse/i);
});

test("batch resolution is atomic and includes every role", (t) => {
  const f = fixture(t);
  const results = resolveAgents(["co-explorer", "co-fixer"], options(f));
  assert.deepEqual(results.map(({ role }) => role), ["co-explorer", "co-fixer"]);
  assert.throws(() => resolveAgents(["co-explorer", "unknown"], options(f)), /unknown role/i);
});

test("batch resolution discovers configuration once and shares a consistent snapshot", (t) => {
  const f = fixture(t);
  let reads = 0;
  const result = resolveAgents(["co-explorer", "co-fixer"], {
    ...options(f),
    get config() {
      reads += 1;
      return { subagents: { defaults: { model: reads === 1 ? "ccs-minimax/MiniMax-M3" : "gpt-6.1-sol" } } };
    },
    capabilities,
  });
  assert.equal(reads, 1);
  assert.deepEqual(result.map((entry) => entry.model), ["ccs-minimax/MiniMax-M3", "ccs-minimax/MiniMax-M3"]);
});

test("CLI prints a compact batch result and rejects invalid batches with status 2", (t) => {
  const f = fixture(t);
  const config = save(join(f.root, "config.json"), { subagents: { roles: { "co-explorer": { model: "ccs-minimax/MiniMax-M3" } } } });
  const caps = save(join(f.root, "caps.json"), capabilities);
  const good = spawnSync(process.execPath, [script, "--roles", "co-explorer,co-fixer", "--cwd", f.cwd, "--config", config, "--capabilities", caps], { encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } });
  assert.equal(good.status, 0, good.stderr);
  const output = JSON.parse(good.stdout);
  assert.deepEqual(output.results.map(({ role }) => role), ["co-explorer", "co-fixer"]);
  assert.equal(output.results[0].spawnArgs.model, "ccs-minimax/MiniMax-M3");
  assert.doesNotMatch(good.stdout, /api_key|providers|council/i);

  const invalid = spawnSync(process.execPath, [script, "--roles", "co-explorer,co-fixer", "--cwd", f.cwd, "--config", config], { encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /capabilit/i);
});
