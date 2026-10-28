// test/review-command.ts —— 子会话发现与取样链路单测
// 覆盖：0/50/51/95 个子会话的 total/ids/truncated、createdAt 降序取样、
//       同毫秒撞值用 id 兜底排序（确定可复现）、traceSession 抛错退化到 listSessions、
//       两条路径结果一致、coverage 四字段补齐、读失败时 sessionsAnalyzed < ids.length。
// 全部用假 ctx stub，不连真宿主。
// 用法：node test/review-command.ts（node >= 24 类型剥离）
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { applyDiscoveryCoverage, findChildIds, normalizeSessionId, sampleNewest, type ChildDiscovery } from "../src/review-command.ts";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log("  " + name + ": PASS");
    pass++;
  } catch (err) {
    console.log("  " + name + ": FAIL — " + (err instanceof Error ? err.message : String(err)));
    fail++;
  }
}
function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(
    () => {
      console.log("  " + name + ": PASS");
      pass++;
    },
    (err) => {
      console.log("  " + name + ": FAIL — " + (err instanceof Error ? err.message : String(err)));
      fail++;
    },
  );
}

// ---- stub 构造 ----
/** n 个子会话，createdAt = 1000 + i（i 越大越新）；trace 树与 list 记录同一份数据 */
function makeChildren(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: "c" + String(i).padStart(3, "0"), createdAt: 1000 + i }));
}
/** traceSession 返回的节点形状：{ session: SessionRecord, descendants: [...] } */
function asTraceTree(children: Array<{ id: string; createdAt: number }>) {
  return {
    session: { header: { id: "root", createdAt: 0 } },
    descendants: children.map(c => ({
      session: { id: c.id, parentSession: "root", header: { id: c.id, createdAt: c.createdAt } },
      descendants: [],
    })),
  };
}
/** listSessions 返回的扁平记录（header.createdAt） */
function asListRecords(children: Array<{ id: string; createdAt: number }>) {
  return [
    { header: { id: "root", createdAt: 0 } },
    ...children.map(c => ({ header: { id: c.id, parentSession: "root", createdAt: c.createdAt } })),
  ];
}
function makeCtx(children: Array<{ id: string; createdAt: number }>, opts: { traceThrows?: boolean; noTrace?: boolean } = {}) {
  const warns: string[] = [];
  return {
    warns,
    ctx: {
      logger: { warn: (m: string) => { warns.push(m); }, info: () => {} },
      sessionQuery: {
        traceSession: opts.noTrace
          ? undefined
          : async () => {
            if (opts.traceThrows) throw new Error("trace boom");
            return asTraceTree(children);
          },
        listSessions: async () => asListRecords(children),
      },
    },
  };
}

// findChildIds 直接导入（已 export，供测试与调试复用）；ctx 用上面的假 stub，不连真宿主。
const discover = (ctx: any, rootId: string): Promise<ChildDiscovery> => findChildIds(ctx, rootId);

