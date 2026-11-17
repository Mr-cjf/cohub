// dsh-cohub/test/output-contract.ts —— 输出契约（src/output-contract.ts）门禁
//
// 覆盖：
//   ① resolveOutputContract：等级归一（缺省/未知 → off）、'lite' 透传、未知角色 schema undefined；
//   ② DEFAULT_OUTPUT_CONTRACTS 12 份：每份用一条**合规样例**过 validateAgainstContract，
//      另加「缺必填 / 类型错 / 枚举错 / 数组元素错」四类负例（断言 errors 含 `$.字段` / `$.字段[0]` 路径）；
//   ③ describeContractForPrompt：12 份逐一 ≤400 字符（截断路径另用巨型契约验证）；
//   ④ extractJsonCandidate / validateContractText：纯 JSON / ```json 围栏 / 正文夹 {...} 三形态都提取成功；
//      含花括号示例在前、真 JSON 在后的噪声文本**不得**被误判为合规；
//   ⑤ formatContractViolation：以 `[契约]` 开头且 ≤500 字符；
//   ⑥ 三级行为差（桩驱动真实 delegate 链路，本文件重点）：
//        off    → prompt 不含「输出契约」、不校验、无 contractViolated；
//        lite   → 违约只标记不重写（spawn=1），合规不标记；
//        strict → 违约重写一次（spawn=2）、二次仍违约仍只 spawn=2、首次合规 spawn=1。
//
// 定位：全部离线。子代理用与 test/runtime-0.2.ts 层 3b 同构的 `ctx.subagents.startActivation` 桩，
//       契约注入 / 校验 / 重写分支都是 src 的真实代码，只把「模型」换成本地桩。
// 用法：node test/output-contract.ts（node >= 24 类型剥离）
import {
  DEFAULT_OUTPUT_CONTRACTS,
  OUTPUT_CONTRACT_PROMPT_MAX_CHARS,
  resolveOutputContract,
  validateAgainstContract,
  describeContractForPrompt,
  extractJsonCandidate,
  validateContractText,
  formatContractViolation,
} from "../src/output-contract.ts";
import type { OutputContractSchema } from "../src/output-contract.ts";
import { createDelegateTool } from "../src/delegate.ts";
import type { SkillRouteConfig } from "../src/delegate.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string) {
  console.log("===== " + title + " =====");
}

/** 把 validateAgainstContract 的联合结果收敛成 errors 数组（通过 = 空数组） */
function errorsOf(result: { ok: true } | { ok: false; errors: string[] }): string[] {
  return result.ok ? [] : result.errors;
}

/**
 * 按契约生成一条合规样例值。
 * 刻意**不复用** src 的私有 exampleValue：样例必须由独立实现生成，
 * 否则「合规样例能过校验」就退化成拿自己的实现证明自己。
 */
function sampleFor(schema: OutputContractSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const first = schema.oneOf[0];
    return first === undefined ? null : sampleFor(first);
  }
  if (schema.type === "array") return [sampleFor(schema.items ?? { type: "string" })];
  if (schema.type === "object" || schema.properties !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties ?? {})) out[name] = sampleFor(child);
    return out;
  }
  if (schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  return "示例文本";
}

/** 带 JSON 语义的字段路径断言：`$.verification`、`$.findings[0]` 必须出现在 errors 里 */
function hasPath(errors: string[], path: string): boolean {
  return errors.some(e => e.startsWith(path + ":"));
}

// ── 用例 1：resolveOutputContract 的等级归一与查表 ──
{
  group("用例 1：resolveOutputContract 等级归一 / 查表");
  const def = resolveOutputContract("co-explorer");
  check("缺省等级为 off", def.level === "off");
  check("缺省仍返回非空 schema", def.schema !== undefined && Object.keys(def.schema).length > 0);
  check("schema.type = object", def.schema?.type === "object");
  check("显式 lite 生效", resolveOutputContract("co-explorer", "lite").level === "lite");
  check("显式 strict 生效", resolveOutputContract("co-explorer", "strict").level === "strict");
  check("'bogus' 归一到 off", resolveOutputContract("co-explorer", "bogus" as any).level === "off");
  check("空串等级归一到 off", resolveOutputContract("co-explorer", "" as any).level === "off");
  check("undefined 等级归一到 off", resolveOutputContract("co-explorer", undefined).level === "off");
  check("未知角色（co-cordis）schema 为 undefined", resolveOutputContract("co-cordis", "strict").schema === undefined);
  check("完全未知名 schema 为 undefined", resolveOutputContract("not-a-role").schema === undefined);
  check("裸角色名归一（explorer → co-explorer）",
    resolveOutputContract("explorer").schema === DEFAULT_OUTPUT_CONTRACTS["co-explorer"]);
  check("首尾空白被 trim 后再查表",
    resolveOutputContract("  co-fixer  ").schema === DEFAULT_OUTPUT_CONTRACTS["co-fixer"]);
  check("空名不误命中（schema undefined + off）",
    resolveOutputContract("").schema === undefined && resolveOutputContract("").level === "off");
}

