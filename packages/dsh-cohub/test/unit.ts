// dsh-port/test/unit.ts —— 运行时单元验证（无需 LLM）
// 用法：node test/unit.ts（node >= 24，默认类型剥离）
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import systemPrompt from "@deepseek-ai/dsh-system-prompt";
import skills from "@deepseek-ai/dsh-skill";
import tools from "@deepseek-ai/dsh-tools";
import subagents from "@deepseek-ai/dsh-subagent";
import * as cohub from "../lib/index.js";

const root = new Context();
root.plugin(systemPrompt);
root.plugin(tools);
root.plugin(skills);
root.plugin(subagents);
await new Promise(r => setImmediate(r)); // cordis 插件挂载为异步微任务，需一个 tick

// 模拟 loader 包装：apply(ctx, config)
cohub.apply(root, { councillors: [], councilTimeoutMs: 180_000 });

// ① systemPrompt 服务存在且可调用
console.log('systemPrompt 服务:', typeof root.systemPrompt?.section === 'function' ? 'OK' : 'MISSING');

// ② skills 快照：应含 13 个 co-* 技能
const snap: any = await root.skills.snapshot({});
const names = snap.skills.map((s: any) => s.name).sort();
console.log('技能数:', names.length, '(期望 13)');
console.log('技能清单:', names.join(', '));

const EXPECTED = [
  'co-cordis','co-council','co-designer','co-explorer','co-fixer','co-librarian',
  'co-observer','co-oracle','co-orchestrator','co-planner','co-rule-app','co-rule-project','co-rule-user',
].sort();
const okSkills = JSON.stringify(names) === JSON.stringify(EXPECTED);
console.log('技能清单校验:', okSkills ? 'PASS' : 'FAIL');

// ③ 每个技能内容非空且含中文
const loaded = await Promise.all(names.map(async (n: string) => {
  const s = await root.skills.get(n, {});
  return { n, len: s?.content?.length ?? 0, hasCn: /[\u4e00-\u9fff]/.test(s?.content ?? '') };
}));
for (const { n, len, hasCn } of loaded) {
  console.log(`  ${n}: ${len} 字符, 含中文=${hasCn}`);
}
const okContent = loaded.every(x => x.len > 50 && x.hasCn);
console.log('内容校验:', okContent ? 'PASS' : 'FAIL');

// ③b brief 校验：12 个 skill 均有 brief 且含中文
const { COHUB_SKILLS } = await import('../src/skills.ts');
const okBrief = COHUB_SKILLS.length === 13 && COHUB_SKILLS.every((s: any) => !!s.brief?.trim() && /[\u4e00-\u9fff]/.test(s.brief));
for (const s of COHUB_SKILLS) {
  console.log(`  brief ${s.name}: ${s.brief?.length ?? 0} 字, 含中文=${/[\u4e00-\u9fff]/.test(s.brief ?? '')}`);
}
console.log('brief 校验:', okBrief ? 'PASS' : 'FAIL');

// ③c delegate 注入 brief：委派 co-fixer 应注入 fixer.brief 而非完整 content
const { createDelegateTool } = await import('../src/delegate.ts');
const fixer = COHUB_SKILLS.find((s: any) => s.name === 'co-fixer')!;
let capturedPrompt = '';
const fakeCtx = {
  llm: { listProviders: () => [] },
  logger: { warn: () => {} },
  subagents: {
    // 0.2.1 契约：startActivation(spec)（无 start）；prompt 首块为 persona 前置，任务块紧随其后
    async startActivation(spec: any) {
      const blocks: any[] = Array.isArray(spec?.request?.prompt) ? spec.request.prompt : [];
      // 跳过前置的 persona 块，取任务 prompt
      const taskBlock = blocks.length > 1 && String(blocks[0]?.text ?? '').includes('你是被委派的专职代理')
        ? blocks[1]
        : blocks[0];
      capturedPrompt = taskBlock?.text ?? '';
      return {
        childId: 'child-1',
        messageId: 'msg-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        async dispose() {},
      };
    },
  },
};
const delegateTool = createDelegateTool(fakeCtx, () => []);
await delegateTool.execute(
  { skill: 'co-fixer', prompt: '请修改 src/foo.ts 的拼写错误' },
  { agent: { id: 'parent' }, signal: new AbortController().signal },
);
const okDelegate = capturedPrompt.includes(fixer.brief)
  && capturedPrompt.includes('--- 你的具体任务 ---')
  && capturedPrompt.includes('请修改 src/foo.ts 的拼写错误')
  && !capturedPrompt.includes('破坏性或大范围的 shell 操作前');
