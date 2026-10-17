/**
 * S2：微压缩端到端（真实 AgentSession + 桩 provider）。
 *
 * 这一层同时完成票据 09 的"先实测"：在 `context` 事件里返回改写后的 `messages`
 * 对 prompt 缓存到底意味着什么。结论写在这里，供票据 10/11 参考：
 *
 *   1. pi 把 handler 返回的数组**原样**发给 provider（请求里出现占位符、图片消失），
 *      但**不落盘**：会话条目、`sessionManager.getBranch()` 与 pi 自己的投影都不变。
 *   2. provider 侧 prompt 缓存是"消息前缀缓存"：改写第 k 条消息，会让第 k 条起的
 *      整个尾部都变成新内容（前缀命中从 k 截断）——成本与"被改写位置之前的稳定部分"
 *      成反比。所以第一次清理必然付出一次前缀失效。
 *   3. 只要清理集合冻结（水位不变），相邻请求的改写结果**逐字节相同**，缓存前缀在
 *      清理后的那个版本上重新建立：成本只付一次，而不是每次请求都付。
 *   4. pi 不会因为 handler 改写了消息而追加"转录检查点"（那是工具集/提示词变化才有的
 *      机制）；会话条目里也不会出现额外记录。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import contextGuard from "../extensions/context-guard.ts";
import { writeNoisePng } from "./png-fixture.ts";
import {
  clearedToolCallIds,
  commonPrefixMessages,
  containsPlaceholder,
  imageBlockCount,
  requestBytes,
  toolResultContent,
} from "./request-metrics.ts";
import { createTempWorkspace, createTestSession, type TestSession, type StubStep } from "./test-session.ts";

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

/** 桩模型的 `input` 声明成支持图片，否则内置 `read` 会把图片省略掉，测不到"大块"。 */
const IMAGE_MODEL = {
  provider: "pi-suite-stub",
  id: "stub-model",
  name: "Stub Model",
  api: "pi-messages",
  baseUrl: "http://127.0.0.1:1/stub",
  input: ["text", "image"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as never;

async function imageCapableSessionIn(cwd: string, responses: StubStep[]): Promise<TestSession> {
  const created = await createTestSession({ extension: contextGuard, cwd, responses });
  sessions.push(created);
  await created.session.setModel(IMAGE_MODEL);
  return created;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

describe("含图片 read 的会话：清理后请求显著变小", () => {
  test("占位符出现在请求里，图片块只剩没被清理的那一条", async () => {
    const cwd = workspace();
    const pngBytes = writeNoisePng(join(cwd, "big.png"), 256);
    expect(pngBytes).toBeGreaterThan(100_000);
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0 });

    const test = await imageCapableSessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { text: "ok" },
      { text: "done" },
    ]);

    await test.run("read the image twice");
    expect(test.requests).toHaveLength(3);

    const secondRead = test.requests[1]!;
    const third = test.requests[2]!;
    // 第二次请求里图片还在、没有占位符
    expect(imageBlockCount(secondRead)).toBe(1);
    expect(containsPlaceholder(secondRead)).toBe(false);

    // 第三次请求：两条可清理结果、keepRecent=1 → 最早那条被换掉
    expect(containsPlaceholder(third)).toBe(true);
    expect(clearedToolCallIds(third)).toHaveLength(1);
    expect(imageBlockCount(third)).toBe(1);

    // 对照组：同样两条 read、但插件关闭——第三次请求里两张图都在
    const controlCwd = workspace();
    writeNoisePng(join(controlCwd, "big.png"), 256);
    writeConfig(controlCwd, { enabled: false });
    const control = await imageCapableSessionIn(controlCwd, [
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { text: "ok" },
    ]);
    await control.run("read the image twice");
    const controlThird = control.requests[2]!;
    expect(imageBlockCount(controlThird)).toBe(2);
    // 清理后少了一张图的 base64：请求体积显著下降（约一半）
    expect(requestBytes(third)).toBeLessThan(requestBytes(controlThird) * 0.6);
    expect(requestBytes(third)).toBeLessThan(requestBytes(controlThird) - 200_000);

    const clearedId = clearedToolCallIds(third)[0] ?? "";
    const content = toolResultContent(third, clearedId) as Array<{ type?: string; text?: string }>;
    expect(content[0]?.text).toContain("Earlier tool result cleared");
    expect(content[0]?.text).toContain("read");
    expect(content[0]?.text).toContain("Re-run that tool if you need the output again");
  });

  test("不落盘：会话条目里的原文（含图片 base64）原样保留", async () => {
    const cwd = workspace();
    writeNoisePng(join(cwd, "big.png"), 128);
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0 });

    const test = await imageCapableSessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { text: "ok" },
    ]);
    await test.run("read twice");

    const storedImages: number[] = [];
    for (const entry of test.session.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: string; content?: unknown };
      if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
      storedImages.push(message.content.filter((block) => (block as { type?: string }).type === "image").length);
    }
    expect(storedImages).toEqual([1, 1]);
  });

  test("PNG 确实是图片：桩 provider 收到的请求里带 image 块", async () => {
    const cwd = workspace();
    writeNoisePng(join(cwd, "one.png"), 64);
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    const test = await imageCapableSessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "one.png" } } },
      { text: "ok" },
    ]);
    await test.run("look");
    const request = test.requests[1];
    expect(request).toBeDefined();
    expect(imageBlockCount(request!)).toBe(1);
  });
});

