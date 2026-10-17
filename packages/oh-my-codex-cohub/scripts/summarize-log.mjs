#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FAILURE_LIMIT = 4000;
const FAILURE_MARKER = /\b(error|exception|failed|failure|fatal|panic|assertionerror)\b|build failure|错误|异常|失败|致命|崩溃|断言/i;

export function redactSecrets(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_match, key) => `${key}[REDACTED]`);
}

function validateExitCode(exitCode) {
  if (!Number.isInteger(exitCode) || exitCode < -2147483648 || exitCode > 4294967295) {
    throw new TypeError("A real signed or unsigned 32-bit integer exit code is required");
  }
}

function processExitCode(exitCode) {
  return exitCode < 0 ? exitCode + 0x100000000 : exitCode;
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 16 || limit > 100000) {
    throw new TypeError("limit must be an integer from 16 through 100000 Unicode characters");
  }
}

function truncateUnicode(value, limit) {
  const chars = Array.from(value);
  if (chars.length <= limit) return { text: value, truncated: false };
  return { text: `${chars.slice(0, limit - 1).join("")}…`, truncated: true };
}

function testTotals(lines) {
  const totals = [];
  let classTotals = [];
  let summaryTotals = [];
  let inResults = false;
  const append = (target, match) => target.push({
    run: Number(match[1]), failures: Number(match[2]), errors: Number(match[3]), skipped: Number(match[4]),
  });
  const finishSegment = () => {
    totals.push(...(summaryTotals.length ? summaryTotals : classTotals));
    classTotals = [];
    summaryTotals = [];
    inResults = false;
  };
  const isClassResult = (suffix) => /^in\s+\S/i.test(suffix) || /--\s+in\s+\S/i.test(suffix);

  for (const line of lines) {
    if (/^\[INFO\]\s+(?:Building\s+.+|---\s+.*(?:maven-(?:surefire|failsafe)-plugin\b|(?:surefire|failsafe):|module\b).*---)\s*$/i.test(line)) {
      finishSegment();
    }
    if (/\bResults:\s*$/i.test(line)) {
      if (summaryTotals.length) finishSegment();
      inResults = true;
      continue;
    }
    const match = line.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i);
    if (!match) continue;
    const suffix = line.slice((match.index ?? 0) + match[0].length).trim();
    const classResult = isClassResult(suffix);
    if (inResults && summaryTotals.length && classResult) finishSegment();
    if (classResult) append(classTotals, match);
    else append(summaryTotals, match);
  }
  finishSegment();
  if (!totals.length) return null;
  return totals.reduce((total, item) => ({
    run: total.run + item.run,
    failures: total.failures + item.failures,
    errors: total.errors + item.errors,
    skipped: total.skipped + item.skipped,
  }), { run: 0, failures: 0, errors: 0, skipped: 0 });
}

function findDuration(text) {
  const totalTime = text.match(/(?:\[INFO\]\s*)?Total time:\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:min|minutes?|sec(?:onds?)?|s)?|[\d.]+\s*(?:s|sec(?:onds?)?))/i);
  if (totalTime) return totalTime[1].trim();
  const nonClassText = text.split(/\r?\n/).filter((line) => !/time elapsed\s*:.*--\s+in\s+\S/i.test(line)).join("\n");
  const patterns = [
    /(?:elapsed(?: time)?|duration|completed in|finished in|took)\s*:?\s*([\d.]+\s*(?:ms|s|sec(?:onds?)?|m|min(?:utes?)?))/i,
    /^real\s+([\dhms.]+)$/im,
  ];
  for (const pattern of patterns) {
    const match = nonClassText.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function relevantExcerpt(lines, limit) {
  const selected = new Set();
  for (let index = 0; index < lines.length; index++) {
    if (!FAILURE_MARKER.test(lines[index])) continue;
    for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around++) {
      selected.add(around);
    }
  }
  const excerpts = [];
  let previous = -2;
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (index > previous + 1) excerpts.push("...");
    excerpts.push(lines[index]);
    previous = index;
    if (Array.from(excerpts.join("\n")).length >= limit) break;
  }
  return excerpts.join("\n");
}

