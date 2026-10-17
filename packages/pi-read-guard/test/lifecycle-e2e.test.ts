/**
 * S2 端到端：生命周期重建（票据 04）。
 *
 * 与其它 S2 用例不同，这里需要**真的会话文件**：resume 与压缩都靠它。所以用
 * `SessionManager.create(cwd, sessionDir)` 让会话落盘，再用 `SessionManager.open(...)` 开回来。
 *
 * 两条实测事实（都踩过）：
 *   - `createAgentSession` **不**派发 `session_start`，那一步在 `session.bindExtensions()` 里。
 *     测试骨架已经替我们调用了它——否则这里所有用例都会因为"读态从没被重建过"而失败。
 *   - `session.compact()` 要"有东西可摘要"才会成功：得让消息序列先后跨过压缩切点，
 *     仅有一轮对话时它会抛 `Nothing to compact (session too small)`。所以下面把
 *     `keepRecentTokens` 压到 100，并先读一个小文件再读一个大文件。
 */
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import readGuard from "../extensions/read-guard.ts";
import { createTestSession, createTempWorkspace, type TestSession } from "./test-session.ts";

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
  extra?: Partial<Parameters<typeof createTestSession>[0]>,
) {
  const created = await createTestSession({ extension: readGuard, cwd, responses, ...extra });
  sessions.push(created);
  return created;
}

const BLOCK_MARKER = "read-guard:";
/** 足够大的文本，用来把消息序列推过压缩切点。 */
const BIG_FILE_LINES = 6_000;
/** 让压缩真的切出摘要区：默认 keepRecentTokens = 20k 会把整段对话都留在尾部。 */
const COMPACTION_SETTINGS = { compaction: { enabled: false, keepRecentTokens: 100 } };

function writeLargeFile(path: string): void {
  const body = Array.from({ length: BIG_FILE_LINES }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  writeFileSync(path, body, "utf8");
}

describe("票据 04：resume 之后不误报", () => {
  test("会话文件里完整读过的文件，恢复后继续编辑不再要求重读", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original content\n", "utf8");
    const sessionDir = join(cwd, "sessions");

    const first = await sessionIn(
      cwd,
      [{ toolCall: { name: "read", arguments: { path: "a.txt" } } }, { text: "read it" }],
      { sessionDir },
    );
    await first.run("read a.txt");
    expect(first.requests[1]?.allText).toContain("original content");
    const sessionFile = first.sessionFile();
    expect(sessionFile, "会话应当落盘，否则这个用例验不到 resume").toBeTruthy();
    first.dispose();

    const resumed = await sessionIn(
      cwd,
      [
        {
          toolCall: {
            name: "edit",
            arguments: { path: "a.txt", edits: [{ oldText: "original", newText: "EDITED" }] },
          },
        },
        { text: "done" },
      ],
      { sessionDir, resumeFrom: sessionFile },
    );
    await resumed.run("now edit it without re-reading");

    expect(readFileSync(file, "utf8")).toBe("EDITED content\n");
    expect(resumed.requests[1]?.allText).not.toContain(BLOCK_MARKER);
  });

  test("恢复的会话里，范围读不是 resume 后的合格水位", async () => {
    const cwd = workspace();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "original content\n", "utf8");
    const sessionDir = join(cwd, "sessions");

    const first = await sessionIn(
      cwd,
      [
        { toolCall: { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } } },
        { text: "range read" },
      ],
      { sessionDir },
    );
    await first.run("range read a.txt");
    const sessionFile = first.sessionFile();
    first.dispose();

    // 会话挂起期间文件被改动：mtime 前进到未来，必然晚于那条消息的时间戳
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);

    const resumed = await sessionIn(
      cwd,
      [
        {
          toolCall: {
            name: "edit",
            arguments: { path: "a.txt", edits: [{ oldText: "original", newText: "EDITED" }] },
          },
        },
        { text: "done" },
      ],
      { sessionDir, resumeFrom: sessionFile },
    );
    await resumed.run("edit without re-reading");

    // 范围读在重建时被跳过 → 等于"没读过" → 必须重读
    expect(resumed.requests[1]?.allText).toContain("read-guard: not_read");
    expect(readFileSync(file, "utf8")).toBe("original content\n");
  });

  test("恢复的会话里，之前 write 过的文件可以直接再写（hash 由输入重算）", async () => {
    const cwd = workspace();
    const sessionDir = join(cwd, "sessions");

    const first = await sessionIn(
      cwd,
      [
        { toolCall: { name: "write", arguments: { path: "fresh.txt", content: "one\n" } } },
        { text: "created" },
      ],
      { sessionDir },
    );
    await first.run("create fresh.txt");
    const sessionFile = first.sessionFile();
    first.dispose();

    const resumed = await sessionIn(
      cwd,
      [
        { toolCall: { name: "write", arguments: { path: "fresh.txt", content: "two\n" } } },
        { text: "done" },
      ],
      { sessionDir, resumeFrom: sessionFile },
    );
    await resumed.run("overwrite it");

    expect(readFileSync(join(cwd, "fresh.txt"), "utf8")).toBe("two\n");
    expect(resumed.requests[1]?.allText).not.toContain(BLOCK_MARKER);
  });
});