// ── 用例 2：12 份默认契约各有一条合规样例；四类负例带字段路径 ──
{
  group("用例 2：12 份默认契约——合规样例 + 四类负例");
  const names = Object.keys(DEFAULT_OUTPUT_CONTRACTS);
  check("默认契约恰为 12 份", names.length === 12);
  check("含 co-orchestrator（调度摘要单字段）", names.includes("co-orchestrator"));
  check("不含 co-cordis（创作过程无一次性结构化产出）", !names.includes("co-cordis"));
  check("每份都是 object 且 required ⊆ properties", names.every(name => {
    const schema = DEFAULT_OUTPUT_CONTRACTS[name];
    if (schema === undefined) return false;
    const props = schema.properties ?? {};
    return schema.type === "object" && (schema.required ?? []).every(field => field in props);
  }));

  const invalid: string[] = [];
  for (const name of names) {
    const schema = DEFAULT_OUTPUT_CONTRACTS[name];
    if (schema === undefined) { invalid.push(name + ": schema 缺失"); continue; }
    const sample = sampleFor(schema);
    const res = validateAgainstContract(sample, schema);
    if (!res.ok) invalid.push(name + ": " + res.errors.join("；"));
    // 缺必填负例对 12 份逐一生效（{} 必然违反 required）
    const empty = errorsOf(validateAgainstContract({}, schema));
    if (empty.length === 0) invalid.push(name + ": 空对象竟通过校验");
    if (!empty.every(e => e.startsWith("$."))) invalid.push(name + ": 必填错误路径未以 $. 开头");
  }
  check("12 份合规样例全部通过校验", invalid.length === 0);
  if (invalid.length > 0) console.log("    失败详情: " + invalid.join(" | "));

  // 负例 ①：缺必填 → 路径 $.verification（co-fixer 有 changed/verification 两个必填）
  const missing = errorsOf(validateAgainstContract({ changed: [] }, DEFAULT_OUTPUT_CONTRACTS["co-fixer"]));
  check("缺必填负例：errors 含 $.verification", hasPath(missing, "$.verification"));
  check("缺必填负例：错误文案点明「缺少必填字段」", missing.some(e => e.includes("缺少必填字段")));
  check("缺必填负例：已给字段不误报", !hasPath(missing, "$.changed"));

  // 负例 ②：类型错 → 路径 $.changed（声明 array，实际是 string）
  const wrongType = errorsOf(validateAgainstContract(
    { changed: "src/a.ts", verification: "已跑测试" },
    DEFAULT_OUTPUT_CONTRACTS["co-fixer"],
  ));
  check("类型错负例：errors 含 $.changed", hasPath(wrongType, "$.changed"));
  check("类型错负例：错误文案给出期望类型", wrongType.some(e => e.includes("期望") && e.includes("string[]")));

  // 负例 ③：枚举错 → 路径 $.verdict（co-oracle 的 pass|fail|unknown）
  const badEnum = errorsOf(validateAgainstContract(
    { verdict: "maybe", reasons: [], anchors: [] },
    DEFAULT_OUTPUT_CONTRACTS["co-oracle"],
  ));
  check("枚举错负例：errors 含 $.verdict", hasPath(badEnum, "$.verdict"));
  check("枚举错负例：错误文案含 enum 白名单", badEnum.some(e => e.includes("enum") && e.includes("pass")));
  const goodEnum = validateAgainstContract(
    { verdict: "pass", reasons: ["r"], anchors: ["src/a.ts:1"] },
    DEFAULT_OUTPUT_CONTRACTS["co-oracle"],
  );
  check("枚举正例：合法枚举值通过", goodEnum.ok === true);

  // 负例 ④：数组元素错 → 路径 $.findings[0]（co-observer 的 findings 是 string[]）
  const badItem = errorsOf(validateAgainstContract(
    { findings: [42], answer: "看起来没问题" },
    DEFAULT_OUTPUT_CONTRACTS["co-observer"],
  ));
  check("数组元素错负例：errors 含 $.findings[0]", hasPath(badItem, "$.findings[0]"));
  const badItem2 = errorsOf(validateAgainstContract(
    { findings: ["正常项", false], answer: "看起来没问题" },
    DEFAULT_OUTPUT_CONTRACTS["co-observer"],
  ));
  check("数组元素错负例：下标精确到具体元素（$.findings[1]）", hasPath(badItem2, "$.findings[1]"));
  check("数组元素错负例：合法元素不误报（无 $.findings[0]）", !hasPath(badItem2, "$.findings[0]"));

  // 额外：非对象输入直接按类型错处理，不进深层校验
  const notObject = errorsOf(validateAgainstContract("整段文本", DEFAULT_OUTPUT_CONTRACTS["co-explorer"]));
  check("非对象输入 → 类型错路径为 $", hasPath(notObject, "$"));
}

