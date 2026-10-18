/**
 * S2（票据 context-guard-snip-boundary/01）：裁剪区间跨过压缩摘要时，目标集必须落在
 * pi 允许 `context_edit` 的条目上。
 *
 * 真机踩过的坑：区间里混进一条 `compaction`（压缩摘要会投影成模型内容，但 pi 的
 * `appendContextEdit` 拒收它），于是**整批** `context_edit` 被拒、一条都不落地——而工具
 * 已经回了 "Queued 44 history message(s)"，`/ctx` 也照着报告，撤销时再去恢复一批
 * 从未生效的条目。两个入口各有一个用例：
 *
 *   1. 新的一次 snip：`branchItems` 只收可编辑条目，压缩摘要的 id 进不了 `targetIds`，
 *      "入队的目标"与"落地的编辑"因此是同一个集合；
 *   2. 会话文件里已存的脏 pending 队列（旧版本写下的，targets 里混着压缩摘要与 system 消息）：
 *      提交前按当前分支再筛一遍，不合格的待办丢弃，不让整批白做。
 *
 * 这两个用例都吃得着骨架的扩展错误断言：修前 `turn_end` 的整批拒收会以扩展错误的形式出现，
 * `run()` 会直接把它抛出来，而不是安静地看着 `context_edit` 一条都没写。
 */
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import contextGuard from "../extensions/context-guard.ts";
import { userShortIds } from "./request-metrics.ts";
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

type BranchEntry = {
  id: string;
  type: string;
  customType?: string;
  message?: { role?: string };
  targetId?: string;
  data?: unknown;
};

/**
 * 造夹具用的最小 `SessionManager` 视图——只列本文件用到的公开写入方法
 * （签名与接受规则见 `docs/pi-contract-map.md` 的锚点表）。
 *
 * `appendCompaction` 就是"这期间发生过一次自动压缩"的等价物：它往分支里插一条
 * 会投影成模型内容、却不可编辑的条目；`appendCustomEntry` 用来伪造旧版本写下的脏队列。
 */
interface SessionManagerFixture {
  getBranch: () => BranchEntry[];
  appendCompaction: (summary: string, firstKeptEntryId: string | null, tokensBefore: number) => string;
  appendCustomEntry: (customType: string, data: unknown) => string;
}

function fixtureManager(test: TestSession): SessionManagerFixture {
  return test.session.sessionManager as unknown as SessionManagerFixture;
}

function branchOf(test: TestSession): BranchEntry[] {
  return fixtureManager(test).getBranch();
}

function contextEditTargets(entries: readonly BranchEntry[]): string[] {
  return entries
    .filter((entry) => entry.type === "context_edit")
    .map((entry) => String(entry.targetId));
}

function customEntry(entries: readonly BranchEntry[], customType: string): BranchEntry | undefined {
  return entries.find((entry) => entry.type === "custom" && entry.customType === customType);
}

describe("区间跨过压缩摘要", () => {
  test("摘要条目进不了 targetIds，入队的目标全部落地", async () => {
    const cwd = workspace();
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
    });
    sessions.push(test);

    await test.run("第一问");
    const id1 = userShortIds(test.requests[0]!)[0] ?? "";

    // 在两条用户消息之间插一条压缩摘要：等价于这期间发生了一次自动压缩
    const manager = fixtureManager(test);
    const compactionId = manager.appendCompaction("旧历史摘要：一批已完成的工作", null, 12345);

    test.pushResponses({ text: "第二次回答" });
    await test.run("第二问");
    const id2 = userShortIds(test.requests[1]!).at(-1) ?? "";

    test.pushResponses(
      { toolCall: { name: "snip", arguments: { from: id1, to: id2 } } },
      { text: "第三次回答" },
    );
    await test.run("第三问");

    const branch = branchOf(test);
    const queued = ((customEntry(branch, "ctx-guard/pending-snip")?.data as { targetIds?: string[] })
      ?.targetIds ?? []) as string[];
    const applied = contextEditTargets(branch);

    // 压缩摘要是区间里唯一不可编辑的条目，必须被挡在目标集之外
    expect(queued).not.toContain(compactionId);
    // 修前的病灶：队列里有 44 个目标，落地 0 条
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toEqual(queued);
    expect(test.extensionErrors).toEqual([]);
  });
});

describe("脏队列自愈", () => {
  test("会话文件里混着不可编辑 target 的 pending-snip：只应用可编辑的那条，审计一致", async () => {
    const cwd = workspace();
    const sessionDir = join(cwd, "sessions");
    const first = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
      sessionDir,
    });
    sessions.push(first);
    await first.run("第一问");

    const manager = fixtureManager(first);
    const compactionId = manager.appendCompaction("旧历史摘要", null, 12345);

    first.pushResponses({ text: "第二次回答" });
    await first.run("第二问");

    // 旧版本写下的脏队列：targets 里混着两类不可编辑的条目——system 消息与压缩摘要
    const entries = manager.getBranch();
    const systemId = entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "system",
    )?.id;
    const userId = entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    )?.id;
    expect(systemId).toBeDefined();
    expect(userId).toBeDefined();
    manager.appendCustomEntry("ctx-guard/pending-snip", {
      targetIds: [systemId, userId, compactionId],
      shortIds: [],
      at: Date.now(),
    });
    const file = first.sessionFile();
    expect(file).toBeDefined();
    first.dispose();

    // 恢复会话 → `session_start` 回放这条脏队列 → 下一个回合边界提交
    const second = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第三次回答" }],
      sessionDir,
      resumeFrom: file,
    });
    sessions.push(second);
    await second.run("第三问");

    const branch = branchOf(second);
    const applied = contextEditTargets(branch);
    const audit = customEntry(branch, "ctx-guard/snip-applied");
    const auditTargets = ((audit?.data as { targetIds?: string[] })?.targetIds ?? []) as string[];

    // 可编辑的那条照常落地，两类不可编辑的条目被丢弃，审计条目与落地集合一致
    expect(applied).toEqual([userId]);
    expect(applied).not.toContain(compactionId);
    expect(applied).not.toContain(systemId);
    expect(auditTargets).toEqual([userId]);
    expect(second.extensionErrors).toEqual([]);
  });
});
