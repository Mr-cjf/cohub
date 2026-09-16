import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src/client/index.js");
const output = resolve(root, "lib/client.js");

const content = readFileSync(source, "utf8");
if (!content.includes("window.__ModuleLoader__.load")) {
  throw new Error(`Invalid client bundle source: ${source} must emit window.__ModuleLoader__.load`);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, content, "utf8");
console.log(`✅ built ${output}`);
