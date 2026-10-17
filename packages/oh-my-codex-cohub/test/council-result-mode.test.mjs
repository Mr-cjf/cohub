import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { packageRoot } from "../scripts/validate.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "cohub-codex-mode-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home,
    COHUB_CONFIG: "", COHUB_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "", MINIMAX_API_KEY: "" } };
}

function client(t, env) {
  const child = spawn(process.execPath, [resolve(packageRoot, "mcp/council_server.mjs")], {
    cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  t.after(() => { lines.close(); child.kill(); });
  return (method, params = {}) => new Promise((resolveResponse, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`MCP timed out: ${method}; ${stderr}`));
    }, 5000);
    pending.set(requestId, { resolve: resolveResponse, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
}

function councilServer(t, { withBroken = false, long = false, chairMode = "ok" } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    if (withBroken && payload.model === "broken") {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("broken councillor boom");
      return;
    }
    if (payload.model === "chair" && chairMode === "http500") {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("chair boom");
      return;
    }
    // chair 用固定模拟响应、不含成员专有标记（"详尽论证与依据。" 仅由长文成员返回），
    // 使 summary 全结果层面断言成员原文省略成立的同时，chair 综合仍被完整保留。
    // chairMode: empty=空 content、blank=仅空白 content，均视为无可用综合。
    const content = payload.model === "chair"
      ? chairMode === "empty"
        ? ""
        : chairMode === "blank"
          ? "   \n\t "
          : `成员正文 chair 的综合结论，保留完整要点。`
      : long
        ? `成员正文 ${payload.model} 的长篇观点。` + "详尽论证与依据。".repeat(400)
        : `成员正文 ${payload.model} 的长篇观点，用于验证 full/summary 是否省略。`;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ requests, port: server.address().port })));
}

async function setupCouncil(t, { withBroken = false, long = false, chairMode = "ok", chair = true } = {}) {
  const { home, env } = fixture(t);
  const { requests, port } = await councilServer(t, { withBroken, long, chairMode });
  const alpha = { provider: "local", model: "alpha" };
  const beta = { provider: "local", model: "beta" };
  const broken = { provider: "local", model: "broken" };
  const chairConfig = chair === false ? {}
    : chair === "incomplete" ? { chair: { provider: "local" } }
      : { chair: { provider: "local", model: "chair" } };
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ council: {
    default_preset: "local", retries: 0, timeout_ms: 1000,
    providers: { local: { base_url: `http://127.0.0.1:${port}/v1`, api_key_env: "COHUB_TEST_KEY" } },
    presets: { local: withBroken ? { alpha, beta, broken } : { alpha, beta } },
    ...chairConfig,
  } }));
  const rpc = client(t, { ...env, COHUB_CONFIG: config, COHUB_TEST_KEY: "fixture-key" });
  return { rpc, requests };
}

test("default council_session omitting result_mode keeps old full behavior, member and chair bodies intact", async (t) => {
  const { rpc } = await setupCouncil(t);
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review" } });
  assert.equal(response.result.isError, false);
  const text = response.result.content[0].text;
  for (const model of ["alpha", "beta", "chair"]) assert.ok(text.includes(`成员正文 ${model}`), `${model} full body present by default`);
  assert.doesNotMatch(text, /视图：summary/);
});

test("explicit result_mode=full equals default full output", async (t) => {
  const { rpc } = await setupCouncil(t);
  const def = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review" } });
  const full = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "full" } });
  assert.equal(def.result.content[0].text, full.result.content[0].text);
  assert.ok(full.result.content[0].text.includes("成员正文 chair"));
});

test("result_mode=summary omits member bodies but keeps full chair synthesis and member metadata", async (t) => {
  const { rpc } = await setupCouncil(t);
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  assert.equal(response.result.isError, false);
  const text = response.result.content[0].text;
  // 成员长篇正文省略
  assert.doesNotMatch(text, /成员正文 alpha/);
  assert.doesNotMatch(text, /成员正文 beta/);
  // chair 最终综合完整保留
  assert.match(text, /成员正文 chair/);
  // 可核验元信息：名称、状态、原始长度、省略标记
  assert.match(text, /## alpha（模型：alpha）/);
  assert.match(text, /状态：成功/);
  assert.match(text, /原始长度：\d+ 字符/);
  assert.match(text, /已省略/);
  assert.match(text, /视图：summary/);
});

test("summary keeps full errors and never marks failure as success; short bodies keep metadata without promising shorter output", async (t) => {
  const { rpc } = await setupCouncil(t, { withBroken: true });
  const summary = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  const full = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "full" } });
  const summaryText = summary.result.content[0].text;
  const fullText = full.result.content[0].text;
  // 失败成员完整错误保留，不省略、不以成功路径呈现
  assert.match(summaryText, /## broken（未取得回复）/);
  assert.match(summaryText, /HTTP 500: broken councillor boom/);
  // 成功成员保留成功状态与元信息
  assert.match(summaryText, /## alpha（模型：alpha）/);
  assert.match(summaryText, /状态：成功/);
  assert.match(summaryText, /原始长度：\d+ 字符/);
  // 短正文（fixture 约 33 字）下元信息开销可能使 summary 不比 full 短，属预期，不宣称一定更省；
  // summary 的字符收益仅在成员正文足够长时有代表性（见长成员原文用例）。
  assert.match(summaryText, /已省略/);
  assert.match(fullText, /成员正文 alpha/);
});

