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
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// lib/ 是 bun 产物（无 .d.ts），在产物边界按 any 使用；类型正确性由 bun run typecheck:src 覆盖
import * as libBuild from "../lib/index.js";
const {
  registerCohubPresets,
  unregisterCohubPresets,
  loadCohubPresetDefs,
  parseMiniYaml,
  evaluatePlatformExpr,
  materializeJsTags,
  assertCustomSkillDirs,
  COHUB_PRESETS_DIR,
  TEAM_OWNED_PRESET_IDS,
}: any = libBuild;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++;
  else fail++;
}

/**
 * 全部档位预设（4 个子代理档位 + cohub-cordis）。
 * 每个档位必须挂独立 preset：persona 只能由 preset 提供，tools.restrict 裁不掉 persona。
 */
const TIER_PRESETS = [
  "cohub-subagent-readonly",
  "cohub-subagent-readonly-net",
  "cohub-subagent-write",
  "cohub-subagent-write-shell",
  "cohub-cordis",
];
/** 由团队注册接管的 preset（不参与档位注册）：co-orchestrator —— team-presets.ts 以「开发团队」名义注册 */
const TEAM_OWNED_PRESETS = ["co-orchestrator"];

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
check("解析出 5 个档位 preset（4 个子代理档位 + cohub-cordis）", defs.length === 5);
check("5 个档位全部解析出来", TIER_PRESETS.every((id) => defIds.includes(id)));
check("co-orchestrator 由团队接管（不在档位列表）", !defIds.includes("co-orchestrator"));
check("4 个档位子代理恢复注册（readonly / readonly-net / write / write-shell）",
  ["cohub-subagent-readonly", "cohub-subagent-readonly-net", "cohub-subagent-write", "cohub-subagent-write-shell"]
    .every((id) => defIds.includes(id)));
check("TEAM_OWNED_PRESET_IDS 恰好是 [co-orchestrator]", (() => {
  const owned: string[] = [...(TEAM_OWNED_PRESET_IDS as string[])].sort();
  return JSON.stringify(owned) === JSON.stringify([...TEAM_OWNED_PRESETS].sort());
})());
check("每个 def 的 plugins 是非空数组", defs.every((def) => Array.isArray(def.plugins) && def.plugins.length > 0));

/** 写类档位 preset：文件即注册事实源，这里直接解析 YAML 断言工具面 */
const writePluginsRaw: any[] = parseMiniYaml(
  readFileSync(join(COHUB_PRESETS_DIR, "cohub-subagent-write", "agent.cordis.yml"), "utf8"),
) as any[];
const writeIds = writePluginsRaw.map((line: any) => line.id);
console.log("  样例：", JSON.stringify({ id: "cohub-subagent-write", pluginIds: writeIds }));
check("cohub-subagent-write 的 YAML 有 10 行 plugins", writePluginsRaw.length === 10);
check("cohub-subagent-write 含 Shell 行 tool-pwsh", writeIds.includes("tool-pwsh"));
check("cohub-subagent-write 含 Shell 行 tool-bash", writeIds.includes("tool-bash"));
check("cordis 档位仍带 name/description（preset.yml）",
  typeof defs.find((def) => def.id === "cohub-cordis")?.name === "string"
  && typeof defs.find((def) => def.id === "cohub-cordis")?.description === "string");

// nested group / isolate / 块标量：cohub-cordis 的 compaction group 与 persona prefix
const cordis: any = defs.find((def) => def.id === "cohub-cordis");
const compaction = cordis.plugins.find((line: any) => line.id === "compaction");
check("group 行解析出 isolate.compaction", compaction?.isolate?.compaction === true);
check("group 行解析出 config 子序列", Array.isArray(compaction?.config) && compaction.config.length === 3);
const persona = cordis.plugins.find((line: any) => line.id === "persona");
check("块标量 |- 保留了多行正文", typeof persona?.config?.prefix === "string" && persona.config.prefix.split("\n").length > 5);
check("块标量正文里的 # 未被当注释剥掉", persona.config.prefix.includes("#"));

