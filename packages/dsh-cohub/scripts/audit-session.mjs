#!/usr/bin/env node
/**
 * audit-session.mjs — DSH 会话审计 / 回归脚本（优化方案 v2 · P2-1）
 *
 * 作用：对 DSH 会话导出目录（根 session.jsonl + subagents/.../session.jsonl）做可复算统计，
 *       输出工具调用/结果/错误、错误类别、通用"重复盲试"、委派树、墙钟超时与环境签名。
 *
 * 用法：
 *   node scripts/audit-session.mjs <sessionDir> [--rules <json>] [--rules-file <path>] [--json <out>]
 *
 * 检测规则（--rules 内联 JSON 或 --rules-file 文件，缺省内置通用规则）：
 *   {
 *     "errorCategories": { "<scope>::<类别名>" 或 "<类别名>": [子串 或 "/正则/" 或 {"regex":"..."}] },
 *     "blindPatterns": ["/正则/", ...],   // 缺省空：所有非超时/非中止类别都参与盲试判定
 *     "timeoutKey": "timeout",            // 超时错误关键词（大小写不敏感）
 *     "perSessionBlindThreshold": 2       // 同会话同类错误 ≥ 阈值 且 之后有成功/改写法 → 一次重复盲试
 *   }
 *   errorCategories 的 key 可用 "工具名::类别名" 限定工具（"*" 或省略 :: 表示通用）。
 *   命中规则的错误归入该类别；未命中时用通用类别（code-run:<mode> / interrupted / other）。
 *
 * 通用盲试口径（缺省，跨环境）：
 *   同一会话内，同一（盲试）错误类别出现 ≥ perSessionBlindThreshold 次，
 *   且该类别首次出现之后存在"成功结果"或"不同类别的错误结果"（改写法）→
 *   计一次重复盲试：该类别全部失败调用计入 blindRetries，该会话计入 blindSessions。
 *   超时 / 中止 / interrupted 类别不参与盲试判定（它们是调度/墙钟问题，不是盲写代码）。
 *
 * 环境签名（envSignatures）：自动提取本会话的错误类别签名、超时数值、工具名清单，
 *   供"基线按会话重测"与跨环境对比（不把本环境观测当通用规则）。
 *
 * 仅使用 Node 内置模块；不修改任何运行时源码。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---------- 默认规则 ---------- */

const DEFAULT_RULES = Object.freeze({
  errorCategories: {}, // 空 = 用通用类别（code-run:<mode> / interrupted / other）
  blindPatterns: [],   // 空 = 所有非超时/非中止类别参与盲试
  timeoutKey: 'timeout',
  perSessionBlindThreshold: 2,
});

const HELP = `audit-session.mjs — DSH 会话审计 / 回归脚本

用法:
  node scripts/audit-session.mjs <sessionDir> [选项]

参数:
  <sessionDir>            会话解压目录（含根 session.jsonl 与 subagents/**/session.jsonl）
  --rules <json>          内联 JSON 检测规则（优先级最高）
  --rules-file <path>     规则 JSON 文件路径
  --json <out>            把完整统计 JSON 写到 <out>
  --help                  显示本帮助

检测规则 schema:
  {
    "errorCategories": { "<scope>::<类别>" | "<类别>": [子串 | "/正则/" | {"regex":"..."}] },
    "blindPatterns": ["/正则/", ...],
    "timeoutKey": "timeout",
    "perSessionBlindThreshold": 2
  }

退出码: 0 成功；1 参数/读取错误。`;

/* ---------- 工具函数 ---------- */

function fail(msg) {
  console.error(`[audit-session] 错误: ${msg}`);
  process.exit(1);
}

function roundPct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

/** 读取 JSONL 文件，返回事件数组（忽略空行与解析失败行） */
function loadJsonLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过无法解析的行（防御） */
    }
  }
  return out;
}

/** 递归收集目录下所有 session.jsonl */
function findSessionFiles(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl') found.push(p);
    }
  };
  walk(dir);
  return found;
}

