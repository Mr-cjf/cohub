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

import { createV1Input } from './compat';

/** 记录调用的假 v2 session domain */
function makeSession(record: Array<{ method: string; input: unknown }>) {
  const capture = (method: string) => async (input: unknown) => {
    record.push({ method, input });
    if (method === 'context') return [{ id: 'm1', role: 'user', content: [] }];
    if (method === 'create') return { id: 'ses_new' };
    return {};
  };
  return {
    create: capture('create'),
    remove: capture('remove'),
    prompt: capture('prompt'),
    interrupt: capture('interrupt'),
    context: capture('context'),
  };
}

describe('createV1Input', () => {
  test('v1 的 path.id 折叠成 v2 的 sessionID', async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const input = createV1Input({ session: makeSession(calls) });
    const client = input.client as { session: Record<string, (o?: unknown) => Promise<unknown>> };

    await client.session.abort({ path: { id: 'ses_1' } });
    expect(calls[0]).toEqual({ method: 'interrupt', input: { sessionID: 'ses_1' } });
  });

  test('query 与 body 摊平进同一个入参对象', async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const input = createV1Input({ session: makeSession(calls) });
    const client = input.client as { session: Record<string, (o?: unknown) => Promise<unknown>> };

    await client.session.create({
      body: { parentID: 'p1', title: 't' },
      query: { directory: 'D:/x' },
    });
    expect(calls[0]).toEqual({
      method: 'create',
      input: { parentID: 'p1', title: 't', directory: 'D:/x' },
    });
  });

  test('v2 的 context 承接 v1 的 messages', async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const input = createV1Input({ session: makeSession(calls) });
    const client = input.client as {
      session: { messages: (o?: unknown) => Promise<{ data?: unknown; error?: unknown }> };
    };

    const res = await client.session.messages({ path: { id: 'ses_2' }, query: { limit: 10 } });
    expect(calls[0]).toEqual({ method: 'context', input: { sessionID: 'ses_2', limit: 10 } });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.data)).toBe(true);
  });

  test('v2 抛错被转成 v1 的 { error }（否则业务侧的错误分支会失效）', async () => {
    const input = createV1Input({
      session: {
        interrupt: async () => {
          throw new Error('boom');
        },
      },
    });
    const client = input.client as {
      session: { abort: (o?: unknown) => Promise<{ data?: unknown; error?: unknown }> };
    };
    const res = await client.session.abort({ path: { id: 'ses_3' } });
    expect(res.error).toBeInstanceOf(Error);
    expect(res.data).toBeUndefined();
  });

  test('directory 取自 location，缺失时回退 cwd', () => {
    expect(createV1Input({ location: { directory: 'D:/proj' } }).directory).toBe('D:/proj');
    expect(createV1Input({}).directory).toBe(process.cwd());
  });

  test('domain 缺少某方法时不注册同名 v1 方法（避免调用到 undefined）', () => {
    const input = createV1Input({ session: { interrupt: async () => ({}) } });
    const client = input.client as { session: Record<string, unknown> };
    expect(typeof client.session.abort).toBe('function');
    expect(client.session.messages).toBeUndefined();
    expect(client.session.create).toBeUndefined();
  });
});
