/**
 * S1：微压缩选择集的纯函数测试。
 *
 * 这些断言就是"决策稳定性"的钉子：选择集只依赖消息序列 + 冻结水位。
 */
import { describe, expect, test } from "vitest";

import {
  applyClearPlaceholders,
  defaultPlaceholder,
  isClearableToolName,
  isPlaceholderContent,
  scanClearableResults,
  selectClearableResults,
  type ClearableToolOptions,
} from "../src/clear.ts";
import type { MessageLike } from "../src/messages.ts";

const OPTIONS: ClearableToolOptions = {
  clearSubagentResults: false,
  clearMemoryResults: false,
};

function toolResult(
  toolName: string,
  toolCallId: string,
  content: unknown,
  extra: Partial<MessageLike> = {},
): MessageLike {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    isError: false,
    timestamp: 1_000,
    content,
    ...extra,
  };
}

function textResult(toolName: string, index: number, text: string): MessageLike {
  return toolResult(toolName, `call_${toolName}_${index}`, [{ type: "text", text }]);
}

function user(timestamp: number, text = "hi"): MessageLike {
  return { role: "user", timestamp, content: text };
}

function assistant(timestamp: number): MessageLike {
  return { role: "assistant", timestamp, content: [{ type: "text", text: "ok" }] };
}

describe("可清理工具白名单", () => {
  test("对齐 CC 的基础白名单全部可清理", () => {
    for (const name of ["read", "bash", "powershell", "grep", "find", "ls", "edit", "write"]) {
      expect(isClearableToolName(name, OPTIONS), name).toBe(true);
    }
  });

  test("MCP / codemode / tool_search 永不清理", () => {
    expect(isClearableToolName("mcp__docs__search", OPTIONS)).toBe(false);
    expect(isClearableToolName("codemode", OPTIONS)).toBe(false);
    expect(isClearableToolName("tool_search", OPTIONS)).toBe(false);
  });

  test("subagent / memory_read 默认排除，开关打开后可清理", () => {
    expect(isClearableToolName("subagent", OPTIONS)).toBe(false);
    expect(isClearableToolName("memory_read", OPTIONS)).toBe(false);
    expect(isClearableToolName("subagent", { ...OPTIONS, clearSubagentResults: true })).toBe(true);
    expect(isClearableToolName("memory_read", { ...OPTIONS, clearMemoryResults: true })).toBe(true);
    // 开一个不影响另一个
    expect(isClearableToolName("memory_read", { ...OPTIONS, clearSubagentResults: true })).toBe(false);
  });

  test("错误结果不进入候选", () => {
    const candidates = scanClearableResults(
      [toolResult("read", "c1", [{ type: "text", text: "boom" }], { isError: true })],
      OPTIONS,
    );
    expect(candidates).toHaveLength(0);
  });
});

