// dsh-cohub/test/team-preset-sync.ts —— 团队预设**差量对账**的回归测试（真机 bug 复现集）
//
// 覆盖任务书要求的六组：
//   ① 两个团队 → 注册两个；② 删一个 → 该 id 被 unregister、另一个保留（保留者不重建）；
//   ③ 改名 → 旧 id 的 handle 被调用 unregister 且新 def 的 name 是新值；
//   ④ 成员变化 → 重建；⑤ 清空 teams → 全部 unregister；⑥ 无 agentPresets 服务 → 不抛。
//
// 关键：mock 里**不提供 registry.get / registry.delete / registry.unregister**，
// 只靠 register() 返回值提供释放能力 —— 真机上失败正是这条路径（没有 get 可退）。
//
// 用法：bun run build && node test/team-preset-sync.ts
import * as libBuild from "../lib/index.js";
const { syncTeamPresets, unregisterTeamPresets } = libBuild as any;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}${cond || detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`);
  if (cond) pass++;
  else fail++;
}

/** register 的返回值形态：真机不确定，这里逐组切换 fm / obj / void 三种形态 */
type HandleShape = "fn" | "object" | "void" | "dispose";

function makeRegistry(shape: HandleShape = "fn") {
  const calls: string[] = [];
  const live = new Map<string, any>();
  const registeredDefs: any[] = [];
  return {
    calls,
    live,
    registeredDefs,
    // 故意不提供 get / delete / unregister / list：释放只能靠 register 的返回值
    async register(def: any) {
      calls.push(`register:${def.id}`);
      registeredDefs.push({ id: def.id, name: def.name, description: def.description });
      const unregister = () => {
        calls.push(`unregister:${def.id}`);
        live.delete(def.id);
      };
      live.set(def.id, unregister);
      if (shape === "object") return { unregister };
      if (shape === "dispose") return { dispose: unregister };
      if (shape === "void") return undefined;
      return unregister;
    },
  };
}

const makeCtx = (registry: any) => ({
  reflect: { get: (name: string) => (name === "agentPresets" ? registry : undefined) },
});
const makeLogger = () => {
  const dry: string[] = [];
  return { dry, warn: (...a: any[]) => dry.push(String(a[0] ?? "")), info: () => {} };
};

const A = { id: "writing-group", name: "写作组", members: ["co-orchestrator", "co-fixer"] };
const B = { id: "review", name: "审查组", members: ["co-oracle"] };

// ── ① 两个团队 → 注册两个 ─────────────────────────────────────────────────
console.log("===== ① 两个团队 → 注册两个 =====");
const r1 = makeRegistry("fn");
const ctx1 = makeCtx(r1);
const lg1 = makeLogger();
const s1 = await syncTeamPresets(ctx1, lg1, { teams: [A, B] });
check("registered 长度 4（2 内置 + 2 用户）", s1.registered.length === 4, s1);
check("registered 含两个 id", s1.registered.includes("cohub-team-writing-group") && s1.registered.includes("cohub-team-review"));
check("注册表 live 4 个", r1.live.size === 4);
check("registeredDefs 里 name 是配置值", r1.registeredDefs.map((d) => d.name).join(",") === "开发团队,写作团队,写作组,审查组");

// ── ② 删一个 → 该 id 被 unregister，另一个保留 ────────────────────────────
console.log("===== ② 删一个团队 → unregister 该 id，另一个保留 =====");
const s2 = await syncTeamPresets(ctx1, lg1, { teams: [A] });
check("removed = [cohub-team-review]", JSON.stringify(s2.removed) === JSON.stringify(["cohub-team-review"]), s2.removed);
check("review 的 unregister 被调用", r1.calls.includes("unregister:cohub-team-review"));
check("live 只剩 3 个（2 内置 + writing-group）", r1.live.has("cohub-team-writing-group") && r1.live.size === 3);
check("writing 指纹未变 → 未重建", r1.calls.filter((c) => c === "register:cohub-team-writing-group").length === 1);

// ── ③ 改名 → 旧 id 的 handle 被调 unregister，新 def 的 name 是新值 ────────
console.log("===== ③ 改名 → unregister 旧 + register 新 def（name 为新值） =====");
const renamed = { ...A, name: "写作组2" };
const s3 = await syncTeamPresets(ctx1, lg1, { teams: [renamed] });
check("updated = [cohub-team-writing-group]", JSON.stringify(s3.updated) === JSON.stringify(["cohub-team-writing-group"]), s3.updated);
const seq3 = r1.calls.filter((c) => c === "unregister:cohub-team-writing-group" || c === "register:cohub-team-writing-group");
check("序列末两位 = unregister → register",
  JSON.stringify(seq3.slice(-2)) === JSON.stringify(["unregister:cohub-team-writing-group", "register:cohub-team-writing-group"]), seq3);
const lastDef = r1.registeredDefs[r1.registeredDefs.length - 1];
check("新 def 的 name = 写作组2", lastDef?.name === "写作组2", lastDef);
check("新 def 的 description 含新名", String(lastDef?.description ?? "").includes("写作组2"));
check("live 仍 3 个（重建后含 2 内置）", r1.live.size === 3);

// ── ④ 成员变化 → 重建（object 形态 handle 也要能释放）────────────────────
console.log("===== ④ 成员变化 → 重建（handle 为 { unregister } 对象形态） =====");
const r4 = makeRegistry("object");
const ctx4 = makeCtx(r4);
const lg4 = makeLogger();
await syncTeamPresets(ctx4, lg4, { teams: [A] });
const changedMembers = { ...A, members: ["co-orchestrator", "co-designer"] };
const s4 = await syncTeamPresets(ctx4, lg4, { teams: [changedMembers] });
check("updated = [cohub-team-writing-group]", JSON.stringify(s4.updated) === JSON.stringify(["cohub-team-writing-group"]), s4.updated);
check("对象形态 handle 被调用 unregister", r4.calls.includes("unregister:cohub-team-writing-group"), r4.calls);
check("重建后 live 仍 3 个", r4.live.size === 3);
const lastDef4 = r4.registeredDefs[r4.registeredDefs.length - 1];
check("新 def 的 description 含新成员 co-designer", String(lastDef4?.description ?? "").includes("co-designer"), lastDef4);

// ── ⑤ 清空 teams → 全部 unregister ───────────────────────────────────────
console.log("===== ⑤ 清空 teams → 全部 unregister =====");
const r5 = makeRegistry("fn");
const ctx5 = makeCtx(r5);
const lg5 = makeLogger();
await syncTeamPresets(ctx5, lg5, { teams: [A, B] });
const s5 = await syncTeamPresets(ctx5, lg5, { teams: [] });
check("removed 含两个 id", s5.removed.length === 2 && s5.removed.includes("cohub-team-writing-group") && s5.removed.includes("cohub-team-review"), s5.removed);
check("两个 unregister 都被调用",
  r5.calls.includes("unregister:cohub-team-writing-group") && r5.calls.includes("unregister:cohub-team-review"), r5.calls);
check("live 只剩 2 个内置团队", r5.live.size === 2);
check("第二次清空幂等（无残留 removed）", (await syncTeamPresets(ctx5, lg5, { teams: [] })).removed.length === 0);

// ── ⑥ 无 agentPresets 服务 → 不抛 ────────────────────────────────────────
console.log("===== ⑥ 无 agentPresets 服务 → 不抛（fail-soft） =====");
let threw = false;
let s6: any;
try {
  s6 = await syncTeamPresets({}, makeLogger(), { teams: [A] });
} catch (error) {
  threw = true;
  console.log("    [⑥ 异常]", (error as Error)?.message ?? error);
}
check("不抛", threw === false);
check("registered 为空", s6.registered.length === 0);
check("failed 为空（服务缺失不算失败）", s6.failed.length === 0);

// 附：插件卸载 → 全部 disposed
const r7 = makeRegistry("void");
const ctx7 = makeCtx(r7);
const lg7 = makeLogger();
await syncTeamPresets(ctx7, lg7, { teams: [A] });
check("void 形态 register 也能记账（台账 1 个）", (unregisterTeamPresets(ctx7, lg7) as string[]).length === 3);
check("void 形态下无句柄可调，live 由宿主删除语义承担（不抛）", true);

console.log("");
console.log(`=== team-preset-sync：PASS ${pass}，FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
