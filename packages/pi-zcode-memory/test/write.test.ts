/**
 * S1：memory_write 的落盘（frontmatter、原子写、索引行维护、revision 重试）。
 *
 * 另含 ZCode `recall/manifest.ts` 规则的回读校验：首行 `---`、30 行内闭合、YAML 可映射。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { isMap, parse as parseYaml, parseDocument } from "yaml";

import { MemoryWriteError } from "../src/errors.ts";
import {
  INDEX_FILENAME,
  revisionIdFromStat,
  revisionOf,
  sameRevision,
  updateMemoryIndex,
  upsertMemoryIndexLine,
} from "../src/index-file.ts";
import { memoryFilenameFor, writeMemory } from "../src/write.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function memoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-write-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSample(root: string, overrides: Partial<Parameters<typeof writeMemory>[0]> = {}) {
  return writeMemory({
    root,
    name: "user-api-preference",
    description: "用户偏好 REST 而不是 GraphQL",
    type: "feedback",
    body: "**Why:** 团队已有 REST 网关。\n\n**How to apply:** 新接口默认 REST。",
    mode: "create",
    ...overrides,
  });
}

/** ZCode `recall/manifest.ts` 的回读规则：首行 ---、30 行内闭合、YAML 是映射。 */
function assertZcodeManifestCompatible(text: string): void {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  expect(end).toBeLessThan(30);
  const parsed = parseYaml(lines.slice(1, end).join("\n"));
  expect(isMap(parseDocument(lines.slice(1, end).join("\n")).contents)).toBe(true);
  expect(typeof (parsed as Record<string, unknown>).description).toBe("string");
}

describe("memoryFilenameFor", () => {
  test("补 .md、剥离 .md、保留大小写", () => {
    expect(memoryFilenameFor("user-api-preference").filename).toBe("user-api-preference.md");
    expect(memoryFilenameFor("user-api-preference.md").filename).toBe("user-api-preference.md");
    expect(memoryFilenameFor("UserPreference").filename).toBe("UserPreference.md");
  });

  test("拒绝空、路径分隔符、盘符、点开头与非法字符", () => {
    for (const bad of ["", "  ", "a/b", "a\\b", "..", ".hidden", "-leading", "a b", "C:evil", "a?b"]) {
      expect(() => memoryFilenameFor(bad), bad).toThrow(MemoryWriteError);
    }
  });
});

