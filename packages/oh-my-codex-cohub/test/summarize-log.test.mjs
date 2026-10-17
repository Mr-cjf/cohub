import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSecrets, summarizeLog } from "../scripts/summarize-log.mjs";

const script = fileURLToPath(new URL("../scripts/summarize-log.mjs", import.meta.url));

test("summarizes successful Maven and generic logs using the supplied exit code", () => {
  const maven = summarizeLog([
    "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 1",
    "[INFO] Total time:  2.345 s",
    "[INFO] BUILD SUCCESS",
  ].join("\n"), { exitCode: 0, logPath: "build.log" });
  assert.equal(maven.status, "passed");
  assert.match(maven.summary, /Tests run: 4/);
  assert.match(maven.summary, /2\.345 s/);
  assert.match(maven.summary, /build\.log/);

  const generic = summarizeLog("completed in 800 ms\nfinished", { exitCode: 0 });
  assert.equal(generic.status, "passed");
  assert.match(generic.summary, /2 lines/);
  assert.match(generic.summary, /800 ms/);
});

test("uses per-module Maven Results summaries without double-counting or dropping interrupted modules", () => {
  const log = [
    "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 in example.FirstTest",
    "[INFO] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0 in example.SecondTest",
    "[INFO] Results:",
    "[INFO] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0",
    "[INFO] --- surefire:3.2.5:test (default-test) @ second ---",
    "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0 in example.ThirdTest",
    "[INFO] Results:",
    "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0",
    "[INFO] Total time: 01:26 min",
  ].join("\n");
  const result = summarizeLog(log, { exitCode: 0 });
  assert.match(result.summary, /Tests run: 9, Failures: 1, Errors: 0, Skipped: 0/);
  assert.match(result.summary, /01:26 min/);

  const standardClasses = summarizeLog([
    "[INFO] --- surefire:3.2.5:test (default-test) @ first ---",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed:0.010 s -- in ExampleTest",
    "[INFO] Results:",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0",
    "[INFO] --- surefire:3.2.5:test (default-test) @ second ---",
    "[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed:0.005 s <<< FAILURE! -- in OtherTest",
    "[ERROR] second module stopped before Results",
  ].join("\n"), { exitCode: 1 });
  assert.match(standardClasses.summary, /Tests run: 7, Failures: 1, Errors: 0, Skipped: 0/);
  assert.doesNotMatch(standardClasses.summary, /duration: 0\.010 s|duration: 0\.005 s/);

  const interrupted = summarizeLog([
    "[INFO] --- module one ---",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0 in example.PassingTest",
    "[INFO] Results:",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0",
    "[INFO] --- surefire:3.2.5:test (default-test) @ second ---",
    "[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0 in example.FailingTest",
    "[ERROR] module two aborted before Results summary",
  ].join("\n"), { exitCode: 1 });
  assert.match(interrupted.summary, /Tests run: 7, Failures: 1, Errors: 0, Skipped: 0/);

  const failsafe = summarizeLog([
    "[INFO] --- maven-surefire-plugin:3.5.0:test @ first ---",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0 in example.PassingTest",
    "[INFO] Results:",
    "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0",
    "[INFO] --- failsafe:3.2.5:integration-test (default) @ second ---",
    "[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0 in example.FailingIT",
    "[ERROR] module second aborted before Results summary",
  ].join("\n"), { exitCode: 1 });
  assert.match(failsafe.summary, /Tests run: 7, Failures: 1, Errors: 0, Skipped: 0/);

  const unmarked = summarizeLog([
    "Tests run: 2, Failures: 1, Errors: 0, Skipped: 0 in example.FirstTest",
    "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0 in example.SecondTest",
    "Tests run: 5, Failures: 1, Errors: 0, Skipped: 0",
  ].join("\n"), { exitCode: 1 });
  assert.match(unmarked.summary, /Tests run: 5, Failures: 1/);
  assert.doesNotMatch(unmarked.summary, /Tests run: 10/);
});

test("failure summaries keep relevant context from earlier errors instead of only the tail", () => {
  const log = [
    "starting check",
    "compiling module",
    "Error: missing interface contract",
    "  at validate (scripts/check.mjs:8)",
    "ordinary output after error",
    ...Array.from({ length: 80 }, (_, index) => `tail line ${index}`),
  ].join("\n");
  const result = summarizeLog(log, { exitCode: 2, logPath: "failed.log", limit: 240 });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 2);
  assert.match(result.summary, /compiling module/);
  assert.match(result.summary, /missing interface contract/);
  assert.match(result.summary, /validate/);
  assert.doesNotMatch(result.summary, /tail line 79/);
  assert.ok(Array.from(result.summary).length <= 240);
});

