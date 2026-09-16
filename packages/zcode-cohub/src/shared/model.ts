// ⚠️ 本文件由 cohub-shared/src/model.ts 自动同步生成，请勿直接编辑。
// 修改请改 cohub-shared/src/model.ts，然后运行 bun cohub-shared/sync.ts
/**
 * 从 "provider/model" 格式提取末尾 model 名，用于展示短标签。
 * 源自 dsh-cohub/src/council.ts 的 shortModelLabel，逻辑与
 * oh-my-opencode-cohub 未导出版本完全一致。
 */
export function shortModelLabel(model: string): string {
  return model.split("/").pop() ?? model;
}