console.log('delegate 注入 brief:', okDelegate ? 'PASS' : 'FAIL');

// ③d 编排契约保留：orchestrator 技能关键规则原样存在（纯调度禁止 / schema / 批次 / 失败处理 / 专责审查）
const orchContent = COHUB_SKILLS.find((s: any) => s.name === 'co-orchestrator')!.content;
const ORCH_KEYS: [string, string][] = [
  ['纯调度禁止', '禁止使用任何文件/代码操作工具'],
  ['仅允许调度工具', '仅允许调度工具'],
  ['delegate schema 必填 skill', 'invalid arguments: missing required property "skill"'],
  ['delegate schema 必填 prompt', 'prompt'],
  ['批次限制参数', 'schedule.maxParallelBatch'],
  ['缺省批大小 3', '缺省 3'],
  ['墙钟预算参数', 'wallClockBudgetMs'],
  ['批量并行(工具层 allSettled)', 'Promise.allSettled'],
  ['消息层多 tool_use 并发', 'tool_use'],
  ['写冲突串行', '写冲突'],
  ['失败处理状态枚举', 'completed/failed/error'],
  ['中止断点续跑', '从中断处继续'],
  // 「代码审查/UI 审查必须由专责代理执行」的措辞已迁到 planner.md（:69），
  // 由 test/skills-contract.ts 用例 2 断言，此处不再重复。
  ['planner 审批选项', 'ask_user_question'],
  // 规则1 方案先行：T2/T3 必须先经 co-planner 出方案再执行（两步都断言，防退化成只留其一）
  ['规则1 方案先行', '必须重新走方案流程'],
  ['规则1 方案经 co-planner', '委派 co-planner 制定方案'],
  ['规则1 禁拉全套', '禁止拉全套方案'],
  ['规则4 三问不新增', '低频吗'],
];
let failKeys = 0;
for (const [k, v] of ORCH_KEYS) {
  const ok = orchContent.includes(v);
  console.log(`  契约[${k}]: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failKeys++;
}
const okOrch = failKeys === 0;
console.log('编排契约保留:', okOrch ? 'PASS' : 'FAIL');

// ③e 两层并行语义：第一层子代理内部原生工具并行；第二层代理间独立验收并行
const okLayer1 = orchContent.includes('子代理内部')
  && orchContent.includes('原生工具')
  && orchContent.includes('不按文件数')
  && orchContent.includes('不自动合并');
const okLayer2 = orchContent.includes('可独立执行验收')
  && orchContent.includes('maxParallelBatch')
  && orchContent.includes('缺省 3')
  && orchContent.includes('delegate_batch')
  && orchContent.includes('tool_use');
const okWriteConflict = orchContent.includes('写冲突')
  && orchContent.includes('独立只读同文件可并行');
console.log('第一层(子代理内部工具并行):', okLayer1 ? 'PASS' : 'FAIL');
console.log('第二层(代理间独立验收并行):', okLayer2 ? 'PASS' : 'FAIL');
console.log('写冲突精确限定(非一律同文件串行):', okWriteConflict ? 'PASS' : 'FAIL');
const okLayers = okLayer1 && okLayer2 && okWriteConflict;

// ③f brief 预算：orchestrator / planner brief ≤300 字且含中文
const okBriefBudget = ['co-orchestrator', 'co-planner'].every((n) => {
  const s = COHUB_SKILLS.find((x: any) => x.name === n)!;
  return s.brief.length <= 300 && /[\u4e00-\u9fff]/.test(s.brief);
});
const plannerBrief = COHUB_SKILLS.find((x: any) => x.name === 'co-planner')!.brief;
// planner brief 必须给出完整并行判据（与 skills/planner.md:62-64 一致）：
// 可独立验收 → 并行；不按文件数拆任务；同文件写冲突 → 串行；每批 ≤3。
const okPlannerBrief = plannerBrief.includes('可独立验收')
  && plannerBrief.includes('无依赖/写冲突')
  && plannerBrief.includes('同问题多文件/多搜索交单代理内部并行')
  && plannerBrief.includes('不按文件数')
  && plannerBrief.includes('同文件写冲突串行')
  && plannerBrief.includes('每批≤3');
console.log('brief 预算(≤300/含中文):', okBriefBudget ? 'PASS' : 'FAIL');
console.log('planner brief 并行判据(独立验收/非文件数/写冲突/批上限):', okPlannerBrief ? 'PASS' : 'FAIL');

// ③f2 orchestrator brief 并行/专责语义：brief 受 ≤300 字硬约束，只承载高层契约；
// 正文 orchestrator.md 的细粒度并行语义由 ③e 断言（子代理内部聚合 / 独立验收并行 / 写冲突精确限定）。
const orchBrief = COHUB_SKILLS.find((x: any) => x.name === 'co-orchestrator')!.brief;
const okOrchBrief = orchBrief.includes('并行省墙钟')                    // 并行是为了省墙钟而非凑数
  && orchBrief.includes('无第二个独立任务时单 delegate 即推荐')          // 反向：无独立任务不并行
  && orchBrief.includes('单批≤maxParallelBatch')                        // 批次上限语义完整
  && orchBrief.includes('纯调度')                                       // 纯调度禁止保留
  && orchBrief.includes('ask_user_question')                            // 审批工具保留
  && orchBrief.includes('co-fixer')                                     // 执行专责保留
  && orchBrief.includes('co-designer')                                  // 专责保留：UI/视觉类才派 co-designer
  && orchBrief.includes('已核实事实')                                    // 增量边界（不重跑探索）保留
  && orchBrief.includes('T0') && orchBrief.includes('T3')               // 任务分档保留
  && orchBrief.includes('≤10 分钟')                                     // 单执行墙钟预算保留
  && !orchBrief.includes('同文件/依赖串行');                             // 负断言：旧笼统"同文件一律串行"语义已删除
console.log('orchestrator brief 语义(专责co-designer/墙钟优先/批次上限/档位):', okOrchBrief ? 'PASS' : 'FAIL');

// ③g 生成源一致：COHUB_SKILLS.content 与磁盘 skills/*.md 完全一致（需先 bun run build 重新生成）
// 磁盘文件按 checkout 可能为 CRLF/CR，而模板字面量运行时恒为 LF：比较前仅规范化换行，其余字符/空格/内容严格相等
const normalizeEol = (t: string) => t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const okNorm = normalizeEol('a\r\nb\rc\nd') === 'a\nb\nc\nd' && normalizeEol('a\r\nb') !== normalizeEol('a\r\nx');
console.log('换行规范化(CRLF/CR→LF 等价, 实质字符变化仍区分):', okNorm ? 'PASS' : 'FAIL');
const SKILLS_DIR = path.join(import.meta.dirname, '..', 'skills');
let genMismatch = 0;
for (const s of COHUB_SKILLS) {
  const disk = readFileSync(path.join(SKILLS_DIR, `${s.name.replace('co-', '')}.md`), 'utf-8');
  if (normalizeEol(disk) !== s.content) { genMismatch++; console.log(`  源不一致: ${s.name}（请先 bun run build）`); }
}
const okGen = genMismatch === 0 && okNorm;
console.log('生成源一致(需 build 后验证):', okGen ? 'PASS' : 'FAIL');

// ============ M4：council 工具 ============
console.log('');
console.log('===== M4 council 测试 =====');

// ④ 纯函数：shortModelLabel / formatCouncillorPrompt / formatCouncillorResults
const lib = await import('../src/council.ts');
console.log('shortModelLabel(openai/gpt-4):', lib.shortModelLabel('openai/gpt-4') === 'gpt-4' ? 'PASS' : 'FAIL');
const fmt = lib.formatCouncillorPrompt('任务', '你是专家');
console.log('formatCouncillorPrompt 前缀:', fmt.startsWith('你是专家\n\n---\n\n任务') ? 'PASS' : 'FAIL');

const mixed = lib.formatCouncillorResults('原题', [
  { name: 'a', model: 'p1/m1', status: 'completed', result: '答案A' },
  { name: 'b', model: 'p2/m2', status: 'failed', error: '超时' },
]);
console.log('聚合含成功结果:', mixed.includes('**a** (m1):') && mixed.includes('**Failed/Timed-out Councillors**') ? 'PASS' : 'FAIL');

const allFailed = lib.formatCouncillorResults('原题', [
  { name: 'a', model: 'p1/m1', status: 'failed', error: 'x' },
]);
console.log('全失败兜底:', allFailed.includes('All councillors failed') && allFailed.includes('original prompt alone') ? 'PASS' : 'FAIL');

// ⑤ 集成：fake provider 并行分发 + agentOptions 模型路由
// 0.2 真实 SubagentRuntime 在 start 前 assertCapabilities：请求带 agentOptions 时
// provider 必须声明 capabilities.agentOptions=true，否则拒绝（fail loud，不静默忽略）。
const started: any[] = [];
root.subagents.registerProvider({
  name: 'fake-council',
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  start(request: any) {
    started.push({ model: request.agentOptions, prompt: request.prompt[0].text, parentId: request.parent.id });
    return {
      id: 'child-' + request.agentOptions.model,
      result: Promise.resolve({
        output: [{ type: 'text', text: `councillor 回复：同意（${request.agentOptions.model}）` }],
        stopReason: 'completed',
      }),
      dispose() {},
    };
  },
});

const tool = lib.createCouncilTool({
  councillors: [
    { name: 'expert1', provider: 'p1', model: 'm1' },
    { name: 'expert2', provider: 'p2', model: 'm2' },
  ],
  councilTimeoutMs: 5000,
  councilProvider: 'fake-council',
}, root);

const out = await tool.execute({ prompt: '要不要重构？' }, { agent: { id: 'council-parent' }, signal: new AbortController().signal });
const okRouting = started.length === 2
  && started[0].model.provider === 'p1' && started[0].model.model === 'm1'
  && started[1].model.provider === 'p2' && started[1].model.model === 'm2'
  && started.every(s => s.parentId === 'council-parent' && s.prompt.includes('要不要重构？'));
console.log('模型路由（agentOptions 覆盖）:', okRouting ? 'PASS' : 'FAIL');

const okAgg = String(out).includes('**expert1** (m1):')
  && String(out).includes('**expert2** (m2):')
  && String(out).includes('Council: 2/2 councillors responded');
console.log('聚合输出:', okAgg ? 'PASS' : 'FAIL');
console.log('输出预览:', String(out).split('\n').slice(0, 6).join(' / '));

// ⑤b 集成：0.2.1 契约（仅 startActivation，无 start）下 council 仍可用
// 这是防回归关键：若 council 仍直接调 ctx.subagents.start(...)，此处会像生产环境一样抛错。
const cSpecs: any[] = [];
const cCtx: any = {
  llm: { listProviders: () => [], listModels: async () => [] },
  logger: { info: () => {}, warn: () => {} },
  subagents: {
    async startActivation(spec: any) {
      cSpecs.push(spec);
      return {
        childId: 'c-' + cSpecs.length,
        messageId: 'cm-' + cSpecs.length,
        result: Promise.resolve({
          output: [{ type: 'text', text: `0.2.1 councillor：同意（${spec?.request?.agentOptions?.model}）` }],
          stopReason: 'completed',
        }),
        async dispose() {},
      };
    },
  },
};
const tool21 = lib.createCouncilTool({
  councillors: [
    { name: 'expert1', provider: 'p1', model: 'm1' },
    { name: 'expert2', provider: 'p2', model: 'm2' },
  ],
  councilTimeoutMs: 5000,
  councilProvider: 'spawn',
}, cCtx);
const out21 = await tool21.execute({ prompt: '要不要重构？' }, { agent: { id: 'council-parent' }, signal: new AbortController().signal });
const okCouncil21 = cSpecs.length === 2
  && cSpecs.every(s => s?.delivery === 'caller')
  && cSpecs.every(s => s?.provider === 'spawn')
  && cSpecs.every(s => s?.request?.persona === undefined)
  && cSpecs[0]?.request?.agentOptions?.model === 'm1'
  && cSpecs[1]?.request?.agentOptions?.model === 'm2'
  && String(out21).includes('Council: 2/2 councillors responded');
console.log('council 走 0.2.1 startActivation（delivery=caller / 无 persona 字段 / 模型路由）:', okCouncil21 ? 'PASS' : 'FAIL');

const allOk = okSkills && okContent && okBrief && okDelegate && okOrch && okLayers && okBriefBudget && okPlannerBrief && okOrchBrief && okGen && okRouting && okAgg && okCouncil21;
console.log('');
console.log(allOk ? '✅ 全部 PASS' : '❌ 存在 FAIL');
process.exit(allOk ? 0 : 1);
