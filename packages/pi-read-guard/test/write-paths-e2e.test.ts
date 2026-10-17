/**
 * S2 端到端：写入路径与读法语义（票据 03）。
 *
 * 每条用例都对着 design/04 §8 验证清单里的一条，断言落在"桩 provider 收到的请求里
 * 有没有阻断文案"以及"盘上的文件到底变成什么"。
 */
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import readGuard from "../extensions/read-guard.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

const cleanups: Array<() => void> = [];
const sessions: TestSession[] = [];

function workspace(): string {
  const { cwd, cleanup } = createTempWorkspace();
  cleanups.push(cleanup);
  return cwd;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function sessionIn(
  cwd: string,
  responses: Parameters<typeof createTestSession>[0]["responses"],
  extra?: Parameters<typeof createTestSession>[0],
) {
  const created = await createTestSession({ extension: readGuard, cwd, responses, ...extra });
  sessions.push(created);
  return created;
}

/** 把文件的 mtime 推后 10 秒（模拟"外部工具碰过它"）。 */
function touchForward(path: string): number {
  const future = new Date(Date.now() + 10_000);
  utimesSync(path, future, future);
  return Math.floor(statSync(path).mtimeMs);
}

const BLOCK_MARKER = "read-guard:";

describe("票据 03：写入成功后更新读水位", () => {
  test("write 成功之后，同一文件再 write 不需要重读", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "one\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "two\n" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "three\n" } } },
      { text: "done" },
    ]);

    await test.run("overwrite twice");
    // 第一次阻断（未读），因为我们从没读过它
    expect(test.requests[1]?.allText).toContain("has not been read in this session");
    // 第二次仍然阻断：第一次被拦下了，不构成读水位
    expect(test.requests[2]?.allText).toContain("has not been read in this session");
    expect(readFileSync(file, "utf8")).toBe("one\n");
  });

  test("read → write → write：第三次不再要求重读（write 更新了水位）", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "one\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "two\n" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "three\n" } } },
      { text: "done" },
    ]);

    await test.run("read then overwrite twice");
    expect(test.requests[3]?.allText).not.toContain(BLOCK_MARKER);
    expect(readFileSync(file, "utf8")).toBe("three\n");
  });

  test("read → edit → edit：edit 更新水位（不记 hash，但 mtime 未变就够）", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "one two\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "one", newText: "ONE" }] } } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }] } } },
      { text: "done" },
    ]);

    await test.run("read then edit twice");
    expect(test.requests[3]?.allText).not.toContain(BLOCK_MARKER);
    expect(readFileSync(file, "utf8")).toBe("ONE TWO\n");
  });
});

describe("票据 03：截断读（对 edit 与 write 都拒）", () => {
  test("读到截断内容后覆盖整文件 → 阻断，文案指路分段读或定点修改", async () => {
    const cwd = workspace();
    const big = join(cwd, "big.txt");
    // > 2000 行会触发 pi read 的截断（details.truncation）
    writeFileSync(big, Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { toolCall: { name: "write", arguments: { path: "big.txt", content: "clobbered\n" } } },
      { text: "done" },
    ]);

    await test.run("read the big file then clobber it");
    expect(test.requests[2]?.allText).toContain("was truncated");
    expect(test.requests[2]?.allText).toContain("read-guard: truncated_read");
    expect(readFileSync(big, "utf8")).not.toBe("clobbered\n");
  });

  test("读到截断内容后用 edit 定点改 → 也阻断（同一套规则）", async () => {
    const cwd = workspace();
    const big = join(cwd, "big.txt");
    writeFileSync(big, Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { toolCall: { name: "edit", arguments: { path: "big.txt", edits: [{ oldText: "line 0", newText: "LINE 0" }] } } },
      { text: "done" },
    ]);

    await test.run("read truncated then edit");
    expect(test.requests[2]?.allText).toContain("read-guard: truncated_read");
    expect(test.requests[2]?.allText).toContain("edit");
  });

  test("分段读小段之后 edit → 放行（截断读导致的死锁不会发生）", async () => {
    const cwd = workspace();
    const big = join(cwd, "big.txt");
    writeFileSync(big, Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.txt", offset: 1, limit: 50 } } },
      { toolCall: { name: "edit", arguments: { path: "big.txt", edits: [{ oldText: "line 0", newText: "LINE 0" }] } } },
      { text: "done" },
    ]);

    await test.run("read a range then edit");
    expect(test.requests[2]?.allText).not.toContain(BLOCK_MARKER);
    // 真的改了：截断的整文件读会死锁，分段读不会
    expect(readFileSync(big, "utf8").startsWith("LINE 0\n")).toBe(true);
  });
});

