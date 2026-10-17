/**
 * S2 端到端：真实 AgentSession + 桩 provider。
 *
 * 这一层同时验证两件容易分开出错的事：
 *   1. 测试骨架本身可用（扩展装得进去、桩 provider 收得到请求）
 *   2. 门禁在真实事件流里按预期放行/阻断
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import readGuard from "../extensions/read-guard.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

const workspaces: Array<() => void> = [];
const sessions: TestSession[] = [];

function workspace(): string {
  const { cwd, cleanup } = createTempWorkspace();
  workspaces.push(cleanup);
  return cwd;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

async function sessionIn(cwd: string, responses: Parameters<typeof createTestSession>[0]["responses"]) {
  const created = await createTestSession({ extension: readGuard, cwd, responses });
  sessions.push(created);
  return created;
}

describe("桩 provider 骨架", () => {
  test("扩展装进真实会话，桩 provider 收到请求", async () => {
    const cwd = workspace();
    const test = await sessionIn(cwd, [{ text: "hello from stub" }]);

    const reply = await test.run("hi");
    expect(reply).toBe("hello from stub");
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.allText).toContain("hi");
  });

  test("桩 provider 能按脚本驱动工具调用", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "line one\nline two\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "read it" },
    ]);

    const reply = await test.run("read a.txt then answer");
    expect(reply).toBe("read it");
    expect(test.requests).toHaveLength(2);
    // 第二次请求里应该带上工具结果
    expect(test.requests[1]?.allText).toContain("line one");
  });
});

describe("read-guard 门禁（未读 / 已读）", () => {
  test("未读直接 write 已存在文件 → 被拒，理由出现在工具结果里", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "original\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "overwritten\n" } } },
      { text: "done" },
    ]);

    await test.run("overwrite a.txt");
    expect(test.requests).toHaveLength(2);
    // 第二次请求里应该出现阻断文案（工具结果），且文件内容没变
    expect(test.requests[1]?.allText).toContain("has not been read in this session");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("original\n");
  });

  test("先 read 再 write → 放行", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "original\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "overwritten\n" } } },
      { text: "done" },
    ]);

    await test.run("read then overwrite a.txt");
    const third = test.requests[2];
    expect(third?.allText).not.toContain("has not been read in this session");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("overwritten\n");
  });

  test("新建文件（目标不存在）直接 write → 放行", async () => {
    const cwd = workspace();
    const test = await sessionIn(cwd, [
      { toolCall: { name: "write", arguments: { path: "brand-new.txt", content: "hi\n" } } },
      { text: "done" },
    ]);

    await test.run("create brand-new.txt");
    expect(test.requests[1]?.allText).not.toContain("read-guard");
    expect(readFileSync(join(cwd, "brand-new.txt"), "utf8")).toBe("hi\n");
  });
});
