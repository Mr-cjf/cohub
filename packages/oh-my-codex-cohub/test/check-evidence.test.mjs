import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSnapshot, recordEvidence, checkEvidence } from "../scripts/check-evidence.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cohub-evidence-"));
  const cwd = join(dir, "project");
  const scope = join(cwd, "src");
  const evidence = join(dir, "evidence.json");
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(scope, "a.js"), "export const a = 1;\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = {
    command: ["node", "--check", "src/a.js"], cwd,
    scope: { roots: ["src"], files: [], patterns: [] },
    completeScope: true, environment: { complete: true, names: ["NODE_ENV"], unknown: false },
    tools: [{ name: "node", version: "20.0.0" }],
    readOnly: true, externalState: false,
  };
  return { dir, cwd, scope, evidence, spec };
}

async function recordPassing(f, options = {}) {
  const before = createSnapshot(f.spec, { env: { NODE_ENV: "test" } });
  return recordEvidence({ spec: f.spec, before, evidencePath: f.evidence,
    completed: true, exitCode: 0, status: "passed", env: { NODE_ENV: "test" }, ...options });
}

test("snapshot re-enumerates scope and detects additions, deletions, and content changes", (t) => {
  const f = fixture(t);
  const before = createSnapshot(f.spec);
  writeFileSync(join(f.scope, "new.js"), "new\n");
  assert.notEqual(createSnapshot(f.spec).inputFingerprint, before.inputFingerprint);
  rmSync(join(f.scope, "new.js"));
  writeFileSync(join(f.scope, "a.js"), "changed\n");
  assert.notEqual(createSnapshot(f.spec).inputFingerprint, before.inputFingerprint);
  rmSync(join(f.scope, "a.js"));
  assert.notEqual(createSnapshot(f.spec).inputFingerprint, before.inputFingerprint);
});

test("a stable passing record is reusable and force always misses", async (t) => {
  const f = fixture(t);
  const record = await recordPassing(f);
  assert.equal(record.reusable, true);
  assert.deepEqual(record.evidence.delta, { added: [], removed: [], changed: [] });
  assert.equal((await checkEvidence(f.spec, f.evidence, { env: { NODE_ENV: "test" } })).reusable, true);
  assert.equal((await checkEvidence(f.spec, f.evidence, { env: { NODE_ENV: "test" }, force: true })).reusable, false);
});

test("spec, cwd, tool, and declared environment changes invalidate evidence", async (t) => {
  const f = fixture(t);
  await recordPassing(f);
  const cases = [
    { ...f.spec, command: ["node", "--check", "src/other.js"] },
    { ...f.spec, cwd: join(f.dir, "other") },
    { ...f.spec, tools: [{ name: "node", version: "22.0.0" }] },
  ];
  for (const spec of cases) assert.equal((await checkEvidence(spec, f.evidence, { env: { NODE_ENV: "test" } })).reusable, false);
  assert.equal((await checkEvidence(f.spec, f.evidence, { env: { NODE_ENV: "production" } })).reusable, false);
});

test("record is not reusable if inputs change while work runs", async (t) => {
  const f = fixture(t);
  const before = createSnapshot(f.spec, { env: { NODE_ENV: "test" } });
  writeFileSync(join(f.scope, "a.js"), "changed during command\n");
  const record = await recordEvidence({ spec: f.spec, before, evidencePath: f.evidence,
    completed: true, exitCode: 0, status: "passed", env: { NODE_ENV: "test" } });
  assert.equal(record.reusable, false);
  assert.deepEqual(record.evidence.delta.changed, ["src/a.js"]);
  assert.equal((await checkEvidence(f.spec, f.evidence, { env: { NODE_ENV: "test" } })).reusable, false);
});

test("failed, pending, unknown-scope, external-state, and writable evidence cannot be reused", async (t) => {
  const f = fixture(t);
  const before = createSnapshot(f.spec, { env: { NODE_ENV: "test" } });
  for (const values of [
    { completed: false, exitCode: 0, status: "passed" },
    { completed: true, exitCode: 1, status: "failed" },
  ]) {
    const result = await recordEvidence({ spec: f.spec, before, evidencePath: f.evidence,
      env: { NODE_ENV: "test" }, ...values });
    assert.equal(result.reusable, false);
  }
  for (const spec of [
    { ...f.spec, completeScope: false },
    { ...f.spec, environment: { names: ["NODE_ENV"], unknown: false } },
    { ...f.spec, externalState: true },
    { ...f.spec, readOnly: false },
    { ...f.spec, environment: { complete: true, names: ["NODE_ENV"], unknown: true } },
  ]) {
    assert.equal(createSnapshot(spec, { env: { NODE_ENV: "test" } }).cacheable, false);
  }
  assert.throws(() => createSnapshot({ ...f.spec, environment: { complete: true, names: ["SERVICE_API_KEY"], unknown: false } }), /secret environment/i);
});

