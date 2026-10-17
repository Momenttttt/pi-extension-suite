/**
 * S2：触发与 `/ctx`（真实 AgentSession + 桩 provider）。
 *
 * 三档各跑一次真实请求流：
 *   - 空闲档：`gapThresholdMinutes: 0` 时自动清理；默认 60 分钟时不清理
 *   - 体积档手动：`/ctx prune` 立刻推进水位，下一次请求变小
 *   - 体积档自动：`autoVolumeTrigger: true` 时不需要命令
 * 以及决策稳定性：相邻两次请求的清理集合一致。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import contextGuard from "../extensions/context-guard.ts";
import {
  clearedToolCallIds,
  commonPrefixMessages,
  containsPlaceholder,
  requestBytes,
  toolResultContent,
} from "./request-metrics.ts";
import { createTempWorkspace, createTestSession, type StubStep, type TestSession } from "./test-session.ts";

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

async function sessionIn(cwd: string, responses: StubStep[]): Promise<TestSession> {
  const created = await createTestSession({ extension: contextGuard, cwd, responses });
  sessions.push(created);
  return created;
}

/** 写一个"多行大文件"：read 会按行保留，单个结果约 50 KiB（超过体积阈值）。 */
function writeLargeText(path: string): void {
  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${"y".repeat(30)}`);
  writeFileSync(path, lines.join("\n"), "utf8");
}

/** 两轮 read：第三次请求里就有两条可清理结果。 */
const TWO_READS: StubStep[] = [
  { toolCall: { name: "read", arguments: { path: "a.txt" } } },
  { toolCall: { name: "read", arguments: { path: "a.txt" } } },
  { text: "ok" },
  { text: "done" },
];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

describe("空闲档", () => {
  test("gapThresholdMinutes=0：不用命令就自动清理", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "line one\nline two\n", "utf8");
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0 });
    const test = await sessionIn(cwd, TWO_READS);

    await test.run("read a.txt twice");
    expect(test.requests).toHaveLength(3);
    expect(clearedToolCallIds(test.requests[2]!)).toHaveLength(1);
    expect(containsPlaceholder(test.requests[2]!)).toBe(true);
  });

  test("默认 60 分钟：刚跑完的会话不清理（活动会话不会被自动救）", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "line one\nline two\n", "utf8");
    writeConfig(cwd, { keepRecent: 1 });
    const test = await sessionIn(cwd, TWO_READS);

    await test.run("read a.txt twice");
    expect(containsPlaceholder(test.requests[2]!)).toBe(false);
    expect(clearedToolCallIds(test.requests[2]!)).toHaveLength(0);
  });
});

describe("体积档：/ctx prune 手动", () => {
  test("正文没超过体积档阈值时不清（体积档的定义本身包含阈值）", async () => {
    const cwd = workspace();
    // 小文件：保留尾部之外的可清理正文远小于阈值
    writeFileSync(join(cwd, "small.txt"), "tiny content\n", "utf8");
    writeConfig(cwd, { keepRecent: 1, maxClearableBytes: 256 * 1024 });
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "small.txt" } } },
      { toolCall: { name: "read", arguments: { path: "small.txt" } } },
      { text: "ok" },
      { text: "done" },
    ]);

    await test.run("read small.txt twice");
    await test.run("/ctx prune");
    await test.run("继续");

    // 没越线 → 水位不动 → 请求里不该出现占位符
    expect(containsPlaceholder(test.requests[3]!)).toBe(false);
    expect(clearedToolCallIds(test.requests[3]!)).toHaveLength(0);
  });

  test("命令立刻清理，之后请求变小且相邻请求集合一致", async () => {
    const cwd = workspace();
    // 单个 read 结果就有约 50 KiB 正文，便于量"请求变小"
    writeLargeText(join(cwd, "big.txt"));
    // 体积档的定义包含阈值，所以阈值必须低于待清的正文量（这里是 ~50 KiB）
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 60, maxClearableBytes: 8 * 1024 });
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { text: "ok" },
      { text: "done" },
      { text: "again" },
    ]);

    await test.run("read big.txt twice");
    expect(test.requests).toHaveLength(3);
    // 空闲档没到、体积档没开自动 → 不动
    expect(containsPlaceholder(test.requests[2]!)).toBe(false);

    // 命令本身不发请求
    await test.run("/ctx prune");
    expect(test.requests).toHaveLength(3);

    await test.run("继续");
    expect(test.requests).toHaveLength(4);
    const afterCompact = test.requests[3]!;
    expect(clearedToolCallIds(afterCompact)).toHaveLength(1);
    expect(containsPlaceholder(afterCompact)).toBe(true);

    // 被清的那条结果：正文从 ~50 KiB 变成一行占位符
    const clearedId = clearedToolCallIds(afterCompact)[0] ?? "";
    const before = JSON.stringify(toolResultContent(test.requests[2]!, clearedId)).length;
    const after = JSON.stringify(toolResultContent(afterCompact, clearedId)).length;
    expect(before).toBeGreaterThan(50_000);
    expect(after).toBeLessThan(300);
    // 整次请求也确实变小（即使它多带了一轮新对话）
    expect(requestBytes(afterCompact)).toBeLessThan(requestBytes(test.requests[2]!));

    await test.run("再继续");
    const next = test.requests[4]!;
    expect(clearedToolCallIds(next)).toEqual(clearedToolCallIds(afterCompact));
    expect(commonPrefixMessages(afterCompact, next)).toBe(afterCompact.messages.length);
  });

  test("/ctx 状态命令可运行（打印占用、统计、阈值对照与子命令）", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "a.txt"), "hi\n", "utf8");
    const test = await sessionIn(cwd, [{ text: "ok" }]);
    await test.run("hello");
    await expect(test.run("/ctx")).resolves.toBeTypeOf("string");
  });
});

describe("体积档：autoVolumeTrigger", () => {
  test("打开后超过 maxClearableBytes 即自动清理", async () => {
    const cwd = workspace();
    writeLargeText(join(cwd, "big.txt"));
    writeConfig(cwd, {
      keepRecent: 1,
      gapThresholdMinutes: 60,
      autoVolumeTrigger: true,
      maxClearableBytes: 1024,
    });
    const test = await sessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { toolCall: { name: "read", arguments: { path: "big.txt" } } },
      { text: "ok" },
    ]);

    await test.run("read big.txt twice");
    expect(containsPlaceholder(test.requests[2]!)).toBe(true);
  });
});
