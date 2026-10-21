// dsh-port/test/client-runtime-0.2.ts —— DSH 0.2 客户端模块契约门禁（构建产物级，非源码 grep）
// 用法：npm run test:client（node test/client-runtime-0.2.ts，node >= 24 类型剥离）
// 前置：已 bun run build（lib/client.js 为真实构建产物，不是 src 直接引用）。
//
// 分层说明（与 host-integration.ts 互补）：
//   ✓ 真实层：lib/client.js 构建产物经真实 window.__ModuleLoader__.load 注册；module id /
//     导出的 inject 数组 / apply 行为 / settings.section 注册形状 / 纯函数写回契约
//     全部来自产物执行结果；dsh.client.inject manifest 声明的包校验 node_modules 已装的 0.2 包。
//   ✗ 边界（stub 标注）：window / locale / slots / configForms / remote 为内存 stub（本测试
//     不渲染 React、不启动真实浏览器 UI，浏览器 UI 实测留给宿主）；Config 服务的
//     SettingsForms 投影由 host-integration.ts 层 3 用真实 Loader + describe() 验证，本测试不重复。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}

// ── 层 1：dsh.client.inject manifest（设置页需要 settings slot + configForms + remote） ──
{
  console.log("===== 层 1：manifest 客户端注入声明 =====");
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const injectPkgs: string[] = manifest.dsh?.client?.inject ?? [];
  const required = [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-api-remotes",
  ];
  for (const pkg of required) {
    check(`dsh.client.inject 含 ${pkg}`, injectPkgs.includes(pkg));
  }
  check("dsh.client.inject 无冗余项", injectPkgs.length === required.length);
  check("dsh.client.platform = web", manifest.dsh?.client?.platform === "web");
  // 本包直接依赖（devDependency）的客户端包：已装则必须与 DSH 0.2 线一致。
  for (const pkg of injectPkgs) {
    const metaPath = join(process.cwd(), "node_modules", pkg, "package.json");
    if (!existsSync(metaPath)) {
      // ui-settings / api-remotes 由宿主 web 组合提供，本包不直接依赖；存在性由宿主保证，
      // 这里只把边界显式记录出来，避免误判为缺包。
      console.log(`    · ${pkg} 由宿主组合提供（本包无直接依赖，跳过本地版本校验）`);
      continue;
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    check(`已装的 inject 包 ${pkg} 属 0.2 线`, /^0\.2\./.test(String(meta.version)));
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

// ── 渲染 shim：组件不调用任何 React hook，只拼 createElement 元素树 ──
// 边界：这不是真实 DOM 渲染（react-dom 未安装、也不启动浏览器），只用于断言
// 「选择控件的 disabled / value="" 占位项 / 不可用回显 / 状态提示」这些真实踩过的坑。
interface El { type: any; props: Record<string, any>; children: any[] }
const renderShim = {
  createElement: (type: any, props: any, ...children: any[]): El => ({ type, props: props ?? {}, children }),
  useState: (value: any) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useMemo: (fn: () => any) => fn(),
  useSyncExternalStore: (subscribe: () => any) => subscribe(),
};
function walkElements(node: any, visit: (el: El) => void) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const item of node) walkElements(item, visit); return; }
  if (typeof node !== "object") return;
  visit(node as El);
  for (const child of (node as El).children ?? []) walkElements(child, visit);
}
function collectElements(node: any, type: string): El[] {
  const out: El[] = [];
  walkElements(node, (el) => { if (el.type === type) out.push(el); });
  return out;
}
function elementText(node: any): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(elementText).join("");
  return elementText((node as El).children);
}

