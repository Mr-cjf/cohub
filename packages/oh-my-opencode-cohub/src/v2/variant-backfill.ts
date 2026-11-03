/**
 * v2 variant 补齐
 *
 * 2.x 宿主遇到 `model.variants` 里不存在的 variant 会抛 `VariantUnavailableError`
 * （1.x 只是静默降级），导致子代理加载失败。这里的做法是把 agent 配置声明的
 * variant 直接补进模型目录，让宿主能找到它。
 *
 * 本模块刻意保持**零依赖**（不 import 宿主包、不 import `node:*`、不 import
 * `../index`），以便单独单测。
 */

/** 目录里单个模型的只读视图（仅取我们需要的部分） */
export interface CatalogModelInfo {
  /** 宿主 schema：variants 是数组（不是字典）。这里声明宽松，靠运行时形状判断 */
  variants?: unknown;
  /** 模型所属 AI SDK 包名，用于生成正确的 variant body */
  api?: { package?: string };
}

/**
 * 补齐所需的最小目录能力。
 *
 * - `get` 用于确认模型**已存在**——这一步不可省略：宿主 `update` 是 upsert，
 *   对未知 provider/model 会创建一个能力与 limit 都不完整的空模型，污染全局目录。
 * - `update` 只用于就地修改**已存在**的模型。
 */
export interface VariantBackfillCatalog {
  model?: {
    get?(providerID: string, modelID: string): CatalogModelInfo | undefined;
    update?(providerID: string, modelID: string, fn: (draft: CatalogModelInfo) => void): void;
  };
}

/** 一条待补齐的声明 */
export interface DeclaredVariant {
  providerID: string;
  modelID: string;
  variant: string;
}

/** variant 条目（宿主形状） */
interface VariantEntry {
  id?: string;
  headers?: unknown;
  body?: unknown;
}

/** 能生成正确请求体的已知包名；其余（含取不到）只补空 body */
const KNOWN_API_PACKAGES = [
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
] as const;

/**
 * 按 provider 的 AI SDK 包名生成 variant 的请求体片段。
 * 与宿主内置生成器逻辑对齐（packages/core/src/plugin/variant.ts:34-38 对应
 * openai-compatible 的 snake_case 写法）。
 * 拿不到包名时返回空对象：只占位、不改请求，至少不会触发 VariantUnavailableError。
 */
export function buildVariantBody(
  apiPackage: string | undefined,
  variant: string,
): Record<string, unknown> {
  if (apiPackage === '@ai-sdk/openai-compatible') {
    return { reasoning_effort: variant };
  }
  if (apiPackage === '@ai-sdk/openai') {
    return { reasoning: { effort: variant } };
  }
  if (apiPackage === '@ai-sdk/anthropic') {
    return { output_config: { effort: variant } };
  }
  return {};
}

/**
 * 把声明的 variant 补进 catalog。
 * - 模型不存在 → 跳过（宿主 update 是 upsert，绝不能创建空模型）
 * - 同 id 已存在 → 跳过（用户显式声明优先，不覆盖）
 * - 幂等：重复调用不产生重复条目
 */
export function backfillVariants(
  catalog: VariantBackfillCatalog,
  declared: DeclaredVariant[],
  onDiag?: (message: string) => void,
): void {
  const diag = onDiag ?? (() => {});

  for (const { providerID, modelID, variant } of declared) {
    try {
      // ⚠️ 宿主 model.update 是 upsert：模型不存在时会被创建成能力/limit
      // 均不完整的空模型，污染全局目录。必须先确认模型已存在。
      const existing = catalog.model?.get?.(providerID, modelID);
      if (!existing) {
        diag(`variant 补齐跳过（模型不在目录）: ${providerID}/${modelID}#${variant}`);
        continue;
      }

      // 宿主在 model.update 回调里拿到的是 raw API（默认 native），
      // provider 的 api.package 要经过读取投影才可见，这里拿不到就
      // 只能补一个空 body：可避免 VariantUnavailableError，但档位不会生效，
      // 需要用户在 opencode.json 显式声明。
      const apiPackage =
        typeof existing.api?.package === 'string' ? existing.api.package : undefined;

      catalog.model?.update?.(providerID, modelID, (draft) => {
        const list: VariantEntry[] = Array.isArray(draft.variants)
          ? (draft.variants as VariantEntry[])
          : [];
        if (list.some((v) => v && typeof v === 'object' && v.id === variant)) {
          return; // 已存在（可能是用户显式声明）→ 完全跳过，绝不覆盖
        }
        // 仅在实际需要新增时才告警：已有同 id 时档位是否生效与本次补齐无关，
        // 重复告警只会误导（也避免目录重放时刷屏）。
        if (!apiPackage || !(KNOWN_API_PACKAGES as readonly string[]).includes(apiPackage)) {
          diag(`variant 补齐缺 api.package，档位不会生效: ${providerID}/${modelID}#${variant}`);
        }
        list.push({
          id: variant,
          headers: {},
          body: buildVariantBody(apiPackage, variant),
        });
        draft.variants = list;
      });
    } catch {
      // 单个模型失败不影响其他模型
    }
  }
}
