/**
 * 本地发版预检脚本（打 tag 前的秒级静态检查）
 *
 * 把 CI 里「打完 tag 才发现失败」的门禁前移到本地一键执行。
 *
 * 本脚本**只做秒级静态检查**：
 * 不执行 `npm ci`、不执行 `npm run build`、不跑测试——
 * 那些属于发版规范 ②③ 项，耗时且由 CI 把关（`prepublishOnly` 已保证 build 先跑）。
 *
 * 覆盖发版规范 ①④⑤⑥ 项 + CHANGELOG 条目（见 docs/dsh-release-guide.md:174-192）：
 *   1. 四处版本一致（package.json / lock 顶层 / lock packages[""] / README 首屏锚点）
 *   2. tag 未被占用（本地 + 远端；远端不可达降级为警告）
 *   3. 工作区干净（git status --porcelain 为空）
 *   4. 当前分支与远端同步（落后 → 失败，领先 → 警告）
 *   5. CHANGELOG 有对应版本条目
 *
 * 用法:
 *   bun run scripts/prepublish-check.ts                 # 检测当前 package.json 版本
 *   bun run scripts/prepublish-check.ts --version 0.12.0 # 预演某个版本（tag 前演练）
 *
 * 退出码: 全部通过 0；任一 ❌ 1（⚠️ 警告不影响退出码）。
 *
 * ⚠️ 本脚本仅用于「本地打 tag 之前」手动预检。
 *    禁止挂到 prepublishOnly / prepublish hook：CI 执行 `npm publish` 时 tag 必然已存在，
 *    检查 2 会误判为失败并阻断发布。
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_DIR = path.resolve(__dirname, '..');

let failCount = 0;
let warnCount = 0;

function section(title: string): void {
  console.log(`\n── ${title} ──────────────────────────────`);
}

function ok(msg: string): void {
  console.log(`✅ ${msg}`);
}

function fail(msg: string): void {
  failCount++;
  console.log(`❌ ${msg}`);
}

function warn(msg: string): void {
  warnCount++;
  console.log(`⚠️  ${msg}`);
}

function readText(file: string): string {
  return fs.readFileSync(path.join(PKG_DIR, file), 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sh(cmd: string): string {
  return execSync(cmd, {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  }).trim();
}

// ── 解析参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const vIdx = argv.indexOf('--version');
const pkg = JSON.parse(readText('package.json')) as { version: string };
const version = vIdx >= 0 && argv[vIdx + 1] ? argv[vIdx + 1] : pkg.version;
const tag = `dsh-v${version}`;

console.log(`🔍 dsh-cohub 发版预检 — 目标版本 ${version}（tag: ${tag}）`);

// ═════════════════════════════ 检查 1：四处版本一致 ═════════════════════════════
section('检查 1/5 版本一致性（规范 ④）');
{
  const mismatches: string[] = [];

  // ① package.json version
  if (pkg.version !== version) {
    mismatches.push(`package.json 的 version 实际为 ${pkg.version}，期望 ${version}`);
  }

  // ② package-lock.json 顶层 version  ③ packages[""].version
  const lock = JSON.parse(readText('package-lock.json')) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  const lockRoot = lock.packages?.['']?.version;
  if (lock.version !== version) {
    mismatches.push(`package-lock.json 顶层 version 实际为 ${lock.version}，期望 ${version}`);
  }
  if (lockRoot !== version) {
    mismatches.push(`package-lock.json 的 packages[""].version 实际为 ${lockRoot}，期望 ${version}`);
  }
  if (lock.version !== version || lockRoot !== version) {
    mismatches.push('修复提示：在包目录执行 `npm install --package-lock-only` 同步 lock（否则 CI 的 npm ci 会直接 EUSAGE 失败）');
  }

  // ④ README.md 前 20 行的版本锚点
  const readmeLines = readText('README.md').split(/\r?\n/).slice(0, 20);
  const anchorRe = new RegExp(`本文对应.*v${escapeRe(version)}\\b`);
  const anchorIdx = readmeLines.findIndex((l) => anchorRe.test(l));
  if (anchorIdx < 0) {
    const actual = readmeLines
      .map((l, i) => ({ i, m: /本文对应.*?v(\d+\.\d+\.\d+)/.exec(l) }))
      .find((x) => x.m);
    const lineNo = actual ? actual.i + 1 : 3;
    const found = actual?.m?.[1] ? `（当前为 v${actual.m[1]}）` : '（未找到锚点）';
    mismatches.push(`README.md 首屏锚点${found}，期望 v${version}`);
    mismatches.push(`修复提示：README.md:${lineNo} 应改为 \`本文对应 **v${version}**\``);
  }

  if (mismatches.length === 0) {
    ok(`四处版本一致：package.json / lock 顶层 / lock packages[""] / README 锚点 均为 ${version}`);
  } else {
    for (const m of mismatches) {
      if (m.startsWith('修复提示')) console.log(`   ↳ ${m}`);
      else fail(m);
    }
  }
}

// ═════════════════════════════ 检查 2：tag 未被占用 ═════════════════════════════
section('检查 2/5 tag 未被占用（规范 ⑤⑥）');
{
  const TAG_HINT = '严禁删除/移动已有 tag：npm 同版本不可重发，动了 tag 只会让 CI 版本一致性检查永久对不上。请改用新版本号。';

  let localTag = '';
  try {
    localTag = sh(`git tag -l "${tag}"`);
  } catch (e) {
    fail(`git tag -l 执行失败：${(e as Error).message}`);
  }
  if (localTag) fail(`本地已存在 tag ${tag}。${TAG_HINT}`);
  else ok(`本地无 tag ${tag}`);

  try {
    const remoteTag = sh(`git ls-remote --tags origin "refs/tags/${tag}"`);
    if (remoteTag) fail(`远端 origin 已存在 tag ${tag}。${TAG_HINT}`);
    else ok(`远端 origin 无 tag ${tag}`);
  } catch (e) {
    warn(`无法访问远端 origin（${(e as Error).message.split('\n')[0]}）— 请手动确认远端未占用 ${tag}`);
  }
}

// ═════════════════════════════ 检查 3：工作区干净 ═════════════════════════════
section('检查 3/5 工作区干净（规范 ①）');
{
  const dirty = sh('git status --porcelain');
  if (!dirty) {
    ok('工作区干净，无未提交改动');
  } else {
    const files = dirty.split('\n').filter(Boolean);
    fail(`工作区有 ${files.length} 项未提交改动：`);
    for (const f of files.slice(0, 10)) console.log(`   ${f}`);
    if (files.length > 10) console.log(`   …还有 ${files.length - 10} 项未显示`);
    console.log('   ↳ 修复提示：提交或 stash 后再发版，否则打出的 tag 不含这些改动（规范 ⑦）');
  }
}

// ═════════════════════════════ 检查 4：分支与远端同步 ═════════════════════════════
section('检查 4/5 分支与远端同步');
{
  const sb = sh('git status -sb').split('\n')[0] ?? '';
  const ahead = /\[.*ahead (\d+).*\]/.exec(sb);
  const behind = /\[.*behind (\d+).*\]/.exec(sb);
  const branch = sb.replace(/^##\s*/, '').split('...')[0] ?? '(unknown)';

  if (behind) fail(`当前分支 ${branch} 落后远端 ${behind[1]} 个提交，请先 merge/rebase`);
  if (ahead) warn(`当前分支 ${branch} 领先远端 ${ahead[1]} 个提交（未推送，不阻断，但请确认 tag 前已推送）`);
  if (!ahead && !behind) {
    if (sb.includes('...')) ok(`当前分支 ${branch} 与远端同步`);
    else warn(`当前分支 ${branch} 无上游跟踪分支，无法判断是否同步 — 请手动确认`);
  }
}