/** 从 tool/result 事件提取错误文本与是否错误（兼容 isError 在 text 块 / tool-result 块 / data.error 三处） */
function inspectResult(o) {
  const msg = o.data && o.data.message;
  const texts = [];
  let isError = false;
  if (o.data && o.data.error) isError = true;
  if (msg && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool-result') {
        if (c.isError) isError = true;
        if (Array.isArray(c.content)) {
          for (const cc of c.content) {
            if (cc && cc.type === 'text') {
              if (typeof cc.text === 'string') texts.push(cc.text);
              if (cc.isError) isError = true;
            }
          }
        }
      } else if (c.type === 'text') {
        if (typeof c.text === 'string') texts.push(c.text);
        if (c.isError) isError = true;
      }
    }
  }
  if (o.data && o.data.error && typeof o.data.error === 'object') {
    try {
      texts.push(JSON.stringify(o.data.error));
    } catch {
      /* ignore */
    }
  }
  return { isError, text: texts.join('\n') };
}

/** 归一化错误签名（用于 errors.categories 与环境签名；只归一数字，不猜语义） */
function normalizeErrorText(text) {
  const first = String(text).split(/\r?\n/)[0].trim().replace(/^Error:\s*/, '');
  return first.replace(/\d+/g, '#').slice(0, 240);
}

/** 模式匹配：字符串=子串(忽略大小写)；"/.../" 或 {regex:"..."}=正则 */
function patternMatches(p, text) {
  if (p && typeof p === 'object' && typeof p.regex === 'string') {
    try {
      return new RegExp(p.regex, 'i').test(text);
    } catch {
      return false;
    }
  }
  if (typeof p !== 'string') return false;
  const m = p.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      return new RegExp(m[1], m[2].includes('i') ? 'i' : '').test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

/** 解析 --rules / --rules-file 传入的规则对象 */
function parseRules(argv) {
  const rules = { ...DEFAULT_RULES };
  const inlineIdx = argv.indexOf('--rules');
  const fileIdx = argv.indexOf('--rules-file');
  let inline = null;
  let file = null;
  if (inlineIdx >= 0 && argv[inlineIdx + 1]) inline = argv[inlineIdx + 1];
  if (fileIdx >= 0 && argv[fileIdx + 1]) file = argv[fileIdx + 1];

  const merged = {};
  if (file) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      fail(`无法读取/解析规则文件 ${file}: ${e.message}`);
    }
    Object.assign(merged, obj);
  }
  if (inline) {
    let obj;
    try {
      obj = JSON.parse(inline);
    } catch (e) {
      fail(`无法解析 --rules JSON: ${e.message}`);
    }
    Object.assign(merged, obj);
  }
  // 自动发现 cwd 下 audit.rules.json（无显式规则时）
  if (!file && !inline) {
    const auto = path.join(process.cwd(), 'audit.rules.json');
    if (fs.existsSync(auto)) {
      try {
        Object.assign(merged, JSON.parse(fs.readFileSync(auto, 'utf8')));
      } catch {
        /* 忽略损坏的自动发现文件 */
      }
    }
  }
  if (merged.errorCategories !== undefined) rules.errorCategories = merged.errorCategories;
  if (merged.blindPatterns !== undefined) rules.blindPatterns = merged.blindPatterns;
  if (merged.timeoutKey !== undefined) rules.timeoutKey = String(merged.timeoutKey);
  if (merged.perSessionBlindThreshold !== undefined) {
    const n = Number(merged.perSessionBlindThreshold);
    if (Number.isFinite(n) && n >= 1) rules.perSessionBlindThreshold = n;
  }
  return rules;
}

/**
 * 错误类别解析：
 *  - 先按 errorCategories 规则（工具作用域 + 模式匹配）→ 规则类别
 *  - 未命中 → 通用类别 code-run:<mode> / interrupted / other
 */
function resolveErrorCategory(text, toolName, rules) {
  const cats = rules.errorCategories || {};
  for (const [key, pats] of Object.entries(cats)) {
    const [scope, catName] = key.includes('::') ? key.split('::') : ['*', key];
    if (scope !== '*' && scope !== toolName) continue;
    if (!Array.isArray(pats)) continue;
    for (const p of pats) {
      if (patternMatches(p, text)) return catName;
    }
  }
  const m = String(text).match(/code run failed \((\w+)\)/i);
  if (m) return `code-run:${m[1].toLowerCase()}`;
  if (/interrupted|outcome is unknown/i.test(String(text))) return 'interrupted';
  return 'other';
}

