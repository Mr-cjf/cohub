// src/error-signature.d.mts —— error-signature.mjs 的类型声明（伴生声明文件）

/** 归一化选项 */
export interface NormalizeErrorSignatureOptions {
  /** 数字归一策略：'#' = 数字替换为 #（默认，用于同类聚合）；'keep' = 保留数字（用于停滞检测等需区分度的场景） */
  digits?: "#" | "keep";
  /** 截断长度，默认 240 */
  maxLen?: number;
  /** 签名前缀，默认 "err:" */
  prefix?: string;
}

/**
 * 归一化错误签名。
 * @param data 错误文本（string，走文本分支）或 tool/result 的 data（object，结构优先）
 * @param opts 归一化选项
 * @returns 归一化签名；无法提取时返回 null
 */
export declare function normalizeErrorSignature(
  data: unknown,
  opts?: NormalizeErrorSignatureOptions,
): string | null;
