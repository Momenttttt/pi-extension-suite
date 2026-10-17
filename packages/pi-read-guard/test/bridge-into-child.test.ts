/**
 * 票据 14（实测部分）：把本扩展作为 `additionalExtensionPaths` 注入一个
 * `noExtensions: true` 的会话，验证它真的生效——子会话里未读直接写会被拦。
 *
 * 结论（pi 1.3.0，本机实测）：
 *   - `additionalExtensionPaths` 在 `noExtensions: true` 下**确实生效**：
 *     loader.getExtensions().extensions 里能看到该路径，errors 为空。
 *   - 注入的扩展的 `session_start` 会正常派发，`tool_call` 拦截也生效。
 *   所以子代理侧不需要自定义 ResourceLoader 来回退。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import readGuard from "../extensions/read-guard.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

const cleanups: Array<() => void> = [];
const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** 本扩展的文件路径：模拟子代理 loader 用 `import.meta.resolve` 解析到的那个路径。 */
const READ_GUARD_PATH = new URL("../extensions/read-guard.ts", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

describe("票据 14 实测：additionalExtensionPaths 在 noExtensions 下生效", () => {
  test("注入路径解析得到真实文件", () => {
    // 只是防呆：路径写法在 win32 上不带前导斜杠
    expect(READ_GUARD_PATH).not.toMatch(/^\/[A-Za-z]:/);
    expect(readFileSync(READ_GUARD_PATH, "utf8")).toContain("readGuard");
  });

  test("被注入的扩展在隔离会话里拦下未读的写入", async () => {
    const cwd = createTempWorkspace();
    cleanups.push(cwd.cleanup);
    const file = join(cwd.cwd, "a.txt");
    writeFileSync(file, "original\n", "utf8");

    // `guardInIsolatedSession` 就是子代理 loader 的形状：noExtensions + 只额外注入这一条路径
    const child: ExtensionFactory = () => {};
    const test = await createTestSession({
      extension: child,
      extraExtensions: [readGuard],
      cwd: cwd.cwd,
      responses: [
        { toolCall: { name: "write", arguments: { path: "a.txt", content: "clobbered\n" } } },
        { text: "done" },
      ],
    });
    sessions.push(test);

    await test.run("write without reading");
    expect(test.requests[1]?.allText).toContain("read-guard: not_read");
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });
});