// ═════════════════════════════ 检查 5：CHANGELOG 条目 ═════════════════════════════
section('检查 5/5 CHANGELOG 条目');
{
  const cl = readText('CHANGELOG.md');
  const entryRe = new RegExp(`^##\\s*\\[v?${escapeRe(version)}\\]`, 'm');
  if (entryRe.test(cl)) {
    ok(`CHANGELOG.md 存在 \`## [${version}]\` 条目`);
  } else {
    fail(`CHANGELOG.md 缺少 \`## [${version}]\` 条目`);
    console.log(`   ↳ 修复提示：在 CHANGELOG.md 顶部（\`# Changelog\` 说明段之后）新增 \`## [${version}] - YYYY-MM-DD\` 并列出变更`);
  }
}

// ═════════════════════════════ 汇总 ═════════════════════════════
console.log('');
if (failCount === 0) {
  console.log(`✅ 预检全部通过，可以打 tag：${tag}`);
  if (warnCount > 0) console.log(`   （另有 ${warnCount} 项警告，不影响发版）`);
  process.exit(0);
} else {
  console.log(`❌ 预检失败 ${failCount} 项，请修复后再发版`);
  if (warnCount > 0) console.log(`   （另有 ${warnCount} 项警告）`);
  process.exit(1);
}