function fallbackExcerpt(lines) {
  const content = lines.map((line) => line.trim()).filter(Boolean);
  if (!content.length) return "Log is empty.";
  if (content.length <= 5) return `Unclassified log excerpt:\n${content.join("\n")}`;
  return `Unclassified log excerpt:\n${content.slice(0, 3).join("\n")}\n...\n${content.slice(-2).join("\n")}`;
}

function hasFailureMarker(lines) {
  return lines.some((line) => {
    if (/\b(?:Failures|Errors):\s*0\b/i.test(line)) {
      return FAILURE_MARKER.test(line.replace(/\b(?:Failures|Errors):\s*0\b/gi, ""));
    }
    return FAILURE_MARKER.test(line);
  });
}

export function summarizeLog(logText, { exitCode, logPath = "", limit } = {}) {
  validateExitCode(exitCode);
  if (typeof logText !== "string") throw new TypeError("logText must be a string");
  if (limit !== undefined) validateLimit(limit);
  const status = exitCode === 0 ? "passed" : "failed";
  const lines = logText.length === 0 ? [] : logText.split(/\r?\n/);
  const duration = findDuration(logText);
  const tests = testTotals(lines);
  let summary;

  if (status === "passed") {
    const details = [`Completed with exit code 0; ${lines.length} lines`];
    if (tests) details.push(`Tests run: ${tests.run}, Failures: ${tests.failures}, Errors: ${tests.errors}, Skipped: ${tests.skipped}`);
    if (duration) details.push(`duration: ${duration}`);
    if (/\bBUILD SUCCESS\b/i.test(logText)) details.push("Maven: BUILD SUCCESS");
    if (hasFailureMarker(lines)) details.push("exit code 0 despite failure-like log markers; status follows the exit code");
    details.push(`full log: ${logPath || "(path unavailable)"}`);
    summary = details.join("; ");
  } else {
    const excerpt = relevantExcerpt(lines, limit ?? DEFAULT_FAILURE_LIMIT);
    const details = [`Command exited ${exitCode}`];
    if (tests) details.push(`Tests run: ${tests.run}, Failures: ${tests.failures}, Errors: ${tests.errors}, Skipped: ${tests.skipped}`);
    if (duration) details.push(`duration: ${duration}`);
    details.push(excerpt || fallbackExcerpt(lines));
    details.push(`full log: ${logPath || "(path unavailable)"}`);
    summary = details.join("\n");
  }

  const redacted = redactSecrets(summary);
  const clipped = truncateUnicode(redacted, limit ?? (status === "failed" ? DEFAULT_FAILURE_LIMIT : 1000));
  return { status, exitCode, summary: clipped.text, logPath, truncated: clipped.truncated };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--log", "--exit-code", "--limit"].includes(key) || options[key]) {
      throw new TypeError(`Unknown or repeated argument: ${key}`);
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`Missing value for ${key}`);
    options[key] = value;
  }
  if (!options["--log"]) throw new TypeError("--log is required");
  if (options["--exit-code"] === undefined || !/^-?\d+$/.test(options["--exit-code"])) {
    throw new TypeError("A real signed or unsigned 32-bit --exit-code is required");
  }
  if (options["--limit"] !== undefined && !/^\d+$/.test(options["--limit"])) {
    throw new TypeError("--limit must be an integer");
  }
  return {
    logPath: options["--log"],
    exitCode: Number(options["--exit-code"]),
    limit: options["--limit"] === undefined ? undefined : Number(options["--limit"]),
  };
}

function runCli() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const logText = readFileSync(options.logPath, "utf8");
    const result = summarizeLog(logText, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = processExitCode(result.exitCode);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