// ── customSkillDirs：`!!js "fileURLToPath(new URL('skills/', baseUrl))"` 必须求值成字符串绝对路径 ──
// 旧行为：序列项里的 `node:url` 冒号让整行被误切成映射 → customSkillDirs[0] 是对象 →
// skill-filesystem 配校验失败（`$.customSkillDirs[0] expected string but got [object Object]`）。
const skillFs = cordis.plugins.find((line: any) => line.id === "skill-filesystem");
const customSkillDirs = skillFs?.config?.customSkillDirs;
const presetDir = join(COHUB_PRESETS_DIR, "cohub-cordis");
const expectedSkillsDir = resolve(presetDir, "skills");
console.log("  实际解析出的 customSkillDirs：", JSON.stringify(customSkillDirs));
check(
  "skill-filesystem.customSkillDirs 是字符串数组",
  Array.isArray(customSkillDirs) && customSkillDirs.length === 1
    && customSkillDirs.every((entry: any) => typeof entry === "string"),
);
check(
  "customSkillDirs[0] = preset 目录下的 skills 绝对路径",
  Array.isArray(customSkillDirs) && resolve(String(customSkillDirs[0])) === expectedSkillsDir,
);
check(
  "customSkillDirs[0] 指向真实存在的目录",
  Array.isArray(customSkillDirs) && existsSync(String(customSkillDirs[0])),
);

// ── 无法识别的 `!!js` → warn + 丢弃，绝不产生非字符串值 ──────────────────────
const dropLogger = makeLogger();
const dropParsed = materializeJsTags(
  parseMiniYaml([
    "- id: skill-filesystem",
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    "  config:",
    "    customSkillDirs:",
    '      - !!js "process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'skills/\', baseUrl))"',
    "      - !!js someUnknownCall(1)",
    "- id: tool-bash",
    "  name: '@deepseek-ai/dsh-tool-bash'",
    "  disabled: !!js someUnknownCall(2)",
  ].join("\n")),
  dropLogger,
  process.platform,
  "plugins",
  presetDir,
) as any[];
const dropSkillFs = dropParsed.find((line: any) => line.id === "skill-filesystem");
const dropDirs = dropSkillFs?.config?.customSkillDirs;
const dropBash = dropParsed.find((line: any) => line.id === "tool-bash");
check(
  "无法识别的 !!js 数组项被丢弃（customSkillDirs 仍是纯字符串数组）",
  Array.isArray(dropDirs) && dropDirs.length === 1 && typeof dropDirs[0] === "string"
    && !JSON.stringify(dropDirs).includes("{"),
);
check(
  "无法识别的 !!js 映射值不落进配置（disabled 键被丢弃，不传对象/原串）",
  dropBash !== undefined && !("disabled" in dropBash),
);
check("丢弃时产生了 warn", dropLogger.warns.some((line: string) => line.includes("无法求值")));

// 注册前兜底断言：对象项被剔除、字符串项保留
const guardInput = [{
  id: "skill-filesystem",
  name: "@deepseek-ai/dsh-skill-filesystem",
  config: { customSkillDirs: [{ bad: 1 }, expectedSkillsDir] },
}];
const guardLogger = makeLogger();
assertCustomSkillDirs(guardInput as any, guardLogger);
check(
  "assertCustomSkillDirs 剔除对象项、保留字符串项",
  deepEqual(guardInput[0]!.config.customSkillDirs, [expectedSkillsDir]) && guardLogger.warns.length === 1,
);

// !!js：文件里保留 `!!js <expr>`，按当前平台求值成真布尔（win32 → bash 禁用、pwsh 启用）
const bashExpr = typeof writePluginsRaw.find((l: any) => l.id === "tool-bash")?.disabled === "string"
  ? (writePluginsRaw.find((l: any) => l.id === "tool-bash")!.disabled as string).replace(/^!!js\s+/, "")
  : undefined;
const pwshExpr = typeof writePluginsRaw.find((l: any) => l.id === "tool-pwsh")?.disabled === "string"
  ? (writePluginsRaw.find((l: any) => l.id === "tool-pwsh")!.disabled as string).replace(/^!!js\s+/, "")
  : undefined;
check("!!js 表达式可被识别（bash / pwsh 都是 process.platform 比较）",
  typeof bashExpr === "string" && typeof pwshExpr === "string");
check("!!js 已求值为布尔", typeof evaluatePlatformExpr(bashExpr) === "boolean"
  && typeof evaluatePlatformExpr(pwshExpr) === "boolean");
