/**
 * S1 单测：从会话条目重建读态（票据 04）。
 *
 * 会话条目的形状是实测来的（pi 1.3.0）：一次工具调用存成两条 `message` 条目——
 * assistant 消息里的 `toolCall`（带 `name` + `arguments`）与一条 `toolResult`
 * （只有 `toolCallId`/`toolName`/`details`/`isError`/`content`）。所以路径必须靠
 * `toolCallId` 关联回来，而水位只能用 toolResult 的 `timestamp` 估计。
 */
import { describe, expect, test } from "vitest";

import { hashContent } from "../src/gate.ts";
import { replayReadState, type SessionEntryLike } from "../src/replay.ts";
import { ReadStateTable } from "../src/state.ts";

const CWD = "C:\\repo";
/** 夹具走 win32 语义，且 `platform` 显式传下去——这样在 Linux CI 上也能覆盖 win32 分支。 */
const PLATFORM = "win32" as const;

let nextId = 0;
function id(): string {
  nextId += 1;
  return `e${nextId}`;
}

/** 一条 assistant 消息，里面带一个工具调用。 */
function toolCallEntry(opts: {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp?: number;
}): SessionEntryLike {
  return {
    id: id(),
    type: "message",
    timestamp: new Date(opts.timestamp ?? 1_000).toISOString(),
    message: {
      role: "assistant",
      timestamp: opts.timestamp ?? 1_000,
      content: [
        {
          type: "toolCall",
          id: opts.toolCallId,
          name: opts.name,
          arguments: opts.arguments,
        },
      ],
    },
  };
}

/** 一条 toolResult 消息。 */
function toolResultEntry(opts: {
  toolCallId: string;
  toolName: string;
  timestamp?: number;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}): SessionEntryLike {
  return {
    id: id(),
    type: "message",
    timestamp: new Date(opts.timestamp ?? 1_000).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      timestamp: opts.timestamp ?? 1_000,
      content: opts.content ?? [{ type: "text", text: "file body" }],
      details: opts.details,
      isError: opts.isError ?? false,
    },
  };
}

function replay(entries: SessionEntryLike[], firstKeptEntryId?: string | null) {
  const table = new ReadStateTable();
  const result = replayReadState(table, entries, {
    cwd: CWD,
    platform: PLATFORM,
    ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
  });
  return { table, result };
}

/** 一次"完整读 a.txt"。 */
function readPair(callId: string, path: string, timestamp: number, extra: Record<string, unknown> = {}) {
  return [
    toolCallEntry({ toolCallId: callId, name: "read", arguments: { path, ...extra }, timestamp }),
    toolResultEntry({ toolCallId: callId, toolName: "read", timestamp }),
  ];
}