test("evidence inside the scope and escaping or symlinked paths are rejected", (t) => {
  const f = fixture(t);
  assert.throws(() => createSnapshot(f.spec, { evidencePath: join(f.scope, "evidence.json") }), /outside|scope/i);
  assert.throws(() => createSnapshot({ ...f.spec, scope: { roots: ["../outside"], files: [], patterns: [] } }), /escape|outside/i);
  const outside = join(f.dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createSnapshot({ ...f.spec, scope: { roots: ["linked"], files: [], patterns: [] } }), /symbolic|symlink/i);
});

test("missing explicit scope files are represented as non-cacheable and as removals", async (t) => {
  const f = fixture(t);
  const spec = { ...f.spec, scope: { roots: ["src"], files: ["src/expected.js"], patterns: [] } };
  writeFileSync(join(f.scope, "expected.js"), "present\n");
  const before = createSnapshot(spec, { env: { NODE_ENV: "test" } });
  rmSync(join(f.scope, "expected.js"));
  const after = createSnapshot(spec, { env: { NODE_ENV: "test" } });
  assert.equal(after.cacheable, false);
  const result = await recordEvidence({ spec, before, evidencePath: f.evidence,
    completed: true, exitCode: 0, status: "passed", env: { NODE_ENV: "test" } });
  assert.equal(result.reusable, false);
  assert.deepEqual(result.evidence.delta.removed, ["src/expected.js"]);
});

test("symlinks in a scope root's parent are rejected", (t) => {
  const f = fixture(t);
  const outside = join(f.dir, "outside");
  mkdirSync(join(outside, "nested"), { recursive: true });
  symlinkSync(outside, join(f.cwd, "linked-parent"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createSnapshot({ ...f.spec, scope: { roots: ["linked-parent/nested"], files: [], patterns: [] } }), /symbolic link/i);
});

test("evidence rejects a junction ancestor even when its direct parent is missing", async (t) => {
  const f = fixture(t);
  const alias = join(f.dir, "scope-alias");
  symlinkSync(f.scope, alias, process.platform === "win32" ? "junction" : "dir");
  const evidencePath = join(alias, "new", "nested", "evidence.json");
  assert.throws(() => createSnapshot(f.spec, { evidencePath }), /symbolic link|outside.*scope/i);
  const before = createSnapshot(f.spec, { env: { NODE_ENV: "test" } });
  assert.throws(() => recordEvidence({ spec: f.spec, before, evidencePath,
    completed: true, exitCode: 0, status: "passed", env: { NODE_ENV: "test" } }), /symbolic link|outside.*scope/i);
  assert.throws(() => checkEvidence(f.spec, evidencePath, { env: { NODE_ENV: "test" } }), /symbolic link|outside.*scope/i);
});

test("evidence can create a fresh external directory and overwrite its record", async (t) => {
  const f = fixture(t);
  const evidencePath = join(f.dir, "new", "nested", "evidence.json");
  assert.equal((await recordPassing(f, { evidencePath })).reusable, true);
  assert.equal((await recordPassing(f, { evidencePath })).reusable, true);
  assert.equal((await checkEvidence(f.spec, evidencePath, { env: { NODE_ENV: "test" } })).reusable, true);
});

test("check revalidates recorded completion fields and CLI rejects unknown or unsafe options", async (t) => {
  const f = fixture(t);
  await recordPassing(f);
  const saved = JSON.parse(readFileSync(f.evidence, "utf8"));
  saved.completed = false;
  writeFileSync(f.evidence, JSON.stringify(saved));
  assert.equal((await checkEvidence(f.spec, f.evidence, { env: { NODE_ENV: "test" } })).reusable, false);

  const specPath = join(f.dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(f.spec));
  const script = fileURLToPath(new URL("../scripts/check-evidence.mjs", import.meta.url));
  const unknown = spawnSync(process.execPath, [script, "check", "--spec", specPath, "--evidence", f.evidence, "--oops"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/i);
  const unsafeOut = spawnSync(process.execPath, [script, "snapshot", "--spec", specPath, "--out", join(f.scope, "before.json")], { encoding: "utf8" });
  assert.equal(unsafeOut.status, 2);
  assert.match(unsafeOut.stderr, /outside.*scope/i);

  const alias = join(f.dir, "scope-alias");
  symlinkSync(f.scope, alias, process.platform === "win32" ? "junction" : "dir");
  const unsafeAliasOut = spawnSync(process.execPath, [script, "snapshot", "--spec", specPath, "--out", join(alias, "new", "out.json")], { encoding: "utf8" });
  assert.equal(unsafeAliasOut.status, 2);
  assert.match(unsafeAliasOut.stderr, /symbolic link|outside.*scope/i);
  const unsafeBefore = spawnSync(process.execPath, [script, "record", "--spec", specPath, "--before", join(alias, "new", "before.json"), "--evidence", f.evidence, "--completed", "--exit-code", "0", "--status", "passed"], { encoding: "utf8" });
  assert.equal(unsafeBefore.status, 2);
  assert.match(unsafeBefore.stderr, /symbolic link|outside.*scope/i);
});