check("win32 语义：bash 禁用 / pwsh 启用",
  process.platform !== "win32" || (evaluatePlatformExpr(bashExpr) === true && evaluatePlatformExpr(pwshExpr) === false));
check("evaluatePlatformExpr 支持 === / !==", evaluatePlatformExpr("process.platform === 'win32'", "win32") === true
  && evaluatePlatformExpr("process.platform !== 'win32'", "linux") === true);
check("evaluatePlatformExpr 无法识别时返回 undefined", evaluatePlatformExpr("Date.now()") === undefined);
check("mini YAML：注释行被忽略", deepEqual(parseMiniYaml("# c\nkey: 1\n"), { key: 1 }));

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── ① 空注册表 → 注册 5 个档位（+团队注册的 co-orchestrator 共 6） ────────────
console.log("===== ① 空注册表 → 5 个档位注册（+团队注册的 co-orchestrator 共 6） =====");
const r1 = makeRegistry();
const logger1 = makeLogger();
const ctx1 = makeCtx(r1);
ctx1.logger = logger1;
const result1 = await registerCohubPresets(ctx1, logger1);
check("registered 共 5 个（4 个子代理档位 + cohub-cordis）", result1.registered.length === 5);
check("failed 为空", result1.failed.length === 0);
check("注册的就是全部档位预设", TIER_PRESETS.every((id) => result1.registered.includes(id)));
check("register 调用 5 次", r1.calls.filter((c) => c.startsWith("register:")).length === 5);
check("4 个档位子代理都被 register",
  ["cohub-subagent-readonly", "cohub-subagent-readonly-net", "cohub-subagent-write", "cohub-subagent-write-shell"]
    .every((id) => r1.calls.includes(`register:${id}`)));
check("首轮不带任何 unregister（无旧注册）", r1.calls.every((c) => !c.startsWith("unregister:")));

// ── ② 已存在同 id → 先 unregister 再 register ─────────────────────────────
console.log("===== ② 已存在同 id → 先 unregister 再 register（幂等） =====");
const r2 = makeRegistry({ existing: ["cohub-cordis"] });
const logger2 = makeLogger();
const ctx2 = makeCtx(r2);
ctx2.logger = logger2;
const result2 = await registerCohubPresets(ctx2, logger2);
const cordisSeq = r2.calls.filter((c) => c.endsWith(":cohub-cordis"));
check("registered 仍含 cohub-cordis", result2.registered.includes("cohub-cordis"));
check(
  "调用序列 = get → unregister → register",
  deepEqual(cordisSeq, ["get:cohub-cordis", "unregister:cohub-cordis", "register:cohub-cordis"]),
);
check("unregister 在 register 之前", r2.calls.indexOf("unregister:cohub-cordis") < r2.calls.indexOf("register:cohub-cordis"));
check("没有档位注册失败", result2.failed.length === 0);

// ── ③ 唯一档位 register 抛错 → failed 登记 + warn，不抛（fail-soft）────────
console.log("===== ③ 单个档位注册抛错 → failed 登记 + warn（fail-soft） =====");
const r3 = makeRegistry({ failOn: ["cohub-cordis"] });
const logger3 = makeLogger();
const ctx3 = makeCtx(r3);
ctx3.logger = logger3;
const result3 = await registerCohubPresets(ctx3, logger3);
check("failed 含 cohub-cordis", result3.failed.includes("cohub-cordis"));
check("registered 为空（其余 4 个照常注册，失败 1 个）", result3.registered.length === 4);
check("产生了一条 warn", logger3.warns.some((line) => line.includes("cohub-cordis")));
check("失败不抛（fail-soft）", true);

// ── ④ dispose → 全部 unregister ───────────────────────────────────────────
console.log("===== ④ 插件卸载 → 全部 unregister =====");
const removed4 = unregisterCohubPresets(ctx1, logger1);
check("卸载数量 = 已注册数量（5）", removed4.length === 5);
check("每个已注册 id 都被 unregister", result1.registered.every((id: string) => r1.calls.includes(`unregister:${id}`)));
check("注册表回到空", r1.registered.size === 0);
check("重复卸载是幂等的（第二次为空）", unregisterCohubPresets(ctx1, logger1).length === 0);

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
