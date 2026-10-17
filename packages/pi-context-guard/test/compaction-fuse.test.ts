/**
 * S2：票据 10 的「先实测」——`session_before_compact` 返回 `{ cancel: true }`
 * 在 `reason: "threshold"` 下的真实行为。
 *
 * 实测结论（pi 1.3.0，跑法即本文件）：
 *
 *   1. pi 抛 `Compaction cancelled` 并立刻吞掉，发一条 `session_compact_failed`：
 *      `aborted: true`、`errorMessage: undefined`、`willRetry: false`。
 *   2. 这次压缩**没有发生**（会话里没有 `compaction` 条目），**也没有重试**；
 *      上下文保持原样继续涨。
 *   3. 只要上下文还超阈值，下一轮还会再取消一次——失败会反复发生，没有内建退避。
 *      （也就是说：失败熔断在 pi 里"不做"就等于"每轮都白试一次"。）
 *   4. overflow 路径上取消更糟：那是唯一一次 compact-and-retry 恢复机会，取消掉就没了。
 *
 * 所以本插件绝不返回 `{ cancel: true }`；失败熔断做成"降压力"：
 * 记失败次数 → 下一次请求强制按体积档清一次 → 连续 ≥3 次明确告警（见扩展头部注释）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory, SessionCompactFailedEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import contextGuard from "../extensions/context-guard.ts";
import { clearedToolCallIds, containsPlaceholder } from "./request-metrics.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

/** 让阈值压缩必然发生的设置：阈值 = 200000 − 199990 = 10 tokens，随便一句对话就超。 */
const LOW_THRESHOLD = {
  compaction: { enabled: true, reserveTokens: 199_990, keepRecentTokens: 1 },
};

const workspaces: Array<() => void> = [];
const sessions: TestSession[] = [];

function workspace(): string {
  const { cwd, cleanup } = createTempWorkspace();
  workspaces.push(cleanup);
  return cwd;
}

function writeConfig(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "context-guard.json"), JSON.stringify(config), "utf8");
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

/** 观测器：记录 before/failed/ok 三种事件，并可选择取消。 */
function makeObserver(cancel: boolean): {
  extension: ExtensionFactory;
  before: SessionBeforeCompactEvent[];
  failed: SessionCompactFailedEvent[];
  succeeded: SessionCompactFailedEvent[];
} {
  const before: SessionBeforeCompactEvent[] = [];
  const failed: SessionCompactFailedEvent[] = [];
  const succeeded: SessionCompactFailedEvent[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      before.push(event);
      return cancel ? { cancel: true } : undefined;
    });
    pi.on("session_compact_failed", (event) => {
      failed.push(event);
    });
    pi.on("session_compact", () => {
      succeeded.push({} as SessionCompactFailedEvent);
    });
  };
  return { extension, before, failed, succeeded };
}

describe("实测：threshold 下 {cancel: true}", () => {
  test("取消 = 失败事件 + 不压缩 + 不重试；下一轮再来一次", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "hello\n", "utf8");
    const observer = makeObserver(true);
    const test = await createTestSession({
      extension: observer.extension,
      cwd,
      responses: [{ text: "first" }, { text: "second" }, { text: "third" }],
      settings: LOW_THRESHOLD,
    });
    sessions.push(test);

    await test.run("问题一");
    expect(observer.before.map((event) => event.reason)).toContain("threshold");
    expect(observer.failed.length).toBeGreaterThanOrEqual(1);
    const first = observer.failed[0]!;
    expect(first.reason).toBe("threshold");
    expect(first.aborted).toBe(true);
    expect(first.errorMessage).toBeUndefined();
    expect(first.willRetry).toBe(false);

    // 没有 compact 条目：压缩确实没发生
    expect(test.session.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
    // 会话照常继续（取消不是崩溃）
    await test.run("问题二");
    expect(observer.failed.length).toBeGreaterThanOrEqual(2);
    expect(test.session.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
  });

  test("不取消：同样阈值下压缩正常发生并清掉失败标记", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "hello\n", "utf8");
    const observer = makeObserver(false);
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "first" }, { text: "second" }],
      settings: LOW_THRESHOLD,
      extraExtensions: [observer.extension],
    });
    sessions.push(test);

    await test.run("问题一");
    await test.run("问题二");
    // 至少有一次 compression（阈值压到 10 tokens，第一轮就可能触发）
    const compactionCount = test.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction").length;
    expect(compactionCount + observer.succeeded.length).toBeGreaterThan(0);
  });
});

describe("失败熔断：降压力而非放弃", () => {
  test("连续失败后，下一次请求强制按体积档清一次（空闲档没到也清）", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "hello\n", "utf8");
    writeFileSync(join(cwd, "b.txt"), "world\n", "utf8");
    // 空闲档 60 分钟、体积档不自动 → 正常情况下不会清
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 60 });
    const observer = makeObserver(true);
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [
        { toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { text: "first" },
        { toolCall: { name: "read", arguments: { path: "b.txt" } } },
        { text: "second" },
        { text: "third" },
      ],
      settings: LOW_THRESHOLD,
      extraExtensions: [observer.extension],
    });
    sessions.push(test);

    await test.run("读 a");
    await test.run("读 b");
    // 取消型压缩已经失败至少一次 → reliefPending
    expect(observer.failed.length).toBeGreaterThanOrEqual(1);

    // 下一轮请求：虽然空闲档没到、体积档没开自动，也按体积档清一次
    await test.run("再来一轮");
    const thirdRunRequests = test.requests.slice(3);
    const cleared = thirdRunRequests.some((request) => clearedToolCallIds(request).length > 0);
    expect(cleared).toBe(true);
    expect(thirdRunRequests.some((request) => containsPlaceholder(request))).toBe(true);
  });
});
