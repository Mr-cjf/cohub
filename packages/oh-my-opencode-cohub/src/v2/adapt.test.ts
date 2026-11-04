// Bun 运行时全局注入 describe/test/expect（项目未安装 @types/bun）
declare function describe(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
interface ExpectResult {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
  toBeUndefined(): void;
  toBeInstanceOf(v: unknown): void;
  toBeGreaterThan(v: number): void;
  toHaveLength(n: number): void;
}
declare function expect(actual: unknown): ExpectResult;

import {
  toV2Model,
  toV2Permissions,
  applyAgentDefinition,
  wrapToolInput,
  setZod,
  type V1AgentLike,
} from './adapt';
import { buildVariantBody } from './index';

describe('toV2Model', () => {
  test('拆分 provider/model', () => {
    expect(toV2Model('newapi/gpt-5.4')).toEqual({ providerID: 'newapi', id: 'gpt-5.4' });
  });

  test('保留模型 id 里的斜杠', () => {
    expect(toV2Model('openrouter/meta/llama')).toEqual({
      providerID: 'openrouter',
      id: 'meta/llama',
    });
  });

  test('无 provider 前缀时返回 undefined（交由宿主默认值）', () => {
    expect(toV2Model('gpt-5.4')).toBeUndefined();
  });

  test('非字符串输入返回 undefined', () => {
    expect(toV2Model(undefined)).toBeUndefined();
    expect(toV2Model(null)).toBeUndefined();
    expect(toV2Model(42)).toBeUndefined();
  });

  test('空 provider 或空 model 返回 undefined', () => {
    expect(toV2Model('/gpt-5.4')).toBeUndefined();
    expect(toV2Model('newapi/')).toBeUndefined();
  });
});

describe('toV2Permissions', () => {
  test('把 v1 映射转成 v2 规则数组', () => {
    expect(toV2Permissions({ council_session: 'allow', close_job: 'deny' })).toEqual([
      { action: 'council_session', resource: '*', effect: 'allow' },
      { action: 'close_job', resource: '*', effect: 'deny' },
    ]);
  });

  test('保留 ask 效果', () => {
    expect(toV2Permissions({ bash: 'ask' })).toEqual([
      { action: 'bash', resource: '*', effect: 'ask' },
    ]);
  });

  test('丢弃非法效果值', () => {
    expect(toV2Permissions({ bash: 'whatever', edit: 'deny' })).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
    ]);
  });

  test('非对象输入返回空数组', () => {
    expect(toV2Permissions(undefined)).toEqual([]);
    expect(toV2Permissions(null)).toEqual([]);
    expect(toV2Permissions('deny')).toEqual([]);
  });
});

describe('applyAgentDefinition', () => {
  const mkTarget = () => ({
    mode: 'subagent',
    system: '',
    description: '',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    request: { settings: {}, headers: {}, body: {} },
  });

  test('嵌套 config 形态：prompt → system', () => {
    const target = mkTarget();
    applyAgentDefinition(target, {
      name: 'co-x',
      description: 'desc',
      config: { mode: 'primary', prompt: 'PROMPT' },
    });
    expect(target.mode).toBe('primary');
    expect(target.system).toBe('PROMPT');
    expect(target.description).toBe('desc');
  });

  test('扁平形态：工厂返回的 agent 记录没有 config 字段', () => {
    // 这是 v1 工厂 `hooks.agent` 的真实形状：config 被摊平到顶层
    const target = mkTarget();
    applyAgentDefinition(target, {
      name: 'co-orchestrator',
      description: '纯调度者',
      mode: 'primary',
      prompt: 'ORCH_PROMPT',
    } as V1AgentLike);
    expect(target.mode).toBe('primary');
    expect(target.system).toBe('ORCH_PROMPT');
  });

  test('模型字符串转 v2 引用并带上 variant', () => {
    const target = mkTarget() as Record<string, unknown>;
    applyAgentDefinition(target, {
      name: 'co-x',
      config: { model: 'guiyi/gpt-6.1-sol', variant: 'max' },
    });
    expect(target.model).toEqual({ providerID: 'guiyi', id: 'gpt-6.1-sol', variant: 'max' });
  });

  test('无 provider 前缀的模型不写 model（不覆盖宿主默认）', () => {
    const target = mkTarget() as Record<string, unknown>;
    applyAgentDefinition(target, { name: 'co-x', config: { model: 'bare-model' } });
    expect(target.model).toBeUndefined();
  });

  test('temperature 落到 request.body', () => {
    const target = mkTarget();
    applyAgentDefinition(target, { name: 'co-x', config: { temperature: 0.1 } });
    expect((target.request as { body: Record<string, unknown> }).body.temperature).toBe(0.1);
    // 既有 request 字段不能被丢
    expect((target.request as { settings: unknown }).settings).toEqual({});
  });

  test('权限按 action/resource 合并，插件声明优先', () => {
    const target = mkTarget();
    applyAgentDefinition(target, {
      name: 'co-x',
      config: { permission: { council_session: 'deny', close_job: 'allow' } },
    });
    const perms = target.permissions as Array<{ action: string; effect: string }>;
    const byAction = new Map(perms.map((p) => [p.action, p.effect]));
    expect(byAction.get('council_session')).toBe('deny');
    expect(byAction.get('close_job')).toBe('allow');
    // 宿主既有的通配规则保留
    expect(byAction.get('*')).toBe('allow');
  });

  test('mode 缺失时安全回退为 subagent', () => {
    const target = mkTarget();
    applyAgentDefinition(target, { name: 'co-x', config: {} });
    expect(target.mode).toBe('subagent');
  });
});

describe('wrapToolInput', () => {
  test('未注入 zod 时原样下传', () => {
    expect(wrapToolInput({ a: 1 })).toEqual({ a: 1 });
  });

  test('注入 zod 后包成 object schema', () => {
    const fakeZod = {
      object: (shape: Record<string, unknown>) => ({ __wrapped: true, shape }),
    };
    setZod(fakeZod);
    expect(wrapToolInput({ a: 1 })).toEqual({ __wrapped: true, shape: { a: 1 } });
  });

  test('zod.object 抛错时回退原值（不因 schema 构造失败丢工具）', () => {
    setZod({
      object: () => {
        throw new Error('boom');
      },
    });
    expect(wrapToolInput({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('buildVariantBody（variant 补齐的请求体构造）', () => {
  test('openai-compatible 用 snake_case reasoning_effort', () => {
    expect(buildVariantBody('@ai-sdk/openai-compatible', 'max')).toEqual({
      reasoning_effort: 'max',
    });
  });

  test('openai 用嵌套 reasoning.effort', () => {
    expect(buildVariantBody('@ai-sdk/openai', 'max')).toEqual({ reasoning: { effort: 'max' } });
  });

  test('anthropic 用 output_config.effort', () => {
    expect(buildVariantBody('@ai-sdk/anthropic', 'max')).toEqual({
      output_config: { effort: 'max' },
    });
  });

  test('未知包名返回空对象（仅占位不改请求）', () => {
    expect(buildVariantBody(undefined, 'max')).toEqual({});
    expect(buildVariantBody('@ai-sdk/other', 'max')).toEqual({});
  });
});
