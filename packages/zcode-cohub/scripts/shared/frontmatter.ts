/**
 * 共享 frontmatter 抽取函数（CRLF 兼容版）。
 *
 * 以 scripts/generate-agents.ts 的实现为准（正则用 `\r?\n` 同时兼容 LF / CRLF）。
 * 原先 scripts/generate-skills.ts 只兼容 LF，存在跨平台漂移风险。
 *
 * @param content 完整的 SKILL.md 内容
 * @returns frontmatter 中解析出的 name / description
 */
export function extractFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim();
    }
  }
  return frontmatter;
}