// ── 用例 3：describeContractForPrompt 长度上限 ──
{
  group("用例 3：describeContractForPrompt ≤400 字符");
  const names = Object.keys(DEFAULT_OUTPUT_CONTRACTS);
  const tooLong = names.filter(name => {
    const schema = DEFAULT_OUTPUT_CONTRACTS[name];
    return schema === undefined || describeContractForPrompt(schema).length > OUTPUT_CONTRACT_PROMPT_MAX_CHARS;
  });
  check("12 份逐一 ≤400 字符", tooLong.length === 0);
  if (tooLong.length > 0) console.log("    超长: " + tooLong.join(", "));
  check("说明文本以「输出契约」开头且提到 JSON",
    names.every(name => {
      const schema = DEFAULT_OUTPUT_CONTRACTS[name];
      if (schema === undefined) return false;
      const text = describeContractForPrompt(schema);
      return text.startsWith("输出契约") && text.includes("JSON");
    }));
  check("逐字段列出（含必填标注）",
    describeContractForPrompt(DEFAULT_OUTPUT_CONTRACTS["co-fixer"]).includes("- verification: string（必填）"));

  // 截断路径：巨型契约必须硬截断到 400 且以 `…` 收尾
  const huge: OutputContractSchema = { type: "object", properties: {}, required: [] };
  for (let i = 0; i < 60; i += 1) {
    huge.properties![("field_" + i + "_" + "x".repeat(20))] = { type: "string" };
    huge.required!.push("field_" + i + "_" + "x".repeat(20));
  }
  const hugeText = describeContractForPrompt(huge);
  check("巨型契约被截断到 ≤400 字符", hugeText.length <= OUTPUT_CONTRACT_PROMPT_MAX_CHARS);
  check("截断以「…」收尾（不切断成半个字段名）", hugeText.endsWith("…"));
}

// ── 用例 4：extractJsonCandidate / validateContractText 三形态 + 噪声 ──
{
  group("用例 4：JSON 提取三形态 + 噪声不误判");
  const schema = DEFAULT_OUTPUT_CONTRACTS["co-explorer"]!;
  const json = JSON.stringify({ files: ["src/a.ts"], answer: "见 src/a.ts" });

  const pure = extractJsonCandidate(json);
  check("形态①：纯 JSON 提取成功", pure.ok === true);
  check("形态①：值正确", pure.ok === true && (pure.value as any).answer === "见 src/a.ts");
  check("形态①：validateContractText 通过", validateContractText(json, schema).ok === true);

  const fenced = extractJsonCandidate("```json\n" + json + "\n```");
  check("形态②：```json 围栏提取成功", fenced.ok === true && (fenced.value as any).files[0] === "src/a.ts");
  check("形态②：validateContractText 通过", validateContractText("```json\n" + json + "\n```", schema).ok === true);
  check("形态②：无语言标记的围栏也可提取",
    extractJsonCandidate("```\n" + json + "\n```").ok === true);

  const inline = extractJsonCandidate("已完成检索，结论如下：\n\n" + json + "\n\n以上。");
  check("形态③：正文夹 {...} 提取成功", inline.ok === true && (inline.value as any).answer === "见 src/a.ts");
  check("形态③：validateContractText 通过",
    validateContractText("已完成检索，结论如下：\n\n" + json + "\n\n以上。", schema).ok === true);

  const empty = extractJsonCandidate("   ");
  check("空文本提取失败且给出原因", empty.ok === false && empty.reason.length > 0);
  const emptyCheck = validateContractText("   ", schema);
  check("空文本校验失败且错误路径形如 `$:`",
    emptyCheck.ok === false && emptyCheck.errors.length > 0 && emptyCheck.errors[0]!.startsWith("$:"));

  // 噪声 1：花括号示例（本身是合法 JSON，但不符合契约）在前，真 JSON 在后
  const noise1 = "格式示例：{\"files\":[]} 才是正确的写法。真正的结果：{\"files\":[\"src/a.ts\"],\"answer\":\"见 src/a.ts\"}";
  const noise1Check = validateContractText(noise1, schema);
  check("噪声①：取到前面的示例 → 判违约（不误判为合规）", noise1Check.ok === false);
  check("噪声①：违约原因指向漏掉的字段（$.answer）",
    noise1Check.ok === false && hasPath(noise1Check.errors, "$.answer"));

  // 噪声 2：正文里的未配平 `{` 不会让提取期扫到后面的真 JSON 就认定合规
  const noise2 = "用 { 表示对象，用 } 表示结束。最终输出 {\"files\":[\"src/a.ts\"],\"answer\":\"见 src/a.ts\"}";
  check("噪声②：未配平花括号在前 → 提取失败（判违约）", extractJsonCandidate(noise2).ok === false);
  check("噪声②：validateContractText 同样判违约", validateContractText(noise2, schema).ok === false);
}

