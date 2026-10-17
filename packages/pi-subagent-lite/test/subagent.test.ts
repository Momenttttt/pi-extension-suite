/**
 * S2 端到端：真实 AgentSession + 桩 provider，把 `subagent` 工具整条跑通。
 *
 * 覆盖票据 13 的四条验收：委派一个只读任务 → 结果与用量正确、父会话合计包含它、
 * Esc 中断后 `status: aborted`、Explore 的工具池里没有 `write`/`edit`（且递归不可能）。
 *
 * 桩 provider 的 `usage` 恒为 0（骨架写死的），所以"合计包含子代理用量"这条用夹具扩展
 * （`test/fixtures/usage-tool.ts`，经 `guardExtensionPaths` 装进子会话）造非零用量，
 * 断言父会话合计真的把那笔账算进去了。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import subagentLite, { createChildSession } from "../extensions/subagent-lite.ts";
import { EXPLORE_AGENT, GENERAL_PURPOSE_AGENT } from "../src/builtin-agents.ts";

import type { AgentProfile } from "../src/profile.ts";
import { createTestSession, type TestSession, type TestSessionOptions } from "./test-session.ts";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "usage-tool.ts",
);

const workspaces: Array<() => void> = [];
const sessions: TestSession[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-e2e-"));
  // git 根标记：让档案向上发现在临时目录里打住，别扫到用户目录
  mkdirSync(join(cwd, ".git"), { recursive: true });
  workspaces.push(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const cleanup of workspaces.splice(0)) cleanup();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

/** 建工作区 + 会话；`agentDir` 与扩展解析的 `PI_CODING_AGENT_DIR` 对齐，测试才是自洽的。 */
async function sessionIn(
  responses: TestSessionOptions["responses"],
  options: { config?: Record<string, unknown>; extraExtensions?: ExtensionFactory[] } = {},
): Promise<{ test: TestSession; cwd: string }> {
  const cwd = workspace();
  const agentDir = join(cwd, ".pi-agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (options.config !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagent-lite.json"), JSON.stringify(options.config), "utf8");
  }

  const test = await createTestSession({
    extension: subagentLite,
    cwd,
    agentDir,
    responses,
    ...(options.extraExtensions === undefined ? {} : { extraExtensions: options.extraExtensions }),
  });
  sessions.push(test);
  return { test, cwd };
}

interface ToolResultRow {
  toolName: string;
  isError: boolean;
  details: Record<string, unknown>;
  usage?: { totalTokens?: number };
  content: unknown;
  text: string;
}

/** 父会话转录里的工具结果（`details` 是我们回传的结构化结果）。 */
function toolResults(test: TestSession, toolName = "subagent"): ToolResultRow[] {
  return test.session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        (entry as { message?: { role?: string } }).message?.role === "toolResult",
    )
    .map((entry) => (entry as unknown as { message: Record<string, unknown> }).message)
    .filter((message) => message["toolName"] === toolName)
    .map((message) => ({
      toolName: String(message["toolName"]),
      isError: message["isError"] === true,
      details: (message["details"] ?? {}) as Record<string, unknown>,
      usage: message["usage"] as ToolResultRow["usage"],
      content: message["content"],
      text: textOfContent(message["content"]),
    }));
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * 子会话发出去的请求。
 *
 * 骨架只捕获 `context.messages`（system prompt 与工具声明在 `context` 的其它字段上，捕获不到），
 * 所以这里按"子代理自己的 prompt 文本"筛选——父会话的请求里**永远不会**出现子代理的 prompt，
 * 这本身就是隔离证据。工具池改用装配接缝直接断言（见文件末尾那组用例）。
 */
