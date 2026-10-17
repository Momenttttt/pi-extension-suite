/**
 * S1：/memory 命令的接线（用假 pi/ctx 捕获注册与通知，不起真实会话）。
 *
 * 状态文案的细节由 status.test.ts 覆盖；这里只验"命令注册了、分派对了"。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import zcodeMemory from "../extensions/zcode-memory.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type Notify = { message: string; type?: "info" | "warning" | "error" };

const cleanups: Array<() => void> = [];

beforeEach(() => {
  process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** 只实现本包用到的 API；其余一律 no-op。 */
function fakePi(): { pi: ExtensionAPI; commands: Map<string, CommandOptions> } {
  const commands = new Map<string, CommandOptions>();
  const pi = {
    on: () => () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
    appendEntry: () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

function fakeContext(cwd: string): { ctx: ExtensionCommandContext; notifications: Notify[] } {
  const notifications: Notify[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, type?: Notify["type"]) => {
        notifications.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function workspaceWithMemory(): { cwd: string; memDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-memory-cmd-"));
  const memDir = mkdtempSync(join(tmpdir(), "pi-memory-cmd-store-"));
  cleanups.push(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  });
  writeFileSync(join(memDir, "a.md"), "---\nname: a\ndescription: 描述\nmetadata:\n  type: user\n---\n正文\n", "utf8");
  writeFileSync(join(memDir, "MEMORY.md"), "- [a](a.md) — 描述\n- [missing](missing.md) — 孤儿\n", "utf8");
  return { cwd, memDir };
}

describe("/memory 命令", () => {
  test("无参数：显示状态与索引体检", async () => {
    const { cwd, memDir } = workspaceWithMemory();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "zcode-memory.json"), JSON.stringify({ dir: memDir }), "utf8");

    const { pi, commands } = fakePi();
    zcodeMemory(pi);
    const command = commands.get("memory");
    expect(command).toBeDefined();

    const { ctx, notifications } = fakeContext(cwd);
    await command!.handler("", ctx);
    const message = notifications[0]?.message ?? "";
    expect(message).toContain(memDir);
    expect(message).toContain("事实文件：1 个");
    expect(message).toContain("孤儿索引行 1 条（missing.md）");
    expect(message).toContain("索引注入：");
  });

  test("/memory reload：排队下一次重新注入", async () => {
    const { cwd } = workspaceWithMemory();
    const { pi, commands } = fakePi();
    zcodeMemory(pi);
    const { ctx, notifications } = fakeContext(cwd);
    await commands.get("memory")!.handler("reload", ctx);
    expect(notifications[0]?.message).toContain("下一次运行会重新注入");
  });

  test("未知子命令：给用法提示", async () => {
    const { cwd } = workspaceWithMemory();
    const { pi, commands } = fakePi();
    zcodeMemory(pi);
    const { ctx, notifications } = fakeContext(cwd);
    await commands.get("memory")!.handler("nonsense", ctx);
    expect(notifications[0]?.type).toBe("warning");
    expect(notifications[0]?.message).toContain("用法");
  });
});