describe("票据 04：基本重建", () => {
  test("完整读 → full，水位用 toolResult 的消息时间戳", () => {
    const { table } = replay(readPair("c1", "a.txt", 5_000));
    const entry = table.get("c:/repo/a.txt");
    expect(entry?.kind).toBe("full");
    expect(entry?.mtimeMs).toBe(5_000);
    expect(entry?.source).toBe("resume");
  });

  test("完整读的 hash 由转录内容重算", () => {
    const { table } = replay([
      toolCallEntry({ toolCallId: "c1", name: "read", arguments: { path: "a.txt" }, timestamp: 5_000 }),
      toolResultEntry({
        toolCallId: "c1",
        toolName: "read",
        timestamp: 5_000,
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    expect(table.get("c:/repo/a.txt")?.contentHash).toBe(hashContent("hello"));
  });

  test("范围读被跳过（它不是 resume 后的合格水位）", () => {
    const { result } = replay(readPair("c1", "a.txt", 5_000, { offset: 1, limit: 10 }));
    expect(result).toEqual([]);
  });

  test("截断读恢复为 truncated", () => {
    const { table } = replay([
      toolCallEntry({ toolCallId: "c1", name: "read", arguments: { path: "a.txt" }, timestamp: 5_000 }),
      toolResultEntry({
        toolCallId: "c1",
        toolName: "read",
        timestamp: 5_000,
        details: { truncation: { truncated: true } },
      }),
    ]);
    expect(table.get("c:/repo/a.txt")?.kind).toBe("truncated");
  });

  test("write 的 hash 由工具输入的 content 重算", () => {
    const { table } = replay([
      toolCallEntry({
        toolCallId: "c1",
        name: "write",
        arguments: { path: "a.txt", content: "written" },
        timestamp: 7_000,
      }),
      toolResultEntry({ toolCallId: "c1", toolName: "write", timestamp: 7_000 }),
    ]);
    const entry = table.get("c:/repo/a.txt");
    expect(entry?.kind).toBe("full");
    expect(entry?.contentHash).toBe(hashContent("written"));
  });

  test("edit 不记 hash（mtime 一动就必须重读）", () => {
    const { table } = replay([
      toolCallEntry({
        toolCallId: "c1",
        name: "edit",
        arguments: { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
        timestamp: 9_000,
      }),
      toolResultEntry({ toolCallId: "c1", toolName: "edit", timestamp: 9_000 }),
    ]);
    const entry = table.get("c:/repo/a.txt");
    expect(entry?.kind).toBe("full");
    expect(entry?.contentHash).toBeUndefined();
  });
});

describe("票据 04：只信结构化字段", () => {
  test("失败的工具结果不记", () => {
    const { result } = replay([
      toolCallEntry({ toolCallId: "c1", name: "read", arguments: { path: "a.txt" }, timestamp: 1_000 }),
      toolResultEntry({ toolCallId: "c1", toolName: "read", timestamp: 1_000, isError: true }),
    ]);
    expect(result).toEqual([]);
  });

  test("找不到对应 toolCall 的 toolResult 被跳过（拿不到路径，也不去解析输出文本）", () => {
    const { result } = replay([
      toolResultEntry({
        toolCallId: "orphan",
        toolName: "read",
        timestamp: 1_000,
        content: [{ type: "text", text: "a.txt\n1→file body" }],
      }),
    ]);
    expect(result).toEqual([]);
  });

  test("toolResult 缺 timestamp 的条目被跳过", () => {
    const { result } = replay([
      toolCallEntry({ toolCallId: "c1", name: "read", arguments: { path: "a.txt" }, timestamp: 1_000 }),
      { id: id(), type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read" } },
    ]);
    expect(result).toEqual([]);
  });

  test("非 message 条目与其它工具（bash/grep）不影响读态", () => {
    const { result } = replay([
      { id: id(), type: "model_change", model: "x" },
      toolCallEntry({ toolCallId: "c9", name: "bash", arguments: { command: "rm -rf /" }, timestamp: 1_000 }),
      toolResultEntry({ toolCallId: "c9", toolName: "bash", timestamp: 1_000 }),
    ]);
    expect(result).toEqual([]);
  });

  test("同一路径后来的记录覆盖先前的", () => {
    const { table } = replay([
      ...readPair("c1", "a.txt", 1_000),
      ...readPair("c2", "a.txt", 5_000),
    ]);
    expect(table.get("c:/repo/a.txt")?.readAtMs).toBe(5_000);
    expect(table.size).toBe(1);
  });
});

describe("票据 04：跨越压缩边界", () => {
  const beforeCompaction = readPair("c1", "old.txt", 1_000);
  const afterCompaction = readPair("c2", "kept.txt", 5_000);
  const keptTailStart = afterCompaction[0]!.id;
  const entries = [...beforeCompaction, ...afterCompaction];

  test("按保留尾部重建时，摘要区里的读记录消失（模型必须重读）", () => {
    const { table } = replay(entries, keptTailStart);
    expect(table.get("c:/repo/old.txt")).toBeUndefined();
    expect(table.get("c:/repo/kept.txt")?.kind).toBe("full");
  });

  test("保留尾部起点不存在时从空表开始（保守：全部要求重读）", () => {
    const { result } = replay(entries, "no-such-entry");
    expect(result).toEqual([]);
  });

  test("自保留压缩（firstKeptEntryId 为 null）得到空表", () => {
    const { result } = replay(entries, null);
    expect(result).toEqual([]);
  });

  test("不传 firstKeptEntryId 时处理整条分支", () => {
    const { table } = replay(entries);
    expect(table.get("c:/repo/old.txt")).toBeDefined();
    expect(table.get("c:/repo/kept.txt")).toBeDefined();
  });

  test("重建是整表替换，不是继续累积（换分支不串台）", () => {
    const table = new ReadStateTable();
    replayReadState(table, readPair("c1", "branch-a.txt", 1_000), { cwd: CWD, platform: PLATFORM });
    expect(table.get("c:/repo/branch-a.txt")).toBeDefined();

    replayReadState(table, readPair("c2", "branch-b.txt", 2_000), { cwd: CWD, platform: PLATFORM });
    expect(table.get("c:/repo/branch-a.txt")).toBeUndefined();
    expect(table.get("c:/repo/branch-b.txt")).toBeDefined();
  });
});
