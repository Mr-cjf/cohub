// A2 复盘采集器单测（独立运行，不连真宿主）
// 覆盖：完整 turn 的 TurnSummary、usage 缺失为 null（非 0）、tool/result 未到为 pending、
//       (sessionId, seq) 去重、turn/end 的 kind 归一化、cwd=null → nocwd 目录、
//       子会话折叠到根会话 + gap 标记、原子写与损坏文件隔离。
// 用法：node test/review-collector.ts（node >= 24 类型剥离）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 隔离落盘根：dshHomePath 每次读 DSH_HOME（未 memoize），必须在 import 前设置
const homeRoot = mkdtempSync(join(tmpdir(), "cohub-review-home-"));
process.env.DSH_HOME = homeRoot;

const { createReviewCollector, resolveRootSessionId } = await import("../src/review-collector.ts");
const { saveStats, loadStats, reviewStorePath, cwdDirName, sessionDirName, REVIEW_STATS_VERSION } =
  await import("../src/review-store.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

/** fake ctx：只提供 on("session/event") + logger，不连真宿主 */
function makeCtx() {
  const listeners = new Set<(...a: any[]) => void>();
  const ctx: any = {
    logger: { info: () => {}, warn: () => {} },
    on(type: string, h: (...a: any[]) => void) {
      if (type === "session/event") { listeners.add(h); return () => listeners.delete(h); }
      return () => {};
    },
    listenerCount: () => listeners.size,
    emit(session: any, event: any) {
      for (const h of [...listeners]) h(session, event);
    },
    off: () => { listeners.clear(); },
  };
  return ctx;
}

/** 事件构造：seq/time 在信封上，data 只放 payload */
function ev(type: string, seq: number, time: number, data: any) {
  return { type, seq, time, data };
}

function sessionOf(id: string, cwd: string | null = "C:\\work\\proj", parentSession: string | null = null) {
  const header: any = { id };
  if (cwd !== null) header.cwd = cwd;
  if (parentSession !== null) header.parentSession = parentSession;
  return { id, header };
}

const tmpDirs: string[] = [homeRoot];

// ---- 用例 1：完整 turn → TurnSummary（usage 累加 / 工具配对 / kind 归一化） ----
{
  console.log("===== 用例 1：完整 turn 统计 =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const sid = "sess-full-1";
  const s = sessionOf(sid, "C:\\work\\proj");
  ctx.emit(s, ev("turn/start", 1, 1000, { turn: 1 }));
  ctx.emit(s, ev("tool/call", 2, 1100, { turn: 1, step: 1, callId: "c1", name: "run_code", arguments: "{}" }));
  ctx.emit(s, ev("tool/result", 3, 1500, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }));
  ctx.emit(s, ev("assistant/message", 4, 1600, {
    turn: 1, step: 1, message: {}, stream: [],
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 10 },
  }));
  ctx.emit(s, ev("turn/end", 5, 1700, { turn: 1, reason: { kind: "completed" } }));
  await collector.flush();
  collector.dispose();

  const stats = loadStats("C:\\work\\proj", sid);
  check("落盘文件存在", existsSync(reviewStorePath("C:\\work\\proj", sid)));
  check("轮次数=1", stats?.turns.length === 1);
  const t = stats?.turns[0];
  check("turn 号取自 data.turn", t?.turn === 1);
  check("end.seq 取自事件信封", t?.end.seq === 5);
  check("end.time 取自事件信封", t?.end.time === 1700);
  check("end.kind 归一化 completed", t?.end.kind === "completed");
  check("usage 汇总 inputTokens", t?.usage?.inputTokens === 100);
  check("usage 汇总 outputTokens", t?.usage?.outputTokens === 20);
  check("usage 汇总 totalTokens", t?.usage?.totalTokens === 120);
  check("usage 未给字段为 null（cacheWrite）", t?.usage?.cacheWriteTokens === null);
  check("usageEvidenceSeqs=[4]", JSON.stringify(t?.usageEvidenceSeqs) === "[4]");
  check("工具记录 1 条", t?.tools.length === 1);
  check("工具 callId 配对", t?.tools[0]?.callId === "c1");
  check("工具 status=success", t?.tools[0]?.status === "success");
  check("工具 startedAt=call.time", t?.tools[0]?.startedAt === 1100);
  check("工具 endedAt=result.time", t?.tools[0]?.endedAt === 1500);
  check("文件内另存原始 sessionId", stats?.sessionId === sid);
  check("rootSessionId=自身", stats?.rootSessionId === sid);
}

