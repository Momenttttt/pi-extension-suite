/**
 * S1：注入前的索引格式化（剥 frontmatter / 顶层注释、200 行 / 25 000 字符截断 + WARNING）。
 */
import { describe, expect, test } from "vitest";

import {
  formatMemoryIndexForInjection,
  stripTopLevelHtmlComments,
  truncateMemoryIndex,
  INDEX_CHARACTER_LIMIT,
  INDEX_LINE_LIMIT,
} from "../src/index-content.ts";

describe("formatMemoryIndexForInjection", () => {
  test("普通索引只 trim，不截断", () => {
    const formatted = formatMemoryIndexForInjection("\n- [a](a.md) — 钩子\n\n");
    expect(formatted.text).toBe("- [a](a.md) — 钩子");
    expect(formatted.truncated).toBe(false);
    expect(formatted.lineCount).toBe(1);
  });

  test("剥掉开头 frontmatter（索引本不该有，但坏输入不能带进上下文）", () => {
    const formatted = formatMemoryIndexForInjection("---\ntitle: x\n---\n- [a](a.md) — 钩子\n");
    expect(formatted.text).toBe("- [a](a.md) — 钩子");
  });

  test("剥掉顶层 HTML 注释，保留列表项与代码围栏里的注释", () => {
    const raw = [
      "<!-- 这是索引的说明，不进上下文 -->",
      "- [a](a.md) — 钩子 <!-- 行内注释保留 -->",
      "",
      "```",
      "<!-- 代码块里的保留 -->",
      "```",
    ].join("\n");
    const stripped = stripTopLevelHtmlComments(raw);
    expect(stripped).not.toContain("这是索引的说明");
    expect(stripped).toContain("行内注释保留");
    expect(stripped).toContain("代码块里的保留");
  });

  test("多行顶层注释整块剥掉；未闭合的注释原样保留", () => {
    const raw = "<!--\n多行\n说明\n-->\n- [a](a.md) — 钩子";
    expect(stripTopLevelHtmlComments(raw)).toBe("- [a](a.md) — 钩子");
    const unclosed = "<!-- 没闭合\n- [a](a.md)";
    expect(stripTopLevelHtmlComments(unclosed)).toBe(unclosed);
  });
});

describe("truncateMemoryIndex", () => {
  test("超过 200 行 → 200 行 + 自写 WARNING", () => {
    const raw = Array.from({ length: 300 }, (_, index) => `- [m${index}](m${index}.md) — 钩子`).join("\n");
    const formatted = formatMemoryIndexForInjection(raw);
    expect(formatted.truncated).toBe(true);
    expect(formatted.lineCount).toBe(300);
    const lines = formatted.text.split("\n");
    expect(lines.filter((line) => line.startsWith("- [m"))).toHaveLength(INDEX_LINE_LIMIT);
    expect(formatted.text).toContain("WARNING");
    expect(formatted.text).toContain(String(INDEX_CHARACTER_LIMIT));
  });

  test("超过 25 000 字符 → 在换行边界截断", () => {
    const long = "- [x](x.md) — " + "字".repeat(3000);
    const raw = Array.from({ length: 10 }, () => long).join("\n");
    const formatted = truncateMemoryIndex(raw);
    expect(formatted.truncated).toBe(true);
    expect(formatted.text.length).toBeLessThan(raw.length);
    expect(formatted.text).toContain("WARNING");
    // 截断点回退到换行：WARNING 之前的部分是完整行集合，不超过字符上限
    const body = formatted.text.split("\n\n> WARNING")[0]!;
    expect(body.length).toBeLessThanOrEqual(INDEX_CHARACTER_LIMIT);
    expect(body.split("\n").every((line) => line === long)).toBe(true);
  });

  test("空白索引 → 空文本", () => {
    expect(truncateMemoryIndex("   \n\n").text).toBe("");
  });
});
