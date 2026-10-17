/**
 * S1：索引体检与 /memory 状态文案。
 */
import { describe, expect, test } from "vitest";

import type { MemoryListEntry } from "../src/list.ts";
import type { MemoryDirResolution } from "../src/resolve.ts";
import { extractIndexTargets, formatMemoryStatus, inspectMemoryIndex } from "../src/status.ts";

function entry(filename: string, description?: string): MemoryListEntry {
  return {
    filename,
    mtimeMs: 0,
    malformed: false,
    ...(description === undefined ? {} : { description }),
  };
}

function resolution(overrides: Partial<MemoryDirResolution> = {}): MemoryDirResolution {
  return {
    dir: "/mem/chat-abc/memory",
    source: "computed",
    computedDir: "/mem/chat-abc/memory",
    projectsRoot: "/mem/projects",
    warnings: [],
    ...overrides,
  };
}

describe("extractIndexTargets", () => {
  test("抽相对 .md 链接，忽略 http 与 MEMORY.md 自身", () => {
    const content = [
      "- [a](a.md) — 一",
      "- [b](sub/b.md) — 二",
      "- [外链](https://example.com/x.md) — 三",
      "- [索引自己](MEMORY.md) — 四",
      "普通文字 (parenthetical) 不算",
    ].join("\n");
    expect(extractIndexTargets(content)).toEqual(["a.md", "sub/b.md"]);
  });
});

describe("inspectMemoryIndex", () => {
  test("孤儿索引行与未入索引的文件", () => {
    const health = inspectMemoryIndex({
      indexContent: "- [a](a.md) — 一\n- [失踪](gone.md) — 二\n",
      files: [entry("a.md"), entry("unindexed.md")],
    });
    expect(health.orphanIndexLines).toEqual(["gone.md"]);
    expect(health.unindexedFiles).toEqual(["unindexed.md"]);
    expect(health.indexLineCount).toBe(2);
  });

  test("没有索引时一切为空", () => {
    const health = inspectMemoryIndex({ indexContent: undefined, files: [entry("a.md")] });
    expect(health.indexLineCount).toBe(0);
    expect(health.unindexedFiles).toEqual(["a.md"]);
  });
});

describe("formatMemoryStatus", () => {
  test("包含目录、来源、行数、事实数、体检与注入状态", () => {
    const text = formatMemoryStatus({
      resolution: resolution(),
      indexContent: "- [a](a.md) — 一\n- [失踪](gone.md) — 二\n",
      files: [entry("a.md"), entry("unindexed.md")],
      injectionLabel: "已注入（hash abc123…）",
    });
    expect(text).toContain("记忆目录：/mem/chat-abc/memory");
    expect(text).toContain("来源：按算法计算（路径存在）");
    expect(text).toContain("索引 MEMORY.md：2 行");
    expect(text).toContain("事实文件：2 个");
    expect(text).toContain("孤儿索引行 1 条（gone.md）");
    expect(text).toContain("未入索引的文件 1 个（unindexed.md）");
    expect(text).toContain("索引注入：已注入");
  });

  test("尚无记忆与 project- 提示都如实显示", () => {
    const text = formatMemoryStatus({
      resolution: resolution({
        dir: undefined,
        source: "none",
        computedDir: "/mem/chat-abc/memory",
        warnings: ["该项目尚无 ZCode 记忆。", "检测到 project- 前缀的记忆目录：……"],
      }),
      indexContent: undefined,
      files: [],
      injectionLabel: "未注入（尚无记忆目录）",
    });
    expect(text).toContain("记忆目录：未解析到");
    expect(text).toContain("来源：尚无记忆");
    expect(text).toContain("索引 MEMORY.md：不存在");
    expect(text).toContain("project- 前缀");
    expect(text).toContain("未注入");
  });
});
