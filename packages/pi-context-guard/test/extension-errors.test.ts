/**
 * S2 骨架自身的用例：扩展抛出的错误必须能被测试看见。
 *
 * 防的是票据 context-guard-snip-boundary/01 诊断时踩过的坑——扩展在 `turn_end` 里抛错时，
 * pi 只是把错误报给宿主（真机上进 TUI 通知），`~/.pi/agent/crashes.json` 不收，
 * 测试里更是完全无声：行为变成"什么都没发生"，而断言看到的正是这个"什么都没发生"。
 * 那次一半的排查时间花在这里，所以骨架默认把扩展错误升级成测试失败。
 */
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import contextGuard from "../extensions/context-guard.ts";
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

/** 一个在 `turn_end` 里抛错的扩展（`turn_end` 是边界事件之一）。 */
const boomAtTurnEnd: ExtensionFactory = (pi) => {
  pi.on("turn_end", () => {
    throw new Error("boom from a turn_end handler");
  });
};

describe("桩骨架：扩展错误可见性", () => {
  test("turn_end 里抛错 → 记进 extensionErrors（含事件名与扩展路径）", async () => {
    const cwd = workspace();
    const test = await createTestSession({
      extension: contextGuard,
      extraExtensions: [boomAtTurnEnd],
      cwd,
      responses: [{ text: "ok" }],
      allowExtensionErrors: true,
    });
    sessions.push(test);

    await test.run("第一问");

    expect(test.extensionErrors.length).toBeGreaterThan(0);
    const boom = test.extensionErrors.find((error) => error.error.includes("boom"));
    expect(boom).toBeDefined();
    expect(boom?.event).toBe("turn_end");
    // 载荷形状：`{ extensionPath, event, error, stack? }`。这里装的都是**内联工厂**
    // （`DefaultResourceLoader({ extensionFactories })`），所以路径是 `<inline:N>`；
    // 真机上装成文件时才是真的扩展文件路径。
    expect(boom?.extensionPath).toMatch(/^<inline:\d+>$/);
  });

  test("默认不允许：同一个扩展会让 run() 直接失败，而不是悄悄通过", async () => {
    const cwd = workspace();
    const test = await createTestSession({
      extension: contextGuard,
      extraExtensions: [boomAtTurnEnd],
      cwd,
      responses: [{ text: "ok" }],
    });
    sessions.push(test);

    await expect(test.run("第一问")).rejects.toThrow(/boom/);
  });
});
