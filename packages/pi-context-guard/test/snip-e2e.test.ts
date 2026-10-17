/**
 * S2：snip 端到端——工具入队 / 边界提交 / 撤销 / 分支感知的会话条目。
 *
 * 走真实事件流：`context` 投影短 id → 模型调 `snip` → 工具校验并入队 →
 * `turn_end` 提交 `context_edit{replacement: null}` + 审计条目 →
 * 下一次请求里那段历史消失；`/ctx undo-snip` 后恢复性 `context_edit` 再把它放回来。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function writeConfig(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "context-guard.json"), JSON.stringify(config), "utf8");
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

function branchEntries(test: TestSession) {
  return test.session.sessionManager.getBranch();
}

/** 消息正文的可读文本（用户消息的 content 可能是字符串也可能是文本块数组）。 */
function textOfMessage(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const message = (entry as { message?: { role?: string; content?: unknown } }).message;
  if (!message || message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block as { text?: unknown })?.text)
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

function entryOfUserText(test: TestSession, text: string) {
  return branchEntries(test).find((entry) => textOfMessage(entry).startsWith(text));
}

describe("snip：裁剪一段历史", () => {
  test("工具可见（direct + promptGuidelines），请求里出现短 id", async () => {
    const cwd = workspace();
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "ok" }],
    });
    sessions.push(test);

    const snip = test.session.getAllTools().find((tool) => tool.name === "snip");
    expect(snip?.exposure).toBe("direct");
    expect(snip?.promptGuidelines?.length).toBe(1);
    expect(snip?.description).toContain("Drop an earlier stretch");
    // 直接对模型可见，不靠 setActiveTools 动态激活（缓存前缀稳定，设计 §3.3）
    expect(test.session.getActiveToolNames()).toContain("snip");

    await test.run("第一问");
    const ids = userShortIds(test.requests[0]!);
    expect(ids).toHaveLength(1);
    expect(test.requests[0]?.allText).toContain(`[id:${ids[0]}]`);
    // 短 id 只加在请求副本上：会话条目里没有它
    const stored = entryOfUserText(test, "第一问");
    expect(stored).toBeDefined();
    expect(textOfMessage(stored)).not.toContain("[id:");
  });

  test("snip 之后那段历史从下一次请求消失，会话里出现 context_edit 与审计条目", async () => {
    const cwd = workspace();
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
      sessionDir: join(cwd, "sessions"),
    });
    sessions.push(test);

    await test.run("第一问");
    const firstId = userShortIds(test.requests[0]!)[0] ?? "";
    const targetEntry = entryOfUserText(test, "第一问");
    expect(targetEntry).toBeDefined();

    test.pushResponses(
      { toolCall: { name: "snip", arguments: { from: firstId, to: firstId } } },
      { text: "第二次回答" },
    );
    await test.run("第二问");

    // 第三次请求：第一问整条不见，第二问还在；工具结果里给了确认文案
    expect(test.requests).toHaveLength(3);
    const third = test.requests[2]!;
    expect(third.allText).not.toContain("第一问");
    expect(third.allText).toContain("第二问");
    expect(third.allText).toContain("Queued");

    // 分支感知的会话条目：context_edit(null) + 审计 custom
    const branch = branchEntries(test);
    const edit = branch.find(
      (entry) => entry.type === "context_edit" && entry.targetId === targetEntry?.id,
    );
    expect(edit?.type === "context_edit" ? edit.replacement : "missing").toBeNull();
    const audit = branch.find(
      (entry) => entry.type === "custom" && entry.customType === "ctx-guard/snip-applied",
    );
    expect(audit).toBeDefined();

    // 会话文件（真落盘）里确实写了这两条
    const file = test.sessionFile();
    expect(file).toBeDefined();
    const saved = readFileSync(file!, "utf8");
    expect(saved).toContain('"type":"context_edit"');
    expect(saved).toContain("ctx-guard/snip-applied");

    // 原始条目没被动过：正文还在（只是不进模型上下文）
    const original = entryOfUserText(test, "第一问");
    expect(original).toBeDefined();
  });
});

