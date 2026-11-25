// dsh-cohub/test/preset-runtime.ts —— 档位 preset **运行时注册**单测（mock ctx，无需 LLM）
//
// 覆盖（对应运行时注册的四条不变式）：
//   ① 空注册表 → 包内全部 preset 都注册（含 5 个档位）；
//   ② 已存在同 id → 先 unregister 再 register（调用序列断言，保证幂等）；
//   ③ 某个 register 抛错 → 其余档位仍注册完成 + 一条 warn（fail-soft）；
//   ④ dispose → 全部 unregister（插件卸载不留登记）。
// 另覆盖：YAML → 对象 的一致性（plugins 条数 / Shell 行 / !!js 求值 / persona 块标量）。
//
// 用法：bun run build && node test/preset-runtime.ts（node >= 24）
import { fileURLToPath } from "node:url";
// lib/ 是 bun 产物（无 .d.ts），在产物边界按 any 使用；类型正确性由 bun run typecheck:src 覆盖
import * as libBuild from "../lib/index.js";
const {
  registerCohubPresets,
  unregisterCohubPresets,
  loadCohubPresetDefs,
  parseMiniYaml,
  evaluatePlatformExpr,
  COHUB_PRESETS_DIR,
}: any = libBuild;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++;
  else fail++;
}

/** 5 个档位（子代理工具面）+ 2 个主代理 preset = 包内 6 个目录 */
const TIER_PRESETS = [
  "cohub-subagent-readonly",
  "cohub-subagent-readonly-net",
  "cohub-subagent-write",
  "cohub-subagent-write-shell",
  "cohub-cordis",
];
const MAIN_PRESETS = ["co-orchestrator"];

/** mock agentPresets 注册表：记录调用序列，可注入「已存在」与「注册抛错」 */
function makeRegistry(options: { failOn?: string[]; existing?: string[] } = {}) {
  const calls: string[] = [];
  const registered = new Map<string, { unregister: () => void }>();
  const failOn = new Set(options.failOn ?? []);
  for (const id of options.existing ?? []) {
    registered.set(id, {
      unregister: () => {
        calls.push(`unregister:${id}`);
        registered.delete(id);
      },
    });
  }
  return {
    calls,
    registered,
    /** registry.get(id)：宿主用它取已注册条目（本 mock 与真实服务的形状一致） */
    get(id: string) {
      calls.push(`get:${id}`);
      return registered.get(id);
    },
    async register(def: any) {
      calls.push(`register:${def.id}`);
      if (failOn.has(def.id)) throw new Error(`mock register failure: ${def.id}`);
      const handle = () => {
        calls.push(`unregister:${def.id}`);
        registered.delete(def.id);
      };
      registered.set(def.id, { unregister: handle });
      return handle;
    },
  };
}

function makeCtx(registry: any) {
  return {
    // 走 reflect.get 的非强校验通道（插件 inject 里没有 agentPresets）
    reflect: { get: (name: string) => (name === "agentPresets" ? registry : undefined) },
    logger: undefined as any,
  };
}

function makeLogger() {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    warn: (...args: any[]) => warns.push(String(args[0] ?? "")),
    info: (...args: any[]) => infos.push(String(args[0] ?? "")),
  };
}

// ── 前置：解析层一致（注册参数就是从这些文件来的）────────────────────────────
console.log("===== 0：YAML → 对象 一致性 =====");
const defs: any[] = loadCohubPresetDefs(COHUB_PRESETS_DIR);
const defIds = defs.map((def) => def.id);
check("解析出 6 个 preset 目录", defs.length === 6);
check("5 个档位都在", TIER_PRESETS.every((id) => defIds.includes(id)));
check("主代理 preset 在", MAIN_PRESETS.every((id) => defIds.includes(id)));
check("每个 def 的 plugins 是非空数组", defs.every((def) => Array.isArray(def.plugins) && def.plugins.length > 0));

/** mock 里使用的 register 参数样例（与 presets/<id>/agent.cordis.yml 逐项对齐） */
const sampleWrite: any = defs.find((def) => def.id === "cohub-subagent-write");
const writeIds = sampleWrite.plugins.map((line: any) => line.id);
console.log(
  "  样例 register 参数：",
  JSON.stringify({
    id: sampleWrite.id,
    name: sampleWrite.name,
    order: sampleWrite.order,
    plugins: sampleWrite.plugins.length,
    pluginIds: writeIds,
  }),
);
check("cohub-subagent-write 有 10 行 plugins", sampleWrite.plugins.length === 10);
check("cohub-subagent-write 含 Shell 行 tool-pwsh", writeIds.includes("tool-pwsh"));
check("cohub-subagent-write 含 Shell 行 tool-bash", writeIds.includes("tool-bash"));
check("name 来自 preset.yml（非目录名）", sampleWrite.name.includes("CoHub 子代理·可写"));
check("description 来自 preset.yml", typeof sampleWrite.description === "string" && sampleWrite.description.length > 0);

// nested group / isolate / 块标量：cohub-cordis 的 compaction group 与 persona prefix
const cordis: any = defs.find((def) => def.id === "cohub-cordis");
const compaction = cordis.plugins.find((line: any) => line.id === "compaction");
check("group 行解析出 isolate.compaction", compaction?.isolate?.compaction === true);
check("group 行解析出 config 子序列", Array.isArray(compaction?.config) && compaction.config.length === 3);
const persona = cordis.plugins.find((line: any) => line.id === "persona");
check("块标量 |- 保留了多行正文", typeof persona?.config?.prefix === "string" && persona.config.prefix.split("\n").length > 5);
check("块标量正文里的 # 未被当注释剥掉", persona.config.prefix.includes("#"));

