/**
 * S2（票据 05 / 06 的集成验收）：真实 AgentSession + 桩 provider。
 *
 * 两个方向都验：
 *   - 读：对一个"ZCode 已写过记忆"的目录，memory_list / memory_read 的模型可见输出与磁盘一致
 *   - 写：memory_write 落盘后，事实文件按回读规则可解析（首行 `---`、30 行内闭合、YAML 是映射）；
 *     MEMORY.md 的 revision 前进（另一侧下一次写读到新 revision 后自己继续）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { isMap, parse as parseYaml, parseDocument } from "yaml";

import { revisionOf, upsertMemoryIndexLine } from "../src/index-file.ts";
import {
  cleanupMemoryWorkspaces,
  createMemoryWorkspace,
  sessionWithMemory,
  writeZcodeStyleFact,
  type MemoryWorkspace,
} from "./e2e-support.ts";
import type { TestSession } from "./test-session.ts";

const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  cleanupMemoryWorkspaces();
});

async function sessionIn(workspace: MemoryWorkspace, responses: Parameters<typeof sessionWithMemory>[1]) {
  const session = await sessionWithMemory(workspace, responses);
  sessions.push(session);
  return session;
}

describe("memory_list / memory_read（读取 ZCode 写下的记忆）", () => {
  test("列表与正文和磁盘内容一致", async () => {
    const workspace = createMemoryWorkspace();
    writeZcodeStyleFact(workspace.memDir, "build-quirk.md", {
      name: "build-quirk",
      description: "构建脚本必须先跑 codegen",
      type: "project",
      body: "**Why:** 生成物不在仓库里。\n\n**How to apply:** 改 schema 后先 pnpm codegen。",
    });
    writeFileSync(
      join(workspace.memDir, "MEMORY.md"),
      "- [build-quirk](build-quirk.md) — 构建脚本必须先跑 codegen\n",
      "utf8",
    );

    const session = await sessionIn(workspace, [
      { toolCall: { name: "memory_list", arguments: {} } },
      { text: "listed" },
    ]);
    await session.run("这个项目有什么记忆？");
    expect(session.requests).toHaveLength(2);
    const listResult = session.requests[1]?.allText ?? "";
    expect(listResult).toContain("build-quirk.md");
    expect(listResult).toContain("构建脚本必须先跑 codegen");
    expect(listResult).toContain("[project]");

    const readSession = await sessionIn(workspace, [
      { toolCall: { name: "memory_read", arguments: { name: "build-quirk" } } },
      { text: "read" },
    ]);
    await readSession.run("读一下 build-quirk 的正文");
    expect(readSession.requests).toHaveLength(2);
    const readResult = readSession.requests[1]?.allText ?? "";
    const onDisk = readFileSync(join(workspace.memDir, "build-quirk.md"), "utf8");
    expect(readResult).toContain("**Why:** 生成物不在仓库里。");
    expect(onDisk).toContain("**How to apply:** 改 schema 后先 pnpm codegen。");
    expect(readResult).toContain("name: build-quirk");
    expect(readResult).toContain("type: project");
  });

  test("坏 frontmatter 的条目降级显示、不崩", async () => {
    const workspace = createMemoryWorkspace();
    writeFileSync(join(workspace.memDir, "broken.md"), "不是 frontmatter\n正文", "utf8");
    const session = await sessionIn(workspace, [
      { toolCall: { name: "memory_list", arguments: {} } },
      { text: "listed" },
    ]);
    await session.run("列一下记忆");
    expect(session.requests[1]?.allText).toContain("broken.md");
    expect(session.requests[1]?.allText).toContain("frontmatter cannot be parsed");
  });

  test("找不到记忆时工具报错、模型能看到原因", async () => {
    const workspace = createMemoryWorkspace();
    const session = await sessionIn(workspace, [
      { toolCall: { name: "memory_read", arguments: { name: "no-such-memory" } } },
      { text: "not found" },
    ]);
    await session.run("读一条不存在的记忆");
    expect(session.requests[1]?.allText).toContain('No memory "no-such-memory"');
    expect(session.requests[1]?.allText).toContain("memory_list");
  });
});

describe("memory_write（写入后 ZCode 可回读）", () => {
  test("create 落盘 + 索引行；文件符合 ZCode manifest 规则", async () => {
    const workspace = createMemoryWorkspace();
    const session = await sessionIn(workspace, [
      {
        toolCall: {
          name: "memory_write",
          arguments: {
            name: "user-api-preference",
            description: "用户偏好 REST 而不是 GraphQL",
            type: "feedback",
            body: "**Why:** 团队已有 REST 网关。\n\n**How to apply:** 新接口默认 REST。",
            mode: "create",
          },
        },
      },
      { text: "written" },
    ]);
    await session.run("记住我偏好 REST");
    expect(session.requests).toHaveLength(2);
    expect(session.requests[1]?.allText).toContain("Created memory user-api-preference.md");

    const text = readFileSync(join(workspace.memDir, "user-api-preference.md"), "utf8");
    const lines = text.replace(/\r\n/gu, "\n").split("\n");
    expect(lines[0]).toBe("---");
    const end = lines.indexOf("---", 1);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(30);
    const parsed = parseYaml(lines.slice(1, end).join("\n")) as Record<string, unknown>;
    expect(isMap(parseDocument(lines.slice(1, end).join("\n")).contents)).toBe(true);
    expect(parsed.name).toBe("user-api-preference");
    expect(parsed.description).toBe("用户偏好 REST 而不是 GraphQL");
    expect((parsed.metadata as Record<string, unknown>).node_type).toBe("memory");
    expect((parsed.metadata as Record<string, unknown>).type).toBe("feedback");
    expect(text).not.toContain("originSessionId");

    expect(readFileSync(join(workspace.memDir, "MEMORY.md"), "utf8")).toBe(
      "- [user-api-preference](user-api-preference.md) — 用户偏好 REST 而不是 GraphQL\n",
    );
  });

  test("upsert 更新同一行，不产生重复", async () => {
    const workspace = createMemoryWorkspace();
    const session = await sessionIn(workspace, [
      {
        toolCall: {
          name: "memory_write",
          arguments: {
            name: "build-quirk",
            description: "构建要先 codegen",
            type: "project",
            body: "第一版正文",
            mode: "create",
          },
        },
      },
      {
        toolCall: {
          name: "memory_write",
          arguments: {
            name: "build-quirk",
            description: "构建必须先跑 codegen（更新）",
            type: "project",
            body: "第二版正文",
            mode: "upsert",
          },
        },
      },
      { text: "done" },
    ]);
    await session.run("先写再更新一条记忆");
    const index = readFileSync(join(workspace.memDir, "MEMORY.md"), "utf8");
    expect(index.match(/\]\(build-quirk\.md\)/gu)).toHaveLength(1);
    expect(index).toContain("（更新）");
    expect(readFileSync(join(workspace.memDir, "build-quirk.md"), "utf8")).toContain("第二版正文");
  });

  test("已有索引被外部改动后写入：revision 前进，重读后能继续加行", async () => {
    const workspace = createMemoryWorkspace();
    // 模拟"另一侧的会话开着"：先有索引与被它读过的 revision
    writeFileSync(join(workspace.memDir, "MEMORY.md"), "- [old](old.md) — 旧\n", "utf8");
    const revisionSeenByZcode = await revisionOf(join(workspace.memDir, "MEMORY.md"));

    const session = await sessionIn(workspace, [
      {
        toolCall: {
          name: "memory_write",
          arguments: { name: "fresh", description: "新事实", type: "user", body: "正文", mode: "create" },
        },
      },
      { text: "written" },
    ]);
    await session.run("写一条新记忆");

    const revisionNow = await revisionOf(join(workspace.memDir, "MEMORY.md"));
    expect(revisionNow?.id).not.toBe(revisionSeenByZcode?.id);

    // 它重读索引后再写：我们的行还在，没有被整份盖掉
    const reRead = readFileSync(join(workspace.memDir, "MEMORY.md"), "utf8");
    const afterZcodeRewrite = upsertMemoryIndexLine(reRead, {
      filename: "zcode-added.md",
      title: "zcode-added",
      description: "ZCode 重读后补的行",
    });
    expect(afterZcodeRewrite.content).toContain("](fresh.md)");
    expect(afterZcodeRewrite.content).toContain("](zcode-added.md)");
  });

  test("项目尚无记忆目录时，memory_write 按配置目录创建", async () => {
    const workspace = createMemoryWorkspace();
    // 把配置指向一个尚不存在的子目录
    const nested = join(workspace.memDir, "not-yet", "memory");
    writeFileSync(
      join(workspace.cwd, ".pi", "zcode-memory.json"),
      JSON.stringify({ dir: nested }),
      "utf8",
    );
    const session = await sessionIn(workspace, [
      {
        toolCall: {
          name: "memory_write",
          arguments: { name: "first", description: "第一条", type: "project", body: "正文", mode: "create" },
        },
      },
      { text: "ok" },
    ]);
    await session.run("写第一条记忆");
    expect(readFileSync(join(nested, "first.md"), "utf8")).toContain("name: first");
    expect(readFileSync(join(nested, "MEMORY.md"), "utf8")).toContain("](first.md)");
  });
});