async function main(): Promise<void> {
  // ---- 用例 1：0 个子会话 ----
  console.log("===== 用例 1：0 个子会话 =====");
  {
    const { ctx } = makeCtx([]);
    const d = await discover(ctx, "root");
    await checkAsync("total=0 / ids=[] / truncated=false", async () => {
      assert.equal(d.total, 0);
      assert.deepEqual(d.ids, []);
      assert.equal(d.truncated, false);
    });
    await checkAsync("source=trace", async () => assert.equal(d.source, "trace"));
  }

  // ---- 用例 2：恰好 50 个 ----
  console.log("===== 用例 2：恰好 50 个 =====");
  {
    const { ctx } = makeCtx(makeChildren(50));
    const d = await discover(ctx, "root");
    await checkAsync("total=50 / ids.length=50 / truncated=false", async () => {
      assert.equal(d.total, 50);
      assert.equal(d.ids.length, 50);
      assert.equal(d.truncated, false);
    });
  }

  // ---- 用例 3：51 个 ----
  console.log("===== 用例 3：51 个 =====");
  {
    const { ctx } = makeCtx(makeChildren(51));
    const d = await discover(ctx, "root");
    await checkAsync("total=51 / ids.length=50 / truncated=true", async () => {
      assert.equal(d.total, 51);
      assert.equal(d.ids.length, 50);
      assert.equal(d.truncated, true);
    });
  }

  // ---- 用例 4：95 个，ids 必须是最新的 50 个 ----
  console.log("===== 用例 4：95 个 → 取最新 50 =====");
  {
    const { ctx } = makeCtx(makeChildren(95));
    const d = await discover(ctx, "root");
    await checkAsync("total=95 / ids.length=50 / truncated=true", async () => {
      assert.equal(d.total, 95);
      assert.equal(d.ids.length, 50);
      assert.equal(d.truncated, true);
    });
    await checkAsync("ids 是最新的 50 个（c045..c094），且倒序", async () => {
      const expected = Array.from({ length: 50 }, (_, i) => "c" + String(94 - i).padStart(3, "0"));
      assert.deepEqual(d.ids, expected);
    });
    await checkAsync("最旧的 45 个被排除（c000 不在 ids 里）", async () => {
      assert.equal(d.ids.includes("c000"), false);
      assert.equal(d.ids.includes("c045"), true);
    });
  }

  // ---- 用例 5：createdAt 撞值 → id 兜底，结果确定可复现 ----
  console.log("===== 用例 5：createdAt 撞值 =====");
  {
    // 60 个节点全部 createdAt 相同（fork 场景同毫秒），只有 id 能区分顺序
    const same = Array.from({ length: 60 }, (_, i) => ({ id: "z" + String(i).padStart(3, "0"), createdAt: 5000 }));
    const a = (await discover(makeCtx(same).ctx, "root")).ids;
    const b = (await discover(makeCtx(same).ctx, "root")).ids;
    await checkAsync("同毫秒下按 id.localeCompare 升序取前 50", async () => {
      const expected = Array.from({ length: 50 }, (_, i) => "z" + String(i).padStart(3, "0"));
      assert.deepEqual(a, expected);
    });
    await checkAsync("两次调用结果完全一致（确定可复现）", async () => {
      assert.deepEqual(a, b);
    });
  }

  // ---- 用例 6：traceSession 抛错 → 退化 listSessions ----
  console.log("===== 用例 6：traceSession 抛错 → 退化 listSessions =====");
  {
    const { ctx, warns } = makeCtx(makeChildren(95), { traceThrows: true });
    const d = await discover(ctx, "root");
    await checkAsync('source="list"', async () => assert.equal(d.source, "list"));
    await checkAsync("退化后 total/ids/truncated 仍正确", async () => {
      assert.equal(d.total, 95);
      assert.equal(d.ids.length, 50);
      assert.equal(d.truncated, true);
    });
    await checkAsync("warn 记录了 traceSession 失败", async () => {
      assert.ok(warns.some(w => w.includes("traceSession")), "应有一条 traceSession 失败 warn");
    });
  }

  // ---- 用例 7：两条路径结果一致 ----
  console.log("===== 用例 7：两条路径结果一致 =====");
  {
    const kids = makeChildren(95);
    const traced = await discover(makeCtx(kids).ctx, "root");
    const listed = await discover(makeCtx(kids, { traceThrows: true }).ctx, "root");
    await checkAsync("source 不同（trace vs list）", async () => {
      assert.equal(traced.source, "trace");
      assert.equal(listed.source, "list");
    });
    await checkAsync("ids 完全相同", async () => assert.deepEqual(traced.ids, listed.ids));
    await checkAsync("total 相同", async () => assert.equal(traced.total, listed.total));
    await checkAsync("truncated 相同", async () => assert.equal(traced.truncated, listed.truncated));
  }

  // ---- 用例 8：coverage 补齐 ----
  console.log("===== 用例 8：coverage 补齐 =====");
  {
    const truncatedDiscovery: ChildDiscovery = { ids: makeChildren(50).map(c => c.id), total: 95, truncated: true, source: "trace" };
    const covA: any = { throughSeq: {}, complete: true, gaps: [], inputTruncated: false };
    applyDiscoveryCoverage(covA, truncatedDiscovery, 0);
    check("truncated=true → lineageTotal=95", () => assert.equal(covA.lineageTotal, 95));
    check("truncated=true → sessionsAnalyzed=50", () => assert.equal(covA.sessionsAnalyzed, 50));
    check("truncated=true → sessionsTruncated=true", () => assert.equal(covA.sessionsTruncated, true));
    check("truncated=true → samplingNote 只存规则（不含数量，数量归渲染层拼）", () => {
      assert.equal(covA.samplingNote, "按创建时间倒序取最新");
    });
    check("P2-1：truncated=true → gaps 不被污染（截断说明只走 samplingNote）", () => {
      assert.deepEqual(covA.gaps, []);
    });
    check("complete 不被改动", () => assert.equal(covA.complete, true));

    const fullDiscovery: ChildDiscovery = { ids: makeChildren(50).map(c => c.id), total: 50, truncated: false, source: "trace" };
    const covB: any = { throughSeq: {}, complete: true, gaps: [], inputTruncated: false };
    applyDiscoveryCoverage(covB, fullDiscovery, 0);
    check("truncated=false → sessionsTruncated=false", () => assert.equal(covB.sessionsTruncated, false));
    check("truncated=false → samplingNote 为空", () => assert.equal(covB.samplingNote, undefined));
    check("truncated=false → gaps 为空", () => assert.deepEqual(covB.gaps, []));
    check("truncated=false → sessionsAnalyzed === lineageTotal", () => {
      assert.equal(covB.sessionsAnalyzed, covB.lineageTotal);
    });
  }

  // ---- 用例 9：部分读失败 → sessionsAnalyzed < ids.length ----
  console.log("===== 用例 9：部分读失败 =====");
  {
    const d: ChildDiscovery = { ids: makeChildren(50).map(c => c.id), total: 95, truncated: true, source: "trace" };
    const cov: any = { throughSeq: {}, complete: true, gaps: [], inputTruncated: false };
    applyDiscoveryCoverage(cov, d, 3);
    check("sessionsAnalyzed = 50 - 3 = 47（< ids.length）", () => {
      assert.equal(cov.sessionsAnalyzed, 47);
      assert.ok(cov.sessionsAnalyzed < d.ids.length);
    });
    check("读取失败数不吃掉 lineageTotal", () => assert.equal(cov.lineageTotal, 95));
    check("两场景并存时 samplingNote 同时说明取样与读失败（仍不含数量）", () => {
      assert.equal(cov.samplingNote, "按创建时间倒序取最新，且存在读取失败的子会话");
    });
    check("P2-1：读失败也不 push 进 gaps", () => assert.deepEqual(cov.gaps, []));
    check("失败数超过取样数时 sessionsAnalyzed 夹到 0", () => {
      const cov2: any = { gaps: [] };
      applyDiscoveryCoverage(cov2, { ids: ["a", "b"], total: 10, truncated: true, source: "list" }, 5);
      assert.equal(cov2.sessionsAnalyzed, 0);
    });
  }

  // ---- 用例 10（P1-2）：无取样截断但有读失败 → sessionsTruncated 必须为 true ----
  console.log("===== 用例 10（P1-2）：total=50/ids=50/读失败 3 =====");
  {
    const d: ChildDiscovery = { ids: makeChildren(50).map(c => c.id), total: 50, truncated: false, source: "trace" };
    const cov: any = { throughSeq: {}, complete: true, gaps: [], inputTruncated: false };
    applyDiscoveryCoverage(cov, d, 3);
    check("discovery.truncated=false（无取样截断）", () => assert.equal(d.truncated, false));
    check("sessionsAnalyzed=47", () => assert.equal(cov.sessionsAnalyzed, 47));
    check("sessionsTruncated=true（按 sessionsAnalyzed < lineageTotal 派生，不再信 truncated）", () => {
      assert.equal(cov.sessionsTruncated, true);
    });
    check("samplingNote 只说读失败（不含取样说明）", () => {
      assert.equal(cov.samplingNote, "存在读取失败的子会话");
    });
    check("契约：sessionsTruncated === (sessionsAnalyzed < lineageTotal)", () => {
      assert.equal(cov.sessionsTruncated, cov.sessionsAnalyzed < cov.lineageTotal);
    });
    // 全部读成功时契约仍成立
    const covOk: any = { gaps: [] };
    applyDiscoveryCoverage(covOk, d, 0);
    check("全读成功 → sessionsTruncated=false，samplingNote=undefined", () => {
      assert.equal(covOk.sessionsTruncated, false);
      assert.equal(covOk.samplingNote, undefined);
      assert.deepEqual(covOk.gaps, []);
    });
  }

  // ---- 用例 11（P2-2）：根 id 带 session- 前缀、子会话裸 uuid（真实磁盘形态）----
  console.log("===== 用例 11（P2-2）：根带 session- 前缀 + 子裸 uuid =====");
  {
    const ROOT = "session-e6c5c248-4713-4c16-a8ab-e838dc33a7d8";
    const kids = [
      { id: "11111111-1111-4111-8111-111111111111", createdAt: 1001 },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: 1002 },
    ];
    // trace 树里（防御性）也带上根节点本身，形态与 rootId 不同 → 必须被去根
    const traceTree = {
      session: { header: { id: ROOT, createdAt: 0 } },
      descendants: [
        { session: { id: "e6c5c248-4713-4c16-a8ab-e838dc33a7d8", header: { createdAt: 0 } }, descendants: [] },
        ...kids.map(k => ({ session: { id: k.id, parentSession: ROOT, header: { id: k.id, createdAt: k.createdAt } }, descendants: [] })),
      ],
    };
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      sessionQuery: {
        traceSession: async () => traceTree,
        listSessions: async () => [
          { header: { id: ROOT, createdAt: 0 } },
          ...kids.map(k => ({ header: { id: k.id, parentSession: ROOT, createdAt: k.createdAt } })),
        ],
      },
    };
    const t = await discover(ctx, ROOT);
    await checkAsync("trace 路径：去根按归一化比较 → total=2（不多算根）", async () => {
      assert.equal(t.total, 2);
      assert.deepEqual(t.ids.slice().sort(), kids.map(k => k.id).sort());
    });
    const ctxList = { ...ctx, sessionQuery: { traceSession: async () => { throw new Error("no trace"); }, listSessions: ctx.sessionQuery.listSessions } };
    const l = await discover(ctxList, ROOT);
    await checkAsync("list 路径：parentSession 匹配归一化 → total=2（不误报 0）", async () => {
      assert.equal(l.total, 2);
      assert.equal(l.ids.length, 2);
    });
    // 反向：根是裸 uuid，但节点带 session- 前缀
    const BARE = "e6c5c248-4713-4c16-a8ab-e838dc33a7d8";
    const prefixed = "session-" + BARE;
    const ctxRev = {
      logger: { warn: () => {}, info: () => {} },
      sessionQuery: {
        traceSession: async () => ({
          descendants: [{ session: { id: prefixed, header: { createdAt: 0 } }, descendants: [] },
                        { session: { id: "kid-a", header: { id: "kid-a", createdAt: 5 } }, descendants: [] }],
        }),
        listSessions: async () => [
          { header: { id: prefixed, createdAt: 0 } },
          { header: { id: "kid-a", parentSession: prefixed, createdAt: 5 } },
        ],
      },
    };
    const r = await discover(ctxRev, BARE);
    await checkAsync("反向（根裸 uuid / 节点带前缀）：trace 去根 + list 匹配都对", async () => {
      assert.equal(r.total, 1);
      assert.deepEqual(r.ids, ["kid-a"]);
      const rl = await discover({ ...ctxRev, sessionQuery: { traceSession: async () => { throw new Error("x"); }, listSessions: ctxRev.sessionQuery.listSessions } }, BARE);
      assert.equal(rl.total, 1);
      assert.deepEqual(rl.ids, ["kid-a"]);
    });
    await checkAsync("normalizeSessionId 只剥前缀、不做其他改写", async () => {
      assert.equal(normalizeSessionId("session-abc"), "abc");
      assert.equal(normalizeSessionId("abc"), "abc");
      assert.equal(normalizeSessionId(undefined), "");
      assert.equal(normalizeSessionId("session-session-x"), "session-x");
    });
  }

  // ---- 用例 12（P1-1）：updateIndex 调用点必须传 lineageTotal / sessionsTruncated ----
  // runAnalysisInner 未导出，构造完整流程成本过高，这里做**源码静态断言**：
  // 逐个检查 review-command.ts 里每个 updateIndex({...}) 调用块是否带上了两个字段。
  console.log("===== 用例 12（P1-1）：updateIndex 接线 =====");
  {
    const src = readFileSync(new URL("../src/review-command.ts", import.meta.url), "utf8");
    /** 从 `updateIndex({` 开始按括号配平截出整个入参块 */
    const blocks: string[] = [];
    let idx = src.indexOf("updateIndex({");
    while (idx !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = idx + "updateIndex".length; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) blocks.push(src.slice(idx, end + 1));
      idx = src.indexOf("updateIndex({", idx + 1);
    }
    check("源码里至少有两处 updateIndex 调用（成功路径 + 失败路径）", () => {
      assert.ok(blocks.length >= 2, "实际 " + blocks.length + " 处");
    });
    check("成功路径的 updateIndex 传了 lineageTotal", () => {
      const ok = blocks.find(b => b.includes("report-") || b.includes("jsonOk") || b.includes("copy.path"));
      assert.ok(ok, "未找到成功路径调用块");
      assert.ok(ok!.includes("lineageTotal: report.coverage.lineageTotal"), "成功路径缺 lineageTotal");
    });
    check("成功路径的 updateIndex 传了 sessionsTruncated", () => {
      const ok = blocks.find(b => b.includes("report-") || b.includes("jsonOk") || b.includes("copy.path"));
      assert.ok(ok!.includes("sessionsTruncated: report.coverage.sessionsTruncated"), "成功路径缺 sessionsTruncated");
    });
    check("失败路径显式传 undefined（不编造 coverage）", () => {
      const bad = blocks.find(b => b.includes('status: "failed"'));
      assert.ok(bad, "未找到失败路径调用块");
      assert.ok(bad!.includes("lineageTotal: undefined"), "失败路径应显式传 lineageTotal: undefined");
      assert.ok(bad!.includes("sessionsTruncated: undefined"), "失败路径应显式传 sessionsTruncated: undefined");
    });
    check("ReviewIndexEntry 类型声明含两个新字段", () => {
      const tsrc = readFileSync(new URL("../src/review-index.ts", import.meta.url), "utf8");
      const at = tsrc.indexOf("export interface ReviewIndexEntry");
      assert.ok(at !== -1, "未找到 ReviewIndexEntry");
      const block = tsrc.slice(at, tsrc.indexOf("}", at));
      assert.ok(block.includes("lineageTotal"), "入参类型缺 lineageTotal");
      assert.ok(block.includes("sessionsTruncated"), "入参类型缺 sessionsTruncated");
    });
  }

  // ---- 补充：sampleNewest 纯函数直接验证 ----
  console.log("===== 补充：sampleNewest 排序语义 =====");
  check("createdAt 降序（最新在前）", () => {
    const ids = sampleNewest([
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 300 },
      { id: "c", createdAt: 200 },
    ], 3);
    assert.deepEqual(ids, ["b", "c", "a"]);
  });
  check("createdAt=0（取不到时间）沉底", () => {
    const ids = sampleNewest([
      { id: "missing", createdAt: 0 },
      { id: "has", createdAt: 42 },
    ], 2);
    assert.deepEqual(ids, ["has", "missing"]);
  });
  check("limit=0 返回空数组", () => {
    assert.deepEqual(sampleNewest([{ id: "a", createdAt: 1 }], 0), []);
  });

  console.log("");
  const allOk = fail === 0;
  console.log("结果: " + pass + " PASS / " + fail + " FAIL");
  console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
  process.exit(allOk ? 0 : 1);
}

void main();
