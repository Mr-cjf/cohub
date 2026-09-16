export { CHINESE_LANGUAGE_INSTRUCTION } from '../shared/chinese';

export const PARALLEL_TOOL_INSTRUCTION = `# 并行工具调用要求

你有能力在单次回复中发起多个工具调用。当需要获取多个相互独立的信息时，必须把这些工具调用合并在同一条消息中一次性并发发起，不要逐个串行等待。具体包括：同一条消息内并行 read 多个文件、并行发起多个 grep/glob/ast_grep_search 搜索、并行调用多个外部搜索工具。串行逐个调用是低效行为，必须避免。`;
