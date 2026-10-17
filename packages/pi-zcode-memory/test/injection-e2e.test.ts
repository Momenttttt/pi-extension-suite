/**
 * S2（票据 07 的端到端验收）：索引注入。
 *
 * 断言落在桩 provider 收到的请求本身：第一次请求带索引；第二次请求不重复注入；
 * 索引内容变化后下一轮重新注入。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupMemoryWorkspaces,
  createMemoryWorkspace,
  sessionWithMemory,
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

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function writeIndex(workspace: MemoryWorkspace, body: string): void {
  writeFileSync(join(workspace.memDir, "MEMORY.md"), body, "utf8");
}

describe("索引注入", () => {
  test("第一次请求注入索引；第二次不重复；索引变化后重新注入", async () => {
    const workspace = createMemoryWorkspace();
    writeIndex(workspace, "- [alpha](alpha.md) — INDEX-ALPHA 钩子\n");
    const session = await sessionIn(workspace, [{ text: "one" }, { text: "two" }, { text: "three" }]);

    await session.run("第一轮");
    const first = session.requests[0]?.allText ?? "";
    expect(first).toContain("cross-session automatic memory index");
    expect(first).toContain("INDEX-ALPHA");
    expect(first).toContain(workspace.memDir);

    await session.run("第二轮");
    const second = session.requests[1]?.allText ?? "";
    expect(countOccurrences(second, "INDEX-ALPHA")).toBe(1);
    expect(countOccurrences(second, "cross-session automatic memory index")).toBe(1);

    // 索引变了 → 下一轮重新注入新内容
    writeIndex(workspace, "- [beta](beta.md) — INDEX-BETA 钩子\n");
    await session.run("第三轮");
    const third = session.requests[2]?.allText ?? "";
    expect(countOccurrences(third, "INDEX-BETA")).toBe(1);
    expect(countOccurrences(third, "cross-session automatic memory index")).toBe(2);
  });

  test("索引不存在时不注入（不制造空记忆上下文）", async () => {
    const workspace = createMemoryWorkspace();
    const session = await sessionIn(workspace, [{ text: "ok" }]);
    await session.run("随便说点什么");
    expect(session.requests[0]?.allText ?? "").not.toContain("cross-session automatic memory index");
  });

  test("resume 后按当前分支重建标记：不重复注入", async () => {
    const workspace = createMemoryWorkspace();
    writeIndex(workspace, "- [alpha](alpha.md) — INDEX-ALPHA 钩子\n");
    const sessionDir = join(workspace.cwd, "sessions");

    const first = await sessionWithMemory(workspace, [{ text: "one" }], { sessionDir });
    await first.run("第一轮");
    const sessionFile = first.sessionFile();
    expect(sessionFile).toBeDefined();
    expect(countOccurrences(first.requests[0]?.allText ?? "", "INDEX-ALPHA")).toBe(1);
    first.dispose();

    // 新进程/新扩展实例恢复同一会话：若 session_start 没有从分支重建标记，这里会再注入一次
    const resumed = await sessionWithMemory(workspace, [{ text: "two" }], {
      sessionDir,
      resumeFrom: sessionFile,
    });
    sessions.push(resumed);
    await resumed.run("第二轮");
    expect(countOccurrences(resumed.requests[0]?.allText ?? "", "INDEX-ALPHA")).toBe(1);
    expect(countOccurrences(resumed.requests[0]?.allText ?? "", "cross-session automatic memory index")).toBe(1);
  });

  test("超长索引按 200 行截断并带着 WARNING 一起注入", async () => {
    const workspace = createMemoryWorkspace();
    const lines = Array.from({ length: 260 }, (_, index) => `- [m${index}](m${index}.md) — 钩子 ${index}`);
    writeIndex(workspace, `${lines.join("\n")}\n`);
    const session = await sessionIn(workspace, [{ text: "ok" }]);
    await session.run("读索引");
    const first = session.requests[0]?.allText ?? "";
    expect(first).toContain("WARNING");
    expect(first).toContain("injection limit");
    expect(first).not.toContain("- [m259]");
    expect(first).toContain("- [m199]");
  });

  test("索引里的 frontmatter 与顶层注释不会进上下文", async () => {
    const workspace = createMemoryWorkspace();
    // 剥离顺序：先剥开头 frontmatter，再剥顶层注释
    writeIndex(workspace, "---\ntitle: stray\n---\n<!-- 内部说明 -->\n- [a](a.md) — 可见钩子\n");
    const session = await sessionIn(workspace, [{ text: "ok" }]);
    await session.run("读索引");
    const first = session.requests[0]?.allText ?? "";
    expect(first).toContain("可见钩子");
    expect(first).not.toContain("内部说明");
    expect(first).not.toContain("title: stray");
  });

  test("注入配置关闭时不注入", async () => {
    const workspace = createMemoryWorkspace();
    writeIndex(workspace, "- [a](a.md) — INDEX-ALPHA\n");
    writeFileSync(
      join(workspace.cwd, ".pi", "zcode-memory.json"),
      JSON.stringify({ dir: workspace.memDir, injectIndex: false }),
      "utf8",
    );
    const session = await sessionIn(workspace, [{ text: "ok" }]);
    await session.run("说点什么");
    expect(session.requests[0]?.allText ?? "").not.toContain("cross-session automatic memory index");
  });
});