// ── 用例 5：formatContractViolation 形态 ──
{
  group("用例 5：formatContractViolation 以 [契约] 开头且 ≤500 字符");
  const one = formatContractViolation(["$.verification: 缺少必填字段（期望 string）"]);
  check("以 [契约] 开头", one.startsWith("[契约]"));
  check("保留原始错误细节", one.includes("$.verification") && one.includes("缺少必填字段"));
  check("单条错误远小于 500 字符", one.length <= 500);
  const none = formatContractViolation([]);
  check("空错误列表也有兜底文案", none.startsWith("[契约]") && none.includes("未提供错误详情"));
  const many = formatContractViolation(Array.from({ length: 60 }, (_v, i) => "$.f" + i + ": " + "错".repeat(100)));
  check("超长错误列表仍 ≤500 字符", many.length <= 500);
  check("超长时以「…」收尾", many.endsWith("…"));
}

// ── 用例 6：三级行为差（off / lite / strict，桩驱动真实 delegate 链路）──
{
  group("用例 6：三级行为差（off 不注入不校验 / lite 只标记 / strict 重写一次）");

  const GARBAGE = "这就是一段普通说明文字，没有任何 JSON。";
  const LEGAL = JSON.stringify({ files: ["src/a.ts"], answer: "见 src/a.ts" });

  interface DelegateRun {
    text: string;
    spawns: number;
    prompts: string[];
    reports: any[];
  }

  /** 与 test/runtime-0.2.ts 同构的 startActivation 桩；env 契约关掉以让 prompt 可判读 */
  async function runDelegate(options: {
    routes: SkillRouteConfig[];
    respond: (spawnNo: number) => { output: Array<{ type: string; text: string }>; stopReason: string };
  }): Promise<DelegateRun> {
    const prompts: string[] = [];
    const reports: any[] = [];
    let spawns = 0;
    const ctx: any = {
      logger: { info: () => {}, warn: () => {} },
      llm: { listProviders: () => [], listModels: async () => [] },
      subagents: {
        async startActivation(spec: any) {
          spawns += 1;
          if (!spec?.parent || !spec?.prompt) {
            throw new Error("startActivation spec 必须双写顶层 parent/prompt（0.2.2-rc.3 只读 spec.parent）");
          }
          const blocks: any[] = Array.isArray(spec.prompt) ? spec.prompt : [];
          prompts.push(blocks.map((b: any) => String(b?.text ?? "")).join("\n"));
          return {
            childId: "d" + spawns,
            messageId: "dm" + spawns,
            result: Promise.resolve(options.respond(spawns)),
            async dispose() {},
          };
        },
      },
    };
    const tool: any = createDelegateTool(ctx, () => options.routes, { delegateEnvContract: { enabled: false } });
    const text: string = await tool.execute(
      { skill: "co-explorer", prompt: "查一下 src/a.ts" },
      {
        agent: { id: "p-contract", session: { header: { delegationDepth: 0 } } },
        signal: new AbortController().signal,
        onDelegateResult: (payload: any) => { reports.push(payload); },
      },
    );
    return { text, spawns, prompts, reports };
  }

  // ① off：默认等级——不注入、不校验、无 contractViolated
  const offRun = await runDelegate({
    routes: [{ name: "co-explorer" }],
    respond: () => ({ output: [{ type: "text", text: GARBAGE }], stopReason: "completed" }),
  });
  check("off：spawn=1（不重写）", offRun.spawns === 1);
  check("off：prompt 不含「输出契约」字样", !String(offRun.prompts[0] ?? "").includes("输出契约"));
  check("off：非 JSON 结果被原样返回（不校验）", offRun.text === GARBAGE);
  check("off：结果不带 [契约] 标记", !offRun.text.includes("[契约]"));
  check("off：onDelegateResult 从未被调用（无 contractViolated）", offRun.reports.length === 0);

  // ② lite：注入 + 校验 + 只标记，绝不重写
  const liteRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "lite" }],
    respond: () => ({ output: [{ type: "text", text: GARBAGE }], stopReason: "completed" }),
  });
  check("lite：prompt 注入「输出契约」段", String(liteRun.prompts[0] ?? "").includes("输出契约"));
  check("lite：违约不重写（spawn=1）", liteRun.spawns === 1);
  check("lite：结果保留首次正文并追加 [契约] 标记",
    liteRun.text.includes(GARBAGE) && liteRun.text.includes("[契约]"));
  check("lite：无 JSON 时标记走「提取失败」路径（$:）", liteRun.text.includes("$:"));
  check("lite：上报一次 contractViolated", liteRun.reports.length === 1 && liteRun.reports[0]?.contractViolated === true);

  // lite + 有 JSON 但漏字段：标记必须精确指向字段路径（$.answer），而不是笼统的「不合法」
  const liteFieldRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "lite" }],
    respond: () => ({ output: [{ type: "text", text: JSON.stringify({ files: [] }) }], stopReason: "completed" }),
  });
  check("lite：漏字段时标记含字段路径（$.answer）",
    liteFieldRun.spawns === 1 && liteFieldRun.text.includes("$.answer"));

  const liteOkRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "lite" }],
    respond: () => ({ output: [{ type: "text", text: LEGAL }], stopReason: "completed" }),
  });
  check("lite：合规时无标记且不外报", liteOkRun.spawns === 1
    && liteOkRun.text === LEGAL && !liteOkRun.text.includes("[契约]") && liteOkRun.reports.length === 0);

  // ③ strict：违约重写一次
  const strictRetryRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "strict" }],
    respond: n => ({
      output: [{ type: "text", text: n === 1 ? GARBAGE : LEGAL }],
      stopReason: "completed",
    }),
  });
  check("strict：违约 → 重写（spawn=2）", strictRetryRun.spawns === 2);
  check("strict：重写 prompt 带 [契约重写] 说明",
    String(strictRetryRun.prompts[1] ?? "").includes("[契约重写]"));
  check("strict：重写合规 → 返回第二次结果且无标记",
    strictRetryRun.text === LEGAL && !strictRetryRun.text.includes("[契约]"));
  check("strict：重写成功不报 contractViolated", strictRetryRun.reports.length === 0);

  const strictTwiceRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "strict" }],
    respond: () => ({ output: [{ type: "text", text: GARBAGE }], stopReason: "completed" }),
  });
  check("strict：二次仍违约 → 仍只 spawn=2（绝不第三次）", strictTwiceRun.spawns === 2);
  check("strict：二次仍违约 → 追加 [契约] 标记", strictTwiceRun.text.includes("[契约]"));
  check("strict：二次仍违约 → 上报 contractViolated",
    strictTwiceRun.reports.length === 1 && strictTwiceRun.reports[0]?.contractViolated === true);

  const strictOkRun = await runDelegate({
    routes: [{ name: "co-explorer", outputContract: "strict" }],
    respond: () => ({ output: [{ type: "text", text: LEGAL }], stopReason: "completed" }),
  });
  check("strict：首次合规 → spawn=1（不重写）", strictOkRun.spawns === 1);
  check("strict：首次合规 → 结果为原样 JSON 且无标记",
    strictOkRun.text === LEGAL && !strictOkRun.text.includes("[契约]"));
  check("strict：首次合规 → 不外报 contractViolated", strictOkRun.reports.length === 0);

  // 三级幂等对照：同一段违约输入的派发次数必须严格递增 1 → 1 → 2
  check("三级派发次数对照 off=1 / lite=1 / strict=2",
    offRun.spawns === 1 && liteRun.spawns === 1 && strictTwiceRun.spawns === 2);
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
