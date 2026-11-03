// Bun 运行时全局注入 describe/test/expect（项目未安装 @types/bun）
declare function describe(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
interface ExpectResult {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
  toBeUndefined(): void;
  toHaveLength(n: number): void;
}
declare function expect(actual: unknown): ExpectResult;

import {
  backfillVariants,
  type CatalogModelInfo,
  type VariantBackfillCatalog,
} from './variant-backfill';

interface FakeCatalog {
  catalog: VariantBackfillCatalog;
  store: Map<string, CatalogModelInfo>;
  updateCount: () => number;
}

/** 极简 fake：Map 存模型，update 只改已存在的模型（不存在则抛错，模拟 upsert 禁令） */
function createFakeCatalog(initial: Record<string, CatalogModelInfo> = {}): FakeCatalog {
  const store = new Map<string, CatalogModelInfo>(Object.entries(initial));
  let updates = 0;
  const catalog: VariantBackfillCatalog = {
    model: {
      get(providerID: string, modelID: string): CatalogModelInfo | undefined {
        return store.get(`${providerID}/${modelID}`);
      },
      update(providerID: string, modelID: string, fn: (draft: CatalogModelInfo) => void): void {
        updates += 1;
        const target = store.get(`${providerID}/${modelID}`);
        if (!target) throw new Error(`upsert 禁止: ${providerID}/${modelID}`);
        fn(target);
      },
    },
  };
  return { catalog, store, updateCount: () => updates };
}

interface VariantShape {
  id?: string;
  headers?: unknown;
  body?: unknown;
}

function variantsOf(fake: FakeCatalog, key: string): VariantShape[] {
  const model = fake.store.get(key);
  return Array.isArray(model?.variants) ? (model.variants as VariantShape[]) : [];
}

describe('backfillVariants', () => {
  test('模型存在且无 variants → 补入一条，body 按 api.package 生成', () => {
    const fake = createFakeCatalog({
      'newapi/gpt-5.4': { api: { package: '@ai-sdk/openai-compatible' } },
    });

    backfillVariants(fake.catalog, [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'high' }]);

    const list = variantsOf(fake, 'newapi/gpt-5.4');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('high');
    expect(list[0].body).toEqual({ reasoning_effort: 'high' });
  });

  test('已有同 id variant → 不重复 push、不改动其 body（用户声明优先）', () => {
    const userBody = { reasoning_effort: 'user-custom' };
    const fake = createFakeCatalog({
      'newapi/gpt-5.4': {
        api: { package: '@ai-sdk/openai-compatible' },
        variants: [{ id: 'high', headers: { 'x-user': '1' }, body: userBody }],
      },
    });

    backfillVariants(fake.catalog, [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'high' }]);

    const list = variantsOf(fake, 'newapi/gpt-5.4');
    expect(list).toHaveLength(1);
    expect(list[0].body).toEqual({ reasoning_effort: 'user-custom' });
    expect(list[0].headers).toEqual({ 'x-user': '1' });
  });

  test('模型不存在 → 不创建（update 未被调用）且记录诊断', () => {
    const fake = createFakeCatalog();
    const diags: string[] = [];

    backfillVariants(
      fake.catalog,
      [{ providerID: 'missing', modelID: 'nope', variant: 'high' }],
      (m) => diags.push(m),
    );

    expect(fake.updateCount()).toBe(0);
    expect(fake.store.size).toBe(0);
    expect(diags).toHaveLength(1);
    expect(diags[0].includes('模型不在目录')).toBe(true);
  });

  test('幂等：同一 declared 连续调用两次 → 条目数仍为 1', () => {
    const fake = createFakeCatalog({
      'newapi/gpt-5.4': { api: { package: '@ai-sdk/openai' } },
    });
    const declared = [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'max' }];

    backfillVariants(fake.catalog, declared);
    backfillVariants(fake.catalog, declared);

    expect(variantsOf(fake, 'newapi/gpt-5.4')).toHaveLength(1);
  });

  test('api.package 缺失 → 补入但 body 为 {}，且 onDiag 被调用', () => {
    const fake = createFakeCatalog({ 'newapi/gpt-5.4': {} });
    const diags: string[] = [];

    backfillVariants(
      fake.catalog,
      [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'high' }],
      (m) => diags.push(m),
    );

    const list = variantsOf(fake, 'newapi/gpt-5.4');
    expect(list).toHaveLength(1);
    expect(list[0].body).toEqual({});
    expect(diags).toHaveLength(1);
    expect(diags[0].includes('缺 api.package')).toBe(true);
  });

  test('已有同 id variant 且 api.package 缺失 → 不输出「档位不会生效」诊断（不误报）', () => {
    const fake = createFakeCatalog({
      'newapi/gpt-5.4': { variants: [{ id: 'high', headers: { 'x-user': '1' } }] },
    });
    const diags: string[] = [];

    backfillVariants(
      fake.catalog,
      [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'high' }],
      (m) => diags.push(m),
    );

    // 用户的 variant 已存在 → 补齐路径根本没走到 push，不应产生缺包告警
    const list = variantsOf(fake, 'newapi/gpt-5.4');
    expect(list).toHaveLength(1);
    expect(list[0].body).toBeUndefined();
    expect(diags.filter((d) => d.includes('档位不会生效'))).toHaveLength(0);
  });

  test('数组形状：draft.variants 为 [{id:"high"}] 时能正确识别重复', () => {
    const fake = createFakeCatalog({
      'newapi/gpt-5.4': {
        api: { package: '@ai-sdk/anthropic' },
        variants: [{ id: 'high' }],
      },
    });

    backfillVariants(fake.catalog, [{ providerID: 'newapi', modelID: 'gpt-5.4', variant: 'high' }]);

    const list = variantsOf(fake, 'newapi/gpt-5.4');
    expect(list).toHaveLength(1);
    // 未识别为重复时会补 body，这里必须仍然没有 body
    expect(list[0].body).toBeUndefined();
  });
});
