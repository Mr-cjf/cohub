import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/init-config.mjs", import.meta.url));
const packageSchema = fileURLToPath(new URL("../config/cohub.schema.json", import.meta.url));

test("initialization creates a referenced schema and preserves existing config and schema", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cohub-init-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "config.json");
  const schema = join(dir, "cohub.schema.json");
  const run = () => spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, COHUB_CONFIG: target },
  });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const exampleConfig = readFileSync(target, "utf8");
  const bundledSchema = readFileSync(packageSchema, "utf8");
  assert.equal(JSON.parse(exampleConfig).$schema, "./cohub.schema.json");
  assert.equal(readFileSync(schema, "utf8"), bundledSchema);

  const userConfig = JSON.stringify({ $schema: "./cohub.schema.json", userSetting: "keep-me" }, null, 2);
  const customSchema = "{\"title\":\"user schema\"}\n";
  writeFileSync(target, userConfig);
  writeFileSync(schema, customSchema);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(target, "utf8"), userConfig);
  assert.equal(readFileSync(schema, "utf8"), customSchema);

  rmSync(schema);
  const third = run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(readFileSync(target, "utf8"), userConfig);
  assert.equal(readFileSync(schema, "utf8"), bundledSchema);
});
