import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { COHUB_ROLES } from "../scripts/resolve-agents.mjs";
import { packageRoot, validate, COHUB_SKILLS, COHUB_WORKFLOWS } from "../scripts/validate.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "cohub-codex-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home,
    COHUB_CONFIG: "", COHUB_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "", MINIMAX_API_KEY: "" } };
}

function client(t, env) {
  const child = spawn(process.execPath, [resolve(packageRoot, "mcp/council_server.mjs")], {
    cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  t.after(() => { lines.close(); child.kill(); });
  return (method, params = {}) => new Promise((resolveResponse, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`MCP timed out: ${method}; ${stderr}`));
    }, 5000);
    pending.set(requestId, { resolve: resolveResponse, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
}

test("plugin manifest, skills and marketplace are installable", () => validate());

function readSkillFrontmatter(root, dir) {
  const source = readFileSync(resolve(root, "skills", dir, "SKILL.md"), "utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${dir}: must have YAML frontmatter`);
  return { source, frontmatter: match[1] };
}

const workflowEntries = [
  { root: packageRoot, dir: "co-git-commit", kind: "commit" },
  { root: packageRoot, dir: "co-git-commit-release", kind: "release" },
  { root: packageRoot, dir: "co-branch-summary", kind: "summary" },
];

test("workflow coverage is fully package-local: fixed 3-set complete, no repo-root .opencode dependency", () => {
  assert.equal(workflowEntries.length, COHUB_WORKFLOWS.length, "covered entries equal the package workflow set");
  assert.deepEqual(workflowEntries.map(({ dir }) => dir).sort(), [...COHUB_WORKFLOWS].sort(), "the fixed 3 package workflows are fully covered");
  assert.ok(workflowEntries.every(({ root }) => root === packageRoot), "all covered workflows live in the package; no repo-root .opencode skill is claimed as published");
  // 故意无根 .opencode 也可执行：干净 checkout 不含根 .opencode 时，测试只读包内文件即可完成校验
  for (const { root, dir } of workflowEntries) {
    const { source } = readSkillFrontmatter(root, dir);
    assert.match(source, /^#{1,6}\s+\S/m, `${dir}: package SKILL.md is complete without repo-root .opencode`);
  }
});

test("skill contract: exactly 16 skills = 1 entry + 12 roles + 3 workflows, role mapping unchanged", () => {
  assert.equal(COHUB_SKILLS.length, 16, "16 skills in total");
  assert.equal(COHUB_ROLES.length, 12, "roles stay at 12");
  assert.equal(COHUB_WORKFLOWS.length, 3, "3 git workflows");
  assert.deepEqual([...COHUB_SKILLS].sort(), ["cohub", ...COHUB_ROLES, ...COHUB_WORKFLOWS].sort());
  assert.equal(new Set(COHUB_SKILLS).size, 16, "no duplicate skill names");
  for (const workflow of COHUB_WORKFLOWS) {
    assert.ok(!COHUB_ROLES.includes(workflow), `${workflow} is a workflow, not a role`);
    assert.notEqual(workflow, "cohub");
  }
  const onDisk = readdirSync(resolve(packageRoot, "skills")).sort();
  assert.deepEqual(onDisk, [...COHUB_SKILLS].sort(), "skills dir equals the fixed 16-skill set");
  const schema = JSON.parse(readFileSync(resolve(packageRoot, "config/cohub.schema.json"), "utf8"));
  const schemaRoles = Object.keys(schema.properties.subagents.properties.roles.properties).sort();
  assert.deepEqual(schemaRoles, [...COHUB_ROLES].sort(), "schema roles are still exactly the 12 co-* roles");
  for (const role of COHUB_ROLES) {
    assert.equal(schema.properties.subagents.properties.roles.properties[role].$ref, "#/$defs/subagentSettings");
  }
  for (const workflow of COHUB_WORKFLOWS) {
    assert.ok(!schemaRoles.includes(workflow), `${workflow} must not enter the role schema`);
  }
});

test("workflow skills: frontmatter name matches dirname, single-line Chinese description", () => {
  for (const { root, dir } of workflowEntries) {
    const { frontmatter } = readSkillFrontmatter(root, dir);
    // 允许无引号 / "dir" / 'dir'，但引号必须配对（不接收不配对引号）
    assert.match(frontmatter, new RegExp(`^name:\\s*(?:"${dir}"|'${dir}'|${dir})\\s*$`, "m"), `${dir}: name equals dirname (paired quotes or none)`);
    const descriptionLines = frontmatter.split(/\r?\n/).filter((line) => line.startsWith("description:"));
    assert.equal(descriptionLines.length, 1, `${dir}: description is a single line`);
    assert.match(descriptionLines[0], /description:\s*\S.*[\u4e00-\u9fff]/, `${dir}: description is Chinese text`);
    assert.doesNotMatch(frontmatter, /^context:\s*fork\b/m, `${dir}: no context:fork`);
    assert.doesNotMatch(frontmatter, /^![\w-]+:/m, `${dir}: no !-preinjected keys`);
  }
});

const forbiddenSteps = [
  /^git add (?:\.|-A|--all)(?:\s|$)/m,            // 不 git add .（覆盖行末，精确边界）
  /^git commit --amend\b/m,                       // 不 amend
  /^git push (?:-f|--force)\b/m,                  // 不 force push
  /^git (?:commit|push|merge)[^\n]*--no-verify/m, // 不绕过 hooks
  /^git -c core\.hooksPath\b/m,                   // 不绕过 hooks
  /^git remote (?:add|set-url)\b/m,               // 不改 remote
  /^git (?:checkout|switch|branch -[mM])\b[^\n]*(?:main|master)\b/m, // 无固定分支
  /^git (?:remote add|push)\b[^\n]*https?:\/\//m, // 无硬编码 remote
  /^mvn\b/m,                                      // 无 Maven
  /^npm run install:codex/m,                      // 无旧安装刷新
];
const writeCommands = /^git (?:add|commit|push|tag|checkout|switch|branch|merge|rebase|reset|stash|rm|mv|restore|stage)\b/m;

test("forbidden command scanner catches real command lines and ignores prose warnings", () => {
  const positives = [
    "git add .",
    "git add . --verbose",
    "git add -A",
    "git add --all",
    "git commit --amend -m x",
    "git push --force origin main",
    "git push -f",
    "git commit --no-verify -m x",
    "git -c core.hooksPath=/dev/null commit",
    "git remote add origin https://example.com/repo.git",
    "git remote set-url origin https://example.com/repo.git",
    "git checkout main",
    "git switch main",
    "git branch -M main",
    "git push origin https://example.com/repo.git",
    "mvn package",
    "npm run install:codex",
  ];
  const negatives = [
    "不要 git add .",
    "禁止 git add . 夹带未授权文件",
    "| `git add .` 夹带未授权文件 |",
    "请勿 git commit --amend",
    "不 push --force、不绕 hooks",
    "| 用 `git push -f` 会丢失历史 |",
    "推荐 `git add <file>` 显式暂存",
    "注意：git add . 包含未授权内容时先询问",
    "后续运行 git commit 前请确认授权",
    "框架会自动安装，不执行 npm run install:codex",
  ];
  for (const text of positives) {
    assert.ok(forbiddenSteps.some((pattern) => pattern.test(text)), `scanner must catch: ${text}`);
  }
  for (const text of negatives) {
    assert.ok(!forbiddenSteps.some((pattern) => pattern.test(text)), `scanner must ignore prose: ${text}`);
  }
});

test("workflow skills: plain commit vs explicit release trigger, authorization boundaries, read-only summary, no destructive steps", () => {
  for (const { root, dir, kind } of workflowEntries) {
    const { source } = readSkillFrontmatter(root, dir);
    for (const pattern of forbiddenSteps) {
      assert.doesNotMatch(source, pattern, `${dir}: must not contain ${pattern} as a command step`);
    }
    // 必要结构：文档必须含 Markdown 标题，避免空壳文件
    assert.match(source, /^#{1,6}\s+\S/m, `${dir}: has section headings`);
    if (kind === "commit") {
      assert.doesNotMatch(source, /^git (?:tag|push)\b/m, `${dir}: plain commit must not tag or push as steps`);
      assert.match(source, /提交/, `${dir}: commit workflow is about committing`);
      assert.match(source, /授权/, `${dir}: commit workflow states an authorization boundary`);
      // oracle 修复项 3：按 hunk 内容级授权，同文件任何未授权 hunk 不得整体 add
      assert.match(source, /hunk/, `${dir}: authorization is scoped per hunk`);
      assert.match(source, /未授权|未获授权/, `${dir}: unauthorized content boundary exists`);
      assert.match(source, /同文件|同一文件/, `${dir}: mixed staged/unstaged hunks in one file are addressed`);
      assert.match(source, /整体|整文件/, `${dir}: whole-file add is prohibited when it absorbs unauthorized hunks`);
    }
    if (kind === "release") {
      assert.match(source, /发版|发布/, `${dir}: release workflow has an explicit release trigger`);
      assert.match(source, /授权/, `${dir}: release workflow states an authorization boundary`);
      assert.match(source, /分别|独立|逐项/, `${dir}: release workflow confirms authorization per step`);
      assert.match(source, /^#{1,6}\s*(阶段|发版)/m, `${dir}: release workflow has a release stage section`);
      // oracle 修复项 1、2：tag 操作统一 <目标tag>，冲突停止待用户确认，不自动换版本
      assert.match(source, /<目标tag>/, `${dir}: tag operations use the <目标tag> placeholder`);
      assert.doesNotMatch(source, /^git (?:tag|push)\b[^\n]*v\d+\.\d+\.\d+/m, `${dir}: no hardcoded tag version in tag/push command steps`);
      assert.match(source, /占用[^\n]*(?:停止|终止|暂停)/m, `${dir}: tag conflict stops instead of silently continuing`);
      assert.match(source, /不自动[^\n]*版本|用户[^\n]*确认新版本/, `${dir}: conflict resolution waits for a user-confirmed version, no auto-bump`);
    }
    if (kind === "summary") {
      assert.doesNotMatch(source, writeCommands, `${dir}: branch summary is read-only`);
      assert.match(source, /只读/, `${dir}: summary declares read-only`);
      if (dir === "co-branch-summary") {
        // oracle 修复项 4：文件统计从 merge-base 到 HEAD，不用 <base>..HEAD 双点
        assert.match(source, /git diff[^\n]*<merge-base>[^\n]*HEAD[^\n]*--stat/, `${dir}: file stats command spans merge-base to HEAD`);
        assert.doesNotMatch(source, /git diff[^\n]*--stat[^\n]*\.\./, `${dir}: no double-dot in the file-stats diff command`);
      }
    }
  }
});

test("MCP initializes and discovers both tools outside the plugin cwd", async (t) => {
  const { env } = fixture(t);
  const rpc = client(t, env);
  const response = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(response.result.serverInfo, { name: "cohub-council", version: pkg.version });
  const list = await rpc("tools/list");
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["council_session", "council_presets"]);
});

test("Council consults configured models and gives their replies to the chair", async (t) => {
  const { home, env } = fixture(t);
  const requests = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: `Reply from ${payload.model}` } }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ council: {
    default_preset: "local", retries: 0, timeout_ms: 1000,
    providers: { local: { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: "COHUB_TEST_KEY" } },
    presets: { local: { alpha: { provider: "local", model: "alpha" }, beta: { provider: "local", model: "beta" } } },
    chair: { provider: "local", model: "chair" },
  } }));
  const rpc = client(t, { ...env, COHUB_CONFIG: config, COHUB_TEST_KEY: "fixture-key" });
  const presets = await rpc("tools/call", { name: "council_presets" });
  assert.match(presets.result.content[0].text, /alpha=alpha, beta=beta/);
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", context: "Context" } });
  const text = response.result.content[0].text;
  for (const model of ["alpha", "beta", "chair"]) assert.ok(text.includes(`Reply from ${model}`));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].messages[0].content, "Context\n\nReview");
  const chair = requests.find((request) => request.model === "chair");
  assert.match(chair.messages[1].content, /Reply from alpha/);
  assert.match(chair.messages[1].content, /Reply from beta/);
});