/** 该类别是否参与"盲试"判定（超时/中止/interrupted 不算盲写代码） */
function isBlindCandidate(category, rules) {
  const c = String(category).toLowerCase();
  if (rules.timeoutKey && c.includes(String(rules.timeoutKey).toLowerCase())) return false;
  if (c.includes('abort')) return false;
  if (c.includes('interrupted')) return false;
  return true;
}

/** 该错误文本是否命中 blindPatterns（非空时仅命中者参与盲试） */
function matchesBlindPatterns(text, rules) {
  const pats = rules.blindPatterns || [];
  if (!pats.length) return true;
  return pats.some((p) => patternMatches(p, text));
}

/** 从事件流提取角色：subagent/descriptor.label "delegate:co-fixer" → co-fixer；根 → root */
function extractRole(events, isRoot) {
  for (const o of events) {
    if (o.type === 'subagent/descriptor' && o.data && typeof o.data.label === 'string') {
      const m = o.data.label.match(/delegate:(.+)/);
      if (m) return m[1].trim();
    }
  }
  const sess = events.find((o) => o.type === 'session');
  if (sess && !sess.parentSession) return 'root';
  if (isRoot) return 'root';
  // 兜底：从种子 prompt 猜角色名（不应依赖，仅防御）
  for (const o of events) {
    if (o.type === 'agent/inbox/spliced' && o.data && Array.isArray(o.data.inserted)) {
      for (const ins of o.data.inserted) {
        if (ins && Array.isArray(ins.content)) {
          for (const cc of ins.content) {
            if (cc && typeof cc.text === 'string') {
              const m = cc.text.match(/（(co-[\w-]+)）/);
              if (m) return m[1];
              const m2 = cc.text.match(/你是\s*([\w\u4e00-\u9fa5]+?)[——-]/);
              if (m2) return m2[1].toLowerCase();
            }
          }
        }
      }
    }
  }
  return 'unknown';
}