function childRequests(
  test: TestSession,
  parentPrompt: string,
  childPrompt: string,
): Array<{ allText: string; bytes: number }> {
  return test.requests.filter(
    (request) =>
      !request.allText.includes(parentPrompt) && request.allText.includes(childPrompt),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PARENT_PROMPT = "please delegate: find the marker";
const CHILD_PROMPT = "find which file holds the marker string";

describe("委派只读任务给 Explore", () => {
  test("结果、用量与工具池都对，且子代理看不到父会话历史", async () => {
    const { test } = await sessionIn([
      {
        text: "delegating",
        toolCall: {
          name: "subagent",
          arguments: {
            description: "locate the marker",
            prompt: CHILD_PROMPT,
            subagent_type: "Explore",
          },
        },
      },
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "The marker is in a.txt line 1." },
      { text: "PARENT DONE" },
    ]);
    writeFileSync(join(test.session.sessionManager.getCwd(), "a.txt"), "marker\n", "utf8");

    const reply = await test.run(PARENT_PROMPT);

    expect(reply).toBe("PARENT DONE");

    const [result] = toolResults(test);
    expect(result).toBeDefined();
    expect(result?.isError).toBe(false);
    expect(result?.details["agent"]).toBe("Explore");
    expect(result?.details["status"]).toBe("completed");
    expect(result?.details["description"]).toBe("locate the marker");
    expect(result?.details["turns"]).toBe(2);
    expect(result?.details["toolCalls"]).toBe(1);
    expect(result?.details["truncated"]).toBe(false);
    expect(result?.details["model"]).toBe("pi-suite-stub/stub-model");
    expect(result?.text).toContain("The marker is in a.txt line 1.");
    expect(result?.text).toMatch(
      /\[subagent\] agent=Explore status=completed turns=2 tool_calls=1 duration=\S+ tokens=0/,
    );

    // 隔离：子代理的每条请求里都没有父会话输入（父会话第二条请求带着工具调用参数，
    // 所以"子代理 prompt"不是判别式，"父会话 prompt 没出现"才是）
    const child = childRequests(test, PARENT_PROMPT, CHILD_PROMPT);
    expect(child).toHaveLength(2);
    for (const request of child) {
      expect(request.allText).not.toContain(PARENT_PROMPT);
      expect(request.allText).toContain(CHILD_PROMPT);
    }
    // 父会话的两条请求都带自己的输入
    const parentRequests = test.requests.filter((request) => !child.includes(request));
    expect(parentRequests).toHaveLength(2);
    for (const request of parentRequests) expect(request.allText).toContain(PARENT_PROMPT);
  });
});

describe("父会话合计包含子代理用量", () => {
  test("子代理自己产生的非零用量进了父会话的合计（桩 provider 的用量恒为 0，所以用夹具扩展造）", async () => {
    const { test } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: { description: "use the fixture", prompt: "call report_usage with total 4242" },
          },
        },
        { toolCall: { name: "report_usage", arguments: { total: 4242 } } },
        { text: "child used the fixture tool" },
        { text: "PARENT DONE" },
      ],
      { config: { guardExtensionPaths: [FIXTURE_PATH] } },
    );

    await test.run("delegate to general-purpose now");

    const [result] = toolResults(test);
    expect(result?.details["agent"]).toBe("general-purpose");
    expect(result?.details["status"]).toBe("completed");
    expect(result?.details["toolCalls"]).toBe(1);
    // 夹具工具的用量（4242）经子会话统计 → 工具结果 → 父会话转录
    expect(result?.details["usage"]).toMatchObject({ input: 4242, totalTokens: 4242 });
    expect(result?.usage?.totalTokens).toBe(4242);

    // 父会话的合计把那笔账算进去了（这正是"要回传 usage"的理由）
    const stats = test.session.getSessionStats();
    expect(stats.tokens.total).toBe(4242);
    expect(stats.toolCalls).toBe(1);
    expect(stats.toolResults).toBe(1);

    // 夹具扩展在子会话里生效：第二次子会话请求里能看到它的工具结果
    const child = childRequests(test, "delegate to general-purpose now", "call report_usage with total 4242");
    expect(child).toHaveLength(2);
    expect(child.at(-1)?.allText).toContain("fixture usage 4242");
  });
});

