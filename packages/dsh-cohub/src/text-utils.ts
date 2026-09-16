// src/text-utils.ts —— 文本工具函数（供 delegate / council / env-signatures 共享）

/** 提取 ContentBlock 输出中的文本 */
export function contentText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .filter((b): b is { type: string; text?: string } =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string",
    )
    .map(b => b.text as string)
    .join("\n\n");
}