describe("选择集", () => {
  test("extend=false 时不推进：只有水位冻结的部分会被清", () => {
    const messages = [user(1), ...Array.from({ length: 6 }, (_, i) => textResult("read", i, "x".repeat(100)))];
    const selection = selectClearableResults({
      messages,
      options: OPTIONS,
      keepRecent: 5,
      extend: false,
    });
    expect(selection.targets).toHaveLength(0);
    expect(selection.extended).toBe(false);
    expect(selection.pendingCount).toBe(6);
  });

  test("keepRecent 保留最近 N 条：6 条候选、保留 5 条 → 清最早 1 条", () => {
    const messages = Array.from({ length: 6 }, (_, i) => textResult("read", i, "x".repeat(100)));
    const selection = selectClearableResults({ messages, options: OPTIONS, keepRecent: 5, extend: true });
    expect(selection.targets.map((target) => target.toolCallId)).toEqual(["call_read_0"]);
    expect(selection.extended).toBe(true);
    expect(selection.extendedTargets).toHaveLength(1);
    expect(selection.watermark).toEqual({ toolCallId: "call_read_0", clearedCount: 1 });
  });

  test("候选数不超过 keepRecent 时不推进", () => {
    const messages = Array.from({ length: 3 }, (_, i) => textResult("bash", i, "out"));
    const selection = selectClearableResults({ messages, options: OPTIONS, keepRecent: 5, extend: true });
    expect(selection.extended).toBe(false);
    expect(selection.targets).toHaveLength(0);
    expect(selection.watermark).toBeUndefined();
  });

  test("决策稳定性：同一批消息相邻两次选择结果相同", () => {
    const messages = [user(1), ...Array.from({ length: 6 }, (_, i) => textResult("grep", i, "hit"))];
    const first = selectClearableResults({ messages, options: OPTIONS, keepRecent: 2, extend: true });
    const second = selectClearableResults({
      messages,
      options: OPTIONS,
      keepRecent: 2,
      watermark: first.watermark,
      extend: false,
    });
    expect(second.targets).toEqual(first.targets);
  });

  test("水位冻结后追加新结果：旧目标不变，新结果不入选", () => {
    const before = Array.from({ length: 6 }, (_, i) => textResult("read", i, "x".repeat(10)));
    const frozen = selectClearableResults({ messages: before, options: OPTIONS, keepRecent: 2, extend: true });
    const after = [...before, ...Array.from({ length: 3 }, (_, i) => textResult("read", 10 + i, "y".repeat(10)))];
    const selection = selectClearableResults({
      messages: after,
      options: OPTIONS,
      keepRecent: 2,
      watermark: frozen.watermark,
      extend: false,
    });
    expect(selection.targets.map((t) => t.toolCallId)).toEqual(
      frozen.targets.map((t) => t.toolCallId),
    );
    expect(selection.extended).toBe(false);
  });

  test("已清理过的不重复处理（幂等）", () => {
    const messages = Array.from({ length: 6 }, (_, i) => textResult("read", i, "x".repeat(100)));
    const first = selectClearableResults({ messages, options: OPTIONS, keepRecent: 2, extend: true });
    const applied = applyClearPlaceholders(messages, first.targets).messages;
    const again = selectClearableResults({
      messages: applied,
      options: OPTIONS,
      keepRecent: 2,
      watermark: first.watermark,
      extend: true,
    });
    expect(again.freedBytes).toBe(0);
    expect(again.targets).toHaveLength(0);
    expect(again.extended).toBe(false);
  });

  test("水位锚点丢失（被裁剪/重排）时按条数回落", () => {
    const messages = Array.from({ length: 8 }, (_, i) => textResult("read", i, "x".repeat(10)));
    const selection = selectClearableResults({
      messages,
      options: OPTIONS,
      keepRecent: 2,
      watermark: { toolCallId: "call_gone", clearedCount: 3 },
      extend: false,
    });
    expect(selection.targets.map((t) => t.toolCallId)).toEqual([
      "call_read_0",
      "call_read_1",
      "call_read_2",
    ]);
  });

  test("体积统计：只算保留尾部之外的未清理正文", () => {
    const messages = [
      user(1),
      textResult("read", 0, "a".repeat(1000)),
      textResult("bash", 1, "b".repeat(1000)),
      ...Array.from({ length: 5 }, (_, i) => textResult("grep", 10 + i, "c".repeat(10))),
    ];
    const selection = selectClearableResults({ messages, options: OPTIONS, keepRecent: 5, extend: false });
    expect(selection.pendingCount).toBe(7);
    expect(selection.pendingBytesBeyondKeepRecent).toBeGreaterThan(2000);
    expect(selection.pendingBytesBeyondKeepRecent).toBeLessThan(2100);
  });

  test("图片结果按内容字节计入体积", () => {
    const image = toolResult("read", "img", [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "A".repeat(4096), mimeType: "image/png" },
    ]);
    const candidates = scanClearableResults([image], OPTIONS);
    expect(candidates[0]?.bytes).toBeGreaterThan(4096);
  });
});

describe("占位符替换", () => {
  test("换成单个文本块，保留 isError / details / 配对字段", () => {
    const original = toolResult("read", "c1", [{ type: "text", text: "很长".repeat(10) }], {
      details: { truncation: null },
      isError: false,
      timestamp: 42,
    });
    const { messages, changed } = applyClearPlaceholders([original], [
      { index: 0, toolCallId: "c1", toolName: "read", bytes: 60 },
    ]);
    expect(changed).toBe(true);
    const rewritten = messages[0] as Record<string, unknown>;
    expect(rewritten.content).toEqual([{ type: "text", text: defaultPlaceholder("read") }]);
    expect(rewritten.isError).toBe(false);
    expect(rewritten.details).toEqual({ truncation: null });
    expect(rewritten.toolCallId).toBe("c1");
    expect(rewritten.timestamp).toBe(42);
    // 原对象不动
    expect((original.content as unknown[])[0]).toEqual({ type: "text", text: "很长".repeat(10) });
  });

  test("占位符检测只认本插件写的文案", () => {
    expect(isPlaceholderContent([{ type: "text", text: defaultPlaceholder("grep") }])).toBe(true);
    expect(isPlaceholderContent([{ type: "text", text: "[Old tool result content cleared]" }])).toBe(false);
    expect(isPlaceholderContent("plain text")).toBe(false);
    expect(isPlaceholderContent([{ type: "image", data: "x", mimeType: "image/png" }])).toBe(false);
  });

  test("目标为空时返回原数组且 changed=false", () => {
    const messages = [assistant(1)];
    const result = applyClearPlaceholders(messages, []);
    expect(result.changed).toBe(false);
    expect(result.messages).toHaveLength(1);
  });
});