test("extracts Chinese errors and falls back to bounded informative lines", () => {
  const error = summarizeLog("错误：配置失败\n补充说明", { exitCode: 1 });
  assert.match(error.summary, /错误：配置失败/);

  const generic = summarizeLog("phase=compile module=alpha\nreason=missing-symbol", { exitCode: 3 });
  assert.match(generic.summary, /phase=compile module=alpha/);
  assert.match(generic.summary, /reason=missing-symbol/);
});

test("limits summaries by Unicode code points and marks truncation", () => {
  const result = summarizeLog("错误：配置失败\n补充说明", { exitCode: 1, limit: 18 });
  assert.equal(result.truncated, true);
  assert.ok(Array.from(result.summary).length <= 18);
  assert.doesNotMatch(result.summary, /\uD800|\uDC00/);
});

test("redacts common credential forms in summaries", () => {
  assert.doesNotMatch(redactSecrets('{"api_key": "json-secret"}'), /json-secret/);
  const result = summarizeLog([
    "Authorization: Bearer abc.def",
    "api_key=secret-key",
    "token: \"long-token\"",
    "password: hunter2",
    '{"api_key": "json-secret"}',
    "sk-proj-1234567890abcdefghijk",
    "Error: request failed",
  ].join("\n"), { exitCode: 1 });
  assert.doesNotMatch(result.summary, /abc\.def|secret-key|long-token|hunter2|json-secret|sk-proj-1234567890abcdefghijk/);
  assert.match(result.summary, /\[REDACTED\]/);
});

test("exit code is authoritative when log markers disagree", () => {
  const zero = summarizeLog("[ERROR] stale failure\nBUILD FAILURE", { exitCode: 0 });
  assert.equal(zero.status, "passed");
  assert.match(zero.summary, /exit code 0.*failure-like log markers/i);

  const nonzero = summarizeLog("BUILD SUCCESS", { exitCode: 7 });
  assert.equal(nonzero.status, "failed");
  assert.equal(nonzero.exitCode, 7);
});

test("rejects missing or invalid exit codes", () => {
  for (const options of [{}, { exitCode: undefined }, { exitCode: Number.NaN }, { exitCode: 1.5 }, { exitCode: -2147483649 }, { exitCode: 4294967296 }]) {
    assert.throws(() => summarizeLog("log", options), /exit code/i);
  }
  for (const limit of [-1, Number.NaN, 1.5, 100001]) {
    assert.throws(() => summarizeLog("log", { exitCode: 0, limit }), /limit/i);
  }
});

test("CLI requires a real exit code and preserves successful or failing codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohub-log-summary-"));
  try {
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, "BUILD SUCCESS\nTests run: 3, Failures: 0, Errors: 0, Skipped: 0\n");
    const missing = spawnSync(process.execPath, [script, "--log", logPath], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /exit-code|required/i);

    const passed = spawnSync(process.execPath, [script, "--log", logPath, "--exit-code", "0"], { encoding: "utf8" });
    assert.equal(passed.status, 0);
    assert.equal(JSON.parse(passed.stdout).status, "passed");

    writeFileSync(logPath, "Error: test failed\n");
    const failed = spawnSync(process.execPath, [script, "--log", logPath, "--exit-code", "9"], { encoding: "utf8" });
    assert.equal(failed.status, 9);
    assert.equal(JSON.parse(failed.stdout).exitCode, 9);

    const invalid = spawnSync(process.execPath, [script, "--log", logPath, "--exit-code", "1.5"], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /exit-code|integer/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves Windows native 32-bit exit codes in JSON and process exit status", () => {
  const nativeCodes = [3221225477, -1073741819];
  for (const exitCode of nativeCodes) {
    const result = summarizeLog("native process failure", { exitCode });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.status, "failed");

    const dir = mkdtempSync(join(tmpdir(), "cohub-native-exit-"));
    try {
      const logPath = join(dir, "run.log");
      writeFileSync(logPath, "native process failure");
      const child = spawnSync(process.execPath, [script, "--log", logPath, "--exit-code", String(exitCode)], { encoding: "utf8" });
      const output = JSON.parse(child.stdout);
      assert.equal(output.exitCode, exitCode);
      assert.equal(output.status, "failed");
    if (process.platform === "win32") assert.equal(child.status >>> 0, exitCode >>> 0);
    else assert.equal(child.status, (exitCode >>> 0) & 0xff);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
