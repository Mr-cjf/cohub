// Re-export from shared layer (cohub-shared sync target).
// 原实现已逐字搬入 shared/fs-json.ts，此处保留 re-export 以不改变现有 import 路径。
export { readJsonFileSafe } from "../shared/fs-json.js";