describe("中断传播", () => {
  test("父会话中断 → 子代理被 abort，结果是 status=aborted", async () => {
    const { test } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: { description: "slow work", prompt: "run the slow fixture" },
          },
        },
        { toolCall: { name: "report_usage", arguments: { total: 5, slowMs: 1_200 } } },
        { text: "child finished" },
        { text: "PARENT DONE" },
      ],
      { config: { guardExtensionPaths: [FIXTURE_PATH] } },
    );

    const run = test.run("delegate a slow task");
    await sleep(300);
    await test.session.abort();
    await run;

    const [result] = toolResults(test);
    expect(result?.details["status"]).toBe("aborted");
    expect(result?.details["agent"]).toBe("general-purpose");
    // 子代理已经发出的工具调用还在账上，且 usage 形状可用（不是 undefined / NaN）
    expect(result?.details["toolCalls"]).toBe(1);
    // turns 是"assistant 消息条数"的近似：中途 abort 时 pi 还会补一条空的 assistant 消息
    expect(result?.details["turns"]).toBeGreaterThanOrEqual(1);
    expect(result?.details["usage"]).toMatchObject({ totalTokens: expect.any(Number) });
    expect(result?.text).toContain("(subagent was interrupted before producing final text)");
    expect(result?.text).toMatch(/\[subagent\] agent=general-purpose status=aborted/);
  });
});

describe("模型与代理名", () => {
  test("档案写 model: provider/id 时按 modelRegistry 解析；找不到会明说回退", async () => {
    const { test, cwd } = await sessionIn([
      {
        text: "delegating",
        toolCall: {
          name: "subagent",
          arguments: {
            description: "use a missing model",
            prompt: "say ok",
            subagent_type: "pinned",
          },
        },
      },
      { text: "child ok" },
      { text: "PARENT DONE" },
    ]);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "pinned.md"),
      "---\nname: pinned\ndescription: 指定模型\nmodel: nope/missing\n---\nbody\n",
      "utf8",
    );
    // 档案是在 session_start 时扫的，所以重新触发一次（真实运行里改档案也是 /reload）
    await test.session.reload();

    await test.run("delegate");

    const [result] = toolResults(test);
    expect(result?.details["model"]).toBe("pi-suite-stub/stub-model");
    expect(result?.text).toContain("nope/missing was not found in the modelRegistry");
    expect(result?.details["status"]).toBe("completed");
  });

  test("未知代理名 → 报错结果里列出可用代理（不静默退回 general-purpose）", async () => {
    const { test } = await sessionIn([
      {
        text: "delegating",
        toolCall: {
          name: "subagent",
          arguments: { description: "bad type", prompt: "x", subagent_type: "nope" },
        },
      },
      { text: "PARENT DONE" },
    ]);

    await test.run("delegate to a missing agent");

    const [result] = toolResults(test);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("No agent profile named nope");
    expect(result?.text).toContain("Explore");
    expect(result?.text).toContain("general-purpose");
  });

  test("model 参数写错形式 → 报错结果说明只接受 provider/model 或 inherit", async () => {
    const { test } = await sessionIn([
      {
        text: "delegating",
        toolCall: {
          name: "subagent",
          arguments: { description: "bad model", prompt: "x", model: "just-a-model-name" },
        },
      },
      { text: "PARENT DONE" },
    ]);

    await test.run("delegate");

    const [result] = toolResults(test);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("provider/model");
  });
});

