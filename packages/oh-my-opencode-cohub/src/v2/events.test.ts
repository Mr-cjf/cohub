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

import { toV1Event, mapEventType } from './events';

describe('mapEventType', () => {
  test('同名事件直接透传', () => {
    expect(mapEventType('session.idle')).toBe('session.idle');
    expect(mapEventType('session.deleted')).toBe('session.deleted');
    expect(mapEventType('session.status')).toBe('session.status');
  });

  test('v2 重试事件映射到 session.status（v1 按 retry 观测）', () => {
    expect(mapEventType('session.retry.scheduled')).toBe('session.status');
  });

  test('v2 执行失败映射到 session.error 观测分支', () => {
    expect(mapEventType('session.execution.failed')).toBe('session.error');
    expect(mapEventType('session.step.failed')).toBe('session.error');
  });

  test('无关事件返回 undefined（不进入 v1 处理逻辑）', () => {
    expect(mapEventType('provider.updated')).toBeUndefined();
    expect(mapEventType('session.text.delta')).toBeUndefined();
    expect(mapEventType('shell.created')).toBeUndefined();
    expect(mapEventType('')).toBeUndefined();
  });
});

describe('toV1Event', () => {
  test('sessionID 同时补到 properties 与 properties.info.id', () => {
    const r = toV1Event({ type: 'session.idle', data: { sessionID: 'ses_abc' } });
    expect(r.properties?.sessionID).toBe('ses_abc');
    expect((r.properties?.info as { id: string }).id).toBe('ses_abc');
  });

  test('原有 info 不被覆盖', () => {
    const r = toV1Event({
      type: 'session.idle',
      data: { sessionID: 'ses_abc', info: { id: 'preserved' } },
    });
    expect((r.properties?.info as { id: string }).id).toBe('preserved');
  });

  test('无 data 时只返回 type', () => {
    const r = toV1Event({ type: 'session.idle' });
    expect(r).toEqual({ type: 'session.idle' });
  });

  test('session.message 事件带 tool part 时透传到 properties.part', () => {
    const r = toV1Event({
      type: 'session.message.updated',
      data: { type: 'tool', tool: 'task', callID: 'c1' },
    });
    expect((r.properties?.part as { tool: string }).tool).toBe('task');
  });

  test('非 tool 形态的 message 事件不伪造 part', () => {
    const r = toV1Event({
      type: 'session.message.updated',
      data: { type: 'text', text: 'hi' },
    });
    expect(r.properties?.part).toBeUndefined();
  });

  test('缺 type 时返回空 type 而不抛错', () => {
    expect(toV1Event({ data: { sessionID: 'x' } })).toEqual({
      type: '',
      properties: { sessionID: 'x', info: { id: 'x' } },
    });
  });
});
