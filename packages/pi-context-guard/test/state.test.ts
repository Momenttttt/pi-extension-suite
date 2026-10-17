/**
 * S1：状态层（水位、统计、待提交队列、失败计数）。
 *
 * 重点在 resume 时的重放规则：pending 条目 + 审计条目要能把"待提交"与"已裁剪"
 * 两个视图都恢复对，否则重启后要么重复提交、要么丢失撤销入口。
 */
import { describe, expect, test } from "vitest";

import { selectClearableResults, type ClearableToolOptions } from "../src/clear.ts";
import type { MessageLike } from "../src/messages.ts";
import {
  ContextGuardState,
  PENDING_SNIP_ENTRY,
  PENDING_UNSNIP_ENTRY,
  shouldWarnCompactionFailures,
  SNIP_APPLIED_ENTRY,
  UNSNIP_APPLIED_ENTRY,
  WATERMARK_ENTRY,
} from "../src/state.ts";

const OPTIONS: ClearableToolOptions = {
  clearSubagentResults: false,
  clearMemoryResults: false,
};

function customEntry(customType: string, data: unknown): unknown {
  return { type: "custom", customType, data, id: `${customType}-1`, parentId: null };
}

function textResult(index: number, size: number): MessageLike {
  return {
    role: "toolResult",
    toolName: "read",
    toolCallId: `call_${index}`,
    isError: false,
    timestamp: 1_000,
    content: [{ type: "text", text: "x".repeat(size) }],
  };
}

function selectionWith(messages: MessageLike[], keepRecent: number, extend: boolean) {
  return selectClearableResults({ messages, options: OPTIONS, keepRecent, extend });
}

describe("水位推进与统计", () => {
  test("只累计本次新选中的目标，重复推进不重复计数", () => {
    const messages = Array.from({ length: 6 }, (_, i) => textResult(i, 100));
    const frozen = selectionWith(messages, 2, true);
    const state = new ContextGuardState();
    state.promoteWatermark(frozen, "idle");
    expect(state.totalCount).toBe(4);
    expect(state.totalBytes).toBeGreaterThan(0);
    expect(state.consumeWatermarkDirty()).toBe(true);

    const again = selectClearableResults({
      messages,
      options: OPTIONS,
      keepRecent: 2,
      watermark: state.watermark,
      extend: true,
    });
    state.promoteWatermark(again, "idle");
    expect(state.totalCount).toBe(4);
    expect(state.consumeWatermarkDirty()).toBe(false);
  });

  test("水位条目的载荷带上锚点、覆盖条数与累计统计", () => {
    const messages = Array.from({ length: 6 }, (_, i) => textResult(i, 100));
    const state = new ContextGuardState();
    state.promoteWatermark(selectionWith(messages, 2, true), "volume");
    const data = state.watermarkData(123);
    expect(data.toolCallId).toBe("call_3");
    expect(data.coveredCount).toBe(4);
    expect(data.totalCount).toBe(4);
    expect(data.mode).toBe("volume");
    expect(data.at).toBe(123);
  });
});

describe("压缩联动", () => {
  test("压缩成功：水位重置、失败清零，统计与队列保留", () => {
    const messages = Array.from({ length: 6 }, (_, i) => textResult(i, 100));
    const state = new ContextGuardState();
    state.promoteWatermark(selectionWith(messages, 2, true), "idle");
    state.queueSnip("entry-1", "aaaaaa");
    state.recordFailure();
    expect(state.failures).toBe(1);
    expect(state.reliefPending).toBe(true);

    state.onCompaction();
    expect(state.watermark).toBeUndefined();
    expect(state.failures).toBe(0);
    expect(state.pendingOps()).toHaveLength(1);
    expect(state.totalCount).toBe(4);
  });

  test("连续失败累计；压缩成功之后清零", () => {
    const state = new ContextGuardState();
    state.recordFailure();
    state.recordFailure();
    state.recordFailure();
    expect(state.failures).toBe(3);
    // 生产路径上"清零"只有一条：压缩成功（`onCompaction`）——没有单独的"成功"信号可用
    state.onCompaction();
    expect(state.failures).toBe(0);
    expect(state.reliefPending).toBe(false);
  });

  test("告警阈值：3 次起、每 3 次一次，不刷屏", () => {
    expect(shouldWarnCompactionFailures(1)).toBe(false);
    expect(shouldWarnCompactionFailures(2)).toBe(false);
    expect(shouldWarnCompactionFailures(3)).toBe(true);
    expect(shouldWarnCompactionFailures(4)).toBe(false);
    expect(shouldWarnCompactionFailures(6)).toBe(true);
  });
});

