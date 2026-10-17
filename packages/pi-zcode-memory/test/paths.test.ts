/**
 * S1：目录算法的回归夹具。
 *
 * 夹具刻意用**中性路径**（`C:\work\chat` 与 `/work/chat`），不用任何本机路径：仓库是公开的，
 * 里面不该带某台机器的目录结构；对 ZCode 真实记忆目录的实测核对记在本机设计文档里。
 *
 * `platform` 一律显式传：这样在 Linux CI 上也能覆盖 win32 语义（用户实际在用的那套），
 * 而不是让断言跟着跑测试的机器变。
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

/** 中性的 Windows 工作区夹具：`C:\work\chat`（win32 折叠后 hash 为 351c3f19d23a3439）。 */
const WIN_CWD = String.raw`C:\work\chat`;
/** 中性的 POSIX 工作区夹具：`/work/chat`（不折叠，hash 为 4ae19effad2b0df3）。 */
const POSIX_CWD = "/work/chat";
const WIN_STORAGE = String.raw`C:\Users\me\.zcode\cli`;

describe("storage root", () => {
  test("~/.zcode 追加 cli；basename 已是 cli 时不追加（win32 语义）", () => {
    expect(resolveZcodeStorageRoot(String.raw`C:\Users\me`, "win32")).toBe(String.raw`C:\Users\me\.zcode\cli`);
    expect(ensureCliStorageRoot(String.raw`C:\Users\me\.zcode`, "win32")).toBe(
      String.raw`C:\Users\me\.zcode\cli`,
    );
    expect(ensureCliStorageRoot(String.raw`D:\zcode\cli`, "win32")).toBe(String.raw`D:\zcode\cli`);
  });

  test("POSIX 语义下同样成立", () => {
    expect(resolveZcodeStorageRoot("/home/me", "linux")).toBe("/home/me/.zcode/cli");
    expect(ensureCliStorageRoot("/home/me/.zcode", "linux")).toBe("/home/me/.zcode/cli");
    expect(ensureCliStorageRoot("/usr/share/cli", "linux")).toBe("/usr/share/cli");
  });
});

describe("slug 清洗", () => {
  test("小写、非法字符换 -、去首尾 -、截 48", () => {
    expect(sanitizeProjectSlug("My Project!!")).toBe("my-project");
    expect(sanitizeProjectSlug("--a--b--")).toBe("a--b");
    expect(sanitizeProjectSlug("!!!")).toBe("project");
    expect(sanitizeProjectSlug("")).toBe("project");
    expect(sanitizeProjectSlug("a".repeat(60))).toBe("a".repeat(48));
    expect(sanitizeProjectSlug("中文目录")).toBe("project");
  });

  test("点与下划线合法", () => {
    expect(sanitizeProjectSlug("my_project.v2")).toBe("my_project.v2");
  });
});

describe("目录算法（win32 折叠大小写）", () => {
  test("win32 夹具回归：chat-351c3f19d23a3439", () => {
    const parts = computeProjectDirParts({ cwd: WIN_CWD, storageRoot: String.raw`C:\x`, platform: "win32" });
    expect(parts).toEqual({ slug: "chat", hash: "351c3f19d23a3439", dirName: "chat-351c3f19d23a3439" });
  });

  test("同样的大小写差异在 win32 上折叠成同一个目录", () => {
    const lower = computeProjectDirParts({
      cwd: String.raw`c:\WORK\Chat`,
      storageRoot: String.raw`C:\x`,
      platform: "win32",
    });
    const upper = computeProjectDirParts({ cwd: WIN_CWD, storageRoot: String.raw`C:\x`, platform: "win32" });
    expect(lower).toEqual(upper);
  });

  test("完整目录：<storageRoot>/memories/projects/<slug>-<hash>/memory", () => {
    const dir = computeMemoryDir({ cwd: WIN_CWD, storageRoot: WIN_STORAGE, platform: "win32" });
    expect(dir).toBe(String.raw`C:\Users\me\.zcode\cli\memories\projects\chat-351c3f19d23a3439\memory`);
    expect(projectsRootOf(WIN_STORAGE, "win32")).toBe(String.raw`C:\Users\me\.zcode\cli\memories\projects`);
  });

  test("workspaceIdentity：slug 固定 project、hash 输入去首尾空白且不是路径", () => {
    const parts = computeProjectDirParts({
      cwd: WIN_CWD,
      storageRoot: "/x",
      platform: "linux",
      workspaceIdentity: "  ssh:example:/workspace/app  ",
    });
    expect(parts).toEqual({ slug: "project", hash: "f6a3c95937dae337", dirName: "project-f6a3c95937dae337" });
    // identity 存在时 hash 与 cwd 无关（换工作区路径也得到同一个目录）
    const other = computeProjectDirParts({
      cwd: "/somewhere/else",
      storageRoot: "/x",
      platform: "linux",
      workspaceIdentity: "ssh:example:/workspace/app",
    });
    expect(other).toEqual(parts);
  });
});

describe("目录算法（POSIX 不折叠大小写）", () => {
  test("hash 输入是 resolve(cwd) 原样，大写不被折叠", () => {
    const parts = computeProjectDirParts({ cwd: POSIX_CWD, storageRoot: "/x", platform: "linux" });
    expect(parts).toEqual({ slug: "chat", hash: "4ae19effad2b0df3", dirName: "chat-4ae19effad2b0df3" });
  });

  test("大小写不同的两个路径在 POSIX 上是两个目录", () => {
    const lower = computeProjectDirParts({ cwd: "/work/chat", storageRoot: "/x", platform: "darwin" });
    const upper = computeProjectDirParts({ cwd: "/Work/Chat", storageRoot: "/x", platform: "darwin" });
    expect(lower.hash).not.toBe(upper.hash);
  });

  test("POSIX 下反斜杠是文件名字符，不属于路径分隔语义", () => {
    // 这条以前只在 Windows 上"碰巧"成立；现在由 platform 参数决定，与跑测试的机器无关
    const parts = computeProjectDirParts({ cwd: POSIX_CWD, storageRoot: "/home/me/.zcode/cli", platform: "linux" });
    expect(computeMemoryDir({ cwd: POSIX_CWD, storageRoot: "/home/me/.zcode/cli", platform: "linux" })).toBe(
      `/home/me/.zcode/cli/memories/projects/${parts.dirName}/memory`,
    );
  });
});