describe("writeMemory", () => {
  test("create：原子写事实文件 + 插入索引行", async () => {
    const root = memoryDir();
    const outcome = await writeSample(root);
    expect(outcome.fileAction).toBe("created");
    expect(outcome.indexAction).toBe("inserted");

    const text = readFileSync(join(root, "user-api-preference.md"), "utf8");
    expect(text.startsWith("---\nname: user-api-preference\n")).toBe(true);
    expect(text).toContain("metadata:\n  node_type: memory\n  type: feedback\n");
    expect(text).not.toContain("originSessionId");
    assertZcodeManifestCompatible(text);

    const index = readFileSync(join(root, INDEX_FILENAME), "utf8");
    expect(index).toBe("- [user-api-preference](user-api-preference.md) — 用户偏好 REST 而不是 GraphQL\n");
  });

  test("create 遇同名报错，且不覆盖已有内容", async () => {
    const root = memoryDir();
    await writeSample(root);
    const before = readFileSync(join(root, "user-api-preference.md"), "utf8");
    await expect(writeSample(root, { description: "新描述" })).rejects.toMatchObject({ code: "exists" });
    expect(readFileSync(join(root, "user-api-preference.md"), "utf8")).toBe(before);
  });

  test("upsert：覆盖文件、更新索引行、不产生重复行", async () => {
    const root = memoryDir();
    await writeSample(root);
    await writeSample(root, { mode: "upsert", description: "改后的描述", body: "改后的正文" });

    const index = readFileSync(join(root, INDEX_FILENAME), "utf8");
    expect(index.match(/\]\(user-api-preference\.md\)/gu)).toHaveLength(1);
    expect(index).toContain("改后的描述");
    expect(index).not.toContain("用户偏好 REST 而不是 GraphQL");
    expect(readFileSync(join(root, "user-api-preference.md"), "utf8")).toContain("改后的正文");
  });

  test("upsert 同一内容 → 索引 unchanged（不写盘）", async () => {
    const root = memoryDir();
    await writeSample(root);
    const outcome = await writeSample(root, { mode: "upsert" });
    expect(outcome.indexAction).toBe("unchanged");
    expect(outcome.fileAction).toBe("overwritten");
  });

  test("缺 description/body → 报错，目录里不留文件", async () => {
    const root = memoryDir();
    await expect(writeSample(root, { description: "  " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(writeSample(root, { body: " " })).rejects.toMatchObject({ code: "invalid_input" });
    expect(readdirSync(root)).toEqual([]);
  });

  test("并发两次写入：走 pi 的写队列串行后两行都在，且没有临时文件残留", async () => {
    const root = memoryDir();
    // 扩展里真实使用的写队列；这里验证"队列 + 我们的读-改-写"组合起来不会丢行
    await Promise.all([
      withFileMutationQueue(root, () => writeSample(root, { name: "one", description: "第一条" })),
      withFileMutationQueue(root, () => writeSample(root, { name: "two", description: "第二条" })),
    ]);
    const index = readFileSync(join(root, INDEX_FILENAME), "utf8");
    expect(index).toContain("](one.md)");
    expect(index).toContain("](two.md)");
    expect(readdirSync(root).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  test("目标是指向别处的符号链接 → 拒绝（Windows 需权限，建不了就跳过）", async (context) => {
    const root = memoryDir();
    const target = join(root, "real.md");
    writeFileSync(target, "real", "utf8");
    try {
      symlinkSync(target, join(root, "link.md"), "file");
    } catch {
      context.skip();
      return;
    }
    await expect(
      writeSample(root, { name: "link", description: "想通过链接写" }),
    ).rejects.toMatchObject({ code: "symlink" });
    expect(readFileSync(target, "utf8")).toBe("real");
  });

  test("写入后 ZCode 的 revision 发生变化（它的 stale_write 自愈路径得以前进）", async () => {
    const root = memoryDir();
    await writeSample(root);
    const before = await revisionOf(join(root, INDEX_FILENAME));
    expect(before?.id).toMatch(/^mtime:\d+:size:\d+$/u);
    await writeSample(root, { mode: "upsert", description: "换一个长一些的描述让 size 必然变化" });
    const after = await revisionOf(join(root, INDEX_FILENAME));
    expect(after?.id).not.toBe(before?.id);
    expect(sameRevision(before, after)).toBe(false);
  });
});

describe("索引行维护", () => {
  test("插入到末尾、保留原有内容与行尾", () => {
    const existing = "# 索引\n\n- [旧](old.md) — 旧钩子\n";
    const result = upsertMemoryIndexLine(existing, { filename: "new.md", title: "new", description: "新钩子" });
    expect(result.action).toBe("inserted");
    expect(result.content).toBe(`${existing}- [new](new.md) — 新钩子\n`);
  });

  test("更新既有行；历史重复行被顺带合并成一行", () => {
    const existing = "- [a](dup.md) — 旧\n- [其它](other.md) — 别的\n- [a](dup.md) — 旧\n";
    const result = upsertMemoryIndexLine(existing, { filename: "dup.md", title: "a", description: "新" });
    expect(result.action).toBe("updated");
    expect(result.content).toBe("- [a](dup.md) — 新\n- [其它](other.md) — 别的\n");
  });

  test("等价行 → unchanged", () => {
    const existing = "- [a](a.md) — 钩子\n";
    expect(upsertMemoryIndexLine(existing, { filename: "a.md", title: "a", description: "钩子" }).action).toBe("unchanged");
  });

  test("引用空目录时创建新索引内容", () => {
    expect(upsertMemoryIndexLine("", { filename: "a.md", title: "a", description: "d" }).content).toBe("- [a](a.md) — d\n");
  });

  test("revision 首次比对不一致 → 重读重试一次后成功", async () => {
    const root = memoryDir();
    let calls = 0;
    const flaky = async (path: string) => {
      calls += 1;
      const real = await revisionOf(path);
      // 第 2 次调用（第一次 attempt 的"写前复查"）故意返回陈旧值
      return calls === 2 ? { id: "mtime:1:size:1", mtimeMs: 1, sizeBytes: 1 } : real;
    };
    const outcome = await updateMemoryIndex(
      root,
      { filename: "a.md", title: "a", description: "d" },
      { revisionReader: flaky },
    );
    expect(outcome.action).toBe("inserted");
    expect(calls).toBe(4);
    expect(readFileSync(join(root, INDEX_FILENAME), "utf8")).toContain("](a.md)");
  });

  test("revision 连续不一致 → 两次重试后硬报错，不静默覆盖", async () => {
    const root = memoryDir();
    let counter = 0;
    const flip = async () => {
      counter += 1;
      return { id: `mtime:${counter}:size:${counter}`, mtimeMs: counter, sizeBytes: counter };
    };
    await expect(
      updateMemoryIndex(root, { filename: "a.md", title: "a", description: "d" }, { revisionReader: flip }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    expect(counter).toBe(4);
    expect(() => readFileSync(join(root, INDEX_FILENAME), "utf8")).toThrow();
  });

  test("revisionIdFromStat 与 ZCode 同构（截断毫秒）", () => {
    expect(revisionIdFromStat({ mtimeMs: 1234.98, size: 7 })).toBe("mtime:1234:size:7");
  });
});

describe("原子写与 upsert 的组合行为", () => {
  test("修改已有文件的权限位不丢（POSIX 下有效；Windows 跳过）", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const root = memoryDir();
    const path = join(root, "script.md");
    writeFileSync(path, "x", { mode: 0o755 });
    await writeMemory({ root, name: "script", description: "d", type: "user", body: "b", mode: "upsert" });
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test("索引中的文件名与磁盘一致（读回来能定位）", async () => {
    const root = memoryDir();
    await writeSample(root, { name: "nested-name", description: "描述", type: "project", body: "正文" });
    const index = await readFile(join(root, INDEX_FILENAME), "utf8");
    expect(index).toContain("(nested-name.md)");
  });

  test("utimes 触碰不影响 upsert 的读-改-写", async () => {
    const root = memoryDir();
    await writeSample(root);
    const indexPath = join(root, INDEX_FILENAME);
    utimesSync(indexPath, new Date(1000), new Date(1000));
    await writeSample(root, { mode: "upsert", description: "触碰后更新" });
    expect(readFileSync(indexPath, "utf8")).toContain("触碰后更新");
  });
});
