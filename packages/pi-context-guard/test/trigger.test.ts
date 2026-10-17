/**
 * S1：触发档位的纯函数测试。
 *
 * 空闲档看时间，体积档看字节，降压力优先于两者；三者都要求"可清理条数 > keepRecent"。
 */
import { describe, expect, test } from "vitest";

import { selectClearableResults, type ClearableToolOptions } from "../src/clear.ts";
import type { MessageLike } from "../src/messages.ts";
import { decideClearTrigger, idleMsSinceLastAssistant } from "../src/trigger.ts";

const OPTIONS: ClearableToolOptions = {
  clearSubagentResults: false,
  clearMemoryResults: false,
};

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function textResult(index: number, text: string): MessageLike {
  return {
    role: "toolResult",
    toolName: "read",
    toolCallId: `call_${index}`,
    isError: false,
    timestamp: NOW,
    content: [{ type: "text", text }],
  };
}

function conversation(options: { assistantAgoMinutes: number | null; results: number; bytesEach: number }) {
  const messages: MessageLike[] = [{ role: "user", timestamp: NOW - 10 * MINUTE, content: "hi" }];
  if (options.assistantAgoMinutes !== null) {
    messages.push({
      role: "assistant",
      timestamp: NOW - options.assistantAgoMinutes * MINUTE,
      content: [{ type: "text", text: "ok" }],
    });
  }
  for (let index = 0; index < options.results; index += 1) {
    messages.push(textResult(index, "x".repeat(options.bytesEach)));
  }
  return messages;
}

function trigger(
  messages: MessageLike[],
  overrides: Partial<Parameters<typeof decideClearTrigger>[0]> = {},
) {
  const selection = selectClearableResults({
    messages,
    options: OPTIONS,
    keepRecent: overrides.keepRecent ?? 5,
    extend: false,
  });
  return decideClearTrigger({
    selection,
    messages,
    keepRecent: 5,
    maxClearableBytes: 4096,
    gapThresholdMinutes: 60,
    now: NOW,
    autoVolumeTrigger: false,
    pressureRelief: false,
    ...overrides,
  });
}

describe("空闲档", () => {
  test("空闲 61 分钟且可清理条数 > keepRecent → 自动清理", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 61, results: 6, bytesEach: 10 }));
    expect(decision.mode).toBe("idle");
    expect(decision.extend).toBe(true);
    expect(decision.idleQualified).toBe(true);
  });

  test("空闲 30 分钟 → 不触发", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 30, results: 6, bytesEach: 10 }));
    expect(decision.mode).toBe("none");
    expect(decision.extend).toBe(false);
  });

  test("可清理条数不超过 keepRecent → 空闲再久也不触发", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 600, results: 5, bytesEach: 10 }));
    expect(decision.mode).toBe("none");
  });

  test("没有 assistant 消息（新会话）时无法判断空闲", () => {
    const messages = conversation({ assistantAgoMinutes: null, results: 6, bytesEach: 10 });
    expect(idleMsSinceLastAssistant(messages, NOW)).toBeUndefined();
    expect(trigger(messages).mode).toBe("none");
  });
});

describe("体积档", () => {
  test("超过阈值 + 自动开关打开 → volume", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 1, results: 8, bytesEach: 1024 }), {
      autoVolumeTrigger: true,
      keepRecent: 2,
    });
    expect(decision.mode).toBe("volume");
    expect(decision.volumeQualified).toBe(true);
  });

  test("默认手动：阈值超了也不自动", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 1, results: 8, bytesEach: 1024 }), {
      keepRecent: 2,
    });
    expect(decision.mode).toBe("none");
    expect(decision.volumeQualified).toBe(true);
  });

  test("体积不够大 → 不触发", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 1, results: 8, bytesEach: 10 }), {
      autoVolumeTrigger: true,
      keepRecent: 2,
    });
    expect(decision.mode).toBe("none");
    expect(decision.volumeQualified).toBe(false);
  });
});

describe("降压力（压缩失败熔断）", () => {
  test("失败标记存在时强制按体积档清一次，不看空闲与体积", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 0, results: 6, bytesEach: 1 }), {
      pressureRelief: true,
    });
    expect(decision.mode).toBe("relief");
    expect(decision.extend).toBe(true);
  });

  test("没有足够可清理结果时降压力也不动", () => {
    const decision = trigger(conversation({ assistantAgoMinutes: 0, results: 2, bytesEach: 1 }), {
      pressureRelief: true,
    });
    expect(decision.extend).toBe(false);
  });
});
