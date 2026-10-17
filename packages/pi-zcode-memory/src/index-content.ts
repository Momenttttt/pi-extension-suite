/**
 * 注入用的索引格式化。
 *
 *   - 剥掉开头 frontmatter、剥掉顶层 HTML 注释、trim
 *   - 截断上限 200 行 / 25 000 字符，超限追加一条 WARNING
 *
 * 不引入 markdown 解析器：逐行扫描就够——代码围栏外、行首以 `<!--` 开头的注释块整块剥掉，
 * 列表项与段落里的注释保持原样（真会出现在索引顶部的注释只有这一种用法）。
 */
import { createHash } from "node:crypto";

export const INDEX_LINE_LIMIT = 200;
export const INDEX_CHARACTER_LIMIT = 25_000;

const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;

export interface FormattedMemoryIndex {
  /** 注入用的正文；索引为空时为 ""。 */
  text: string;
  truncated: boolean;
  lineCount: number;
  characterCount: number;
}

export function formatMemoryIndexForInjection(raw: string): FormattedMemoryIndex {
  const normalized = raw.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const withoutFrontmatter = normalized.replace(LEADING_FRONTMATTER_PATTERN, "");
  const decorated = stripTopLevelHtmlComments(withoutFrontmatter);
  return truncateMemoryIndex(decorated);
}

/** 只删代码围栏之外、行首就是 `<!--` 的顶层注释块（列表项/段落里的注释保留）。 */
export function stripTopLevelHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmedStart = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/u.exec(trimmedStart);
    if (fenceMatch) {
      if (fence === undefined) fence = fenceMatch[1]![0];
      else if (trimmedStart.startsWith(fence.repeat(3))) fence = undefined;
      out.push(line);
      continue;
    }
    if (fence === undefined && trimmedStart.startsWith("<!--")) {
      let end = index;
      let closed = trimmedStart.includes("-->");
      while (!closed && end + 1 < lines.length) {
        end += 1;
        if (lines[end]!.includes("-->")) closed = true;
      }
      if (closed) {
        const closeIndex = lines[end]!.indexOf("-->");
        const rest = lines[end]!.slice(closeIndex + 3);
        index = end;
        if (rest.trim().length > 0) out.push(rest);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function truncateMemoryIndex(content: string): FormattedMemoryIndex {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { text: "", truncated: false, lineCount: 0, characterCount: 0 };
  }
  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > INDEX_CHARACTER_LIMIT;
  if (!lineTruncated && !characterTruncated) {
    return { text: trimmed, truncated: false, lineCount, characterCount };
  }

  let truncated = lineTruncated ? lines.slice(0, INDEX_LINE_LIMIT).join("\n") : trimmed;
  if (truncated.length > INDEX_CHARACTER_LIMIT) {
    const lastNewline = truncated.lastIndexOf("\n", INDEX_CHARACTER_LIMIT);
    truncated = truncated.slice(0, lastNewline > 0 ? lastNewline : INDEX_CHARACTER_LIMIT);
  }
  const warning =
    `> WARNING: the MEMORY.md index is too long (${lineCount} lines / ${characterCount} characters; ` +
    `the injection limit is ${INDEX_LINE_LIMIT} lines / ${INDEX_CHARACTER_LIMIT} characters), so only the truncated part above was injected. ` +
    `Shorten the index lines and move details into the fact files.`;
  return {
    text: `${truncated}\n\n${warning}`,
    truncated: true,
    lineCount,
    characterCount,
  };
}

/** 注入状态用的内容 hash（对注入正文取，保证"内容没变就不重注"）。 */
export function memoryIndexHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