test("summary char win is representative with long member bodies; errors stay complete and chair gets full long text", async (t) => {
  const { rpc, requests } = await setupCouncil(t, { withBroken: true, long: true });
  const summary = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  const full = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "full" } });
  const summaryText = summary.result.content[0].text;
  const fullText = full.result.content[0].text;
  const longMarker = "详尽论证与依据。";
  // 长成员原文下 summary 确实更短：full 含三份长正文，summary 仅含 chair 综合一份。
  // 成员专有标记 "详尽论证与依据。" 仅由长文成员返回，chair 为固定模拟响应、不引用该短语，
  // 故 summary 全结果不含成员原文；chair 综合本身仍完整保留（见 /成员正文 chair/ 断言）。
  assert.ok(summaryText.length < fullText.length, "summary is shorter than full for long member bodies");
  // 成员章节省略长正文，保留可核验元信息
  assert.doesNotMatch(summaryText, new RegExp(longMarker));
  assert.match(summaryText, /原始长度：\d+ 字符/);
  assert.match(summaryText, /已省略/);
  assert.match(fullText, new RegExp(longMarker));
  // 错误仍完整保留，不因长文本模式改变
  assert.match(summaryText, /## broken（未取得回复）/);
  assert.match(summaryText, /HTTP 500: broken councillor boom/);
  // chair 收到的是完整长成员原文，而非摘要视图
  const chairRequests = requests.filter((r) => r.model === "chair");
  assert.ok(chairRequests.length >= 1, "chair was called");
  for (const chair of chairRequests) {
    assert.match(chair.messages[1].content, /成员正文 alpha/);
    assert.match(chair.messages[1].content, new RegExp(longMarker));
    assert.doesNotMatch(chair.messages[1].content, /视图：summary/);
  }
});

test("invalid result_mode is rejected with the server error shape (isError true)", async (t) => {
  const { rpc } = await setupCouncil(t);
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "brief" } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /无效 result_mode "brief"/);
  assert.match(response.result.content[0].text, /summary/);
  assert.match(response.result.content[0].text, /full/);
});

test("chair still receives the full member results when result_mode=summary", async (t) => {
  const { rpc, requests } = await setupCouncil(t);
  await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  const chair = requests.find((request) => request.model === "chair");
  assert.ok(chair, "chair was called");
  // chair 综合基于完整成员结果，未先截成员再送 chair
  assert.match(chair.messages[1].content, /成员正文 alpha/);
  assert.match(chair.messages[1].content, /成员正文 beta/);
});

test("summary with no chair configured falls back to full: all member bodies returned, reason explained", async (t) => {
  const { rpc } = await setupCouncil(t, { chair: false });
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  assert.equal(response.result.isError, false);
  const text = response.result.content[0].text;
  // 显式说明请求 summary、实际回退 full 及具体原因
  assert.match(text, /请求视图为 summary/);
  assert.match(text, /未配置 chair 模型/);
  assert.match(text, /已回退为 full/);
  // 成员观点完整返回，不损失新信息；不再是 summary 视图
  assert.match(text, /成员正文 alpha/);
  assert.match(text, /成员正文 beta/);
  assert.doesNotMatch(text, /视图：summary/);
  assert.doesNotMatch(text, /正文：已省略/);
  assert.match(text, /> 未配置 chair 模型，请由主代理综合以上观点形成共识。/);
});

test("summary with incomplete chair config falls back to full and keeps chair skip info", async (t) => {
  const { rpc } = await setupCouncil(t, { chair: "incomplete" });
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  const text = response.result.content[0].text;
  assert.match(text, /请求视图为 summary/);
  assert.match(text, /chair 配置不完整/);
  assert.match(text, /已回退为 full/);
  assert.match(text, /成员正文 alpha/);
  assert.match(text, /## 共识主席（未取得回复）\nchair 配置不完整/);
});

test("summary falls back to full when chair returns empty or blank response, chair error kept", async (t) => {
  for (const chairMode of ["empty", "blank"]) {
    await t.test(`chair ${chairMode} response`, async (t) => {
      const { rpc } = await setupCouncil(t, { chairMode });
      const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
      const text = response.result.content[0].text;
      assert.match(text, /请求视图为 summary/);
      assert.match(text, /chair 调用失败：空响应/);
      assert.match(text, /已回退为 full/);
      assert.match(text, /成员正文 alpha/);
      assert.match(text, /## 共识主席（未取得回复）\n空响应/);
    });
  }
});

test("summary with chair HTTP failure falls back to full and keeps all member bodies and errors", async (t) => {
  const { rpc } = await setupCouncil(t, { chairMode: "http500", withBroken: true });
  const response = await rpc("tools/call", { name: "council_session", arguments: { prompt: "Review", result_mode: "summary" } });
  const text = response.result.content[0].text;
  assert.match(text, /请求视图为 summary/);
  assert.match(text, /chair 调用失败：HTTP 500: chair boom/);
  assert.match(text, /已回退为 full/);
  // 成功成员全文、失败成员错误、chair 错误全部完整
  assert.match(text, /成员正文 alpha/);
  assert.match(text, /## broken（未取得回复）/);
  assert.match(text, /HTTP 500: broken councillor boom/);
  assert.match(text, /## 共识主席（未取得回复）\nHTTP 500: chair boom/);
});
