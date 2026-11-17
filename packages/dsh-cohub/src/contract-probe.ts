// src/contract-probe.ts —— 派发前 activation 契约自检 + 失败归因（A · 失败归因增强）
//
// 背景（两代宿主的契约漂移）：
//   - DSH 0.2.2-rc.1 的 SubagentRuntime.startActivation(spec) 从 **spec.request** 读
//     parent / prompt（node_modules/@deepseek-ai/dsh-subagent/lib/index.js 读 spec.request.parent.id）；
//   - DSH 0.2.2-rc.3 改为从 **spec 顶层** 读（app.asar 内 dsh-subagent/lib/index.js:3019-3026，
//     其中 :3025 直接读 spec.parent.id，且不再有 request 兼容分支）。
//   cohub 因此在 delegate.ts 的 startSubagentRunOnce 里做「顶层 + request 双写」，任一版本都能取到。
//
// 但双写只是**当下的**兼容：若宿主再迁到第三层（例如 spec.request.agent.parent）或改字段名，
// 宿主会在 spawn 前抛裸 TypeError：
//   TypeError: Cannot read properties of undefined (reading 'id')
// 这条 message 不含任何 cohub 侧信息，落到 delegate_batch 的 error 条目里也无法归因。
// 本模块只做两件事，**都不真 spawn、不发起任何探测式调用**：
//   1) assertDualActivationSpec —— 提交前在本地校验「双写契约」是否成立（缺字段立刻可读报错）；
//   2) describeActivationContractError —— 宿主仍抛裸 TypeError 时，把症状翻译成可操作的归因文本，
//      并保留原始 message（调用方负责拼接，绝不吞原文）。
//   3) probeActivationSpecShape —— 静态推断宿主读哪层的**尝试**，当前实现刻意返回
//      { confident: false }（原因见该函数上方注释）。

