// dsh-cohub/test/contract-probe.ts —— src/contract-probe.ts 的离线契约验证
// 用法：node test/contract-probe.ts（node >= 24 类型剥离）
//
// 被测对象（src/contract-probe.ts）的定位：不 spawn、不发任何探测调用，只做
//   1) assertDualActivationSpec —— 提交前本地校验「顶层 + request 双写」契约；
//   2) describeActivationContractError —— 宿主仍抛裸 TypeError 时翻译成可操作归因；
//   3) probeActivationSpecShape —— 只读观察宿主读哪一层，恒返回 confident:false。
//
// 用例组织原则：**每个正例都配一个负例**（同一现场「该过的过、该炸的炸」），避免只测
// 一条分支把校验写成恒真/恒假也照样绿灯。分组对应上面三个导出函数 + 一条双写等价性
// 端到端（校验抓的形态 = 真宿主读法会崩的形态）。
import {
  assertDualActivationSpec,
  describeActivationContractError,
  probeActivationSpecShape,
} from "../src/contract-probe.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** 跑一次调用并捕获错误文本（不区分错误类型：本测试只关心「抛没抛 + 文案」）。 */
interface Outcome {
  threw: boolean;
  message: string;
}
function attempt(fn: () => void): Outcome {
  try {
    fn();
    return { threw: false, message: "" };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 正例：断言不抛。 */
function expectOk(name: string, spec: unknown, skillName?: string): Outcome {
  const outcome = attempt(() => assertDualActivationSpec(spec, skillName));
  check(name + " → 不抛", outcome.threw === false);
  return outcome;
}

/** 负例：断言抛错，且文案逐条包含期望片段。 */
function expectThrows(name: string, spec: unknown, mustInclude: string[], skillName?: string): Outcome {
  const outcome = attempt(() => assertDualActivationSpec(spec, skillName));
  check(name + " → 抛错", outcome.threw === true);
  for (const needle of mustInclude) {
    check(name + " → 文案含「" + needle + "」", outcome.message.includes(needle));
  }
  return outcome;
}

// 双写契约里同一份内容的两个合法副本（各用例按需只写其中一层即可构造负例）
const parent = { id: "parent-1" };
const prompt = [{ type: "text", text: "任务正文" }];
/** 完整双写 spec：顶层与 request 都具备 parent/prompt（宿主 rc.1 / rc.3 都能取到） */
const fullSpec = { parent, prompt, request: { parent, prompt } };

// ── 用例 1：assertDualActivationSpec 正例 —— 完整双写必须放行 ──
group("用例 1：assertDualActivationSpec 正例（完整双写放行）");
expectOk("P1 完整双写（顶层 + request 各一份 parent/prompt）", fullSpec);
expectOk("P2 顶层与 request 用**不同实例**（不查引用相等，只看字段是否齐）", {
  parent: { id: "parent-1" },
  prompt: [{ type: "text", text: "任务正文" }],
  request: { parent: { id: "parent-1" }, prompt: [{ type: "text", text: "任务正文" }] },
});
expectOk("P3 带 skillName 上下文（错误文案加 label，不影响通过）", fullSpec, "co-fixer");
expectOk("P4 带宿主其它字段（provider/label/delivery/signal）不干扰校验", {
  ...fullSpec,
  provider: "spawn",
  label: "co-fixer",
  delivery: "caller",
  signal: new AbortController().signal,
});

// ── 用例 2：assertDualActivationSpec 负例 —— 四类缺字段各自可读报错 ──
group("用例 2：assertDualActivationSpec 负例（缺字段点名 + 修复指引）");
// ① 顶层 parent 缺失（只有 request 一份 → rc.3 宿主会崩）
expectThrows(
  "N1 缺顶层 parent",
  { prompt, request: { parent, prompt } },
  ["spec 顶层", "parent", "修复", "startActivation", "双写"],
);
// ② request.parent 缺失（只有顶层一份 → rc.1 宿主会崩）
expectThrows(
  "N2 缺 request.parent",
  { parent, prompt, request: { prompt } },
  ["spec.request", "parent"],
);
// ③ 顶层 prompt 空数组
expectThrows(
  "N3 顶层 prompt 为空数组",
  { parent, prompt: [], request: { parent, prompt } },
  ["spec 顶层", "prompt", "数组(length=0)"],
);
// ④ request.prompt 空数组
expectThrows(
  "N4 request.prompt 为空数组",
  { parent, prompt, request: { parent, prompt: [] } },
  ["spec.request", "数组(length=0)"],
);
// ⑤ prompt 不是数组
expectThrows(
  "N5 顶层 prompt 非数组（字符串）",
  { parent, prompt: "任务正文", request: { parent, prompt } },
  ["prompt", "字符串"],
);
// ⑥ parent 有对象但 id 缺失
expectThrows(
  "N6 顶层 parent 缺 id",
  { parent: {}, prompt, request: { parent, prompt } },
  ["spec 顶层.parent.id", "parent.id"],
);
// ⑦ request.parent.id 是空串
expectThrows(
  "N7 request.parent.id 为空串",
  { parent, prompt, request: { parent: { id: "" }, prompt } },
  ["spec.request.parent.id"],
);
// ⑧ 整个 request 缺失 → 两条问题都要点名（一次报全，不是报一条就返回）
expectThrows(
  "N8 缺整个 request（parent 与 prompt 同时点名）",
  { parent, prompt },
  ["spec.request 缺少 parent", "spec.request 缺少 prompt"],
);
// ⑨ 多处同时坏 → 聚合报错（不遮蔽）
expectThrows(
  "N9 多处同时缺（顶层 parent + request 两项）",
  { prompt: [], request: {} },
  ["spec 顶层", "spec.request"],
);
// ⑩ 入参不是对象
expectThrows("N10 入参 undefined", undefined, ["不是对象"]);
expectThrows("N11 入参字符串", "spec", ["不是对象"]);
// ⑪ 修复指引必须落到具体代码位置（否则报错不可操作）
group("用例 2b：报错文案可操作性（修复指栅落到 delegate.ts:startSubagentRunOnce）");
const missingTop = attempt(() => assertDualActivationSpec({ prompt, request: { parent, prompt } }));
check("文案点名 delegate.ts", missingTop.message.includes("delegate.ts"));
check("文案点名 startSubagentRunOnce", missingTop.message.includes("startSubagentRunOnce"));
check("文案说明两代宿主读法差异（rc.1 读 request / rc.3 读顶层）",
  missingTop.message.includes("rc.1") && missingTop.message.includes("rc.3"));

// ── 用例 3：双写等价性 —— 校验抓的正是「真宿主读法会崩」的形态 ──
group("用例 3：双写等价性（校验通过 ⇔ 两代宿主读法都取得到）");
/** 0.2.2-rc.3 宿主读法：直接读 spec.parent.id（无 request 兼容分支） */
const readTopLayer = (spec: any): string => spec.parent.id;
/** 0.2.2-rc.1 宿主读法：读 spec.request.parent.id */
const readRequestLayer = (spec: any): string => spec.request.parent.id;
const okTop = attempt(() => void readTopLayer(fullSpec));
const okRequest = attempt(() => void readRequestLayer(fullSpec));
check("P5 完整双写：rc.3 读法（spec.parent.id）取到 parent-1", !okTop.threw && readTopLayer(fullSpec) === "parent-1");
check("P6 完整双写：rc.1 读法（spec.request.parent.id）取到 parent-1", !okRequest.threw && readRequestLayer(fullSpec) === "parent-1");
const requestOnly = { prompt, request: { parent, prompt } };
const rc3Crash = attempt(() => void readTopLayer(requestOnly));
check("N12 只写 request：rc.3 读法真的抛 TypeError（= 契约自检必须拦住的那个 bug）",
  rc3Crash.threw && rc3Crash.message.includes("reading 'id'"));
check("N12 该崩溃可被 describeActivationContractError 归因", typeof describeActivationContractError(
  new TypeError(rc3Crash.message),
) === "string");
const topOnly = { parent, prompt };
const rc1Crash = attempt(() => void readRequestLayer(topOnly));
check("N13 只写顶层：rc.1 读法真的抛 TypeError（先崩在读 .parent，request 整层缺失）",
  rc1Crash.threw && rc1Crash.message.includes("reading 'parent'"));

// ── 用例 4：describeActivationContractError —— 归因文本与「放行边界」 ──
group("用例 4：describeActivationContractError（读 id/parent/prompt 才归因，其它一律 undefined）");
const idAttr = describeActivationContractError(new TypeError("Cannot read properties of undefined (reading 'id')"));
check("P7 读 'id' 的 TypeError → 返回归因文本", typeof idAttr === "string" && idAttr.length > 0);
check("归因文本点名 rc.1（request 读法）", typeof idAttr === "string" && idAttr.includes("rc.1"));
check("归因文本点名 rc.3（顶层读法）", typeof idAttr === "string" && idAttr.includes("rc.3"));
check("归因文本点名 spec.request 层", typeof idAttr === "string" && idAttr.includes("spec.request"));
check("归因文本点名 spec 顶层", typeof idAttr === "string" && idAttr.includes("spec 顶层"));
check("归因文本给出修复指引", typeof idAttr === "string" && idAttr.includes("修复指引"));
check("归因文本点名 delegate.ts:startSubagentRunOnce 落点",
  typeof idAttr === "string" && idAttr.includes("delegate.ts") && idAttr.includes("startSubagentRunOnce"));
const parentAttr = describeActivationContractError(
  new TypeError("Cannot read properties of undefined (reading 'parent')"),
);
check("P8 读 'parent' 的 TypeError → 归因文本", typeof parentAttr === "string" && parentAttr.includes("rc.3"));
const promptAttr = describeActivationContractError(
  new TypeError("Cannot read properties of undefined (reading 'prompt')"),
);
check("P9 读 'prompt' 的 TypeError → 归因文本", typeof promptAttr === "string" && promptAttr.includes("spec.request"));
const crossRealm = Object.assign(new Error("Cannot read properties of undefined (reading 'id')"), { name: "TypeError" });
check("P10 name 伪装成 TypeError 的 Error 也归因（跨 realm/bundle 场景）",
  typeof describeActivationContractError(crossRealm) === "string");
check("N14 普通 Error('boom') → undefined（不改写既有错误语义）",
  describeActivationContractError(new Error("boom")) === undefined);
check("N15 TypeError 读 'length' → undefined（只有契约相关键才归因，避免误伤真实 bug）",
  describeActivationContractError(new TypeError("Cannot read properties of undefined (reading 'length')")) === undefined);
check("N16 TypeError 但 message 不含 Cannot read → undefined",
  describeActivationContractError(new TypeError("boom")) === undefined);
check("N17 非 Error 值（同名 message 的字符串）→ undefined",
  describeActivationContractError("Cannot read properties of undefined (reading 'id')") === undefined);
check("N18 null / undefined → undefined",
  describeActivationContractError(null) === undefined && describeActivationContractError(undefined) === undefined);

// ── 用例 5：probeActivationSpecShape —— 形状断言 + 无副作用 ──
group("用例 5：probeActivationSpecShape（恒 confident:false，带 reason/hints，不 spawn）");
const emptyProbe = probeActivationSpecShape({});
check("P11 无 startActivation → confident:false", emptyProbe.confident === false);
check("P11 reason 是非空字符串", typeof emptyProbe.reason === "string" && emptyProbe.reason.length > 0);
check("P11 hints 是非空数组", Array.isArray(emptyProbe.hints) && emptyProbe.hints.length > 0);
check("P11 hints 点名 startActivation 不可用", emptyProbe.hints.some(hint => hint.includes("startActivation")));
check("P12 ctx 为 undefined → confident:false 且仍有 hints",
  probeActivationSpecShape(undefined).confident === false
  && probeActivationSpecShape(undefined).hints.length > 0);

let probeCalls = 0;
const rc1LikeHost = {
  startActivation(spec: any): any {
    probeCalls++;
    return spec.request.parent.id;
  },
};
const withFnProbe = probeActivationSpecShape({ subagents: rc1LikeHost });
check("P13 有 startActivation → 仍 confident:false（不猜）", withFnProbe.confident === false);
check("P13 reason 说明静态信息不可作证据", withFnProbe.reason.includes("静态"));
check("P13 hints 记录 arity 无区分度（length=1）", withFnProbe.hints.some(hint => hint.includes("length=1")));
check("P13 hints 记录 .request.parent 文本（疑似 rc.1）", withFnProbe.hints.some(hint => hint.includes("rc.1")));
check("P13 hints 记录 <x>.parent 文本（疑似顶层读法）", withFnProbe.hints.some(hint => hint.includes(".parent")));
check("P14 **不调用** startActivation（探测零副作用，不浪费子运行）", probeCalls === 0);
const boundProbe = probeActivationSpecShape({
  subagents: { startActivation: (function (spec: any): any { return spec; }).bind(null) },
});
check("P15 bound/native 函数 → 仍 confident:false", boundProbe.confident === false);
check("P15 hints 记录函数体不可见（静态扫描无效）", boundProbe.hints.some(hint => hint.includes("不可见")));

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