// !!js：按当前平台求值成真布尔（win32 → bash 禁用、pwsh 启用）
const winDefs: any[] = defs;
const writeBash = winDefs.find((def) => def.id === "cohub-subagent-write")!.plugins.find((l: any) => l.id === "tool-bash");
const writePwsh = winDefs.find((def) => def.id === "cohub-subagent-write")!.plugins.find((l: any) => l.id === "tool-pwsh");
check("!!js 已求值为布尔（bash）", typeof writeBash?.disabled === "boolean");
check("!!js 已求值为布尔（pwsh）", typeof writePwsh?.disabled === "boolean");
check("win32 语义：bash 禁用 / pwsh 启用", process.platform !== "win32" || (writeBash.disabled === true && writePwsh.disabled === false));
check("evaluatePlatformExpr 支持 === / !==", evaluatePlatformExpr("process.platform === 'win32'", "win32") === true
  && evaluatePlatformExpr("process.platform !== 'win32'", "linux") === true);
check("evaluatePlatformExpr 无法识别时返回 undefined", evaluatePlatformExpr("Date.now()") === undefined);
check("mini YAML：注释行被忽略", deepEqual(parseMiniYaml("# c\nkey: 1\n"), { key: 1 }));

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── ① 空注册表 → 全部注册 ──────────────────────────────────────────────────
console.log("===== ① 空注册表 → 5 个档位（含主代理）都注册 =====");
const r1 = makeRegistry();
const logger1 = makeLogger();
const ctx1 = makeCtx(r1);
ctx1.logger = logger1;
const result1 = await registerCohubPresets(ctx1, logger1);
check("registered 共 6 个", result1.registered.length === 6);
check("failed 为空", result1.failed.length === 0);
check("5 个档位都进了注册表", TIER_PRESETS.every((id) => r1.registered.has(id)));
check("register 调用 6 次", r1.calls.filter((c) => c.startsWith("register:")).length === 6);
check("首轮不带任何 unregister（无旧注册）", r1.calls.every((c) => !c.startsWith("unregister:")));

// ── ② 已存在同 id → 先 unregister 再 register ─────────────────────────────
console.log("===== ② 已存在同 id → 先 unregister 再 register（幂等） =====");
const r2 = makeRegistry({ existing: ["cohub-subagent-write-shell"] });
const logger2 = makeLogger();
const ctx2 = makeCtx(r2);
ctx2.logger = logger2;
const result2 = await registerCohubPresets(ctx2, logger2);
const writeShellSeq = r2.calls.filter((c) => c.endsWith(":cohub-subagent-write-shell"));
check("registered 仍含 cohub-subagent-write-shell", result2.registered.includes("cohub-subagent-write-shell"));
check(
  "调用序列 = get → unregister → register",
  deepEqual(writeShellSeq, ["get:cohub-subagent-write-shell", "unregister:cohub-subagent-write-shell", "register:cohub-subagent-write-shell"]),
);
check("unregister 在 register 之前", r2.calls.indexOf("unregister:cohub-subagent-write-shell") < r2.calls.indexOf("register:cohub-subagent-write-shell"));
check("没有档位注册失败", result2.failed.length === 0);

// ── ③ 某个 register 抛错 → 其余 4 个档位仍完成 + warn ──────────────────────
console.log("===== ③ 单个档位注册抛错 → 其余档位继续 + warn =====");
const r3 = makeRegistry({ failOn: ["cohub-subagent-write"] });
const logger3 = makeLogger();
const ctx3 = makeCtx(r3);
ctx3.logger = logger3;
const result3 = await registerCohubPresets(ctx3, logger3);
check("failed 含 cohub-subagent-write", result3.failed.includes("cohub-subagent-write"));
check("其余 4 个档位仍注册完成", TIER_PRESETS.filter((id) => id !== "cohub-subagent-write").every((id) => result3.registered.includes(id)));
check("registered 共 5 个（6 - 1）", result3.registered.length === 5);
check("产生了一条 warn", logger3.warns.some((line) => line.includes("cohub-subagent-write")));
check("失败不抛（fail-soft）", true);

// ── ④ dispose → 全部 unregister ───────────────────────────────────────────
console.log("===== ④ 插件卸载 → 全部 unregister =====");
const removed4 = unregisterCohubPresets(ctx3, logger3);
check("卸载数量 = 已注册数量（5）", removed4.length === 5);
check("每个已注册 id 都被 unregister", result3.registered.every((id: string) => r3.calls.includes(`unregister:${id}`)));
check("注册表回到空", r3.registered.size === 0);
check("重复卸载是幂等的（第二次为空）", unregisterCohubPresets(ctx3, logger3).length === 0);

// ── ⑤ 缺少 agentPresets 服务 → 不抛（fail-soft，回退 patch 声明）───────────
console.log("===== ⑤ 无 agentPresets 服务 → 不抛 =====");
const logger5 = makeLogger();
const result5 = await registerCohubPresets({}, logger5);
check("registered 为空", result5.registered.length === 0);
check("failed 为空（不算失败，走 patch 兜底）", result5.failed.length === 0);
check("info 提示回退 patch", logger5.infos.some((line) => line.includes("agentPresets")));

console.log("");
console.log(`=== preset-runtime：PASS ${pass}，FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
