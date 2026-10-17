/**
 * S1：目录算法的回归夹具。
 *
 * 关键夹具是本机实测值：`sha256("e:\\agentproject\\zcode\\chat")[:16] === "ace14747b286680c"`，
 * 与 ZCode 桌面工作区 `chat` 的记忆目录吻合（设计 §2.1）。
 */
import { describe, expect, test } from "vitest";

import {
  computeMemoryDir,
  computeProjectDirParts,
  ensureCliStorageRoot,
  projectsRootOf,
  resolveZcodeStorageRoot,
  sanitizeProjectSlug,
} from "../src/paths.ts";

const ZCODE_CHAT_CWD = String.raw`E:\agentproject\zcode\chat`;

describe("storage root", () => {
  test("~/.zcode 追加 cli；basename 已是 cli 时不追加", () => {
    expect(resolveZcodeStorageRoot(String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me\.zcode\cli`);
    expect(ensureCliStorageRoot(String.raw`C:\Users\me\.zcode`)).toBe(String.raw`C:\Users\me\.zcode\cli`);
    expect(ensureCliStorageRoot(String.raw`D:\zcode\cli`)).toBe(String.raw`D:\zcode\cli`);
  });
});

describe("slug 清洗", () => {
  test("小写、非法字符换 -、去首尾 -、截 48", () => {
    expect(sanitizeProjectSlug("My Project!!")).toBe("my-project");
    expect(sanitizeProjectSlug("--a--b--")).toBe("a--b");
    expect(sanitizeProjectSlug("!!!" )).toBe("project");
    expect(sanitizeProjectSlug("")).toBe("project");
    expect(sanitizeProjectSlug("a".repeat(60))).toBe("a".repeat(48));
    expect(sanitizeProjectSlug("中文目录")).toBe("project");
  });

  test("点与下划线合法（与 ZCode 的正则一致）", () => {
    expect(sanitizeProjectSlug("my_project.v2")).toBe("my_project.v2");
  });
});

describe("目录算法（win32 折叠大小写）", () => {
  test("本机实测值回归：chat-ace14747b286680c", () => {
    const parts = computeProjectDirParts({ cwd: ZCODE_CHAT_CWD, storageRoot: String.raw`C:\x`, platform: "win32" });
    expect(parts).toEqual({ slug: "chat", hash: "ace14747b286680c", dirName: "chat-ace14747b286680c" });
  });

  test("非 win32 不折叠大小写（hash 输入是 resolve(cwd) 原样）", () => {
    const parts = computeProjectDirParts({ cwd: ZCODE_CHAT_CWD, storageRoot: "/x", platform: "darwin" });
    expect(parts.slug).toBe("chat");
    expect(parts.hash).toBe("9f600d4f9e4a92e7");
  });

  test("完整目录：<storageRoot>/memories/projects/<slug>-<hash>/memory", () => {
    const dir = computeMemoryDir({
      cwd: ZCODE_CHAT_CWD,
      storageRoot: String.raw`C:\Users\me\.zcode\cli`,
      platform: "win32",
    });
    expect(dir).toBe(String.raw`C:\Users\me\.zcode\cli\memories\projects\chat-ace14747b286680c\memory`);
    expect(projectsRootOf(String.raw`C:\Users\me\.zcode\cli`)).toBe(
      String.raw`C:\Users\me\.zcode\cli\memories\projects`,
    );
  });

  test("workspaceIdentity：slug 固定 project、hash 输入去首尾空白且不是路径", () => {
    const parts = computeProjectDirParts({
      cwd: ZCODE_CHAT_CWD,
      storageRoot: "/x",
      platform: "linux",
      workspaceIdentity: "  ssh:example:/workspace/app  ",
    });
    expect(parts).toEqual({ slug: "project", hash: "f6a3c95937dae337", dirName: "project-f6a3c95937dae337" });
  });
});