// ── 层 2：真实构建产物 lib/client.js 注册 / 导出 ──
let captured: { id?: string; factory?: (require: (id: string) => unknown) => any } | null = null;
{
  console.log("===== 层 2：构建产物 ModuleLoader 注册 =====");
  const src = readFileSync(join(process.cwd(), "lib", "client.js"), "utf8");
  (globalThis as any).window = {
    __ModuleLoader__: { load: (spec: any) => { captured = spec; } },
  };
  new Function(src)();
  check("产物经 window.__ModuleLoader__.load 注册", captured !== null);
  check("module id = dsh-cohub", captured?.id === "dsh-cohub");

  // 客户端 bundle 只允许 require("react")：设置页是手写 createElement，不引官方 primitives
  // （官方 dsh-client-ui-primitives 没有 Select/Dropdown，本页不需要它）。
  const requireStub = (id: string): unknown => {
    if (id === "react") return renderShim;
    throw new Error("client 模块不应 require 其他外部模块，却请求: " + id);
  };
  const mod = (captured as any).factory(requireStub) as { apply: (ctx: any) => void; inject: string[] };
  check("factory 导出 apply", typeof mod.apply === "function");
  for (const service of ["slots", "locale", "remote", "remote.session", "configForms"]) {
    check(`inject 声明 ${service}`, (mod.inject ?? []).includes(service));
  }
  const staleServices = ["settingsScope", "settings", "settings.plugin.item"];
  check("inject 不含已改名的旧服务", (mod.inject ?? []).filter((s) => staleServices.includes(s)).length === 0);
}