/** 解析单个会话文件，返回会话统计 */
function analyzeSession(file, rules, isRoot) {
  const events = loadJsonLines(file);
  if (!events) return null;
  const sess = events.find((o) => o.type === 'session') || {};
  const id = sess.id || (isRoot ? 'root' : path.basename(path.dirname(file)));
  const role = extractRole(events, isRoot);

  // callId -> 工具名（用于错误归类时按工具作用域匹配规则）
  const callTool = new Map();
  const toolNames = new Set();
  let firstTs = Infinity;
  let lastTs = -Infinity;
  const pushTime = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      if (n < firstTs) firstTs = n;
      if (n > lastTs) lastTs = n;
    }
  };
  if (sess.createdAt) pushTime(sess.createdAt);

  let calls = 0;
  let results = 0;
  const errors = []; // {text, tool}
  for (const o of events) {
    if (o.type === 'tool/call' && o.data) {
      calls++;
      if (typeof o.data.name === 'string') {
        toolNames.add(o.data.name);
        if (o.data.callId) callTool.set(o.data.callId, o.data.name);
      }
      if (o.time) pushTime(o.time);
    } else if (o.type === 'tool/result' && o.data) {
      results++;
      const { isError, text } = inspectResult(o);
      const callId = o.data.message && o.data.message.source && o.data.message.source.callId;
      const tool = callId ? callTool.get(callId) : null;
      if (isError) errors.push({ text, tool });
      if (o.time) pushTime(o.time);
    } else if (o.time) {
      pushTime(o.time);
    }
  }

  // 显示签名类别（detail）+ 盲试类别（blind）统计
  const byDetail = new Map();
  const byBlind = new Map();
  const seq = []; // 结果序列（ok / {cat}），用于盲试"之后成功/改写法"
  for (const o of events) {
    if (o.type !== 'tool/result' || !o.data) continue;
    const { isError, text } = inspectResult(o);
    if (!isError) {
      seq.push({ ok: true });
      continue;
    }
    const callId = o.data.message && o.data.message.source && o.data.message.source.callId;
    const tool = callId ? callTool.get(callId) : null;
    const cat = resolveErrorCategory(text, tool || 'unknown', rules);
    byBlind.set(cat, (byBlind.get(cat) || 0) + 1);
    seq.push({ ok: false, cat });
    const detail = normalizeErrorText(text);
    byDetail.set(detail, (byDetail.get(detail) || 0) + 1);
  }

  // 盲试判定（按会话）
  const blindCats = new Set();
  let blindRetries = 0;
  for (const [cat, cnt] of byBlind) {
    if (!isBlindCandidate(cat, rules)) continue;
    if (cnt < rules.perSessionBlindThreshold) continue;
    const firstIdx = seq.findIndex((e) => !e.ok && e.cat === cat);
    if (firstIdx < 0) continue;
    let laterOk = false;
    let laterDiff = false;
    for (let i = firstIdx + 1; i < seq.length; i++) {
      const e = seq[i];
      if (e.ok) laterOk = true;
      else if (e.cat !== cat) laterDiff = true;
    }
    if (laterOk || laterDiff) {
      blindRetries += cnt;
      blindCats.add(cat);
    }
  }

  // 超时（按 timeoutKey 关键词）
  let timeoutCount = 0;
  const timeoutVals = new Set();
  for (const e of errors) {
    if (rules.timeoutKey && e.text.toLowerCase().includes(String(rules.timeoutKey).toLowerCase())) {
      timeoutCount++;
      const m = e.text.match(/(\d+)\s*(ms|s|seconds?|minutes?)/i);
      timeoutVals.add(m ? `${m[1]}${m[2].toLowerCase()}` : '?');
    }
  }

  return {
    id,
    role,
    calls,
    results,
    errors: errors.length,
    errorRatePct: roundPct(errors.length, calls),
    detailCategories: byDetail,
    blindCats: [...blindCats],
    blindRetries,
    timeoutCount,
    timeoutValues: [...timeoutVals],
    toolNames: [...toolNames],
    firstTs,
    lastTs,
  };
}

