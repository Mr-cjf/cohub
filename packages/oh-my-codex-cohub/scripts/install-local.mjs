import { spawnSync } from "node:child_process";
import { validate, repoRoot } from "./validate.mjs";

validate();
const commands = [
  ["plugin", "marketplace", "add", repoRoot],
  ["plugin", "add", "oh-my-codex-cohub@cohub"],
];
for (const args of commands) {
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "codex";
  const commandArgs = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", `& codex ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Installed from the CoHub repository. Start a new Codex session to load changes.");
