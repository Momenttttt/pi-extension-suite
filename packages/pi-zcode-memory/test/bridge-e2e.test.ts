/**
 * S2（票据 08）：memory_read 与 read-guard 的读态互通。
 *
 * 两个包装在同一个真实会话里：memory_read 之后内置 edit 直接放行；
 * 只装记忆包时 emit 落到没有订阅者的总线上，行为不变、无报错。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import readGuard from "../../pi-read-guard/extensions/read-guard.ts";
import zcodeMemory from "../extensions/zcode-memory.ts";
import {
  cleanupMemoryWorkspaces,
  createMemoryWorkspace,
  sessionWithMemory,
  writeZcodeStyleFact,
} from "./e2e-support.ts";
import { createTestSession, type TestSession } from "./test-session.ts";

const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  cleanupMemoryWorkspaces();
});

describe("既有 read-guard 时的互通", () => {
  test("memory_read 之后 edit 同一记忆文件 → 放行（不再要求重读）", async () => {
    const workspace = createMemoryWorkspace();
    writeZcodeStyleFact(workspace.memDir, "build-quirk.md", {
      name: "build-quirk",
      description: "构建要先 codegen",
      type: "project",
      body: "旧正文",
    });
    const memoryFile = join(workspace.memDir, "build-quirk.md");

    const session = await createTestSession({
      extension: zcodeMemory,
      extraExtensions: [readGuard],
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      responses: [
        { toolCall: { name: "memory_read", arguments: { name: "build-quirk" } } },
        {
          toolCall: {
            name: "edit",
            arguments: { path: memoryFile, edits: [{ oldText: "旧正文", newText: "新正文" }] },
          },
        },
        { text: "done" },
      ],
    });
    sessions.push(session);

    await session.run("读记忆后直接改它");
    expect(session.requests).toHaveLength(3);
    expect(readFileSync(memoryFile, "utf8")).toContain("新正文");
    // 工具结果里没有 read-guard 的阻断文案
    expect(session.requests[2]?.allText ?? "").not.toContain("read-guard:");
    expect(session.requests[2]?.allText ?? "").not.toContain("has not been read in this session");
  });

  test("截断读之后 edit → 被 read-guard 拦住（截断读不是写水位）", async () => {
    const workspace = createMemoryWorkspace();
    const longBody = Array.from({ length: 260 }, (_, index) => `第 ${index} 行`).join("\n");
    writeZcodeStyleFact(workspace.memDir, "huge.md", {
      name: "huge",
      description: "超长记忆",
      type: "project",
      body: longBody,
    });
    const memoryFile = join(workspace.memDir, "huge.md");

    const session = await createTestSession({
      extension: zcodeMemory,
      extraExtensions: [readGuard],
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      responses: [
        { toolCall: { name: "memory_read", arguments: { name: "huge" } } },
        {
          toolCall: {
            name: "edit",
            arguments: { path: memoryFile, edits: [{ oldText: "第 0 行", newText: "改" }] },
          },
        },
        { text: "done" },
      ],
    });
    sessions.push(session);

    await session.run("读超长记忆后直接改它");
    expect(session.requests[2]?.allText ?? "").toContain("read-guard: truncated_read");
    expect(readFileSync(memoryFile, "utf8")).toContain("第 0 行");
  });
});

describe("只有记忆包时静默降级", () => {
  test("emit 没有订阅者：memory_read 照常返回，无报错", async () => {
    const workspace = createMemoryWorkspace();
    writeZcodeStyleFact(workspace.memDir, "solo.md", {
      name: "solo",
      description: "单独安装",
      type: "project",
      body: "正文可见",
    });
    const session = await sessionWithMemory(workspace, [
      { toolCall: { name: "memory_read", arguments: { name: "solo" } } },
      { text: "done" },
    ]);
    sessions.push(session);
    await session.run("单独读一条记忆");
    expect(session.requests[1]?.allText ?? "").toContain("正文可见");
  });
});
