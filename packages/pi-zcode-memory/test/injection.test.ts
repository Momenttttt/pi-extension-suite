/**
 * S1：注入决策与从会话投影重建注入状态。
 */
import { describe, expect, test } from "vitest";

import {
  INDEX_MESSAGE_TYPE,
  INJECTED_ENTRY_TYPE,
  decideInjection,
  rebuildInjectedHash,
  type InjectionDecisionInput,
} from "../src/injection.ts";

function input(overrides: Partial<InjectionDecisionInput> = {}): InjectionDecisionInput {
  return {
    messageType: "user",
    enabled: true,
    injectIndex: true,
    indexPresent: true,
    indexHash: "hash-new",
    injectedHash: undefined,
    force: false,
    ...overrides,
  };
}

describe("decideInjection", () => {
  test("首次运行注入", () => {
    expect(decideInjection(input())).toEqual({ inject: true, reason: "first" });
  });

  test("hash 未变 → 不重复注入", () => {
    expect(decideInjection(input({ injectedHash: "hash-new" }))).toEqual({
      inject: false,
      reason: "already-injected",
    });
  });

  test("hash 变化 → 重新注入", () => {
    expect(decideInjection(input({ injectedHash: "hash-old" }))).toEqual({ inject: true, reason: "changed" });
  });

  test("/memory reload 强制注入（即使 hash 未变）", () => {
    expect(decideInjection(input({ injectedHash: "hash-new", force: true }))).toEqual({
      inject: true,
      reason: "reload",
    });
  });

  test("跳过 custom 运行与关闭状态、无索引", () => {
    expect(decideInjection(input({ messageType: "custom" }))).toEqual({ inject: false, reason: "custom-run" });
    expect(decideInjection(input({ enabled: false }))).toEqual({ inject: false, reason: "disabled" });
    expect(decideInjection(input({ injectIndex: false }))).toEqual({ inject: false, reason: "disabled" });
    expect(decideInjection(input({ indexPresent: false }))).toEqual({ inject: false, reason: "no-index" });
    expect(decideInjection(input({ indexHash: undefined }))).toEqual({ inject: false, reason: "no-index" });
  });
});

describe("rebuildInjectedHash（按当前投影）", () => {
  const message = { type: "custom_message", customType: INDEX_MESSAGE_TYPE, details: { indexHash: "h1" } };
  const marker = { type: "custom", customType: INJECTED_ENTRY_TYPE, data: { indexHash: "h1" } };

  test("标记与注入消息都在 → 视为已注入", () => {
    expect(rebuildInjectedHash([message, marker])).toBe("h1");
  });

  test("注入消息被压缩掉（投影里没有）→ 视为未注入", () => {
    expect(rebuildInjectedHash([marker])).toBeUndefined();
  });

  test("只有消息没有标记 → 视为未注入", () => {
    expect(rebuildInjectedHash([message])).toBeUndefined();
  });

  test("取最新一组标记；hash 不匹配的旧标记不算", () => {
    const oldMessage = { type: "custom_message", customType: INDEX_MESSAGE_TYPE, details: { indexHash: "h0" } };
    const oldMarker = { type: "custom", customType: INJECTED_ENTRY_TYPE, data: { indexHash: "h0" } };
    expect(rebuildInjectedHash([oldMessage, oldMarker, message, marker])).toBe("h1");
    expect(rebuildInjectedHash([oldMarker, marker])).toBeUndefined();
  });

  test("坏数据不抛错", () => {
    expect(rebuildInjectedHash([{ type: "custom", customType: INJECTED_ENTRY_TYPE, data: null }])).toBeUndefined();
    expect(rebuildInjectedHash([{ type: "custom", customType: INJECTED_ENTRY_TYPE, data: { indexHash: 42 } }])).toBeUndefined();
  });
});