/** 双写契约里要求同时具备的四个（字段, 位置）组合 */
interface FieldRequirement {
  /** 给人读的位置标签（错误文案用） */
  where: string;
  /** 从 spec 上取值（取不到返回 undefined） */
  pick: (spec: Record<string, unknown>) => unknown;
  /** 缺失时的一句话说明 */
  what: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function pickParent(spec: Record<string, unknown>): unknown {
  return spec.parent;
}

function pickPrompt(spec: Record<string, unknown>): unknown {
  return spec.prompt;
}

function pickRequestParent(spec: Record<string, unknown>): unknown {
  return asRecord(spec.request)?.parent;
}

function pickRequestPrompt(spec: Record<string, unknown>): unknown {
  return asRecord(spec.request)?.prompt;
}

/**
 * 校验「即将提交给 startActivation 的对象」是否同时具备
 * 顶层 parent/prompt 与 request.parent/request.prompt。
 *
 * 这是**本地静态校验**：只看我们自己的入参对象，不调用宿主、不 spawn 探测。
 * 校验失败即抛可读错误（点名缺哪个字段、缺在哪个位置，并说明双写兼容契约被破坏），
 * 让「宿主再迁移一层」在 cohub 侧就以清晰信息暴露，而不是变成宿主的裸 TypeError。
 *
 * @param spec startActivation 的入参对象（delegate.ts 构造的双写对象）
 * @param skillName 可选上下文（label / skill 名），用于错误文案定位是哪次派发
 */
export function assertDualActivationSpec(spec: unknown, skillName?: string): void {
  const subject = skillName !== undefined && skillName.length > 0 ? `（label=${skillName}）` : "";
  const record = asRecord(spec);
  if (record === undefined) {
    throw new Error(
      "cohub: activation 契约自检失败" + subject + "——startActivation 入参不是对象（收到 "
      + JSON.stringify(spec ?? null) + "）。双写兼容契约要求入参同时具备 spec 顶层与 spec.request 的 parent/prompt。",
    );
  }

  const requirements: FieldRequirement[] = [
    { where: "spec 顶层", pick: pickParent, what: "parent（对象且含 id）" },
    { where: "spec 顶层", pick: pickPrompt, what: "prompt（非空 text 块数组）" },
    { where: "spec.request", pick: pickRequestParent, what: "parent（对象且含 id）" },
    { where: "spec.request", pick: pickRequestPrompt, what: "prompt（非空 text 块数组）" },
  ];

  const problems: string[] = [];
  for (const req of requirements) {
    const value = req.pick(record);
    const isPrompt = req.what.startsWith("prompt");
    if (isPrompt) {
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${req.where} 缺少 ${req.what}（实际：${describeValue(value)}）`);
      }
      continue;
    }
    const parent = asRecord(value);
    if (parent === undefined) {
      problems.push(`${req.where} 缺少 ${req.what}（实际：${describeValue(value)}）`);
      continue;
    }
    const id = parent.id;
    if (typeof id !== "string" || id.length === 0) {
      problems.push(`${req.where}.parent.id 缺失/非字符串（实际：${describeValue(id)}）`);
    }
  }

  if (problems.length === 0) return;

  throw new Error(
    "cohub: activation 契约自检失败" + subject + "——双写兼容契约被破坏，以下字段在对应位置缺失或非法：\n"
    + problems.map(p => "  - " + p).join("\n") + "\n"
    + "为什么要求双写：0.2.2-rc.1 宿主从 spec.request 读 parent/prompt，0.2.2-rc.3 宿主改从 spec 顶层读"
    + "（直接读 spec.parent.id），两代没有兼容分支。\n"
    + "修复：构造 startActivation 入参时，把同一份 parent/prompt 同时写进 spec 顶层与 spec.request"
    + "（见 delegate.ts 的 startSubagentRunOnce）。",
  );
}

/** 值的安全短描述（错误文案用，避免把大对象打进 message） */
function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(length=${value.length})`;
  if (typeof value === "object") return "对象";
  if (typeof value === "string") return value.length > 40 ? `字符串(${JSON.stringify(value.slice(0, 40))}…)` : `字符串(${JSON.stringify(value)})`;
  return typeof value;
}

/** 裸 TypeError 特征：读 undefined/null 的属性 */
const CANNOT_READ_RE = /Cannot read (?:properties|property)/i;
/** 读的是哪个键（'id' / 'parent' / 'prompt'，兼容双引号/单引号/无引号） */
const READING_KEY_RE = /\breading ['"`]?(id|parent|prompt)\b/i;

/**
 * 把宿主的裸 TypeError 翻译成可读归因文本。
 *
 * 只在「确实是读 undefined/null 的属性」且「读的键属于 id / parent / prompt」时返回文本；
 * 其它错误一律返回 undefined（调用方按原样处理，不改变既有错误语义）。
 *
 * 调用方约定：**保留原始 message**（把本函数返回值作为补充/后缀），
 * 因为现有测试把 orchestrator.md 里的报错原文当契约（test/unit.ts:147 一类的原文断言）。
 */
export function describeActivationContractError(err: unknown): string | undefined {
  const error = err instanceof Error ? err : undefined;
  if (error === undefined) return undefined;
  const isTypeError = err instanceof TypeError || error.name === "TypeError";
  if (!isTypeError) return undefined;
  const message = error.message;
  if (!CANNOT_READ_RE.test(message)) return undefined;
  const keyMatch = READING_KEY_RE.exec(message);
  if (keyMatch === null) return undefined;
  const key = keyMatch[1] ?? "id";

  const layerHint = key === "id"
    ? "宿主读的是某层 parent 的 .id，说明它读的 parent 层级里 parent 是 undefined（第三层迁移 / 字段改名）"
    : key === "parent"
      ? "宿主读的是某层的 .parent，说明它期望的容器层不存在（例如 spec.request 或更深的 agent 层缺失）"
      : "宿主读的是某层的 .prompt，说明它期望的容器层不存在（prompt 未写在宿主读取的那一层）";

  return "宿主 activation 契约不匹配（cohub 归因）：\n"
    + `  - 症状：startActivation 内读取 ${key} 时命中 undefined（原始 TypeError 如上）。\n`
    + "  - 两代差异：0.2.2-rc.1 读 spec.request.parent / spec.request.prompt；"
    + "0.2.2-rc.3 读 spec 顶层 spec.parent / spec.prompt（直接读 spec.parent.id）。\n"
    + `  - 推断：${layerHint}。\n`
    + "  - 修复指引：检查 startActivation 入参是否同时具备 spec 顶层与 spec.request 的 parent/prompt"
    + "（delegate.ts 的 startSubagentRunOnce 已双写；若仍报此错，说明宿主读取路径又变了，"
    + "需对照该版本 subagent/lib/index.js 的 startActivation 实际读取路径补上第三处写入）。";
}

/** probeActivationSpecShape 的返回：当前实现只产出 confident:false 这一支 */
export interface ActivationShapeProbe {
  /** 是否已静态确定宿主读哪一层；当前实现恒为 false（见下方注释） */
  confident: false;
  /** 无法确定的原因 */
  reason: string;
  /** 只读观察到的事实（供人工排查，不含任何 spawn 行为） */
  hints: string[];
}

/**
 * 静态推断宿主可能从哪一层读 parent/prompt —— **当前实现刻意不做判断**。
 *
 * 为什么静态探测不可靠（这段就是「不实现」的理由，留档避免后人反复尝试）：
 *   1) arity 无区分度：两代 startActivation 都是 (spec) 单参，Function#length 恒为 1；
 *   2) 函数名无区分度：两代都叫 startActivation（bundle 后甚至可能被压缩改名）；
 *   3) Function#toString 在宿主 bundle（app.asar 内 esbuild 产物、可能 minify/闭包化）里
 *      只能看到源码文本，不能证明**运行期实际执行分支**，静态 grep 命中的字符串可能是死代码、
 *      也可能是兜底分支，据此下结论会把「误判」变成「错写一层」；
 *   4) 唯一可靠判据是「跑一次」——而本模块明确不 spawn（契约自检的价值就在于派发前零副作用），
 *      真 spawn 一次来探形既浪费一个子运行，也会污染会话；
 *   5) 宿主的读取路径还可能来自 prepareContinuable / startLocalNamed / startExternalNamed 等
 *      多层转接（rc.3 的 spawn 路径在 startLocalNamed 里按名取字段），单点静态观察覆盖不到。
 *
 * 因此这里只做**只读观察**并回传 hint；结论交给人（或未来的运行期遥测）。调用方可忽略返回值。
 */
export function probeActivationSpecShape(ctx: unknown): ActivationShapeProbe {
  const hints: string[] = [];
  const subagents = asRecord(ctx)?.subagents;
  const startActivation = asRecord(subagents)?.startActivation;
  if (typeof startActivation !== "function") {
    hints.push("ctx.subagents.startActivation 不可用（非 0.2.2-rc.1+ 宿主或探测时机过早）");
    return { confident: false, reason: "拿不到 startActivation，无法观察", hints };
  }
  const fn = startActivation as { name?: string; length?: number };
  hints.push(`startActivation.name=${JSON.stringify(fn.name ?? "")}，length=${String(fn.length)}（两代都是单参，无区分度）`);
  try {
    const source = Function.prototype.toString.call(startActivation);
    if (source.includes("[native code]")) {
      hints.push("函数体不可见（native/bound），静态扫描无效");
    } else {
      if (source.includes(".request.parent") || source.includes(".request.prompt")) {
        hints.push("函数体出现 .request.parent / .request.prompt 文本（疑似 rc.1 读法；也可能是兜底分支，不能据此下结论）");
      }
      if (/[A-Za-z_$][\w$]*\.parent\b/.test(source)) {
        hints.push("函数体出现 <x>.parent 文本（疑似顶层读法；bundle/minify 后文本不可作为证据）");
      }
    }
  } catch {
    hints.push("读取函数源码失败（toString 被拦截），静态扫描不可用");
  }
  return {
    confident: false,
    reason: "静态信息（arity/name/源码文本）都不能证明运行期实际读取路径；可靠判据只有真跑一次，而本模块不 spawn",
    hints,
  };
}
