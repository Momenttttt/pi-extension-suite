/**
 * S1：档案解析与旧字段名兼容（纯层，不碰 pi、不碰磁盘）。
 */
import { describe, expect, test } from "vitest";

import { parseAgentProfile } from "../src/profile.ts";

const FILE = "C:/repo/.pi/agents/reviewer.md";

describe("frontmatter 解析", () => {
  test("camelCase 字段全量解析，正文是 body", () => {
    const parsed = parseAgentProfile(
      [
        "---",
        "name: reviewer",
        "description: 审查改动",
        "tools: read, grep",
        "disallowedTools: write",
        "model: anthropic/claude-opus-4-5",
        "thinking: high",
        "maxTurns: 12",
        "promptMode: replace",
        "injectAgentsMd: false",
        "enabled: true",
        "---",
        "",
        "你是审查者。",
      ].join("\n"),
      { path: FILE, kind: "file", layer: "project-pi" },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toEqual([]);
    expect(parsed.profile).toMatchObject({
      name: "reviewer",
      description: "审查改动",
      tools: ["read", "grep"],
      disallowedTools: ["write"],
      model: "anthropic/claude-opus-4-5",
      thinking: "high",
      maxTurns: 12,
      promptMode: "replace",
      injectAgentsMd: false,
      enabled: true,
      body: "你是审查者。",
    });
    expect(parsed.profile.source).toEqual({ layer: "project-pi", kind: "file", path: FILE });
  });

  test("默认值：tools 全量、model/thinking inherit、promptMode append、读 AGENTS.md、不限轮次", () => {
    const parsed = parseAgentProfile("---\ndescription: d\n---\nbody", { path: FILE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.tools).toBe("*");
    expect(parsed.profile.disallowedTools).toEqual([]);
    expect(parsed.profile.model).toBe("inherit");
    expect(parsed.profile.thinking).toBe("inherit");
    expect(parsed.profile.promptMode).toBe("append");
    expect(parsed.profile.injectAgentsMd).toBe(true);
    expect(parsed.profile.maxTurns).toBeUndefined();
  });

  test("tools 支持数组、块列表与 *", () => {
    const inline = parseAgentProfile('---\ndescription: d\ntools: ["read", "grep"]\n---\n', { path: FILE });
    expect(inline.ok && inline.profile.tools).toEqual(["read", "grep"]);

    const block = parseAgentProfile("---\ndescription: d\ntools:\n  - read\n  - bash\n---\n", { path: FILE });
    expect(block.ok && block.profile.tools).toEqual(["read", "bash"]);

    const star = parseAgentProfile('---\ndescription: d\ntools: "*"\n---\n', { path: FILE });
    expect(star.ok && star.profile.tools).toBe("*");
  });

  test("description 支持块标量（> 折叠 / | 保留换行）", () => {
    const folded = parseAgentProfile("---\ndescription: >\n  第一行\n  第二行\n---\n", { path: FILE });
    expect(folded.ok && folded.profile.description).toBe("第一行 第二行");

    const literal = parseAgentProfile("---\ndescription: |\n  第一行\n  第二行\n---\n", { path: FILE });
    expect(literal.ok && literal.profile.description).toBe("第一行\n第二行");
  });

  test("没有 frontmatter = 缺 description，进失败列表", () => {
    const parsed = parseAgentProfile("只有正文", { path: FILE });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("description");
  });

  test("前置元数据坏掉时报错，不抛异常", () => {
    const parsed = parseAgentProfile("---\nname: x\n", { path: FILE });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("结束的 ---");
  });

  test("name 缺省时用文件名，并给一条不静默的提示", () => {
    const parsed = parseAgentProfile("---\ndescription: d\n---\nbody", { path: FILE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.name).toBe("reviewer");
    expect(parsed.warnings.join("\n")).toContain("按文件名取名");
  });
});

describe("旧字段名兼容（不静默）", () => {
  test("display_name / prompt_mode / disallowed_tools / max_turns 全部按新名解析并逐条警告", () => {
    const parsed = parseAgentProfile(
      [
        "---",
        "display_name: Explore",
        "description: 搜代码",
        "disallowed_tools: write, edit",
        "prompt_mode: replace",
        "max_turns: 3",
        "---",
        "body",
      ].join("\n"),
      { path: FILE },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.name).toBe("Explore");
    expect(parsed.profile.promptMode).toBe("replace");
    expect(parsed.profile.disallowedTools).toEqual(["write", "edit"]);
    expect(parsed.profile.maxTurns).toBe(3);

    const warnings = parsed.warnings.join("\n");
    for (const alias of ["display_name", "prompt_mode", "disallowed_tools", "max_turns"]) {
      expect(warnings).toContain(alias);
    }
  });

  test("规范字段与旧字段同时出现：用规范字段，但仍然警告", () => {
    const parsed = parseAgentProfile(
      "---\ndisplay_name: 旧的名字\nname: new-name\ndescription: d\n---\n",
      { path: FILE },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.name).toBe("new-name");
    expect(parsed.warnings.join("\n")).toContain("display_name");
  });

  test("用旧字段名的 Explore.md 能直接加载", () => {
    const parsed = parseAgentProfile(
      [
        "---",
        'description: "Fast read-only search agent for locating code."',
        "display_name: Explore",
        "tools: read, bash, grep, find, ls",
        "prompt_mode: replace",
        "---",
        "# CRITICAL: READ-ONLY MODE",
      ].join("\n"),
      { path: "C:/Users/me/.pi/agent/agents/Explore.md", kind: "file", layer: "user" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.name).toBe("Explore");
    expect(parsed.profile.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(parsed.profile.promptMode).toBe("replace");
  });
});

describe("非法字段不阻断，按默认处理并告警", () => {
  test("maxTurns 非正整数被忽略", () => {
    const parsed = parseAgentProfile("---\ndescription: d\nmaxTurns: 0\n---\n", { path: FILE });
    expect(parsed.ok && parsed.profile.maxTurns).toBeUndefined();
    expect(parsed.warnings.join("\n")).toContain("maxTurns");
  });

  test("thinking 非法值退回 inherit", () => {
    const parsed = parseAgentProfile("---\ndescription: d\nthinking: turbo\n---\n", { path: FILE });
    expect(parsed.ok && parsed.profile.thinking).toBe("inherit");
    expect(parsed.warnings.join("\n")).toContain("thinking");
  });

  test("promptMode 非法值退回 append", () => {
    const parsed = parseAgentProfile("---\ndescription: d\npromptMode: prepend\n---\n", { path: FILE });
    expect(parsed.ok && parsed.profile.promptMode).toBe("append");
    expect(parsed.warnings.join("\n")).toContain("promptMode");
  });

  test("frontmatter 里的 source 被忽略（身份由加载器持有，ADR-0002）", () => {
    const parsed = parseAgentProfile("---\ndescription: d\nsource: builtin\n---\n", { path: FILE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.source.kind).toBe("file");
    expect(parsed.warnings.join("\n")).toContain("source");
  });
});
