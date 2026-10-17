/**
 * 真实加载路径：用 pi 自己的加载器（jiti）把扩展文件装进来。
 *
 * 这一层专门覆盖桩会话测不到的东西：
 *   - jiti 能不能吃下 `extensions/*.ts` 里那些 `../src/*.ts` 带后缀的 import
 *   - 工厂真的注册出了 `subagent` 工具与 `agents` 命令
 *   - **守卫自动解析在 jiti 下的那条退路**：`import.meta.resolve` 在 jiti 里会抛
 *     （模块被转成 `data:` URL），实际走的是 `createRequire` —— 这条路径只有在这里才被测到
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import { discoverAndLoadExtensions, type Extension } from "@earendil-works/pi-coding-agent";

const EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "subagent-lite.ts",
);

const workspaces: Array<() => void> = [];
const originalAgentDir = process.env.PI_AGENT_DIR;

afterEach(() => {
  for (const cleanup of workspaces.splice(0)) cleanup();
  if (originalAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = originalAgentDir;
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-loader-"));
  mkdirSync(join(cwd, ".git"), { recursive: true });
  workspaces.push(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

async function loadOurExtension(cwd: string): Promise<{ extension: Extension; errors: unknown[] }> {
  const result = await discoverAndLoadExtensions([EXTENSION_PATH], cwd, join(cwd, ".pi-agent"));
  const extension = result.extensions.find((entry) => entry.path.endsWith("subagent-lite.ts"));
  expect(extension).toBeDefined();
  return { extension: extension as Extension, errors: result.errors };
}

/** 只实现被测扩展用到的字段（`ui.notify` 与 `modelRegistry.find`）。 */
function fakeContext(cwd: string, notifications: string[]) {
  return {
    cwd,
    ui: { notify: (message: string) => notifications.push(message) },
    modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [], getCwd: () => cwd },
    isIdle: () => true,
    isProjectTrusted: () => true,
  } as never;
}

describe("pi 的真实加载路径（jiti）", () => {
  test("扩展文件装得进来，工具与命令都注册上了", async () => {
    const cwd = workspace();
    process.env.PI_AGENT_DIR = join(cwd, ".pi-agent");
    const { extension, errors } = await loadOurExtension(cwd);

    expect(errors).toEqual([]);
    expect([...extension.tools.keys()]).toContain("subagent");
    expect([...extension.commands.keys()]).toContain("agents");
    expect([...extension.handlers.keys()]).toContain("session_start");
  });

  test("jiti 下守卫仍能自动解析到 pi-read-guard（走 createRequire 退路）", async () => {
    const cwd = workspace();
    process.env.PI_AGENT_DIR = join(cwd, ".pi-agent");
    const { extension } = await loadOurExtension(cwd);

    const notifications: string[] = [];
    const command = extension.commands.get("agents");
    expect(command).toBeDefined();
    await command?.handler("", fakeContext(cwd, notifications));

    const report = notifications.join("\n");
    expect(report).toContain("读守卫注入：已注入");
    expect(report).toContain("read-guard.ts");
    expect(report).toContain("Explore");
  });

  test("session_start 跑得起来（档案扫描 + 冲突扫描不炸）", async () => {
    const cwd = workspace();
    process.env.PI_AGENT_DIR = join(cwd, ".pi-agent");
    const { extension } = await loadOurExtension(cwd);

    const notifications: string[] = [];
    for (const handler of extension.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" } as never, fakeContext(cwd, notifications));
    }
    // 只有降级/覆盖/跳过才鸣笛；正常情况安静
    expect(notifications.join("\n")).not.toContain("读守卫注入：未注入");
  });
});
