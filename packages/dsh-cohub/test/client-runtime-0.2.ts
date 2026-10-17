// dsh-port/test/client-runtime-0.2.ts —— DSH 0.2 客户端模块契约门禁（构建产物级，非源码 grep）
// 用法：npm run test:client（node test/client-runtime-0.2.ts，node >= 24 类型剥离）
// 前置：已 bun run build（lib/client.js 为真实构建产物，不是 src 直接引用）。
//
// 分层说明（与 host-integration.ts 互补）：
//   ✓ 真实层：lib/client.js 构建产物经真实 window.__ModuleLoader__.load 注册；module id /
//     导出的 inject 数组 / apply 行为全部来自产物执行结果；dsh.client.inject manifest 声明的
//     包校验 node_modules 真实安装且版本 0.2.0-rc.2（module id 来自已安装 0.2 包/官方组合）。
//   ✗ 边界（stub 标注）：window / locale 对象为内存 stub（本测试不渲染 React、不启动真实浏览器
//      UI，浏览器 UI 实测留给宿主）；Config 服务 SettingsForms 投影由 host-integration.ts 层 3
//      用真实 Loader + describe() 验证，本测试不重复。
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

// ── 层 1：dsh.client.inject manifest 收敛 + 已安装 0.2 包校验 ──
{
  console.log("===== 层 1：manifest 客户端服务收敛 =====");
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const injectPkgs: string[] = manifest.dsh?.client?.inject ?? [];
  check("dsh.client.inject 收敛为仅 @deepseek-ai/dsh-client-locale",
    JSON.stringify(injectPkgs) === JSON.stringify(["@deepseek-ai/dsh-client-locale"]));
  for (const pkg of injectPkgs) {
    const meta = JSON.parse(readFileSync(join(process.cwd(), "node_modules", pkg, "package.json"), "utf8"));
    check(`inject 包 ${pkg} 已安装且版本 0.2.0-rc.2`, meta.version === "0.2.0-rc.2");
  }
  // locale 官方组合依赖存在（host 按各包自身 dsh.client.inject 组合，本包无需重复声明）
  const localeMeta = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "@deepseek-ai/dsh-client-locale", "package.json"), "utf8"));
  check("locale 官方声明注入组合存在（connection/ui-renderer/ui-settings/api-remotes）",
    Array.isArray(localeMeta.dsh?.client?.inject) && localeMeta.dsh.client.inject.length >= 4);
  // session-projection：tokenMeter 真实使用 ctx.sessionProjections.snapshot，peer 必须 required
  const peers: Record<string, string> = manifest.peerDependencies ?? {};
  const optional: Record<string, unknown> = manifest.peerDependenciesMeta ?? {};
  check("peer 含 @deepseek-ai/dsh-session-projection ^0.2.0-rc.2", peers["@deepseek-ai/dsh-session-projection"] === "^0.2.0-rc.2");
  check("session-projection peer 非 optional（required）", optional["@deepseek-ai/dsh-session-projection"] === undefined);
  const projMeta = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "@deepseek-ai/dsh-session-projection", "package.json"), "utf8"));
  check("session-projection 已安装 0.2.0-rc.2（dev 精确锁定）", projMeta.version === "0.2.0-rc.2");
}

// ── 层 2：真实构建产物 lib/client.js 注册 / 导出 ──
{
  console.log("===== 层 2：构建产物 ModuleLoader 注册 =====");
  const src = readFileSync(join(process.cwd(), "lib", "client.js"), "utf8");
  let captured: { id?: string; factory?: (require: (id: string) => unknown) => unknown } | null = null;
  (globalThis as any).window = {
    __ModuleLoader__: { load: (spec: any) => { captured = spec; } },
  };
  new Function(src)();
  check("产物经 window.__ModuleLoader__.load 注册", captured !== null);
  check("module id = dsh-cohub", captured?.id === "dsh-cohub");

  const requireStub = (id: string): never => { throw new Error("client 模块不应 require 外部 npm 模块，却请求: " + id); };
  const mod = (captured as any).factory(requireStub) as { apply: (ctx: any) => void; inject: string[] };
  check("factory 导出 apply", typeof mod.apply === "function");
  check("factory 导出 inject 仅 locale 服务", JSON.stringify(mod.inject) === JSON.stringify(["locale"]));
  const staleServices = ["slots", "remote", "remote.llm", "remote.session", "settingsScope", "settings"];
  const staleTouched = (mod.inject ?? []).filter((s) => staleServices.includes(s));
  check("inject 不含旧 settingsScope/slot/remote 服务", staleTouched.length === 0);
}

// ── 层 3：执行 apply —— 只访问声明服务，不触碰旧分支 ──
{
  console.log("===== 层 3：apply 服务访问契约 =====");
  const src = readFileSync(join(process.cwd(), "lib", "client.js"), "utf8");
  let captured: any = null;
  (globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { captured = spec; } } };
  new Function(src)();
  const mod = captured.factory((id: string): never => { throw new Error("不应 require: " + id); });

  const accessed: string[] = [];
  const registerCalls: { ns: string; dict: any }[] = [];
  const localeStub = { register: (ns: string, dict: any) => { registerCalls.push({ ns, dict }); return () => {}; } };
  const effectStub = (fn: () => unknown) => { fn(); return () => {}; };
  const ctx = new Proxy({ locale: localeStub, effect: effectStub }, {
    get(target, prop) {
      accessed.push(String(prop));
      return (target as any)[prop];
    },
  });
  mod.apply(ctx);
  check("apply 执行成功（不抛错）", true);
  check("locale.register 注册 cohub 字典（zh/en）",
    registerCalls.length === 1 && registerCalls[0].ns === "cohub" && !!registerCalls[0].dict?.zh && !!registerCalls[0].dict?.en);
  const banned = ["settingsScope", "slots", "remote", "remote.llm", "remote.session", "settings"];
  const touchedBanned = accessed.filter((p) => banned.includes(p));
  check("apply 不访问旧 settingsScope/slot/未声明 remote", touchedBanned.length === 0);
  const allowed = ["locale", "effect"];
  const unexpected = accessed.filter((p) => !allowed.includes(p));
  check("apply 仅访问声明服务（locale/effect）", unexpected.length === 0);
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
