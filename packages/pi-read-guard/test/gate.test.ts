import { describe, expect, test } from "vitest";

import {
  DEFAULT_WRITE_GATE_MESSAGES,
  decideWriteGate,
  displayPathOf,
  hashContent,
  normalizePathKey,
  type ReadStateEntry,
} from "../src/gate.ts";

function entry(overrides: Partial<ReadStateEntry> = {}): ReadStateEntry {
  return {
    key: "c:/repo/a.ts",
    absolutePath: "C:\\repo\\a.ts",
    mtimeMs: 1_000,
    sizeBytes: 10,
    kind: "full",
    source: "read",
    readAtMs: 1_000,
    ...overrides,
  };
}

describe("normalizePathKey（win32 语义）", () => {
  test("相对路径按 cwd 解析为绝对路径", () => {
    const key = normalizePathKey("src/a.ts", { cwd: String.raw`C:\repo`, caseInsensitive: false, platform: "win32" });
    expect(key).toBe("C:/repo/src/a.ts");
  });

  test("解析 .. 与 .", () => {
    const key = normalizePathKey("./src/../lib/a.ts", {
      cwd: String.raw`C:\repo`,
      caseInsensitive: false,
      platform: "win32",
    });
    expect(key).toBe("C:/repo/lib/a.ts");
  });

  test("win32 折叠大小写", () => {
    const folded = normalizePathKey(String.raw`C:\Repo\A.TS`, { cwd: "C:\\", platform: "win32" });
    const notFolded = normalizePathKey(String.raw`C:\Repo\A.TS`, {
      cwd: "C:\\",
      caseInsensitive: false,
      platform: "win32",
    });
    expect(folded).toBe("c:/repo/a.ts");
    expect(notFolded).toBe("C:/Repo/A.TS");
  });

  test("默认的 caseInsensitive 取自**传入的平台**，不是跑测试的这台机器", () => {
    // 这条是本次修 CI 的根因：以前默认读 process.platform，
    // 于是 Linux 上跑这些 win32 用例全挂（CI 会红）。
    const win = normalizePathKey(String.raw`C:\Repo\A.TS`, { cwd: "C:\\", platform: "win32" });
    const linux = normalizePathKey("/Repo/A.TS", { cwd: "/", platform: "linux" });
    expect(win).toBe("c:/repo/a.ts");
    expect(linux).toBe("/Repo/A.TS");
  });

  test("同一个文件的不同写法折叠成同一个键", () => {
    const a = normalizePathKey(String.raw`c:\repo\Foo\a.ts`, { cwd: "C:\\", platform: "win32" });
    const b = normalizePathKey("C:/REPO/foo/A.TS", { cwd: "C:\\", platform: "win32" });
    expect(a).toBe(b);
  });
});

describe("normalizePathKey（POSIX 语义）", () => {
  test("相对路径按 cwd 解析，不折叠大小写", () => {
    expect(normalizePathKey("src/a.ts", { cwd: "/repo", platform: "linux" })).toBe("/repo/src/a.ts");
    expect(normalizePathKey("Src/A.ts", { cwd: "/repo", platform: "linux" })).toBe("/repo/Src/A.ts");
  });

  test("反斜杠在 POSIX 上是合法文件名字符，不能当分隔符", () => {
    const key = normalizePathKey(String.raw`weird\name.ts`, { cwd: "/repo", platform: "darwin" });
    expect(key).toBe(String.raw`/repo/weird\name.ts`);
  });

  test("macOS 也走 POSIX 语义", () => {
    expect(normalizePathKey("SRC/A.ts", { cwd: "/Users/me", platform: "darwin" })).toBe("/Users/me/SRC/A.ts");
  });

  test("NFC 归一化让组合字符与预组合字符同键", () => {
    const composed = normalizePathKey("caf\u00e9.ts", { cwd: "/repo", platform: "linux" });
    const decomposed = normalizePathKey("cafe\u0301.ts", { cwd: "/repo", platform: "linux" });
    expect(composed).toBe(decomposed);
  });
});