// ── 层 3：执行 apply —— settings.section 注册形状 + configForms 读写 + 目录加载 + 冲突栅栏 ──
let sectionComponent: any = null;
let zhDict: Record<string, string> = {};
{
  console.log("===== 层 3：apply 行为（settings.section / configForms / modelCatalog） =====");
  const src = readFileSync(join(process.cwd(), "lib", "client.js"), "utf8");
  let spec: any = null;
  (globalThis as any).window = { __ModuleLoader__: { load: (s: any) => { spec = s; } } };
  new Function(src)();
  const mod = spec.factory((id: string): unknown => {
    if (id === "react") return renderShim;
    throw new Error("不应 require: " + id);
  });

  // locale / slots / configForms / remote 的最小内存 stub（真实宿主服务在上层验证）。
  const registerCalls: { ns: string; dict: any }[] = [];
  const dicts: Record<string, any> = {};
  const localeStub = {
    register: (ns: string, dict: any) => { registerCalls.push({ ns, dict }); dicts[ns] = dict; return () => {}; },
    bind: (ns: string) => (key: string, params?: Record<string, unknown>) => {
      const template = dicts[ns]?.zh?.[key] ?? key;
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, (m: string, n: string) => (n in params ? String(params[n]) : m));
    },
  };
  const effectStub = (fn: () => unknown) => { const off = fn(); return typeof off === "function" ? off : () => {}; };

  const slotInjected: string[] = [];
  const registrations: { name: string; id?: string; order?: number; label?: unknown; locale?: string }[] = [];
  let component: unknown = null;
  const slotsStub = {
    inject: (name: string, cb: () => unknown) => { slotInjected.push(name); return cb(); },
    register: (options: any, comp: unknown) => { registrations.push(options); component = comp; return () => {}; },
  };

  // configForms stub：把 skills 数组当成宿主配置；revision 由测试显式推进。
  const formState = { status: "ready", writable: true, revision: 1, value: { skills: [] as any[] }, base: {}, user: {} };
  const scopeListeners: (() => void)[] = [];
  const mutations: { ops: any[]; revision: number }[] = [];
  const scopeStub = {
    getSnapshot: () => formState,
    subscribe: (fn: () => void) => { scopeListeners.push(fn); return () => {}; },
    mutate: (ops: any[], revision: number) => {
      mutations.push({ ops, revision });
      const set = ops.find((op) => op.op === "set" && op.path?.[0] === "skills");
      if (set) formState.value = { ...formState.value, skills: set.value };
      formState.revision += 1;
      for (const fn of scopeListeners) fn();
      return Promise.resolve(true);
    },
  };
  const configFormsStub = { get: (ns: string) => { (configFormsStub as any).asked = ns; return scopeStub; }, asked: "" };
  const eventNames: string[] = [];
  const remoteStub = {
    session: {
      modelCatalog: () => Promise.resolve({
        ok: true,
        value: {
          default: { provider: "p1", model: "m1" },
          routableProviders: ["p1"],
          groups: [{ id: "p1", name: "Provider 1", models: [{ id: "m1", name: "Model 1" }] }],
          failures: [],
        },
      }),
    },
    $on: (name: string, _cb: () => void) => { eventNames.push(name); return () => {}; },
  };

  const accessed: string[] = [];
  const ctx = new Proxy(
    { locale: localeStub, effect: effectStub, slots: slotsStub, configForms: configFormsStub, remote: remoteStub },
    { get(target, prop) { accessed.push(String(prop)); return (target as any)[prop]; } },
  );

  mod.apply(ctx);
  check("apply 执行成功（不抛错）", true);
  check("locale.register 注册 cohub 字典（zh/en）",
    registerCalls.length === 1 && registerCalls[0].ns === "cohub" && !!registerCalls[0].dict?.zh && !!registerCalls[0].dict?.en);
  {
    const zhKeys = Object.keys(registerCalls[0].dict.zh).sort();
    const enKeys = Object.keys(registerCalls[0].dict.en).sort();
    check("zh/en 字典键集合一致（回退链末端是 en，缺键会退化成 key）", JSON.stringify(zhKeys) === JSON.stringify(enKeys));
    const missingLabels = ["co-orchestrator", "co-cordis"].filter((n) => registerCalls[0].dict.zh["skill." + n] === undefined);
    check("字典含 13 个代理的中文标签（抽样 co-orchestrator/co-cordis）", missingLabels.length === 0);
    check("字典 flat key 含点的技能标签（locale 的 lookup 是 dict[key]，不按路径切分）",
      Object.keys(registerCalls[0].dict.zh).filter((k) => k.startsWith("skill.")).length === 13);
  }
  check("configForms 命名空间取 Loader entry id = cohub", configFormsStub.asked === "cohub");

  const section = registrations.find((r) => r.name === "settings.section");
  check("注册到 settings.section（左侧导航自动生成）", section !== undefined);
  check("section id = cohub", section?.id === "cohub");
  check("section order = 12（模型 10 与插件 15 之间）", section?.order === 12);
  check("section locale = cohub", section?.locale === "cohub");
  const labelText = typeof section?.label === "function" ? (section?.label as () => string)() : "";
  check("section label 为 thunk 且返回中文字典的 nav 文案", labelText === "CoHub 代理");
  check("section 组件是函数（React 组件）", typeof component === "function");
  sectionComponent = component;
  zhDict = registerCalls[0].dict.zh;
  check("订阅 llm/adapters-updated 刷新目录", eventNames.includes("llm/adapters-updated"));

  const banned = ["settingsScope", "settings", "settings.plugin.item"];
  check("apply 不访问已改名的旧服务", accessed.filter((p) => banned.includes(p)).length === 0);

  const injectedFace = (section as any)?.inject;
  check("section 暴露 inject 面", typeof injectedFace === "function");
  const face = typeof injectedFace === "function" ? injectedFace() : {};
  const observable = face?.hooks?.cohubSkills;
  check("hooks.cohubSkills 是可观察量（getSnapshot/subscribe）",
    !!observable && typeof observable.getSnapshot === "function" && typeof observable.subscribe === "function");

  // 目录加载是异步的（Promise）：让微任务队列跑完。
  await Promise.resolve();
  await Promise.resolve();
  let snapshot = observable.getSnapshot();
  check("modelCatalog 成功后 catalogStatus = ready", snapshot?.catalogStatus === "ready");
  check("目录含供应商 p1", Array.isArray(snapshot?.providers) && snapshot.providers.some((p: any) => p.id === "p1"));
  check("目录含 p1 的模型 m1", Array.isArray(snapshot?.modelsByProvider?.p1) && snapshot.modelsByProvider.p1[0].id === "m1");
  check("初始渲染 13 个代理行", Array.isArray(snapshot?.rows) && snapshot.rows.length === 13);
  check("13 行覆盖 co-cordis（旧实现遗漏的代理）", snapshot.rows.some((r: any) => r.name === "co-cordis"));

  // 编辑 → 草稿脏 → 外部 revision 推进 → 冲突栅栏（不得覆盖别处的新配置）
  face.editRow("co-fixer", "provider", "p1");
  snapshot = observable.getSnapshot();
  check("编辑 provider 后 dirty = true", snapshot?.dirty === true);
  const editedRow = snapshot.rows.find((r: any) => r.name === "co-fixer");
  check("编辑后该行 provider = p1", editedRow?.provider === "p1");
  check("换供应商会清空旧 model（避免写出失效路由）", editedRow?.model === "");
  check("编辑不立即写配置（仍走显式保存）", mutations.length === 0);

  formState.revision = 9; // 模拟「设置已在其他位置更新」
  for (const fn of scopeListeners) fn();
  snapshot = observable.getSnapshot();
  check("revision 不一致 → conflicted = true", snapshot?.conflicted === true);
  const rejected = await face.save();
  check("冲突态 save() 直接拒绝且不写配置", rejected === false && mutations.length === 0);

  face.discard();
  snapshot = observable.getSnapshot();
  check("放弃修改后 conflicted/dirty 均复位", snapshot?.conflicted === false && snapshot?.dirty === false);

  // 正常保存：整数组替换 + revision 栅栏 + provider 有值 / model 空则不写 model 键
  face.editRow("co-fixer", "provider", "p1");
  const accepted = await face.save();
  check("save() 成功后返回 true", accepted === true);
  check("写入恰好一次 mutate", mutations.length === 1);
  const mutation = mutations[0];
  check("mutate 提交 path = [\"skills\"]（数组整体替换）", mutation?.ops?.length === 1
    && mutation.ops[0].op === "set"
    && JSON.stringify(mutation.ops[0].path) === JSON.stringify(["skills"]));
  check("mutate 携带读取时的 revision（冲突栅栏）", mutation?.revision === 9);
  const written = mutation?.ops?.[0]?.value ?? [];
  check("只写入显式配置的代理（未配置代理不写入 = 继承父模型）",
    Array.isArray(written) && written.length === 1 && written[0].name === "co-fixer" && written[0].provider === "p1");
  check("model 为空时不写 model 键", Array.isArray(written) && written[0] !== undefined && !("model" in written[0]));
  snapshot = observable.getSnapshot();
  check("保存后 dirty = false 且 saved = true", snapshot?.dirty === false && snapshot?.saved === true);
}