/* ---------- 主流程 ---------- */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.length === 0) {
    console.log(HELP);
    process.exit(1);
  }
  const dir = argv[0];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`会话目录不存在或不是目录: ${dir}`);
  }
  const rules = parseRules(argv);
  const jsonOutIdx = argv.indexOf('--json');
  const jsonOut = jsonOutIdx >= 0 && argv[jsonOutIdx + 1] ? argv[jsonOutIdx + 1] : null;

  const files = findSessionFiles(dir);
  if (!files.length) fail(`目录下未找到任何 session.jsonl: ${dir}`);
  const rootPath = fs.existsSync(path.join(dir, 'session.jsonl')) ? path.join(dir, 'session.jsonl') : null;

  const sessions = [];
  for (const f of files) {
    const isRoot = rootPath && path.resolve(f) === path.resolve(rootPath);
    const s = analyzeSession(f, rules, isRoot);
    if (s) sessions.push(s);
  }
  if (!sessions.length) fail('没有可分析的会话（所有 session.jsonl 为空或无法解析）');
  const rootS = sessions.find((s) => s.role === 'root') || sessions[0];

  // 聚合：调用/结果/错误、per-role
  const perRole = new Map();
  const toolNamesAll = new Set();
  const byName = new Map();
  let totalCalls = 0;
  let totalResults = 0;
  let totalErrors = 0;
  for (const s of sessions) {
    totalCalls += s.calls;
    totalResults += s.results;
    totalErrors += s.errors;
    for (const n of s.toolNames) toolNamesAll.add(n);
    const r = perRole.get(s.role) || { sessions: 0, calls: 0, results: 0, errors: 0 };
    r.sessions++;
    r.calls += s.calls;
    r.results += s.results;
    r.errors += s.errors;
    perRole.set(s.role, r);
  }
  // byName：以 tool/call 为单位再统计一次（analyzeSession 里只留了 Set）
  for (const f of files) {
    const events = loadJsonLines(f);
    if (!events) continue;
    for (const o of events) {
      if (o.type === 'tool/call' && o.data && typeof o.data.name === 'string') {
        byName.set(o.data.name, (byName.get(o.data.name) || 0) + 1);
      }
    }
  }
  const perRoleOut = {};
  for (const [role, r] of perRole) {
    perRoleOut[role] = { ...r, errorRatePct: roundPct(r.errors, r.calls) };
  }

  // 错误类别（全部会话，按显示签名）
  const errCats = new Map();
  const envErrCats = new Set();
  for (const s of sessions) {
    for (const [cat, cnt] of s.detailCategories) {
      errCats.set(cat, (errCats.get(cat) || 0) + cnt);
      envErrCats.add(cat);
    }
  }

  // 盲试聚合
  let blindRetriesTotal = 0;
  const blindSessionList = [];
  const blindByCategory = new Map();
  for (const s of sessions) {
    if (s.blindRetries > 0) {
      blindRetriesTotal += s.blindRetries;
      blindSessionList.push({ id: s.id, role: s.role, blindCategories: s.blindCats });
      for (const c of s.blindCats) blindByCategory.set(c, (blindByCategory.get(c) || 0) + 1);
    }
  }

  // 委派：bySkill（子代理 descriptor label）+ byDepth（session.delegationDepth）
  const bySkill = new Map();
  const depthMap = new Map();
  for (const f of files) {
    const isRoot = rootPath && path.resolve(f) === path.resolve(rootPath);
    const events = loadJsonLines(f);
    if (!events) continue;
    const sess = events.find((o) => o.type === 'session');
    if (!sess) continue;
    if (sess.delegationDepth !== undefined) {
      depthMap.set(String(sess.delegationDepth), (depthMap.get(String(sess.delegationDepth)) || 0) + 1);
    }
    if (isRoot) continue;
    let skill = 'unknown';
    for (const o of events) {
      if (o.type === 'subagent/descriptor' && o.data && typeof o.data.label === 'string') {
        const m = o.data.label.match(/delegate:(.+)/);
        if (m) skill = m[1].trim();
        break;
      }
    }
    bySkill.set(skill, (bySkill.get(skill) || 0) + 1);
  }

  // dispatch 统计（run_code 内嵌调用：delegate / skill / job_list ...）
  let dispatchTotal = 0;
  let dispatchErrors = 0;
  const dispatchByName = new Map();
  for (const f of files) {
    const events = loadJsonLines(f);
    if (!events) continue;
    for (const o of events) {
      if (o.type === 'tool/code-dispatch' && o.data) {
        dispatchTotal++;
        if (typeof o.data.name === 'string') dispatchByName.set(o.data.name, (dispatchByName.get(o.data.name) || 0) + 1);
        if (o.data.isError) dispatchErrors++;
      }
    }
  }

  // 墙钟
  let timeoutTotal = 0;
  const timeoutValsAll = new Set();
  for (const s of sessions) {
    timeoutTotal += s.timeoutCount;
    for (const v of s.timeoutValues) timeoutValsAll.add(v);
  }
  const durations = sessions
    .filter((s) => Number.isFinite(s.firstTs) && Number.isFinite(s.lastTs))
    .map((s) => ({ id: s.id, role: s.role, durMs: Math.max(0, s.lastTs - s.firstTs) }));
  const maxDur = durations.length ? Math.max(...durations.map((d) => d.durMs)) : 0;
  const rootDur = durations.find((d) => d.role === 'root');
  const rootWallClockMs = rootDur ? rootDur.durMs : maxDur;
  const createdTs = rootS ? rootS.firstTs : 0;
  const endedTs = rootS ? rootS.lastTs : 0;

  const summary = {
    meta: {
      source: dir,
      rootSessionId: rootS ? rootS.id : null,
      totalSessions: sessions.length,
      subagentCount: sessions.filter((s) => s.role !== 'root').length,
      createdAt: Number.isFinite(createdTs) && createdTs ? new Date(createdTs).toISOString() : null,
      endedAt: Number.isFinite(endedTs) && endedTs ? new Date(endedTs).toISOString() : null,
      wallClockMs: rootWallClockMs,
    },
    tools: {
      totalCalls,
      byName: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1])),
      totalResults,
      errors: totalErrors,
      errorRatePct: roundPct(totalErrors, totalResults),
      perRole: perRoleOut,
    },
    errors: {
      categories: Object.fromEntries([...errCats].sort((a, b) => b[1] - a[1])),
      blindRetries: blindRetriesTotal,
      blindSessionsCount: blindSessionList.length,
      blindSessions: blindSessionList,
      blindByCategory: Object.fromEntries([...blindByCategory].sort((a, b) => b[1] - a[1])),
    },
    delegation: {
      rootId: rootS ? rootS.id : null,
      totalSubagents: sessions.filter((s) => s.role !== 'root').length,
      bySkill: Object.fromEntries([...bySkill].sort((a, b) => b[1] - a[1])),
      byDepth: Object.fromEntries([...depthMap].sort((a, b) => Number(a[0]) - Number(b[0]))),
    },
    dispatch: {
      total: dispatchTotal,
      byName: Object.fromEntries([...dispatchByName].sort((a, b) => b[1] - a[1])),
      errors: dispatchErrors,
    },
    perRole: perRoleOut,
    wallClock: {
      timeoutCount: timeoutTotal,
      timeoutValues: [...timeoutValsAll].sort(),
      maxDurationMs: maxDur,
      rootWallClockMs,
    },
    envSignatures: {
      errorCategories: [...envErrCats].sort(),
      timeoutValues: [...timeoutValsAll].sort(),
      toolNames: [...toolNamesAll].sort(),
    },
    sessions: sessions
      .sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : a.id.localeCompare(b.id)))
      .map((s) => ({
        id: s.id,
        role: s.role,
        calls: s.calls,
        results: s.results,
        errors: s.errors,
        errorRatePct: s.errorRatePct,
        blindRetries: s.blindRetries,
        timeoutCount: s.timeoutCount,
        pass: s.blindRetries === 0 && s.timeoutCount === 0,
      })),
  };

  // stdout 摘要
  console.log(`[audit-session] 源目录: ${dir}`);
  console.log(`  会话: ${summary.meta.totalSessions}（子代理 ${summary.meta.subagentCount}） 根: ${summary.meta.rootSessionId}`);
  console.log(
    `  工具: 调用 ${summary.tools.totalCalls} / 结果 ${summary.tools.totalResults} / 错误 ${summary.tools.errors}（${summary.tools.errorRatePct}%，按结果）`,
  );
  console.log(`  工具名: ${summary.envSignatures.toolNames.join(', ')}`);
  console.log('  错误类别 (top):');
  for (const [c, n] of Object.entries(summary.errors.categories).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${n}  ${c}`);
  }
  console.log(
    `  重复盲试: ${summary.errors.blindRetries} 次失败调用 / ${summary.errors.blindSessionsCount} 个会话（阈值 ${rules.perSessionBlindThreshold}）`,
  );
  console.log(`  委派: 子代理 ${summary.delegation.totalSubagents}，bySkill ${JSON.stringify(summary.delegation.bySkill)}`);
  console.log(
    `  墙钟: 超时 ${summary.wallClock.timeoutCount} 次（${summary.wallClock.timeoutValues.join(', ') || '-'}），根会话 ${(summary.wallClock.rootWallClockMs / 60000).toFixed(1)} 分钟`,
  );
  console.log('  会话 PASS/FAIL（盲试=0 且超时=0 → PASS）:');
  const passN = summary.sessions.filter((s) => s.pass).length;
  for (const s of summary.sessions) {
    console.log(
      `    ${s.pass ? 'PASS' : 'FAIL'}  ${String(s.role).padEnd(14)} ${s.id.slice(0, 8)}  calls=${s.calls} errs=${s.errors} blind=${s.blindRetries} timeout=${s.timeoutCount}`,
    );
  }
  console.log(`  PASS ${passN}/${summary.sessions.length}`);

  if (jsonOut) {
    try {
      fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2), 'utf8');
      console.log(`[audit-session] JSON 已写入: ${jsonOut}`);
    } catch (e) {
      fail(`写入 JSON 失败: ${e.message}`);
    }
  }
}

main();