describe("票据 04：压缩后只有保留尾部内的读记录仍有效", () => {
  test("压缩之后门禁仍然工作：没读过的文件照旧被拦", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "small.txt"), "small content\n", "utf8");
    writeLargeFile(join(cwd, "big.txt"));
    writeFileSync(join(cwd, "b.txt"), "another file\n", "utf8");

    const test = await sessionIn(
      cwd,
      [
        { toolCall: { name: "read", arguments: { path: "small.txt" } } },
        { text: "one" },
        { toolCall: { name: "read", arguments: { path: "big.txt" } } },
        { text: "two" },
      ],
      { settings: COMPACTION_SETTINGS },
    );
    await test.run("read small");
    await test.run("read big");

    await test.session.compact();

    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "b.txt", content: "clobbered\n" } } },
      { text: "done" },
    );
    await test.run("write b.txt");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("read-guard: not_read");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("another file\n");
  });

  test("被摘要掉的读记录失效（要求重读），压缩后的写入不会静默覆盖", async () => {
    const cwd = workspace();
    const oldFile = join(cwd, "old.txt");
    writeFileSync(oldFile, "old content\n", "utf8");
    writeLargeFile(join(cwd, "big.txt"));

    const test = await sessionIn(
      cwd,
      [
        // 先读小文件：它的读记录会被下面的压缩摘掉
        { toolCall: { name: "read", arguments: { path: "old.txt" } } },
        { text: "one" },
        // 再读大文件：压缩的保留尾部从这里开始
        { toolCall: { name: "read", arguments: { path: "big.txt" } } },
        { text: "two" },
      ],
      { settings: COMPACTION_SETTINGS },
    );
    await test.run("read old.txt");
    await test.run("read the big file");

    await test.session.compact();

    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "old.txt", content: "clobbered\n" } } },
      { text: "done" },
    );
    await test.run("write old.txt after compaction");

    const last = test.requests[test.requests.length - 1];
    // 收紧到具体 code：只断言"出现 read-guard:" 的话，三种判定都算过。
    // 被摘要掉就等于"没读过"，所以这里必须是 not_read。
    expect(last?.allText).toContain("read-guard: not_read");
    expect(readFileSync(oldFile, "utf8")).toBe("old content\n");
  });

  test("保留尾部里的读记录仍然有效：重读之后写入放行（不是一律要求重读）", async () => {
    const cwd = workspace();
    writeLargeFile(join(cwd, "big.txt"));
    const tailFile = join(cwd, "tail.txt");
    writeFileSync(tailFile, "tail content\n", "utf8");

    const test = await sessionIn(
      cwd,
      [
        { toolCall: { name: "read", arguments: { path: "tail.txt" } } },
        { text: "one" },
        // 大文件的读把 `tail.txt` 那条读记录远远推出保留尾部
        { toolCall: { name: "read", arguments: { path: "big.txt" } } },
        { text: "two" },
      ],
      { settings: COMPACTION_SETTINGS },
    );
    await test.run("read the small file");
    await test.run("read the big file");

    await test.session.compact();

    test.pushResponses(
      { toolCall: { name: "read", arguments: { path: "tail.txt" } } },
      { text: "re-read it" },
    );
    await test.run("re-read the small file");

    // 压缩后重新读过的记录必须是有效水位：写入放行，而不是被当成"没读过"
    test.pushResponses(
      { toolCall: { name: "write", arguments: { path: "tail.txt", content: "rewritten\n" } } },
      { text: "done" },
    );
    await test.run("write the small file");

    const last = test.requests[test.requests.length - 1];
    expect(last?.allText).toContain("Successfully wrote to tail.txt");
    expect(readFileSync(tailFile, "utf8")).toBe("rewritten\n");
  });
});