// ---- 用例 2：usage 缺失 → null，不是 0 ----
{
  console.log("===== 用例 2：usage 缺失 → null =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const sid = "sess-nousage-1";
  const s = sessionOf(sid);
  ctx.emit(s, ev("turn/start", 1, 2000, { turn: 1 }));
  ctx.emit(s, ev("assistant/message", 2, 2100, { turn: 1, step: 1, message: {}, stream: [] }));
  ctx.emit(s, ev("turn/end", 3, 2200, { turn: 1, reason: { kind: "aborted", reason: "user" } }));
  await collector.flush();
  collector.dispose();

  const t = loadStats("C:\\work\\proj", sid)?.turns[0];
  check("usage 为 null", t?.usage === null);
  check("usage 不为 0 值对象", JSON.stringify(t?.usage) === "null");
  check("usageEvidenceSeqs 为空", t?.usageEvidenceSeqs.length === 0);
  check("aborted 的 kind 归一化", t?.end.kind === "aborted");
}

// ---- 用例 3：tool/result 未到达 → pending ----
{
  console.log("===== 用例 3：无 tool/result → pending =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const sid = "sess-pending-1";
  const s = sessionOf(sid);
  ctx.emit(s, ev("turn/start", 1, 3000, { turn: 1 }));
  ctx.emit(s, ev("tool/call", 2, 3100, { turn: 1, step: 1, callId: "c9", name: "bash", arguments: "{}" }));
  ctx.emit(s, ev("turn/end", 3, 3200, { turn: 1, reason: { kind: "completed" } }));
  await collector.flush();
  collector.dispose();

  const t = loadStats("C:\\work\\proj", sid)?.turns[0];
  check("工具 status=pending", t?.tools[0]?.status === "pending");
  check("resultSeq 为 null", t?.tools[0]?.resultSeq === null);
  check("endedAt 为 null", t?.tools[0]?.endedAt === null);
}

// ---- 用例 4：同一 seq 不重复计数（重放/重复投递） ----
{
  console.log("===== 用例 4：(sessionId, seq) 去重 =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const sid = "sess-dup-1";
  const s = sessionOf(sid);
  const msg = ev("assistant/message", 2, 4100, { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 50, outputTokens: 5 } });
  ctx.emit(s, ev("turn/start", 1, 4000, { turn: 1 }));
  ctx.emit(s, msg);
  ctx.emit(s, msg); // 重放同一事件
  ctx.emit(s, { ...msg }); // 同 seq 的不同对象
  ctx.emit(s, ev("turn/end", 3, 4200, { turn: 1, reason: { kind: "completed" } }));
  ctx.emit(s, ev("turn/end", 3, 4200, { turn: 1, reason: { kind: "completed" } })); // 结束事件重放
  await collector.flush();
  collector.dispose();

  const stats = loadStats("C:\\work\\proj", sid);
  const t = stats?.turns[0];
  check("usage 只累加一次（inputTokens=50）", t?.usage?.inputTokens === 50);
  check("evidence 只记一次 seq", JSON.stringify(t?.usageEvidenceSeqs) === "[2]");
  check("轮次仍为 1 条", stats?.turns.length === 1);
}

// ---- 用例 5：cwd=null → nocwd 目录，不猜工作目录 ----
{
  console.log("===== 用例 5：cwd=null → nocwd =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const sid = "sess-nocwd-1";
  const s = sessionOf(sid, null);
  ctx.emit(s, ev("turn/start", 1, 5000, { turn: 1 }));
  ctx.emit(s, ev("turn/end", 2, 5100, { turn: 1, reason: { kind: "error", error: { message: "x", code: "UNKNOWN" } } }));
  await collector.flush();
  collector.dispose();

  const path = reviewStorePath(null, sid);
  check("cwd=null 目录名为 nocwd", path.includes("nocwd"));
  check("nocwd 落盘存在", existsSync(path));
  check("cwd 目录 hash 长度 16", cwdDirName("C:\\work\\proj").length === 16);
  check("session 目录 hash 长度 32", sessionDirName(sid).length === 32);
  check("hash 定长且无路径穿越", !sessionDirName("../evil/x").includes("/"));
  check("error 的 kind 归一化", loadStats(null, sid)?.turns[0]?.end.kind === "error");
}

// ---- 用例 6：子会话折叠到根会话 + 未见子会话记 gap ----
{
  console.log("===== 用例 6：子会话折叠与 gap =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, {
    enabled: true,
    debounceMs: 0,
    // 预期两个子会话：child-ok 会来，child-missing 被 scope 过滤
    expectChildSessions: () => ["child-ok", "child-missing"],
  });
  const root = sessionOf("root-1", "C:\\work\\proj");
  const child = sessionOf("child-ok", "C:\\work\\proj", "root-1");
  ctx.emit(child, ev("turn/start", 1, 6000, { turn: 1 }));
  ctx.emit(child, ev("assistant/message", 2, 6100, { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 7, outputTokens: 3 } }));
  ctx.emit(child, ev("turn/end", 3, 6200, { turn: 1, reason: { kind: "completed" } }));
  ctx.emit(root, ev("turn/start", 1, 6300, { turn: 1 }));
  ctx.emit(root, ev("tool/call", 2, 6400, { turn: 1, step: 1, callId: "spawn1", name: "delegate", arguments: "{}" }));
  ctx.emit(root, ev("turn/end", 3, 6500, { turn: 1, reason: { kind: "completed" } }));
  await collector.flush();
  collector.dispose();

  const rootStats = loadStats("C:\\work\\proj", "root-1");
  const childStats = loadStats("C:\\work\\proj", "child-ok");
  check("子会话统计独立落盘", childStats?.rootSessionId === "root-1");
  check("子会话 usage 独立汇总", childStats?.turns[0]?.usage?.inputTokens === 7);
  check("根会话 gaps 记录未见子会话", !!rootStats?.gaps.some(g => g === "subagent events not received for session child-missing"));
  check("已到达的子会话不记 gap", !rootStats?.gaps.some(g => g.includes("child-ok")));
}

// ---- 用例 7：原子写 / 损坏文件隔离 / 读写失败静默 ----
{
  console.log("===== 用例 7：原子写与损坏隔离 =====");
  const cwd = "C:\\work\\proj";
  const sid = "sess-atomic-1";
  const file = reviewStorePath(cwd, sid);
  const stats = {
    version: REVIEW_STATS_VERSION, sessionId: sid, cwd, rootSessionId: sid, gaps: [],
    updatedAt: new Date().toISOString(), turns: [],
  };
  check("saveStats 成功", await saveStats(cwd, sid, stats));
  check("无残留 .tmp", !existsSync(file + ".tmp"));
  writeFileSync(file, "{ not json", "utf8");
  check("损坏文件读取返回 null", loadStats(cwd, sid) === null);
  check("损坏文件被改名 .corrupt", existsSync(file + ".corrupt"));
  check("损坏文件未被静默覆盖为默认值", !existsSync(file));
  const sid3 = "sess-atomic-3";
  const blocked = reviewStorePath(cwd, sid3);
  // 把「会话目录」位置占成普通文件 → mkdir -p 必失败 → saveStats 静默返回 false
  mkdirSync(dirname(dirname(blocked)), { recursive: true });
  writeFileSync(dirname(blocked), "x", "utf8");
  check("写失败静默返回 false", (await saveStats(cwd, sid3, { ...stats, sessionId: sid3 })) === false);
  check("写失败不抛错且无目标文件", !existsSync(blocked));
}

// ---- 用例 6b：多级子会话上溯到真根（P1：stats 与 report 同源） ----
{
  console.log("===== 用例 6b：多级子会话归一真根 =====");
  const ctx = makeCtx();
  const collector = createReviewCollector(ctx, { enabled: true, debounceMs: 0 });
  const rootId = "root-deep";
  const midId = "mid-deep";
  const leafId = "leaf-deep";
  const root = sessionOf(rootId, "C:\\work\\proj");
  const mid = sessionOf(midId, "C:\\work\\proj", rootId);
  const leaf = sessionOf(leafId, "C:\\work\\proj", midId); // 孙会话：父是 mid 而非 root
  // 乱序到达：孙先到（此时上溯链还不完整），验证落盘前重算能纠正为真根
  for (const [s, base] of [[leaf, 7000], [mid, 7100], [root, 7200]] as const) {
    ctx.emit(s, ev("turn/start", 1, base, { turn: 1 }));
    ctx.emit(s, ev("turn/end", 2, base + 50, { turn: 1, reason: { kind: "completed" } }));
  }
  await collector.flush();
  collector.dispose();

  check("根会话 rootSessionId 是自己", loadStats("C:\\work\\proj", rootId)?.rootSessionId === rootId);
  check("一级子会话 rootSessionId 是真根", loadStats("C:\\work\\proj", midId)?.rootSessionId === rootId);
  check("二级子会话 rootSessionId 是真根（非单跳 mid）", loadStats("C:\\work\\proj", leafId)?.rootSessionId === rootId);
  check("子会话 sessionId 仍为自己（不覆盖身份）", loadStats("C:\\work\\proj", leafId)?.sessionId === leafId);
}

// ---- 用例 6c：resolveRootSessionId 上溯语义（自环/未知父不挂死） ----
{
  console.log("===== 用例 6c：resolveRootSessionId 语义 =====");
  const parents = new Map<string, string>([["a", "b"], ["b", "c"], ["loop1", "loop2"], ["loop2", "loop1"]]);
  const resolve = (id: string) => resolveRootSessionId(id, x => parents.get(x));
  check("三级链 a→b→c 解析到 c", resolve("a") === "c");
  check("链顶 c 解析到自己", resolve("c") === "c");
  check("未知会话解析到自己", resolve("nobody") === "nobody");
  check("自环不死循环且落在环内", ["loop1", "loop2"].includes(resolve("loop1")));
}

// 清理临时目录
for (const d of tmpDirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ }
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