describe("session_start 里的冲突扫描与 /agents", () => {
  /** 只实现被测扩展真正用到的 `notify`，其余方法不会被调用。 */
  function recordingUI(messages: Array<{ message: string; type?: string }>) {
    return {
      notify: (message: string, type?: string) => {
        messages.push({ message, ...(type === undefined ? {} : { type }) });
      },
    } as never;
  }

  const foreignAgentTool: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "Agent",
      label: "Agent",
      description: "一个同类扩展的假工具",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      execute: async () => ({ content: [{ type: "text", text: "noop" }], details: {} }),
    });
  };

  test("本机装了别的子代理扩展时给冲突告警，且不把自己的工具误报成冲突", async () => {
    const { test } = await sessionIn([{ text: "hi" }], { extraExtensions: [foreignAgentTool] });
    const notifications: Array<{ message: string; type?: string }> = [];
    await test.session.bindExtensions({ uiContext: recordingUI(notifications) });

    const warnings = notifications.filter((entry) => entry.type === "warning" || entry.type === "error");
    const text = warnings.map((entry) => entry.message).join("\n");
    expect(text).toContain("工具 Agent");
    expect(text).toContain("不并存");
    expect(text).not.toContain("工具 subagent");
  });

  test("/agents 列出生效代理、模型解析与来源；冲突也出现", async () => {
    const { test, cwd } = await sessionIn([{ text: "hi" }], { extraExtensions: [foreignAgentTool] });
    // 用户级目录放一个档案，/agents 才会把它算进"扫描的目录"
    const userAgentsDir = join(cwd, ".pi-agent", "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(
      join(userAgentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: 用户级档案\n---\n",
      "utf8",
    );
    const notifications: Array<{ message: string; type?: string }> = [];
    await test.session.bindExtensions({ uiContext: recordingUI(notifications) });

    const command = test.session.extensionRunner.getCommand("agents");
    expect(command).toBeDefined();
    await command?.handler("", test.session.extensionRunner.createCommandContext());

    const report = notifications.map((entry) => entry.message).join("\n");
    expect(report).toContain("Explore");
    expect(report).toContain("general-purpose");
    expect(report).toContain("inherit → pi-suite-stub/stub-model");
    expect(report).toContain("工具 5 个：read, grep, find, ls, bash");
    expect(report).toContain("来源 内置（代码）");
    expect(report).toContain("工具 Agent");
    expect(report).toContain("扫描的目录：");
    expect(report).toContain(userAgentsDir);
  });

  test("坏档案在 /agents 里带原因列出，且不影响内置代理可用", async () => {
    const { test, cwd } = await sessionIn([{ text: "hi" }]);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "---\nname: broken\n", "utf8");
    await test.session.reload();

    const notifications: Array<{ message: string; type?: string }> = [];
    await test.session.bindExtensions({ uiContext: recordingUI(notifications) });
    const command = test.session.extensionRunner.getCommand("agents");
    await command?.handler("", test.session.extensionRunner.createCommandContext());

    const report = notifications.map((entry) => entry.message).join("\n");
    expect(report).toContain("跳过的档案：");
    expect(report).toContain("broken.md：前置元数据解析失败");
    expect(report).toContain("Explore");
  });
});

/**
 * 子会话装配（`createChildSession` 接缝，票据 14 也在这里接守卫）。
 *
 * 这里直接看装配出来的会话本身：工具池（`getActiveToolNames` 就是"声明给模型的工具集"）、
 * 递归不可能（`subagent` 既不在活动工具里也不在可调用工具里）、不落盘、提示词模式。
 */
