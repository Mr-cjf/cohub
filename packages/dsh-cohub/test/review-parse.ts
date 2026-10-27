// test/review-parse.ts —— extractJsonArray 解析健壮性单测（B-2 真机回归）
//
// 真机根因：模型输出被 maxTokens 截断（没有结尾 `]`），旧实现用 lastIndexOf("]") 定位结尾，
// 于是 slice 到 -1 拿到半截 JSON，必然 parse 失败，整份 findings 被丢弃。
// 覆盖 5 种输入：纯数组 / Markdown 围栏 / 前后说明文字 / 尾随逗号 / 被截断。
// 用法：node test/review-parse.ts（node >= 24 类型剥离）
import assert from "node:assert";
import { extractJsonArray } from "../src/review-command.ts";

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

/** 一条合法的 finding 对象（贴近真实模型输出形状） */
const obj = (n: number) =>
  `{"kind":"observation","text":"第 ${n} 条结论","evidence":[{"sessionId":"session-c9cd5d0c","turn":1,"seq":${n}}],"limitations":[]}`;

// ---- 用例 a：纯 JSON 数组 ----
{
  console.log("===== 用例 a：纯 JSON 数组 =====");
  const raw = `[${obj(1)},${obj(2)}]`;
  const r = extractJsonArray(raw);
  check("能解析出 2 条", () => assert.equal(r.items?.length, 2));
  check("未标记 truncated", () => assert.equal(r.truncated, false));
}

// ---- 用例 b：包了 ```json 围栏 ----
{
  console.log("===== 用例 b：Markdown 围栏 =====");
  const raw = "```json\n[" + obj(1) + "," + obj(2) + "," + obj(3) + "]\n```";
  const r = extractJsonArray(raw);
  check("剥围栏后解析出 3 条", () => assert.equal(r.items?.length, 3));
  check("未标记 truncated", () => assert.equal(r.truncated, false));
}

// ---- 用例 c：前缀说明文字 + JSON + 后缀说明 ----
{
  console.log("===== 用例 c：前后有说明文字 =====");
  const raw = "以下是分析结果：\n[" + obj(1) + "," + obj(2) + "]\n以上是分析结果，请复核。";
  const r = extractJsonArray(raw);
  check("忽略前后文字解析出 2 条", () => assert.equal(r.items?.length, 2));
  check("未标记 truncated", () => assert.equal(r.truncated, false));
}

// ---- 用例 d：尾随逗号（非严格 JSON） ----
{
  console.log("===== 用例 d：尾随逗号 =====");
  const raw = `[${obj(1)},${obj(2)},]`;
  const r = extractJsonArray(raw);
  check("修复尾随逗号后解析出 2 条", () => assert.equal(r.items?.length, 2));
  check("未标记 truncated", () => assert.equal(r.truncated, false));
}

// ---- 用例 e：被截断（末尾缺 `]`，真机故障形状） ----
{
  console.log("===== 用例 e：输出被截断 =====");
  // 第 3 条对象写到一半就断了（模拟 maxTokens 截断）
  const raw = "[" + obj(1) + "," + obj(2) + ',{"kind":"observation","text":"第三条被截断的结论","evid';
  const r = extractJsonArray(raw);
  check("抢救出 2 条完整对象", () => assert.equal(r.items?.length, 2));
  check("明确标记 truncated=true", () => assert.equal(r.truncated, true));
  check("抢救出的对象内容正确", () => assert.equal((r.items?.[1] as any)?.text, "第 2 条结论"));
}

// ---- 用例 f：完全无法解析 → items=null，不抛错 ----
{
  console.log("===== 用例 f：无 JSON 内容 =====");
  check("纯文字返回 items=null", () => assert.equal(extractJsonArray("抱歉，我无法完成该分析。").items, null));
  check("空字符串返回 items=null", () => assert.equal(extractJsonArray("").items, null));
  check("非字符串入参不抛错", () => assert.equal(extractJsonArray(undefined).items, null));
  check("空数组返回 0 条（非 null）", () => assert.equal(extractJsonArray("[]")?.items?.length, 0));
}

console.log("");
const allOk = fail === 0;
console.log("结果: " + pass + " PASS / " + fail + " FAIL");
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