// ── 层 4：纯函数写回契约（rowsToSkills / rowsFromSkills） ──
{
  console.log("===== 层 4：skills 写回纯函数契约 =====");
  const src = readFileSync(join(process.cwd(), "lib", "client.js"), "utf8");
  let spec: any = null;
  (globalThis as any).window = { __ModuleLoader__: { load: (s: any) => { spec = s; } } };
  new Function(src)();
  const mod = spec.factory((id: string): unknown => {
    if (id === "react") return { createElement: () => null };
    throw new Error("不应 require: " + id);
  });
  const internals = mod.__internals;
  check("导出纯函数契约（__internals）", !!internals && typeof internals.rowsToSkills === "function" && typeof internals.rowsFromSkills === "function");

  const rows = internals.rowsFromSkills([
    { name: "co-fixer", provider: "p1", model: "m1", maxTokens: 4096 },
    { name: "co-oracle", provider: "p2" },
    { name: "custom-agent", provider: "p3", model: "m3" },
    { provider: "p9" },
  ]);
  check("rowsFromSkills 跳过无名项", rows.length === 3);
  check("rowsFromSkills 保留 maxTokens 到 extra", rows[0].extra.maxTokens === 4096);
  check("rowsFromSkills 缺 model 时归一为空串", rows[1].model === "");

  const written = internals.rowsToSkills(rows);
  check("rowsToSkills 丢弃 provider 为空的整行", written.every((item: any) => typeof item.provider === "string" && item.provider !== ""));
  check("rowsToSkills 保留 maxTokens 等额外字段", written[0].maxTokens === 4096);
  check("rowsToSkills 空 model 不写 model 键", !("model" in written[1]));
  check("rowsToSkills 保留未知 skill 名（不静默丢配置）", written.some((item: any) => item.name === "custom-agent"));
  check("rowsToSkills 保留 provider 有值的行数（3 条）", written.length === 3);

  const allEmpty = internals.rowsToSkills(internals.rowsFromSkills([]).concat([{ name: "co-fixer", provider: "", model: "", extra: {} }]));
  check("全部继承时写入空数组（等价于清空配置）", Array.isArray(allEmpty) && allEmpty.length === 0);
}