describe("子会话装配", () => {
  const stubModel = {
    provider: "pi-suite-stub",
    id: "stub-model",
    name: "Stub Model",
    api: "pi-messages",
    baseUrl: "http://127.0.0.1:1/stub",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };

  async function assemble(profile: AgentProfile) {
    const cwd = workspace();
    const agentDir = join(cwd, ".pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const { session } = await createChildSession({
      cwd,
      agentDir,
      profile,
      model: stubModel as never,
      thinkingLevel: undefined,
      modelRuntime: undefined,
      extensionPaths: [],
    });
    assembled.push(session);
    return session;
  }

  const assembled: AgentSession[] = [];
  afterEach(() => {
    for (const session of assembled.splice(0)) session.dispose();
  });

  test("Explore：只读五件套，没有 write/edit，也没有 subagent（递归不可能）", async () => {
    const session = await assemble(EXPLORE_AGENT);
    expect(session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(session.getCallableToolNames()).not.toContain("subagent");
    expect(session.getActiveToolNames()).not.toContain("write");
    expect(session.getActiveToolNames()).not.toContain("edit");
  });

  test("general-purpose：默认集 read/bash/edit/write，依然没有 subagent", async () => {
    const session = await assemble(GENERAL_PURPOSE_AGENT);
    expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
    expect(session.getCallableToolNames()).not.toContain("subagent");
  });

  test("子会话不落盘（SessionManager.inMemory）", async () => {
    const session = await assemble(EXPLORE_AGENT);
    expect(session.sessionFile).toBeUndefined();
  });

  test("promptMode: append 追加在 pi 标准提示词之后；replace 整段替换", async () => {
    const appended = await assemble(EXPLORE_AGENT);
    expect(appended.systemPrompt).toContain("# Read-only search agent");
    expect(appended.systemPrompt).toContain("You are an expert coding assistant");

    const replaced = await assemble({
      ...EXPLORE_AGENT,
      promptMode: "replace",
      body: "只有这一段。",
    });
    expect(replaced.systemPrompt).toContain("只有这一段。");
    expect(replaced.systemPrompt).not.toContain("You are an expert coding assistant");
  });

  test("injectAgentsMd: false 的子会话读不到项目 AGENTS.md，true 的读得到", async () => {
    const cwd = workspace();
    const agentDir = join(cwd, ".pi-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "项目规则：只用中文注释。\n", "utf8");

    const without = await createChildSession({
      cwd,
      agentDir,
      profile: EXPLORE_AGENT,
      model: stubModel as never,
      thinkingLevel: undefined,
      modelRuntime: undefined,
      extensionPaths: [],
    });
    assembled.push(without.session);
    expect(without.session.systemPrompt).not.toContain("只用中文注释");

    const withContext = await createChildSession({
      cwd,
      agentDir,
      profile: GENERAL_PURPOSE_AGENT,
      model: stubModel as never,
      thinkingLevel: undefined,
      modelRuntime: undefined,
      extensionPaths: [],
    });
    assembled.push(withContext.session);
    expect(withContext.session.systemPrompt).toContain("只用中文注释");
  });
});

describe("maxTurns", () => {
  test("档案设了 maxTurns 才启用：到点 abort，status=max_turns", async () => {
    const { test, cwd } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: { description: "long task", prompt: "keep working", subagent_type: "limited" },
          },
        },
        { text: "turn one", toolCall: { name: "read", arguments: { path: "a.txt" } } },
        { text: "turn two", toolCall: { name: "read", arguments: { path: "a.txt" } } },
        // 上限是 2 条 assistant 消息，第三步不该被跑到；脚本里留着也只会被父会话消费
        { text: "PARENT DONE" },
        { text: "unused" },
      ],
      { config: { guardExtensionPaths: [FIXTURE_PATH] } },
    );
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "limited.md"),
      "---\nname: limited\ndescription: 有轮次上限的代理\ntools: read, bash\nmaxTurns: 2\n---\nbody\n",
      "utf8",
    );
    // 档案是 session_start 时扫的（真实运行里改档案等价于 /reload）
    await test.session.reload();
    writeFileSync(join(cwd, "a.txt"), "marker\n", "utf8");

    const reply = await test.run("delegate a long task");

    expect(reply).toBe("PARENT DONE");
    const [result] = toolResults(test);
    expect(result?.details["agent"]).toBe("limited");
    expect(result?.details["status"]).toBe("max_turns");
    // 近似值：到点那一刻已计到上限，中断时 pi 可能再补一条空的 assistant 消息
    expect(result?.details["turns"]).toBeGreaterThanOrEqual(2);
    expect(result?.details["turns"]).toBeLessThanOrEqual(3);
    // 跑到一半被中断，最后一次工具调用可能被丢弃
    expect(result?.details["toolCalls"]).toBeGreaterThanOrEqual(1);
    // 到点即停，但已经产出的最后文本要带回来（设计 §5 的 maxTurns 行为）
    expect(result?.text).toContain("turn two");
    expect(result?.text).toMatch(/status=max_turns/);
  });

  test("没设 maxTurns 的代理不会被上限截断（Explore 连跑两轮）", async () => {
    const { test } = await sessionIn([
      {
        text: "delegating",
        toolCall: {
          name: "subagent",
          arguments: { description: "two turns", prompt: CHILD_PROMPT, subagent_type: "Explore" },
        },
      },
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { toolCall: { name: "read", arguments: { path: "a.txt" } } },
      { text: "child finished after two turns" },
      { text: "PARENT DONE" },
    ]);
    writeFileSync(join(test.session.sessionManager.getCwd(), "a.txt"), "marker\n", "utf8");

    await test.run(PARENT_PROMPT);

    const [result] = toolResults(test);
    expect(result?.details["status"]).toBe("completed");
    expect(result?.details["turns"]).toBe(3);
    expect(result?.text).toContain("child finished after two turns");
  });
});

/**
 * 守卫注入（票据 14 的后半段）：子代理默认也受"先读后写"约束。
 *
 * 注入路径经 `src/guard.ts` 解析（默认自动找 `@momenttttt/pi-read-guard`），失败只降级不中断。
 */