describe("snip：撤销", () => {
  test("/ctx undo-snip 之后，恢复性 context_edit 让历史重新出现", async () => {
    const cwd = workspace();
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    writeFileSync(join(cwd, "a.txt"), "hello\n", "utf8");
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
    });
    sessions.push(test);

    await test.run("第一问");
    const firstId = userShortIds(test.requests[0]!)[0] ?? "";
    const targetEntry = entryOfUserText(test, "第一问");
    // 用真实 id 驱动脚本：snip 之后边界提交 context_edit
    test.pushResponses(
      { toolCall: { name: "snip", arguments: { from: firstId, to: firstId } } },
      { text: "第二次回答" },
    );
    await test.run("第二问");
    expect(test.requests[2]?.allText).not.toContain("第一问");

    // 撤销：命令只入队；下一个回合边界（这里是一次 read 之后的 turn_end）提交恢复
    await test.run("/ctx undo-snip");
    test.pushResponses(
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "第三次回答" },
    );
    await test.run("第三问");

    const later = test.requests.at(-1)!;
    expect(later.allText).toContain("第一问");

    const branch = branchEntries(test);
    const restoreEdit = branch
      .filter((entry) => entry.type === "context_edit" && entry.targetId === targetEntry?.id)
      .at(-1);
    expect(restoreEdit?.type === "context_edit" ? restoreEdit.replacement : null).not.toBeNull();
    expect(
      branch.some((entry) => entry.type === "custom" && entry.customType === "ctx-guard/unsnip-applied"),
    ).toBe(true);
  });
});

describe("snip：校验", () => {
  test("端点不存在 → 工具报错并列出可用 id", async () => {
    const cwd = workspace();
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [
        { text: "第一次回答" },
        { toolCall: { name: "snip", arguments: { from: "zzzzzz", to: "zzzzzz" } } },
        { text: "第二次回答" },
      ],
    });
    sessions.push(test);

    await test.run("第一问");
    await test.run("第二问");
    const third = test.requests[2]!;
    expect(third.allText).toContain("No such short id");
    const availableId = userShortIds(test.requests[1]!)[0] ?? "";
    expect(third.allText).toContain(availableId);
    // 没有产生任何 context_edit
    expect(branchEntries(test).some((entry) => entry.type === "context_edit")).toBe(false);
  });

  test("from 晚于 to → 拒绝并给出可用 id 顺序", async () => {
    const cwd = workspace();
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
    });
    sessions.push(test);

    await test.run("第一问");
    const firstId = userShortIds(test.requests[0]!)[0] ?? "";
    test.pushResponses({ text: "第二次回答" });
    await test.run("第二问");
    // 第二次请求里能看到两条用户消息的短 id
    const ids = userShortIds(test.requests[1]!);
    expect(ids).toHaveLength(2);
    const [id1, id2] = ids as [string, string];

    // 第三问里用反序区间去裁：必须被拒，且错误里列出可用 id
    test.pushResponses(
      { toolCall: { name: "snip", arguments: { from: id2, to: id1 } } },
      { text: "第三次回答" },
    );
    await test.run("第三问");
    const latest = test.requests.at(-1)!;
    expect(latest.allText).toContain("Bad range");
    expect(latest.allText).toContain(id1);
    expect(latest.allText).toContain(id2);
    // 被拒之后没有任何 context_edit
    expect(branchEntries(test).some((entry) => entry.type === "context_edit")).toBe(false);
  });
});

describe("snip：渲染", () => {
  test("审计条目带可渲染的数据（count / targetIds）", async () => {
    const cwd = workspace();
    const test = await createTestSession({
      extension: contextGuard,
      cwd,
      responses: [{ text: "第一次回答" }],
    });
    sessions.push(test);
    await test.run("第一问");
    const firstId = userShortIds(test.requests[0]!)[0] ?? "";
    test.pushResponses(
      { toolCall: { name: "snip", arguments: { from: firstId, to: firstId } } },
      { text: "第二次回答" },
    );
    await test.run("第二问");
    const audit = branchEntries(test).find(
      (entry) => entry.type === "custom" && entry.customType === "ctx-guard/snip-applied",
    );
    const data = audit?.type === "custom" ? (audit.data as { count?: number; targetIds?: string[] }) : undefined;
    expect(data?.count).toBe(1);
    expect(data?.targetIds).toHaveLength(1);
  });
});
