import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { COHUB_ROLES, parseAgentConfig, resolveAgents } from "./resolve-agents.mjs";

export const COHUB_WORKFLOWS = Object.freeze([
  "co-git-commit", "co-git-commit-release", "co-branch-summary",
]);
export const COHUB_SKILLS = Object.freeze(["cohub", ...COHUB_ROLES, ...COHUB_WORKFLOWS]);

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(packageRoot, "../..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function localPath(root, path) {
  assert.ok(path.startsWith("./"), `Expected a relative plugin path: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel), `Path escapes root: ${path}`);
  statSync(target);
  return target;
}

function validateSkillLinks(skillPath, source) {
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const [, rawTarget] of links) {
    const target = rawTarget.trim().match(/^<([^>]+)>|^(\S+)/);
    if (!target) continue;
    const link = target[1] ?? target[2];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
    const path = link.split(/[?#]/, 1)[0];
    if (!path) continue;
    const resolved = resolve(dirname(skillPath), path);
    const rel = relative(packageRoot, resolved);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel), `Skill link escapes package: ${link}`);
    statSync(resolved);
  }
}

function validateSkillFrontmatter(name, source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `Invalid skill frontmatter: ${name}`);
  assert.match(match[1], new RegExp(`^name: ${name}\\r?$`, "m"));
  assert.match(match[1], /^description:\s*.+$/m);
}

export function validate() {
  const pkg = json(resolve(packageRoot, "package.json"));
  const manifest = json(resolve(packageRoot, ".codex-plugin/plugin.json"));
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  const marketplace = json(resolve(repoRoot, ".agents/plugins/marketplace.json"));
  assert.equal(marketplace.name, "cohub");
  const entry = marketplace.plugins.find((item) => item.name === pkg.name);
  assert.equal(entry.source.source, "local");
  assert.equal(localPath(repoRoot, entry.source.path), packageRoot);
  assert.equal(entry.policy.installation, "AVAILABLE");
  for (const key of ["logo", "composerIcon"]) localPath(packageRoot, manifest.interface[key]);
  const skillsRoot = localPath(packageRoot, manifest.skills);
  localPath(packageRoot, "./skills/cohub/references/efficiency.md");
  localPath(packageRoot, "./scripts/check-evidence.mjs");
  localPath(packageRoot, "./scripts/summarize-log.mjs");
  localPath(packageRoot, "./scripts/orchestrator-policy.mjs");
  const roles = [...COHUB_ROLES];
  const expected = COHUB_SKILLS;
  assert.equal(COHUB_SKILLS.length, 1 + COHUB_ROLES.length + COHUB_WORKFLOWS.length,
    "skill set = 1 entry + 12 roles + 3 workflows");
  assert.ok(COHUB_WORKFLOWS.every((name) => !roles.includes(name) && name !== "cohub"),
    "workflow skills must not be agent roles");
  assert.deepEqual(readdirSync(skillsRoot).sort(), [...expected].sort());
  for (const name of expected) {
    const skillPath = resolve(skillsRoot, name, "SKILL.md");
    const source = readFileSync(skillPath, "utf8");
    validateSkillFrontmatter(name, source);
    validateSkillLinks(skillPath, source);
  }
  statSync(resolve(skillsRoot, "cohub/references/context-guard.md"));
  statSync(resolve(skillsRoot, "cohub/references/batch-execution.md"));
  const mcp = json(localPath(packageRoot, manifest.mcpServers));
  const server = mcp.mcpServers["cohub-council"];
  assert.equal(server.command, "node");
  assert.equal(server.cwd, ".");
  localPath(packageRoot, server.args[0]);
  const example = json(resolve(packageRoot, "config/cohub.example.json"));
  const schema = json(resolve(packageRoot, "config/cohub.schema.json"));
  const subagentExample = json(resolve(packageRoot, "config/subagents.example.json"));
  parseAgentConfig(JSON.stringify(example), "cohub.example.json");
  parseAgentConfig(JSON.stringify(subagentExample), "subagents.example.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(Object.keys(schema.properties.subagents.properties.roles.properties).sort(), roles.sort());
  assert.equal(schema.properties.subagents.additionalProperties, false);
  for (const role of roles) {
    assert.equal(schema.properties.subagents.properties.roles.properties[role].$ref, "#/$defs/subagentSettings");
  }
  assert.deepEqual(resolveAgents(["co-explorer", "co-oracle"], { config: example }).map(({ role }) => role), ["co-explorer", "co-oracle"]);
  assert.ok(example.council.presets[example.council.default_preset]);
  for (const provider of Object.values(example.council.providers)) {
    assert.ok(server.env_vars.includes(provider.api_key_env), `MCP must forward ${provider.api_key_env}`);
  }
  assert.ok(server.env_vars.includes("COHUB_CONFIG"));
  assert.ok(server.env_vars.includes("COHUB_API_KEY"));
  console.log(`Validated ${pkg.name}@${pkg.version}: ${COHUB_SKILLS.length} skills (1 entry + ${COHUB_ROLES.length} roles + ${COHUB_WORKFLOWS.length} workflows) and Council MCP`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validate();