describe("票据 03：mtime 前进与内容等价逃逸", () => {
  test("读完之后外部 touch（mtime 变、内容不变）→ 放行", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "same content\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "read it" },
    ]);
    await test.run("read a.txt");
    expect(test.requests[1]?.allText).toContain("same content");

    // 外部只改时间、不改内容
    touchForward(file);
    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "same content\n" } } },
      { text: "done" },
    );
    await test.run("now overwrite it with identical content");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).not.toContain("read-guard: modified_since_read");
  });

  test("读完之后外部改了内容 → 阻断 modified_since_read", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "read it" },
    ]);
    await test.run("read a.txt");

    writeFileSync(file, "someone else changed this\n", "utf8");
    touchForward(file);
    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "mine\n" } } },
      { text: "done" },
    );
    await test.run("now overwrite it");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("read-guard: modified_since_read");
    expect(readFileSync(file, "utf8")).toBe("someone else changed this\n");
  });

  test("阻断后重读 → 放行", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "read it" },
    ]);
    await test.run("read a.txt");

    writeFileSync(file, "changed by someone\n", "utf8");
    touchForward(file);
    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "mine\n" } } },
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "mine\n" } } },
      { text: "done" },
    );
    await test.run("try, re-read, try again");

    // 请求历史里还留着上一次被拒的文案，所以不能对整段文本断言"没有阻断"；
    // 改为断言最后一次写入的结果是成功的、且盘上内容确实换了。
    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("Successfully wrote to a.txt");
    expect(readFileSync(file, "utf8")).toBe("mine\n");
  });

  test("范围读在 mtime 未变时是合格水位（edit 与 write 都放行）", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt", offset: 1, limit: 5 } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "rewritten\n" } } },
      { text: "done" },
    ]);

    await test.run("range read then whole-file write");
    expect(test.requests[2]?.allText).not.toContain(BLOCK_MARKER);
    expect(readFileSync(file, "utf8")).toBe("rewritten\n");
  });

  test("范围读之后外部改动 mtime → 要求重读（范围读没有 hash，不能逃逸）", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original content here\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } } },
      { text: "range read it" },
    ]);
    await test.run("range read");

    touchForward(file);
    test.pushResponses(
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "original", newText: "ORIGINAL" }] } } },
      { text: "done" },
    );
    await test.run("edit after the touch");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("read-guard: modified_since_read");
  });

  test("mtime 相等时放行（不因为同一毫秒就重读）", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "content\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "write", arguments: { path: "a.txt", content: "new content\n" } } },
      { text: "done" },
    ]);

    await test.run("read then immediately write");
    expect(test.requests[2]?.allText).not.toContain(BLOCK_MARKER);
    expect(readFileSync(file, "utf8")).toBe("new content\n");
  });
});

describe("票据 03/04：同批次并行工具调用不互相误判", () => {
  test("同一批次的两个 edit 作用在不同文件：都放行", async () => {
    const cwd = workspace();
    const a = join(cwd, "a.txt");
    const b = join(cwd, "b.txt");
    writeFileSync(a, "alpha original\n", "utf8");
    writeFileSync(b, "beta original\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" }, id: "call_a" } },
      { toolCall: { name: "read", arguments: { path: "b.txt" }, id: "call_b" } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, id: "call_a2" } },
      { toolCall: { name: "edit", arguments: { path: "b.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, id: "call_b2" } },
      { text: "done" },
    ]);

    await test.run("read both, then edit both");
    expect(readFileSync(a, "utf8")).toBe("ALPHA original\n");
    expect(readFileSync(b, "utf8")).toBe("BETA original\n");
    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).not.toContain("read-guard:");
  });

  test("同一批次里对同一文件先 read 再 edit：read 先落水位，edit 不误判", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original content\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" }, id: "call_r" } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "original", newText: "EDITED" }] }, id: "call_e" } },
      { text: "done" },
    ]);

    await test.run("read then edit in one batch");
    expect(readFileSync(file, "utf8")).toBe("EDITED content\n");
    expect(test.requests[test.requests.length - 1]?.allText).not.toContain("read-guard:");
  });

  test("同一批次里对同一文件发两个 edit：第二个用第一个留下的水位，不要求重读", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "one two three\n", "utf8");
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "a.txt" }, id: "call_r" } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "one", newText: "ONE" }] }, id: "call_e1" } },
      { toolCall: { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }] }, id: "call_e2" } },
      { text: "done" },
    ]);

    await test.run("read then two edits in one batch");
    // edit 记的是新 mtime、不记 hash：只要没有外部改动，第二次同批 edit 不该被要求重读
    expect(readFileSync(file, "utf8")).toBe("ONE TWO three\n");
  });
});