describe("待提交队列", () => {
  test("同一目标后写者胜（先裁后忘就直接恢复）", () => {
    const state = new ContextGuardState();
    state.queueSnip("e1", "aaaaaa");
    state.queueSnip("e1", undefined, "restore");
    const drained = state.drain(1);
    expect(drained.snips).toHaveLength(0);
    expect(drained.restores.map((op) => op.entryId)).toEqual(["e1"]);
    expect(state.activeSnipCount()).toBe(0);
  });

  test("提交后进入已裁剪视图，撤销后移出", () => {
    const state = new ContextGuardState();
    state.queueSnip("e1", "aaaaaa");
    state.queueSnip("e2", "bbbbbb");
    state.drain(1);
    expect(state.activeSnipTargets()).toEqual(["e1", "e2"]);

    state.queueSnip("e1", undefined, "restore");
    state.drain(2);
    expect(state.activeSnipTargets()).toEqual(["e2"]);
  });
});

describe("从分支重建", () => {
  test("水位取最新一条，累计统计随它", () => {
    const state = new ContextGuardState();
    state.hydrate([
      customEntry(WATERMARK_ENTRY, { toolCallId: "call_0", coveredCount: 1, totalCount: 1, totalBytes: 10, mode: "idle", at: 1 }),
      customEntry(WATERMARK_ENTRY, { toolCallId: "call_3", coveredCount: 4, totalCount: 4, totalBytes: 40, mode: "volume", at: 2 }),
    ]);
    expect(state.watermark).toEqual({ toolCallId: "call_3", clearedCount: 4 });
    expect(state.totalCount).toBe(4);
    expect(state.totalBytes).toBe(40);
    expect(state.lastMode).toBe("volume");
  });

  test("已提交的 pending 条目不再排队；审计条目恢复已裁剪视图", () => {
    const state = new ContextGuardState();
    state.hydrate([
      customEntry(PENDING_SNIP_ENTRY, { targetIds: ["e1", "e2"], shortIds: ["aaaaaa", "bbbbbb"], at: 1 }),
      customEntry(SNIP_APPLIED_ENTRY, { count: 2, targetIds: ["e1", "e2"], shortIds: ["aaaaaa", "bbbbbb"], at: 2 }),
      customEntry(PENDING_SNIP_ENTRY, { targetIds: ["e3"], shortIds: ["cccccc"], at: 3 }),
    ]);
    expect(state.pendingOps().map((op) => op.entryId)).toEqual(["e3"]);
    expect(state.activeSnipTargets()).toEqual(["e1", "e2"]);
  });

  test("恢复审计条目把目标移出已裁剪视图", () => {
    const state = new ContextGuardState();
    state.hydrate([
      customEntry(SNIP_APPLIED_ENTRY, { count: 1, targetIds: ["e1"], shortIds: ["aaaaaa"], at: 1 }),
      customEntry(PENDING_UNSNIP_ENTRY, { targetIds: ["e1"], at: 2 }),
      customEntry(UNSNIP_APPLIED_ENTRY, { count: 1, targetIds: ["e1"], shortIds: [], at: 3 }),
    ]);
    expect(state.activeSnipCount()).toBe(0);
    expect(state.pendingOps()).toHaveLength(0);
  });

  test("不认识的条目与坏数据一律跳过，不抛", () => {
    const state = new ContextGuardState();
    state.hydrate([
      { type: "message" },
      customEntry("ctx-guard/other", { whatever: true }),
      customEntry(WATERMARK_ENTRY, "not-an-object"),
      customEntry(PENDING_SNIP_ENTRY, { targetIds: [1, 2, "e1"], at: 1 }),
    ]);
    expect(state.watermark).toBeUndefined();
    expect(state.pendingOps().map((op) => op.entryId)).toEqual(["e1"]);
  });

  test("reset 清掉一切（会话关闭）", () => {
    const state = new ContextGuardState();
    state.queueSnip("e1", "aaaaaa");
    state.drain(1);
    state.recordFailure();
    state.reset();
    expect(state.activeSnipCount()).toBe(0);
    expect(state.failures).toBe(0);
    expect(state.pendingOps()).toHaveLength(0);
  });
});
