/**
 * S2 端到端：读态互通（票据 08，接收侧）。
 *
 * 记忆插件那半边由 `pi-zcode-memory` 负责发布；这里只验本插件收到"某路径刚被读过"
 * 之后确实把它登记成读水位。发布方用一个最小桩扩展模拟——真实的记忆插件是独立包，
 * 在测试里 import 它会引入跨包依赖，而契约本身只有"事件名 + 载荷形状"。
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import readGuard from "../extensions/read-guard.ts";
import { READ_STATE_EVENT } from "../src/bridge.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

const cleanups: Array<() => void> = [];
const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * 模拟"另一个扩展读了这个文件"：`before_agent_start` 时把该路径登记到共享总线。
 *
 * 用 `before_agent_start` 是因为它一定早于本轮的 `tool_call`，且带 ctx；真实的记忆插件
 * 在自己的工具实现里发同一个事件。默认只发布一次——真实的 `memory_read` 也只是"读的那一刻"
 * 登记，不是每轮都重新登记。
 */
function fakeMemoryReader(
  absolutePath: string,
  payload?: Partial<Record<string, unknown>>,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let published = false;
    pi.on("before_agent_start", () => {
      if (published) return;
      published = true;
      const stat = statSync(absolutePath);
      pi.events.emit(READ_STATE_EVENT, {
        path: absolutePath,
        mtimeMs: Math.floor(stat.mtimeMs),
        sizeBytes: stat.size,
        contentHash: undefined,
        kind: "full",
        ...payload,
      });
    });
  };
}

describe("票据 08：收到读态登记之后写入门禁放行", () => {
  test("另一个扩展登记过读态 → 内置 write 放行", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    const file = join(cwd.cwd, "memory-file.md");
    writeFileSync(file, "a memory body\n", "utf8");

    const test = await createTestSession({
      extension: readGuard,
      extraExtensions: [fakeMemoryReader(file)],
      cwd: cwd.cwd,
      responses: [
        { toolCall: { name: "write", arguments: { path: "memory-file.md", content: "rewritten\n" } } },
        { text: "done" },
      ],
    });
    sessions.push(test);

    await test.run("overwrite the memory file");

    expect(readFileSync(file, "utf8")).toBe("rewritten\n");
    expect(test.requests[1]?.allText).not.toContain("read-guard:");
  });

  test("只装 read-guard（总线无人发布）→ 行为不变，仍然要求先读", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    const file = join(cwd.cwd, "a.txt");
    writeFileSync(file, "original\n", "utf8");

    const test = await createTestSession({
      extension: readGuard,
      cwd: cwd.cwd,
      responses: [
        { toolCall: { name: "write", arguments: { path: "a.txt", content: "clobbered\n" } } },
        { text: "done" },
      ],
    });
    sessions.push(test);

    await test.run("overwrite without reading");
    expect(test.requests[1]?.allText).toContain("read-guard: not_read");
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });

  test("登记的是截断读（没有内容 hash）→ 仍然拒绝整文件覆盖", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    const file = join(cwd.cwd, "big.md");
    writeFileSync(file, "a long body\n", "utf8");

    const test = await createTestSession({
      extension: readGuard,
      extraExtensions: [fakeMemoryReader(file, { kind: "truncated", contentHash: undefined })],
      cwd: cwd.cwd,
      responses: [
        { toolCall: { name: "write", arguments: { path: "big.md", content: "clobbered\n" } } },
        { text: "done" },
      ],
    });
    sessions.push(test);

    await test.run("overwrite a truncated read");
    expect(test.requests[1]?.allText).toContain("read-guard: truncated_read");
    expect(readFileSync(file, "utf8")).toBe("a long body\n");
  });

  test("别的扩展登记范围读 → 文件被动过之后必须重读（登记本身不构成完整水位）", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    const file = join(cwd.cwd, "ranged.md");
    writeFileSync(file, "a body\n", "utf8");

    const test = await createTestSession({
      extension: readGuard,
      extraExtensions: [fakeMemoryReader(file, { kind: "ranged", contentHash: undefined })],
      cwd: cwd.cwd,
      responses: [{ text: "first" }],
    });
    sessions.push(test);
    await test.run("first turn");

    // 外部改动：mtime 前进到未来
    const future = new Date(Date.now() + 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(file, future, future);

    test.pushResponses(
      { toolCall: { name: "edit", arguments: { path: "ranged.md", edits: [{ oldText: "a", newText: "A" }] } } },
      { text: "done" },
    );
    await test.run("edit after the change");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("read-guard: modified_since_read");
    expect(readFileSync(file, "utf8")).toBe("a body\n");
  });

  test("载荷形状不对时静默忽略，不抛错", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    writeFileSync(join(cwd.cwd, "a.txt"), "original\n", "utf8");

    const badPublisher: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", () => {
        pi.events.emit(READ_STATE_EVENT, { nope: true });
        pi.events.emit(READ_STATE_EVENT, null);
        pi.events.emit(READ_STATE_EVENT, { path: 42, mtimeMs: "x" });
      });
    };

    const test = await createTestSession({
      extension: readGuard,
      extraExtensions: [badPublisher],
      cwd: cwd.cwd,
      responses: [
        { toolCall: { name: "write", arguments: { path: "a.txt", content: "clobbered\n" } } },
        { text: "done" },
      ],
    });
    sessions.push(test);

    // 坏载荷不被登记，门禁照常拦；而且没有把整个会话搞崩
    await test.run("overwrite");
    expect(test.requests[1]?.allText).toContain("read-guard: not_read");
  });
});
