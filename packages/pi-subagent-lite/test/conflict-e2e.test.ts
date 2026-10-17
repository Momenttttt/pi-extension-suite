/**
 * S2 端到端：同类子代理扩展的冲突告警（票据 12）。
 *
 * pi 的工具注册在同一名字上是"后写者胜"且**不报错**，所以冲突必须由我们主动检测并
 * 明确告诉用户——这也是为什么这里要接住 `ctx.ui.notify`：告警本身是产品行为的一部分，
 * 只测 `findForeignSubagentTools` 的返回值不足以证明它真的会说出口。
 *
 * 同一份通知里还应当带上"用户级 Explore.md 覆盖了内置代理"与旧字段名兼容的告警，
 * 因为本机确实存在这样一个文件（用 tintinweb 风格的 `display_name` / `prompt_mode`）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import subagentLite from "../extensions/subagent-lite.ts";
import { createTempWorkspace, createTestSession, type TestSession } from "./test-session.ts";

const cleanups: Array<() => void> = [];
const sessions: TestSession[] = [];

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
});

/** 模拟 `@tintinweb/pi-subagents`：它用的是 `Agent` 这个名字。 */
const competitor: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "另一个子代理扩展的工具",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "noop" }], details: undefined }),
  });
};

/**
 * 自建 agent 目录，并把 `PI_CODING_AGENT_DIR` 指过去。
 *
 * 这一步不能省：扩展是用 `resolveAgentDir()`（读环境变量、回落 `~/.pi/agent`）找档案目录的，
 * 不是用会话的 agentDir。只造目录却不动环境变量，扩展就会去读**开发者本机真实的**
 * `~/.pi/agent/agents/`——断言于是取决于那台机器上碰巧有什么文件。这个坑真发生过：
 * 这条用例曾经在 Windows 上"通过"，仅仅因为本机恰好有一个用旧字段名的 Explore.md；
 * 换到 Linux CI 上立刻失败（`expected '' to contain 'display_name'`）。
 */
function isolatedAgentDir(cwd: string, files: Record<string, string> = {}): string {
  const agentDir = join(cwd, ".pi-agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(agentDir, "agents", name), body, "utf8");
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return agentDir;
}

describe("票据 12：检测到同类扩展时明确告警", () => {
  test("另一个子代理扩展在场 → 启动通知里有冲突告警与卸载建议", async () => {
    const { cwd, cleanup } = createTempWorkspace();
    cleanups.push(cleanup);
    const notifications: Array<{ message: string; kind?: string }> = [];
    const session = await createTestSession({
      extension: subagentLite,
      extraExtensions: [competitor],
      cwd,
      agentDir: isolatedAgentDir(cwd),
      responses: [{ text: "ok" }],
      onNotify: (notification) => notifications.push(notification),
    });
    sessions.push(session);
    await session.run("hello");

    const warnings = notifications.map((entry) => entry.message).join("\n");
    expect(warnings).toContain("Agent");
    expect(warnings).toContain("不并存");
    expect(warnings).toContain("pi uninstall");
    expect(notifications.some((entry) => entry.kind === "error")).toBe(true);
  });

  test("只有本插件时没有冲突告警", async () => {
    const { cwd, cleanup } = createTempWorkspace();
    cleanups.push(cleanup);
    const notifications: Array<{ message: string; kind?: string }> = [];
    const session = await createTestSession({
      extension: subagentLite,
      cwd,
      agentDir: isolatedAgentDir(cwd),
      responses: [{ text: "ok" }],
      onNotify: (notification) => notifications.push(notification),
    });
    sessions.push(session);
    await session.run("hello");

    const warnings = notifications.map((entry) => entry.message).join("\n");
    expect(warnings).not.toContain("不并存");
    expect(warnings).not.toContain("pi uninstall");
  });

  test("用户级同名档案覆盖内置代理时打覆盖告警，旧字段名给兼容提示", async () => {
    const { cwd, cleanup } = createTempWorkspace();
    cleanups.push(cleanup);
    const notifications: Array<{ message: string; kind?: string }> = [];
    const session = await createTestSession({
      extension: subagentLite,
      cwd,
      agentDir: isolatedAgentDir(cwd, {
        // 用旧插件那套字段名，验证兼容别名与覆盖告警（夹具明确写在这里，不依赖本机状态）
        "Explore.md": [
          "---",
          "display_name: Explore",
          "prompt_mode: append",
          "description: 用户的只读探索代理",
          "---",
          "你是只读探索代理。",
          "",
        ].join("\n"),
      }),
      responses: [{ text: "ok" }],
      onNotify: (notification) => notifications.push(notification),
    });
    sessions.push(session);
    await session.run("hello");

    const warnings = notifications.map((entry) => entry.message).join("\n");
    expect(warnings).toContain("display_name");
    expect(warnings).toContain("prompt_mode");
    expect(warnings).toContain("覆盖");
    // 同名整文件替换（ADR-0002）：不能被静默发生
    expect(warnings).toContain("同名整文件替换");
  });
});
