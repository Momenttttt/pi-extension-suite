/**
 * S1：事实文件 frontmatter 的解析容错与生成。
 *
 * 解析规则：首行 `---`、30 行内闭合、YAML 可映射，坏输入一律降级为"无描述条目"而不抛错。
 */
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseMemoryDocument, parseMemoryFrontmatter, renderMemoryFile } from "../src/frontmatter.ts";

const VALID = [
  "---",
  "name: user-api-preference",
  "description: 用户偏好 REST 而不是 GraphQL",
  "metadata:",
  "  node_type: memory",
  "  type: feedback",
  "---",
  "",
  "正文第一行。",
  "",
].join("\n");

describe("parseMemoryFrontmatter", () => {
  test("合法 frontmatter：name / description / metadata.type", () => {
    const frontmatter = parseMemoryFrontmatter(VALID);
    expect(frontmatter).toEqual({
      name: "user-api-preference",
      description: "用户偏好 REST 而不是 GraphQL",
      type: "feedback",
      malformed: false,
    });
  });

  test("type 可退回顶层键；非法 type 丢弃", () => {
    const top = ["---", "description: x", "type: project", "---", ""].join("\n");
    expect(parseMemoryFrontmatter(top).type).toBe("project");
    const bad = ["---", "description: x", "metadata:", "  type: invented", "---", ""].join("\n");
    expect(parseMemoryFrontmatter(bad).type).toBeUndefined();
  });

  test("带 originSessionId 的文件照常解析", () => {
    const zcode = [
      "---",
      "name: build-quirk",
      "description: 构建脚本的怪癖",
      "metadata:",
      "  node_type: memory",
      "  originSessionId: 6a3...",
      "  type: project",
      "---",
      "正文",
    ].join("\n");
    const frontmatter = parseMemoryFrontmatter(zcode);
    expect(frontmatter.malformed).toBe(false);
    expect(frontmatter.type).toBe("project");
  });

  test("坏输入降级为无描述条目", () => {
    expect(parseMemoryFrontmatter("没有 frontmatter").malformed).toBe(true);
    expect(parseMemoryFrontmatter(["---", "name: a"].join("\n")).malformed).toBe(true);
    expect(parseMemoryFrontmatter(["---", "name: a", "bad: [", "---"].join("\n")).malformed).toBe(true);
    expect(parseMemoryFrontmatter(["---", "- just", "- a list", "---"].join("\n")).malformed).toBe(true);
    // 只有非映射 YAML 才算坏；映射里缺字段仍是合法文档
    expect(parseMemoryFrontmatter(["---", "name: a", "---"].join("\n")).malformed).toBe(false);
  });

  test("闭合行超过 30 行时视为无 frontmatter", () => {
    const lines = ["---", "description: 藏在很后面"];
    for (let index = 0; index < 40; index += 1) lines.push(`填充 ${index}`);
    lines.push("---");
    expect(parseMemoryFrontmatter(lines.join("\n")).malformed).toBe(true);
  });

  test("CRLF 与 BOM 归一化", () => {
    const crlf = VALID.replace(/\n/gu, "\r\n");
    expect(parseMemoryFrontmatter(crlf).name).toBe("user-api-preference");
    expect(parseMemoryFrontmatter(`\uFEFF${VALID}`).name).toBe("user-api-preference");
  });

  test("正文里的 --- 不会切断正文", () => {
    const document = parseMemoryDocument(`${VALID}\n分隔线\n---\n后面还有`);
    expect(document.body).toContain("分隔线");
    expect(document.body).toContain("后面还有");
  });
});

describe("renderMemoryFile", () => {
  test("只写四个键，不写 originSessionId（三级标题行序固定）", () => {
    const text = renderMemoryFile({
      name: "user-api-preference",
      description: "用户偏好 REST 而不是 GraphQL",
      type: "feedback",
      body: "**Why:** 因为……\n\n**How to apply:** 写接口时默认 REST。",
    });
    const lines = text.split("\n");
    expect(lines.slice(0, 7)).toEqual([
      "---",
      "name: user-api-preference",
      "description: 用户偏好 REST 而不是 GraphQL",
      "metadata:",
      "  node_type: memory",
      "  type: feedback",
      "---",
    ]);
    expect(text).not.toContain("originSessionId");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("往返：生成的文档能被 YAML 解析回原值", () => {
    const input = {
      name: "weird-description",
      description: '带冒号: 引号 " 和 # 的值',
      type: "reference" as const,
      body: "正文",
    };
    const text = renderMemoryFile(input);
    const parsed = parseYaml(text.split("---\n")[1]!) as Record<string, unknown>;
    expect(parsed.name).toBe(input.name);
    expect(parsed.description).toBe(input.description);
    expect((parsed.metadata as Record<string, unknown>).type).toBe("reference");
    expect(parseMemoryFrontmatter(text).description).toBe(input.description);
  });

  test("description 里的换行折叠成空格", () => {
    const text = renderMemoryFile({ name: "a", description: "第一行\n第二行", type: "user", body: "x" });
    expect(parseMemoryFrontmatter(text).description).toBe("第一行 第二行");
  });
});
