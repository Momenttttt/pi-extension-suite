/**
 * S1（票据 08）：发布载荷的形状。
 *
 * 截断读必须 `kind: "truncated"` 且**不带** hash——否则它会变成合法的写水位。
 */
import { describe, expect, test } from "vitest";

import { buildReadStatePayload, hashMemoryContent } from "../src/bridge.ts";

describe("buildReadStatePayload", () => {
  test("完整读：full + contentHash", () => {
    const payload = buildReadStatePayload({
      absolutePath: "/mem/a.md",
      mtimeMs: 1234,
      sizeBytes: 42,
      contentHash: "abc",
      truncated: false,
    });
    expect(payload).toEqual({
      path: "/mem/a.md",
      mtimeMs: 1234,
      sizeBytes: 42,
      kind: "full",
      contentHash: "abc",
    });
  });

  test("截断读：truncated 且不带 hash（即使调用方给了 hash）", () => {
    const payload = buildReadStatePayload({
      absolutePath: "/mem/a.md",
      mtimeMs: 1234,
      sizeBytes: 42,
      contentHash: "should-not-leak",
      truncated: true,
    });
    expect(payload.kind).toBe("truncated");
    expect("contentHash" in payload).toBe(false);
  });

  test("hashMemoryContent 与 read-guard 的 hashContent 同构（sha256 小写 hex）", () => {
    expect(hashMemoryContent("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashMemoryContent("abc")).toMatch(/^[0-9a-f]{64}$/u);
  });
});
