/**
 * S1：memory_list 的扫描规则与 memory_read 的定位/截断。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { listMemoryFiles } from "../src/list.ts";
import { locateMemory, truncateMemoryBody, MEMORY_BODY_BYTE_LIMIT, MEMORY_BODY_LINE_LIMIT } from "../src/read.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function memoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-dir-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fact(root: string, relativePath: string, fields: { name?: string; description?: string; type?: string; body?: string }): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  const frontmatter = ["---"];
  if (fields.name !== undefined) frontmatter.push(`name: ${fields.name}`);
  if (fields.description !== undefined) frontmatter.push(`description: ${fields.description}`);
  if (fields.type !== undefined) {
    frontmatter.push("metadata:", "  node_type: memory", `  type: ${fields.type}`);
  }
  frontmatter.push("---", "", fields.body ?? "正文");
  writeFileSync(path, `${frontmatter.join("\n")}\n`, "utf8");
  return path;
}

describe("listMemoryFiles", () => {
  test("递归扫描、排除 MEMORY.md 与非 .md；坏 frontmatter 降级不抛错", () => {
    const root = memoryDir();
    fact(root, "a.md", { name: "a", description: "第一", type: "user" });
    fact(root, "sub/deep/b.md", { name: "b", description: "第二", type: "project" });
    writeFileSync(join(root, "MEMORY.md"), "- [a](a.md) — 第一\n", "utf8");
    writeFileSync(join(root, "notes.txt"), "ignore me", "utf8");
    writeFileSync(join(root, "broken.md"), "没有 frontmatter", "utf8");

    const entries = listMemoryFiles(root);
    expect(entries.map((entry) => entry.filename).sort()).toEqual(["a.md", "broken.md", "sub/deep/b.md"]);
    const broken = entries.find((entry) => entry.filename === "broken.md");
    expect(broken?.malformed).toBe(true);
    expect(broken?.description).toBeUndefined();
    const deep = entries.find((entry) => entry.filename === "sub/deep/b.md");
    expect(deep?.name).toBe("b");
    expect(deep?.type).toBe("project");
  });

  test("按 mtime 倒序", () => {
    const root = memoryDir();
    const older = fact(root, "older.md", { description: "old" });
    const newer = fact(root, "newer.md", { description: "new" });
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    expect(listMemoryFiles(root).map((entry) => entry.filename)).toEqual(["newer.md", "older.md"]);
  });

  test("不跟随目录符号链接", (context) => {
    const root = memoryDir();
    fact(root, "real/a.md", { description: "real" });
    try {
      symlinkSync(join(root, "real"), join(root, "link"), "dir");
    } catch {
      context.skip();
      return;
    }
    expect(listMemoryFiles(root).map((entry) => entry.filename)).toEqual(["real/a.md"]);
  });
});

describe("locateMemory", () => {
  test("按文件名 / name / 无后缀 / 子目录定位", () => {
    const root = memoryDir();
    fact(root, "user-pref.md", { name: "user-pref", description: "偏好" });
    fact(root, "sub/nested.md", { name: "nested-memory", description: "嵌套" });

    const byFile = locateMemory(root, "user-pref.md");
    expect(byFile.ok && byFile.value.filename).toBe("user-pref.md");
    const byName = locateMemory(root, "nested-memory");
    expect(byName.ok && byName.value.filename).toBe("sub/nested.md");
    const bySubPath = locateMemory(root, "sub/nested.md");
    expect(bySubPath.ok && bySubPath.value.filename).toBe("sub/nested.md");
    const byBase = locateMemory(root, "user-pref");
    expect(byBase.ok && byBase.value.filename).toBe("user-pref.md");
  });

  test("同名多处命中 → 报歧义而不是猜", () => {
    const root = memoryDir();
    fact(root, "one.md", { name: "dup", description: "1" });
    fact(root, "two.md", { name: "dup", description: "2" });
    const result = locateMemory(root, "dup");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ambiguous");
      expect(result.error.message).toContain("one.md");
      expect(result.error.message).toContain("two.md");
    }
  });

  test("找不到与越界引用", () => {
    const root = memoryDir();
    fact(root, "a.md", { description: "x" });
    const missing = locateMemory(root, "nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
    const traversal = locateMemory(root, "../../secret.md");
    expect(traversal.ok).toBe(false);
    const absolute = locateMemory(root, join(root, "..", "secret.md"));
    expect(absolute.ok).toBe(false);
  });

  test("可以直接读 MEMORY.md（索引也是记忆目录里的文件）", () => {
    const root = memoryDir();
    writeFileSync(join(root, "MEMORY.md"), "- [a](a.md) — hook\n", "utf8");
    const result = locateMemory(root, "MEMORY.md");
    expect(result.ok && result.value.body.trim()).toBe("- [a](a.md) — hook");
  });
});

describe("truncateMemoryBody（对齐 ZCode recall 上限）", () => {
  test("短正文原样返回", () => {
    const result = truncateMemoryBody("第一行\n第二行");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("第一行\n第二行");
  });

  test("超过 200 行 → 取前 200 行", () => {
    const body = Array.from({ length: 300 }, (_, index) => `第 ${index} 行`).join("\n");
    const result = truncateMemoryBody(body);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("lines");
    expect(result.text.split("\n")).toHaveLength(MEMORY_BODY_LINE_LIMIT);
  });

  test("超过 4096 字节 → 截到完整行边界", () => {
    const line = "x".repeat(100);
    const body = Array.from({ length: 100 }, () => line).join("\n");
    const result = truncateMemoryBody(body);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("bytes");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MEMORY_BODY_BYTE_LIMIT);
    expect(result.text.split("\n").every((value) => value === line)).toBe(true);
  });

  test("行数与字节同时超限 → both", () => {
    const line = "y".repeat(200);
    const body = Array.from({ length: 300 }, () => line).join("\n");
    expect(truncateMemoryBody(body).reason).toBe("both");
  });
});