describe("prompt 缓存的实测口径（票据 09 的『先实测』）", () => {
  test("改写越早，前缀从被改写那条起失效；冻结水位后相邻请求逐字节一致", async () => {
    const cwd = workspace();
    writeNoisePng(join(cwd, "big.png"), 256);
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0, autoVolumeTrigger: false });

    const test = await imageCapableSessionIn(cwd, [
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { toolCall: { name: "read", arguments: { path: "big.png" } } },
      { text: "ok" },
      { text: "done" },
    ]);
    await test.run("read twice");
    // 再跑一轮：此时清理集合已冻结，第四次请求应与第三次的改写前缀一致
    await test.run("and again");

    expect(test.requests.length).toBeGreaterThanOrEqual(4);
    const third = test.requests[2]!;
    const fourth = test.requests[3]!;

    // 第三次（首次改写）与"未改写的上一版"（第二次）之间：前缀恰好在第一条
    // 被清理的工具结果处截断——这正是"改写第 k 条消息 → 前缀缓存从 k 失效"的实测口径
    const second = test.requests[1]!;
    const prefixBack = commonPrefixMessages(second, third);
    expect(prefixBack).toBe(
      third.messages.findIndex(
        (message, index) => JSON.stringify(message) !== JSON.stringify(second.messages[index]),
      ),
    );
    expect(third.messages[prefixBack]?.role).toBe("toolResult");
    expect(JSON.stringify(second.messages[prefixBack])).not.toBe(JSON.stringify(third.messages[prefixBack]));

    // 第四次与第三次之间：pi 再次送的是同一份改写结果 → 前缀覆盖第三次的全部消息
    const prefixForward = commonPrefixMessages(third, fourth);
    expect(prefixForward).toBe(third.messages.length);
    expect(clearedToolCallIds(fourth)).toEqual(clearedToolCallIds(third));

    // 被清理的那条在两次请求里逐字节相同（缓存前缀在清理后的版本上重建）
    const clearedId = clearedToolCallIds(third)[0] ?? "";
    expect(JSON.stringify(toolResultContent(fourth, clearedId))).toBe(
      JSON.stringify(toolResultContent(third, clearedId)),
    );
  });

  test("同一批消息在相邻请求里选择集一致（不抖动）", async () => {
    const cwd = workspace();
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0 });
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [
        { toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { text: "ok" },
        { text: "done" },
      ],
    });
    sessions.push(test);
    writeFileSync(join(cwd, "a.txt"), "line one\nline two\n", "utf8");

    await test.run("read a.txt twice");
    await test.run("and again");
    const third = test.requests[2]!;
    const fourth = test.requests[3]!;
    expect(clearedToolCallIds(third)).toHaveLength(1);
    expect(clearedToolCallIds(fourth)).toEqual(clearedToolCallIds(third));
    expect(commonPrefixMessages(third, fourth)).toBe(third.messages.length);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("line one\nline two\n");
  });
});