test("missing keys skip model calls and unknown tools return errors", async (t) => {
  const { home, env } = fixture(t);
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ council: { presets: { default: {
    alpha: { model: "alpha", base_url: "http://127.0.0.1:1", api_key_env: "COHUB_MISSING_TEST_KEY" },
  } } } }));
  const rpc = client(t, { ...env, COHUB_CONFIG: config, COHUB_MISSING_TEST_KEY: "" });
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review" } });
  assert.match(response.result.content[0].text, /COHUB_MISSING_TEST_KEY/);
  const unknown = await rpc("tools/call", { name: "unknown" });
  assert.equal(unknown.result.isError, true);
});

test("init-config migrates legacy configuration and does not overwrite it", async (t) => {
  const { home, env } = fixture(t);
  const legacy = join(home, ".config", "oh-my-codex-cohub");
  mkdirSync(legacy, { recursive: true });
  const content = JSON.stringify({ council: { default_preset: "legacy", presets: { legacy: {} } } });
  writeFileSync(join(legacy, "config.json"), content);
  const rpc = client(t, env);
  const response = await rpc("tools/call", { name: "council_presets" });
  assert.match(response.result.content[0].text, /legacy/);
  const script = resolve(packageRoot, "scripts/init-config.mjs");
  assert.equal(spawnSync(process.execPath, [script], { env }).status, 0);
  const target = join(home, ".codex", "oh-my-codex-cohub", "config.json");
  assert.equal(readFileSync(target, "utf8"), content);
  writeFileSync(target, content + "\n");
  assert.equal(spawnSync(process.execPath, [script], { env }).status, 0);
  assert.equal(readFileSync(target, "utf8"), content + "\n");
});

test("init-config honors COHUB_CONFIG and Council prefers the new user path", async (t) => {
  const { home, env } = fixture(t);
  const target = join(home, "custom", "config.json");
  const result = spawnSync(process.execPath, [resolve(packageRoot, "scripts/init-config.mjs")], {
    env: { ...env, COHUB_CONFIG: target },
  });
  assert.equal(result.status, 0);
  assert.ok(JSON.parse(readFileSync(target, "utf8")).council.presets.default);
  for (const root of [".codex", ".config"]) {
    const path = join(home, root, "oh-my-codex-cohub");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "config.json"), JSON.stringify({ council: { default_preset: root, presets: { [root]: {} } } }));
  }
  const rpc = client(t, env);
  const response = await rpc("tools/call", { name: "council_presets" });
  assert.match(response.result.content[0].text, /\.codex/);
  assert.doesNotMatch(response.result.content[0].text, /\.config/);
});
