/**
 * S1（票据 memory-tool-boundary/01）：两条工具描述里的记忆文件访问口径。
 *
 * 防的是"以后有人精简描述，把这条口径悄悄删掉"：口径本身只是提示词级的
 * （read-guard 仍放行 memory_read 之后的内置 edit），一旦文案掉了，静默出错的两种
 * 情况就会回来——手写的事实没有 MEMORY.md 索引行，索引行与 description 对不上。
 *
 * 不需要真会话：工厂在注册期只调用 `on` / `registerTool` / `registerCommand`，
 * 所以桩一个只捕获 `registerTool` 的对象就够。
 */
import { describe, expect, test } from "vitest";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import zcodeMemory from "../extensions/zcode-memory.ts";

/** 跑一次工厂，收下它注册的工具（描述就是模型实际读到的那份文案）。 */
function registeredToolDescriptions(): Map<string, string> {
  const descriptions = new Map<string, string>();
  const stub = {
    on: () => () => {},
    registerTool: (tool: ToolDefinition) => {
      descriptions.set(tool.name, tool.description);
    },
    registerCommand: () => {},
  };
  zcodeMemory(stub as unknown as ExtensionAPI);
  return descriptions;
}

describe("工具描述里的记忆文件访问口径", () => {
  test("memory_write：新增与修改只经本工具，手写的事实没有索引行", () => {
    const write = registeredToolDescriptions().get("memory_write");
    expect(write).toBeDefined();
    expect(write).toContain("managed through these tools only");
    expect(write).toContain("never with the built-in write or edit");
    // 手写的事实会隐身：没有索引行，之后的会话看不到
    expect(write).toContain("cannot see it");
  });

  test("memory_read：读正文只经本工具，截断是唯一例外", () => {
    const read = registeredToolDescriptions().get("memory_read");
    expect(read).toBeDefined();
    expect(read).toContain("managed through these tools only");
    expect(read).toContain("never with the built-in read tool");
    // 第 2 条规则：正文被截断时仍可用内置 read 取全文，描述里必须留着这个例外
    expect(read).toContain("The only exception is a truncated body");
  });
});