describe("守卫注入", () => {
  const READ_GUARD_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "pi-read-guard",
    "extensions",
    "read-guard.ts",
  );

  const WRITE_PARENT_PROMPT = "delegate a write task";
  const WRITE_CHILD_PROMPT = "overwrite target.txt";

  test("子代理未读就写 → 被 read-guard 阻断，理由出现在它的工具结果里", async () => {
    const { test, cwd } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: {
              description: "write without reading",
              prompt: WRITE_CHILD_PROMPT,
            },
          },
        },
        { toolCall: { name: "write", arguments: { path: "target.txt", content: "OVERWRITTEN\n" } } },
        { text: "child done" },
        { text: "PARENT DONE" },
      ],
      { config: { guardExtensionPaths: [READ_GUARD_PATH] } },
    );
    writeFileSync(join(cwd, "target.txt"), "原始内容\n", "utf8");

    await test.run(WRITE_PARENT_PROMPT);

    // 子代理自己的工具结果里带着阻断理由（它是子会话第二次请求的一部分）
    const child = childRequests(test, WRITE_PARENT_PROMPT, WRITE_CHILD_PROMPT);
    expect(child).toHaveLength(2);
    const childText = child.at(-1)?.allText ?? "";
    expect(childText).toContain("has not been read in this session");
    expect(childText).toContain("read-guard: not_read");

    // 文件没被改：阻断真的生效了
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("原始内容\n");
    // 子代理本身照常跑完
    const [result] = toolResults(test);
    expect(result?.details["status"]).toBe("completed");
  });

  test("子代理自己先读再写 → 放行", async () => {
    const { test, cwd } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: { description: "read then write", prompt: WRITE_CHILD_PROMPT },
          },
        },
        { toolCall: { name: "read", arguments: { path: "target.txt" } } },
        { toolCall: { name: "write", arguments: { path: "target.txt", content: "OVERWRITTEN\n" } } },
        { text: "child done" },
        { text: "PARENT DONE" },
      ],
      { config: { guardExtensionPaths: [READ_GUARD_PATH] } },
    );
    writeFileSync(join(cwd, "target.txt"), "原始内容\n", "utf8");

    await test.run(WRITE_PARENT_PROMPT);

    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("OVERWRITTEN\n");
    const child = childRequests(test, WRITE_PARENT_PROMPT, WRITE_CHILD_PROMPT);
    expect(child.at(-1)?.allText).not.toContain("read-guard: not_read");
  });

  test("守卫路径解析不到 → 子代理照常跑 + 明确告警（不中断）", async () => {
    const { test } = await sessionIn(
      [
        {
          text: "delegating",
          toolCall: {
            name: "subagent",
            arguments: { description: "still works", prompt: CHILD_PROMPT, subagent_type: "Explore" },
          },
        },
        { text: "child ok" },
        { text: "PARENT DONE" },
      ],
      { config: { guardExtensionPaths: [join("C:/definitely-missing", "read-guard.ts")] } },
    );

    const notifications: Array<{ message: string; type?: string }> = [];
    await test.session.bindExtensions({
      uiContext: {
        notify: (message: string, type?: string) => {
          notifications.push({ message, ...(type === undefined ? {} : { type }) });
        },
      } as never,
    });

    const reply = await test.run(PARENT_PROMPT);
    expect(reply).toBe("PARENT DONE");

    const [result] = toolResults(test);
    expect(result?.details["status"]).toBe("completed");
    const warnings = notifications.filter((entry) => entry.type === "warning");
    expect(warnings.map((entry) => entry.message).join("\n")).toContain("读守卫注入：未注入");

    const command = test.session.extensionRunner.getCommand("agents");
    notifications.length = 0;
    await command?.handler("", test.session.extensionRunner.createCommandContext());
    expect(notifications.map((entry) => entry.message).join("\n")).toContain("读守卫注入：未注入");
  });

  test("默认（不写配置）时自动解析到 pi-read-guard，/agents 显示已注入", async () => {
    const { test } = await sessionIn([{ text: "hi" }]);

    const notifications: Array<{ message: string; type?: string }> = [];
    await test.session.bindExtensions({
      uiContext: {
        notify: (message: string, type?: string) => {
          notifications.push({ message, ...(type === undefined ? {} : { type }) });
        },
      } as never,
    });
    const command = test.session.extensionRunner.getCommand("agents");
    await command?.handler("", test.session.extensionRunner.createCommandContext());

    const report = notifications.map((entry) => entry.message).join("\n");
    expect(report).toContain("读守卫注入：已注入");
    expect(report).toContain("read-guard.ts");
  });
});
