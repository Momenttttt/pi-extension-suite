/**
 * S2：resume 之后状态还在（`pi.appendEntry` 持久化的价值）。
 *
 * 两件事必须在重开会话后成立：
 *   - 冻结的清理水位还在 → 恢复后的第一个请求清掉**同一批**结果（决策稳定跨 resume）；
 *   - 已提交的裁剪还在 → 那段历史仍然不进模型上下文，而且 `/ctx undo-snip` 仍可撤销。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import contextGuard from "../extensions/context-guard.ts";
import { clearedToolCallIds, containsPlaceholder, userShortIds } from "./request-metrics.ts";
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

async function sessionIn(
  cwd: string,
  responses: StubStep[],
  options: { sessionDir?: string; resumeFrom?: string } = {},
): Promise<TestSession> {
  const created = await createTestSession({ extension: contextGuard, cwd, responses, ...options });
  sessions.push(created);
  return created;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
});

describe("resume 后清理水位仍是同一批", () => {
  test("空闲置零触发过一次之后，恢复的会话不再触发也照样清同一批结果", async () => {
    const cwd = workspace();
    const sessionDir = join(cwd, "sessions");
    writeFileSync(join(cwd, "a.txt"), "line one\nline two\n", "utf8");
    // 第一段会话：空闲档打开，自动清一次并把水位落盘
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 0 });
    const first = await sessionIn(
      cwd,
      [
        { toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { text: "ok" },
      ],
      { sessionDir },
    );
    await first.run("read twice");
    const clearedBefore = clearedToolCallIds(first.requests[2]!);
    expect(clearedBefore).toHaveLength(1);
    const file = first.sessionFile();
    expect(file).toBeDefined();
    first.dispose();

    // 第二段会话：把空闲档关掉（60 分钟），只剩冻结水位在起作用
    writeConfig(cwd, { keepRecent: 1, gapThresholdMinutes: 60 });
    const second = await sessionIn(cwd, [{ text: "resumed" }], { sessionDir, resumeFrom: file });
    await second.run("继续");
    const after = second.requests[0]!;
    expect(containsPlaceholder(after)).toBe(true);
    expect(clearedToolCallIds(after)).toEqual(clearedBefore);
  });
});

describe("resume 后裁剪仍然生效", () => {
  test("被 snip 的历史在恢复的会话里依旧消失", async () => {
    const cwd = workspace();
    const sessionDir = join(cwd, "sessions");
    writeConfig(cwd, { keepRecent: 5, gapThresholdMinutes: 60 });
    const first = await sessionIn(cwd, [{ text: "第一次回答" }], { sessionDir });
    await first.run("第一问");
    const firstId = userShortIds(first.requests[0]!)[0] ?? "";
    first.pushResponses(
      { toolCall: { name: "snip", arguments: { from: firstId, to: firstId } } },
      { text: "第二次回答" },
    );
    await first.run("第二问");
    expect(first.requests[2]?.allText).not.toContain("第一问");
    const file = first.sessionFile();
    expect(file).toBeDefined();
    first.dispose();

    const second = await sessionIn(cwd, [{ text: "resumed" }], { sessionDir, resumeFrom: file });
    await second.run("恢复后继续");
    const request = second.requests[0]!;
    expect(request.allText).not.toContain("第一问");
    expect(request.allText).toContain("恢复后继续");
  });
});
