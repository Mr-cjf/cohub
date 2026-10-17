import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enable, disable, status } from "../scripts/orchestrator-policy.mjs";

function fixture(t, { base = "", override = undefined } = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), "cohub-orchestrator-policy-"));
  writeFileSync(join(codexHome, "AGENTS.md"), base, "utf8");
  if (override !== undefined) writeFileSync(join(codexHome, "AGENTS.override.md"), override, "utf8");
  t.after(() => {});
  return { codexHome, base: join(codexHome, "AGENTS.md"), override: join(codexHome, "AGENTS.override.md") };
}

test("enable is idempotent and preserves user text and line endings", (t) => {
  const f = fixture(t, { base: "# User\r\n\r\nKeep this.\r\n" });
  const first = enable({ codexHome: f.codexHome });
  const content = readFileSync(f.base, "utf8");
  assert.equal(first.changedFiles.length, 1);
  assert.match(content, /# User\r\n\r\nKeep this/);
  assert.equal((content.match(/COHUB_ORCHESTRATOR_START/g) || []).length, 1);
  assert.equal(enable({ codexHome: f.codexHome }).changedFiles.length, 0);
});

test("non-empty override is active and stale base block is removed", (t) => {
  const f = fixture(t, { base: "old\n<!-- COHUB_ORCHESTRATOR_START -->\nold\n<!-- COHUB_ORCHESTRATOR_END -->\n", override: "# Override\n" });
  const result = enable({ codexHome: f.codexHome });
  assert.equal(result.activeTarget, f.override);
  assert.doesNotMatch(readFileSync(f.base, "utf8"), /COHUB_ORCHESTRATOR_START/);
  assert.match(readFileSync(f.override, "utf8"), /COHUB_ORCHESTRATOR_START/);
  assert.equal(status({ codexHome: f.codexHome }).shadowed, false);
});

test("disable removes only the managed block", (t) => {
  const f = fixture(t, { base: "before\n" });
  enable({ codexHome: f.codexHome });
  const result = disable({ codexHome: f.codexHome });
  assert.equal(result.configured, false);
  assert.equal(readFileSync(f.base, "utf8"), "before\n");
});

test("malformed or duplicate markers fail without writing", (t) => {
  const f = fixture(t, { base: "before\n<!-- COHUB_ORCHESTRATOR_START -->\n" });
  assert.throws(() => enable({ codexHome: f.codexHome }), /标记/);
  assert.equal(readFileSync(f.base, "utf8"), "before\n<!-- COHUB_ORCHESTRATOR_START -->\n");
  assert.equal(existsSync(join(f.codexHome, "orchestrator-backups")), false);
});

test("enable and disable preserve exact user bytes outside the managed block", (t) => {
  const f = fixture(t, { base: "before\n\n\nmiddle\nlast   \n\n\n" });
  const original = readFileSync(f.base, "utf8");
  enable({ codexHome: f.codexHome });
  enable({ codexHome: f.codexHome });
  disable({ codexHome: f.codexHome });
  assert.equal(readFileSync(f.base, "utf8"), original);
});

test("empty, BOM-only, and no-final-newline files round-trip", (t) => {
  for (const original of ["", "\uFEFF", "last"]) {
    const f = fixture(t, { base: original });
    enable({ codexHome: f.codexHome });
    disable({ codexHome: f.codexHome });
    assert.equal(readFileSync(f.base, "utf8"), original);
  }
});
