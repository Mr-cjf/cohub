import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : stable(value)).digest("hex");
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeSpec(spec) {
  assert.ok(spec && typeof spec === "object", "spec must be an object");
  assert.ok(typeof spec.cwd === "string" && spec.cwd.length > 0, "spec.cwd is required");
  assert.ok(typeof spec.command === "string" || (Array.isArray(spec.command) && spec.command.length > 0 && spec.command.every((part) => typeof part === "string")), "command must be a string or argv array");
  const cwd = resolve(spec.cwd);
  const scope = spec.scope ?? {};
  const roots = (scope.roots ?? []).map((root) => {
    assert.ok(typeof root === "string" && root.length > 0 && !isAbsolute(root), `scope root must be relative: ${root}`);
    const target = resolve(cwd, root);
    assert.ok(inside(cwd, target), `scope root escapes cwd: ${root}`);
    return relative(cwd, target).split(sep).join("/") || ".";
  }).sort();
  const files = (scope.files ?? []).map((file) => {
    assert.ok(typeof file === "string" && file.length > 0 && !isAbsolute(file), `scope file must be relative: ${file}`);
    const target = resolve(cwd, file);
    assert.ok(inside(cwd, target), `scope file escapes cwd: ${file}`);
    assert.ok(roots.some((root) => inside(resolve(cwd, root), target)), `scope file must be inside a root: ${file}`);
    return relative(cwd, target).split(sep).join("/");
  }).sort();
  const patterns = (scope.patterns ?? []).map((pattern) => {
    assert.ok(typeof pattern === "string" && pattern.length > 0 && !pattern.startsWith("/") && !pattern.includes(".."), `invalid scope pattern: ${pattern}`);
    return pattern.replaceAll("\\", "/");
  }).sort();
  assert.ok(roots.length > 0, "scope.roots must declare at least one directory");
  const env = spec.environment ?? {};
  const names = (env.names ?? []).map((name) => {
    assert.ok(typeof name === "string" && name.length > 0, "environment names must be non-empty strings");
    assert.ok(!/(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(name), `secret environment variable cannot be fingerprinted: ${name}`);
    return name;
  }).sort();
  const tools = (spec.tools ?? []).map((tool) => {
    assert.ok(typeof tool?.name === "string" && typeof tool?.version === "string", "each tool needs name and version identifiers");
    return { name: tool.name, version: tool.version };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    command: spec.command, cwd, scope: { roots, files, patterns },
    completeScope: spec.completeScope === true,
    environment: { names, complete: env.complete === true, unknown: env.unknown === true }, tools,
    readOnly: spec.readOnly === true, externalState: spec.externalState !== false,
  };
}

function eligible(spec) {
  return spec.completeScope && spec.environment.complete && !spec.environment.unknown && spec.readOnly && !spec.externalState;
}

function assertNoSymlinkPath(target, label) {
  const absolute = resolve(target);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const part of relative(parsed.root, absolute).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      assert.ok(!lstatSync(current).isSymbolicLink(), `symbolic link ${label} rejected: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

function glob(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; source += "(?:.*/)?"; }
      else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function assertSafeEvidencePath(spec, evidencePath) {
  if (!evidencePath) return;
  const target = resolve(evidencePath);
  assertNoSymlinkPath(target, "evidence path");
  for (const root of spec.scope.roots) {
    assert.ok(!inside(resolve(spec.cwd, root), target), "evidence path must be outside the scope");
  }
  if (existsSync(target)) assert.ok(!lstatSync(target).isSymbolicLink(), "evidence path cannot be a symbolic link");
  const parent = dirname(target);
  if (existsSync(parent)) {
    const realParent = realpathSync(parent);
    for (const root of spec.scope.roots) {
      const rootPath = resolve(spec.cwd, root);
      if (existsSync(rootPath)) assert.ok(!inside(realpathSync(rootPath), realParent), "evidence path must be outside the scope");
    }
  }
}

function collectFiles(spec) {
  const selectedFiles = new Set(spec.scope.files);
  const patterns = spec.scope.patterns.map(glob);
  const found = new Map();
  for (const root of spec.scope.roots) {
    const rootPath = resolve(spec.cwd, root);
    assertNoSymlinkPath(rootPath, "scope path");
    const rootStat = lstatSync(rootPath);
    assert.ok(!rootStat.isSymbolicLink(), `symbolic link scope root rejected: ${root}`);
    assert.ok(rootStat.isDirectory(), `scope root must be a directory: ${root}`);
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = resolve(directory, entry.name);
        const path = relative(spec.cwd, absolute).split(sep).join("/");
        const stat = lstatSync(absolute);
        assert.ok(!stat.isSymbolicLink(), `symbolic link in scope rejected: ${path}`);
        if (stat.isDirectory()) walk(absolute);
        else if (stat.isFile() && (selectedFiles.has(path) || (selectedFiles.size === 0 && patterns.length === 0) || patterns.some((pattern) => pattern.test(path)))) {
          found.set(path, digest(readFileSync(absolute)));
        }
      }
    }
    walk(rootPath);
  }
  for (const file of selectedFiles) {
    const absolute = resolve(spec.cwd, file);
    if (existsSync(absolute)) {
      assertNoSymlinkPath(absolute, "scope file path");
      if (lstatSync(absolute).isFile()) found.set(file, digest(readFileSync(absolute)));
    }
  }
  const files = [...found].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
  const missing = [...selectedFiles].filter((file) => !found.has(file)).sort();
  return { files, missing };
}

function environmentFingerprint(spec, env) {
  const values = spec.environment.names.map((name) => {
    const value = env[name];
    return { name, present: value !== undefined, sha256: value === undefined ? null : digest(String(value)) };
  });
  return digest(values);
}

function fileDelta(before, after) {
  const oldFiles = new Map((before?.files ?? []).map(({ path, sha256 }) => [path, sha256]));
  const newFiles = new Map(after.map(({ path, sha256 }) => [path, sha256]));
  return {
    added: [...newFiles.keys()].filter((path) => !oldFiles.has(path)).sort(),
    removed: [...oldFiles.keys()].filter((path) => !newFiles.has(path)).sort(),
    changed: [...newFiles.keys()].filter((path) => oldFiles.has(path) && oldFiles.get(path) !== newFiles.get(path)).sort(),
  };
}

export function assessEvidence({ spec: inputSpec, before, after, completed = false, exitCode = null, status = "pending" }) {
  const spec = normalizeSpec(inputSpec);
  const stableInputs = before?.schemaVersion === SCHEMA_VERSION && before.specFingerprint === after?.specFingerprint && before.inputFingerprint === after?.inputFingerprint;
  const reusable = eligible(spec) && before?.cacheable === true && after?.cacheable === true && stableInputs && completed === true && exitCode === 0 && status === "passed";
  return {
    reusable,
    reason: reusable ? "stable-passed" : !eligible(spec) ? "ineligible-spec" : !stableInputs ? "inputs-changed-during-run" : status !== "passed" || exitCode !== 0 || completed !== true ? "not-completed-passed" : "not-reusable",
  };
}

export function createSnapshot(inputSpec, options = {}) {
  const spec = normalizeSpec(inputSpec);
  assert.ok(existsSync(spec.cwd) && lstatSync(spec.cwd).isDirectory(), `cwd must be a directory: ${spec.cwd}`);
  assertNoSymlinkPath(spec.cwd, "cwd path");
  assertSafeEvidencePath(spec, options.evidencePath);
  const { files, missing } = collectFiles(spec);
  const specFingerprint = digest(spec);
  const envFingerprint = environmentFingerprint(spec, options.env ?? process.env);
  const inputFingerprint = digest({ specFingerprint, envFingerprint, files, missing });
  return { schemaVersion: SCHEMA_VERSION, specFingerprint, envFingerprint, inputFingerprint, files, missing, cacheable: eligible(spec) && missing.length === 0 };
}

function readEvidence(evidencePath) {
  try {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    if (evidence.schemaVersion !== SCHEMA_VERSION) return null;
    return evidence;
  } catch { return null; }
}

export function recordEvidence({ spec: inputSpec, before, evidencePath, completed = false, exitCode = null, status = "pending", env = process.env }) {
  assert.ok(typeof evidencePath === "string" && evidencePath.length > 0, "evidencePath is required");
  const spec = normalizeSpec(inputSpec);
  assertSafeEvidencePath(spec, evidencePath);
  assert.ok(before?.schemaVersion === SCHEMA_VERSION, "before must be a check-evidence snapshot");
  const after = createSnapshot(spec, { env, evidencePath });
  const assessment = assessEvidence({ spec, before, after, completed, exitCode, status });
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    specFingerprint: after.specFingerprint,
    beforeFingerprint: before.inputFingerprint,
    inputFingerprint: after.inputFingerprint,
    files: after.files,
    missing: after.missing,
    delta: fileDelta(before, after.files),
    completed: completed === true,
    exitCode,
    status,
    reusable: assessment.reusable,
    reason: assessment.reason,
    recordedAt: new Date().toISOString(),
  };
  const target = resolve(evidencePath);
  mkdirSync(dirname(target), { recursive: true });
  assertSafeEvidencePath(spec, target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw error;
  }
  return { reusable: assessment.reusable, reason: evidence.reason, evidence };
}

export function checkEvidence(inputSpec, evidencePath, options = {}) {
  const spec = normalizeSpec(inputSpec);
  assertSafeEvidencePath(spec, evidencePath);
  if (options.force) return { reusable: false, reason: "forced" };
  if (!eligible(spec)) return { reusable: false, reason: "ineligible-spec" };
  const evidence = readEvidence(evidencePath);
  if (!evidence || evidence.schemaVersion !== SCHEMA_VERSION || evidence.reusable !== true || evidence.completed !== true || evidence.status !== "passed" || evidence.exitCode !== 0 || typeof evidence.inputFingerprint !== "string" || evidence.beforeFingerprint !== evidence.inputFingerprint || !Array.isArray(evidence.files) || !Array.isArray(evidence.missing) || evidence.missing.length > 0) {
    return { reusable: false, reason: "no-reusable-evidence" };
  }
  if (evidence.specFingerprint !== digest(spec)) return { reusable: false, reason: "spec-changed" };
  for (const root of spec.scope.roots) if (existsSync(resolve(spec.cwd, root))) assertNoSymlinkPath(resolve(spec.cwd, root), "scope path");
  let current;
  try { current = createSnapshot(spec, { env: options.env ?? process.env, evidencePath }); }
  catch (error) {
    if (error.code === "ENOENT") return { reusable: false, reason: "scope-missing" };
    throw error;
  }
  if (evidence.inputFingerprint !== current.inputFingerprint) return { reusable: false, reason: "inputs-changed" };
  return { reusable: true, reason: "exact-input-match", evidence };
}

function parseArgs(args) {
  const [action, ...rest] = args;
  const allowed = {
    snapshot: new Set(["spec", "evidence", "out"]),
    record: new Set(["spec", "before", "evidence", "completed", "exit-code", "status"]),
    check: new Set(["spec", "evidence", "force"]),
  };
  assert.ok(allowed[action], "usage: check-evidence.mjs <snapshot|record|check> --spec spec.json [options]");
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    assert.ok(key.startsWith("--"), `unexpected argument: ${key}`);
    const name = key.slice(2);
    assert.ok(allowed[action].has(name), `unknown option: ${key}`);
    assert.ok(!(name in options), `duplicate option: ${key}`);
    if (name === "force" || name === "completed") options[name] = true;
    else {
      const value = rest[++i];
      assert.ok(value && !value.startsWith("--"), `missing value for ${key}`);
      options[name] = value;
    }
  }
  assert.ok(options.spec, "--spec is required");
  if (action === "record") assert.ok(options.before && options.evidence && options.completed && options["exit-code"] !== undefined && options.status, "record requires --before, --evidence, --completed, --exit-code, and --status");
  if (action === "check") assert.ok(options.evidence, "check requires --evidence");
  return { action, options };
}

function cli() {
  const { action, options } = parseArgs(process.argv.slice(2));
  const readSpec = () => JSON.parse(readFileSync(options.spec, "utf8"));
  let result;
  if (action === "snapshot") {
    const spec = readSpec();
    result = createSnapshot(spec, { evidencePath: options.evidence });
    if (options.out) {
      assertSafeEvidencePath(normalizeSpec(spec), options.out);
      mkdirSync(dirname(resolve(options.out)), { recursive: true });
      assertSafeEvidencePath(normalizeSpec(spec), options.out);
      writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    }
  } else if (action === "record") {
    const spec = readSpec();
    assertSafeEvidencePath(normalizeSpec(spec), options.before);
    result = recordEvidence({ spec, before: JSON.parse(readFileSync(options.before, "utf8")), evidencePath: options.evidence,
      completed: options.completed === true, exitCode: options["exit-code"] === undefined ? null : Number(options["exit-code"]),
      status: options.status ?? "pending" });
  } else if (action === "check") {
    result = checkEvidence(readSpec(), options.evidence, { force: options.force === true });
  } else {
    throw new Error("usage: check-evidence.mjs <snapshot|record|check> --spec spec.json [options]");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
