// dsh-port/test/unit.ts —— 运行时单元验证（无需 LLM）
// 用法：node test/unit.ts（node >= 24，默认类型剥离）
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

// ② skills 快照：应含 12 个 co-* 技能
const snap: any = await root.skills.snapshot({});
const names = snap.skills.map((s: any) => s.name).sort();
console.log('技能数:', names.length, '(期望 12)');
console.log('技能清单:', names.join(', '));

const EXPECTED = [
  'co-council','co-designer','co-explorer','co-fixer','co-librarian',
  'co-orchestrator','co-observer','co-oracle','co-planner','co-rule-app','co-rule-project','co-rule-user',
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
const okBrief = COHUB_SKILLS.length === 12 && COHUB_SKILLS.every((s: any) => !!s.brief?.trim() && /[\u4e00-\u9fff]/.test(s.brief));
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
    start: (_transport: string, req: any) => {
      capturedPrompt = req.prompt[0].text;
      return {
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose() {},
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
const started: any[] = [];
root.subagents.registerProvider({
  name: 'fake-council',
  capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
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

const allOk = okSkills && okContent && okBrief && okDelegate && okRouting && okAgg;
console.log('');
console.log(allOk ? '✅ 全部 PASS' : '❌ 存在 FAIL');
process.exit(allOk ? 0 : 1);