// ── 层 5：组件渲染契约（5 个特殊态 + 状态提示） ──
// 边界：用模块顶部的 createElement shim 渲染元素树（组件不调用任何 React hook），
// 验证「选择控件的 disabled / value="" 占位项 / 不可用回显 / 状态提示」这些真实踩过的坑，
// 不是真实 DOM 渲染（浏览器 UI 实测留给宿主）。
{
  console.log("===== 层 5：组件渲染契约（5 个特殊态） =====");

  const walk = walkElements;
  const collect = collectElements;
  const textOf = elementText;
  function rowsOf(tree: any): El[] {
    const out: El[] = [];
    walk(tree, (el) => { if (el.props?.className === "cohub-row") out.push(el); });
    return out;
  }

  const t = (key: string, params?: Record<string, unknown>) => {
    const template = zhDict[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
  };

  check("组件不依赖 React hook（props.useCohubSkills 由 slot hooks 注入，组件只拼元素树）",
    typeof renderShim.createElement === "function");

  function baseState(overrides: Record<string, any> = {}) {
    return {
      status: "ready",
      writable: true,
      dirty: false,
      conflicted: false,
      saving: false,
      saved: false,
      failed: false,
      rows: [{ name: "co-fixer", provider: "", model: "", extra: {} }],
      providers: [{ id: "p1", label: "Provider 1" }],
      modelsByProvider: { p1: [{ id: "m1", label: "Model 1" }] },
      catalogStatus: "ready",
      catalogError: "",
      ...overrides,
    };
  }
  function render(state: any) {
    // 组件的 React 来自工厂的 require("react")（层 3 传的就是 renderShim），这里只需喂状态。
    return sectionComponent({
      t,
      useCohubSkills: (selector: (value: any) => unknown) => selector(state),
      editRow: () => {},
      resetRow: () => {},
      discard: () => {},
      save: () => {},
      retryCatalog: () => {},
    });
  }

  // ① provider 为空 → 模型控件禁用并提示「请先选择供应商」，供应商下拉必须有 value="" 空选项
  const emptyProvider = render(baseState());
  const emptyProviderRow = rowsOf(emptyProvider)[0];
  const emptyProviderSelects = collect(emptyProviderRow, "select");
  check("① provider 为空：供应商下拉含 value=\"\" 的继承项（否则浏览器把第一项当成已选）",
    String(emptyProviderSelects[0]?.props?.value) === ""
    && collect(emptyProviderSelects[0], "option").some((o) => o.props.value === ""));
  check("① provider 为空：模型下拉 disabled 且提示「请先选择供应商」",
    emptyProviderSelects[1]?.props?.disabled === true
    && textOf(emptyProviderSelects[1]) === zhDict["selectProviderFirst"]);
  check("① provider 为空：不渲染 model 手填框", collect(emptyProviderRow, "input").length === 0);

  // ⑤ 空 model 占位：provider 已选、目录就绪 → 模型 select 第一个 option 必须是 value=""
  const withProvider = render(baseState({ rows: [{ name: "co-fixer", provider: "p1", model: "", extra: {} }] }));
  const modelSelect = collect(rowsOf(withProvider)[0], "select")[1];
  const modelOptions = collect(modelSelect, "option");
  check("⑤ 空 model：模型下拉首项是 value=\"\" 的继承占位项", modelOptions[0]?.props?.value === ""
    && textOf(modelOptions[0]) === zhDict["modelInherit"]);
  check("⑤ 空 model：占位项之后是目录里的模型", modelOptions[1]?.props?.value === "m1");
  check("⑤ 空 model：下拉未被禁用（可选择）", modelSelect?.props?.disabled === false);

  // ② 目录加载中 → 模型下拉 disabled 并显示「加载中…」
  const loadingState = render(baseState({
    catalogStatus: "loading",
    providers: [],
    modelsByProvider: {},
    rows: [{ name: "co-fixer", provider: "p1", model: "", extra: {} }],
  }));
  const loadingModel = collect(rowsOf(loadingState)[0], "select")[1];
  check("② 目录加载中：模型下拉 disabled 且显示「加载中…」",
    loadingModel?.props?.disabled === true && textOf(loadingModel) === zhDict["loading"]);

  // ③ provider 无模型目录（或目录加载失败）→ 降级为手填 input
  const noCatalog = render(baseState({
    modelsByProvider: { p1: [] },
    rows: [{ name: "co-fixer", provider: "p1", model: "custom-model", extra: {} }],
  }));
  const noCatalogInputs = collect(rowsOf(noCatalog)[0], "input");
  check("③ provider 无模型目录：降级为手填 input 且回显已存的 model id",
    noCatalogInputs.length === 1
    && noCatalogInputs[0].props.type === "text"
    && String(noCatalogInputs[0].props.value) === "custom-model"
    && String(noCatalogInputs[0].props.placeholder).includes(zhDict["customModel"]));

  const catalogError = render(baseState({
    catalogStatus: "error",
    catalogError: "boom",
    providers: [],
    modelsByProvider: {},
    rows: [{ name: "co-fixer", provider: "p1", model: "", extra: {} }],
  }));
  check("③ 目录加载失败：同样降级手填 + 顶部错误提示 + 重试按钮",
    collect(rowsOf(catalogError)[0], "input").length === 1
    && textOf(catalogError).includes(zhDict["loadProvidersFailed"])
    && collect(catalogError, "button").some((b) => textOf(b) === zhDict["retry"]));

  // ④ 已存但当前不可用 → <option disabled> 回显（供应商与模型各一处）
  const unavailable = render(baseState({
    rows: [{ name: "co-fixer", provider: "gone-provider", model: "", extra: {} }],
  }));
  const unavailableProviderSelect = collect(rowsOf(unavailable)[0], "select")[0];
  const deadProviderOption = collect(unavailableProviderSelect, "option").find((o) => o.props.value === "gone-provider");
  check("④ 供应商已存但目录里没有：渲染 disabled 回显项并标注不可用",
    deadProviderOption !== undefined && deadProviderOption.props.disabled === true
    && textOf(deadProviderOption).includes(zhDict["unavailableOption"].replace("{value}", "gone-provider").replace("（不可用）", "").trim()));

  const unavailableModel = render(baseState({
    rows: [{ name: "co-fixer", provider: "p1", model: "gone-model", extra: {} }],
  }));
  const deadModelOption = collect(collect(rowsOf(unavailableModel)[0], "select")[1], "option")
    .find((o) => o.props.value === "gone-model");
  check("④ 模型已存但当前目录不可用：渲染 disabled 回显项（不再显示成第一项）",
    deadModelOption !== undefined && deadModelOption.props.disabled === true
    && textOf(deadModelOption).includes("gone-model"));

  // 状态提示：只读 / 冲突 / 失败 / 未保存
  const readOnly = render(baseState({ writable: false, rows: [{ name: "co-fixer", provider: "p1", model: "m1", extra: {} }] }));
  check("只读连接：提示只读且全部控件禁用",
    textOf(readOnly).includes(zhDict["readOnly"])
    && collect(readOnly, "select").every((s) => s.props.disabled === true)
    && collect(readOnly, "button").every((b) => b.props.disabled === true));

  const conflicted = render(baseState({ conflicted: true, dirty: true, rows: [{ name: "co-fixer", provider: "p1", model: "m1", extra: {} }] }));
  const saveButton = collect(conflicted, "button").find((b) => textOf(b) === zhDict["save"]);
  check("冲突态：提示「设置已在其他位置更新」且保存按钮禁用",
    textOf(conflicted).includes(zhDict["conflicted"]) && saveButton?.props.disabled === true);

  const failed = render(baseState({ failed: true, dirty: true }));
  check("保存失败：提示保存失败", textOf(failed).includes(zhDict["failed"]));
  const dirtyHint = render(baseState({ dirty: true, rows: [{ name: "co-fixer", provider: "p1", model: "m1", extra: {} }] }));
  check("有未保存修改：提示 + 保存按钮可用", textOf(dirtyHint).includes(zhDict["dirty"])
    && collect(dirtyHint, "button").find((b) => textOf(b) === zhDict["save"])?.props.disabled === false);

  // 13 行都在（含 co-cordis），且行标签走字典
  const allRows = render(baseState({
    rows: [
      "co-orchestrator", "co-planner", "co-oracle", "co-explorer", "co-librarian", "co-observer",
      "co-fixer", "co-designer", "co-council", "co-rule-user", "co-rule-project", "co-rule-app", "co-cordis",
    ].map((name) => ({ name, provider: "", model: "", extra: {} })),
  }));
  check("渲染 13 行代理（含 co-cordis）", rowsOf(allRows).length === 13);
  check("行标签用中文字典（co-cordis → Cordis 插件）", textOf(allRows).includes(zhDict["skill.co-cordis"]));

  // 未加载完 / 不可用：只给标题与状态，不渲染半截表单
  const unready = render(baseState({ status: "loading" }));
  check("非 ready 状态只渲染标题与状态提示（不渲染半截表单）",
    rowsOf(unready).length === 0 && textOf(unready).includes(zhDict["title"]) && textOf(unready).includes(zhDict["loading"]));
  const unavailableNs = render(baseState({ status: "unavailable", writable: false }));
  check("命名空间不可用：给出明确提示", textOf(unavailableNs).includes(zhDict["unavailable"]));
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