describe("decideWriteGate 判定表", () => {
  test("新建文件（目标不存在）放行", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: undefined,
      currentContentHash: undefined,
      entry: undefined,
    });
    expect(decision).toEqual({ action: "allow" });
  });

  test("未读就写已存在文件 → 阻断 not_read，文案指向先读", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 1_000,
      currentContentHash: undefined,
      entry: undefined,
    });
    expect(decision.action).toBe("block");
    expect(decision.code).toBe("not_read");
    expect(decision.reason).toContain("has not been read in this session");
  });

  test("截断读 → 阻断 truncated_read（edit 与 write 同一套规则）", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 1_000,
      currentContentHash: undefined,
      entry: entry({ kind: "truncated" }),
    });
    expect(decision.code).toBe("truncated_read");
    expect(decision.reason).toContain("was truncated");
  });

  test("mtime 相等 → 放行（范围读也放行）", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 1_000,
      currentContentHash: undefined,
      entry: entry({ kind: "ranged" }),
    });
    expect(decision.action).toBe("allow");
  });

  test("mtime 后退 → 放行（视为回滚）", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 900,
      currentContentHash: undefined,
      entry: entry({ kind: "ranged" }),
    });
    expect(decision.action).toBe("allow");
  });

  test("mtime 前进 + 完整读 + 内容等价 → 放行（内容等价逃逸）", () => {
    const hash = hashContent("hello");
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 2_000,
      currentContentHash: hash,
      entry: entry({ mtimeMs: 1_000, contentHash: hash }),
    });
    expect(decision.action).toBe("allow");
  });

  test("mtime 前进 + 完整读 + 内容不同 → 阻断 modified_since_read", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 2_000,
      currentContentHash: hashContent("changed"),
      entry: entry({ mtimeMs: 1_000, contentHash: hashContent("hello") }),
    });
    expect(decision.code).toBe("modified_since_read");
    expect(decision.reason).toContain("changed after you read it");
  });

  test("mtime 前进 + 范围读 → 阻断（范围读没有 hash，不能走逃逸）", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 2_000,
      currentContentHash: hashContent("hello"),
      entry: entry({ mtimeMs: 1_000, kind: "ranged" }),
    });
    expect(decision.code).toBe("modified_since_read");
  });

  test("mtime 前进 + 完整读但读的内容算不出 hash（图片/二进制）→ 阻断", () => {
    const decision = decideWriteGate({
      key: "k",
      displayPath: "a.ts",
      currentMtimeMs: 2_000,
      currentContentHash: hashContent("hello"),
      entry: entry({ mtimeMs: 1_000, contentHash: undefined }),
    });
    expect(decision.code).toBe("modified_since_read");
  });

  test("三类阻断文案都可以整份替换", () => {
    const decision = decideWriteGate(
      {
        key: "k",
        displayPath: "a.ts",
        currentMtimeMs: 1_000,
        currentContentHash: undefined,
        entry: undefined,
      },
      { ...DEFAULT_WRITE_GATE_MESSAGES, notRead: (path) => `CUSTOM ${path}` },
    );
    expect(decision.reason).toBe("CUSTOM a.ts");
  });
});

describe("helm 小工具", () => {
  test("displayPathOf 在 cwd 内给相对路径（按平台选分隔符）", () => {
    expect(displayPathOf(String.raw`C:\repo\src\a.ts`, String.raw`C:\repo`, "win32")).toBe(String.raw`src\a.ts`);
    expect(displayPathOf(String.raw`D:\other\a.ts`, String.raw`C:\repo`, "win32")).toBe(String.raw`D:\other\a.ts`);
    expect(displayPathOf("/repo/src/a.ts", "/repo", "linux")).toBe("src/a.ts");
  });

  test("hashContent 稳定且区分内容", () => {
    expect(hashContent("a")).toBe(hashContent("a"));
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});
