/**
 * S1：短 id 投影与 snip 区间校验。
 *
 * 短 id 公式是接口的一部分（模型看到的 `[id:xxxxxx]` 必须能在这里重新算出来），
 * 所以对"稳定、可重算、6 位 base36"逐条钉住。
 */
import { describe, expect, test } from "vitest";

import { isUserMessage, type MessageLike } from "../src/messages.ts";
import {
  appendShortIdToContent,
  collectUserAnchors,
  resolveSnipTargets,
  shortIdOf,
  type ProjectedItem,
} from "../src/snip.ts";

function user(timestamp: number, text = "hello"): MessageLike {
  return { role: "user", timestamp, content: text };
}

function assistant(timestamp: number): MessageLike {
  return { role: "assistant", timestamp, content: [{ type: "text", text: "ok" }] };
}

function toolResult(timestamp: number): MessageLike {
  return {
    role: "toolResult",
    toolName: "read",
    toolCallId: "c1",
    isError: false,
    timestamp,
    content: [{ type: "text", text: "file body" }],
  };
}

/** 一条用户消息 + 一段助手/工具往返 + 下一条用户消息…… */
function itemsOf(timestamps: number[]): ProjectedItem[] {
  const items: ProjectedItem[] = [];
  timestamps.forEach((timestamp, index) => {
    items.push({ entryId: `u${index + 1}`, message: user(timestamp, `第 ${index + 1} 轮`) });
    items.push({ entryId: `a${index + 1}`, message: assistant(timestamp + 1) });
    items.push({ entryId: `t${index + 1}`, message: toolResult(timestamp + 2) });
  });
  return items;
}

describe("短 id", () => {
  test("同一 role + timestamp 永远得到同一个 6 位 base36", () => {
    const id = shortIdOf("user", 1_700_000_000_123);
    expect(id).toHaveLength(6);
    expect(id).toMatch(/^[0-9a-z]{6}$/);
    expect(shortIdOf("user", 1_700_000_000_123)).toBe(id);
    expect(shortIdOf("user", 1_700_000_000_124)).not.toBe(id);
  });

  test("与实现中的临时拼法无关：换 role 就换 id", () => {
    expect(shortIdOf("user", 42)).not.toBe(shortIdOf("assistant", 42));
  });
});

describe("用户消息投影", () => {
  test("只认带时间戳的用户消息，顺序稳定", () => {
    const anchors = collectUserAnchors(itemsOf([1_000, 2_000, 3_000]));
    expect(anchors.map((anchor) => anchor.entryId)).toEqual(["u1", "u2", "u3"]);
    expect(anchors.map((anchor) => anchor.id)).toEqual([
      shortIdOf("user", 1_000),
      shortIdOf("user", 2_000),
      shortIdOf("user", 3_000),
    ]);
    expect(anchors[0]?.preview).toBe("第 1 轮");
  });

  test("字符串正文追加后缀，不动原对象", () => {
    const original = "hi";
    expect(appendShortIdToContent(original, "abc123")).toBe("hi\n[id:abc123]");
    expect(original).toBe("hi");
  });

  test("块数组追加到最后一个文本块；纯图片消息另起一个文本块", () => {
    const withText = appendShortIdToContent(
      [
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "看图" },
      ],
      "abc123",
    ) as Array<Record<string, unknown>>;
    expect(withText[1]).toEqual({ type: "text", text: "看图\n[id:abc123]" });

    const imageOnly = appendShortIdToContent(
      [{ type: "image", data: "x", mimeType: "image/png" }],
      "abc123",
    ) as Array<Record<string, unknown>>;
    expect(imageOnly).toHaveLength(2);
    expect(imageOnly[1]).toEqual({ type: "text", text: "[id:abc123]" });
  });
});

describe("区间解析与校验", () => {
  const items = itemsOf([1_000, 2_000, 3_000]);
  const [u1, u2, u3] = [1_000, 2_000, 3_000].map((timestamp) => shortIdOf("user", timestamp)) as [
    string,
    string,
    string,
  ];

  test("正常区间：端点之间的所有条目都进入 targetIds", () => {
    const resolved = resolveSnipTargets(items, u1, u2);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.targetIds).toEqual(["u1", "a1", "t1", "u2"]);
    expect(resolved.shortIds).toEqual([u1, u2]);
  });

  test("from === to：只裁那一条用户消息", () => {
    const resolved = resolveSnipTargets(items, u1, u1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.targetIds).toEqual(["u1"]);
  });

  test("端点不存在：报错并列出可用 id", () => {
    const resolved = resolveSnipTargets(items, "zzzzzz", u2);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("找不到短 id");
    expect(resolved.error).toContain(u1);
    expect(resolved.available).toEqual([u1, u2, u3]);
  });

  test("顺序错误：from 晚于 to", () => {
    const resolved = resolveSnipTargets(items, u2, u1);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("区间顺序错误");
  });

  test("不能裁当前回合：区间终点是本回合的用户消息", () => {
    const resolved = resolveSnipTargets(items, u1, u3);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("不能裁剪当前回合");
  });

  test("时间戳撞车导致 id 歧义时拒绝，而不是猜一个", () => {
    const duplicated: ProjectedItem[] = [
      { entryId: "u1", message: user(5_000, "第一条") },
      { entryId: "u2", message: user(5_000, "第二条") },
      { entryId: "u3", message: user(6_000, "当前回合") },
    ];
    const resolved = resolveSnipTargets(duplicated, shortIdOf("user", 5_000), shortIdOf("user", 5_000));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("对应多条消息");
  });

  test("没有用户消息时给出空列表提示", () => {
    const resolved = resolveSnipTargets([{ entryId: "a1", message: assistant(1) }], "abcdef", "abcdef");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("找不到短 id");
    expect(resolved.available).toEqual([]);
  });

  test("多条消息共享一个条目 id 时 targetIds 去重", () => {
    const shared: ProjectedItem[] = [
      { entryId: "u1", message: user(7_000, "第一轮") },
      { entryId: "u2", message: assistant(7_001) },
      { entryId: "u2", message: user(7_002, "同一条目里的第二条消息") },
      { entryId: "u3", message: user(7_003, "当前回合") },
    ];
    const resolved = resolveSnipTargets(shared, shortIdOf("user", 7_000), shortIdOf("user", 7_002));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.targetIds).toEqual(["u1", "u2"]);
  });
});

describe("消息形状守卫", () => {
  test("isUserMessage 只认 role", () => {
    expect(isUserMessage({ role: "user" })).toBe(true);
    expect(isUserMessage({ role: "assistant" })).toBe(false);
    expect(isUserMessage({})).toBe(false);
  });
});
