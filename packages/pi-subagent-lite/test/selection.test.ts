/**
 * S1：折算与文案（工具池、模型/思考解析、结果形状、/agents 文本、冲突检测）。
 */
import { describe, expect, test } from "vitest";

import { EXPLORE_AGENT, GENERAL_PURPOSE_AGENT } from "../src/builtin-agents.ts";
import type { AgentListing } from "../src/discovery.ts";
import { parseAgentProfile, type AgentProfile } from "../src/profile.ts";
import { describeConflicts, findForeignSubagentTools } from "../src/registry.ts";
import { formatAgentsReport } from "../src/report.ts";
import {
  composeResultContent,
  formatDuration,
  formatTokens,
  formatTrailer,
  type SubagentDetails,
} from "../src/result.ts";
import {
  describeModel,
  describeTools,
  isMalformedModelSpec,
  parseModelSpec,
  resolveThinking,
  toolSelectionFor,
} from "../src/selection.ts";
import { usageFromSessionStats } from "../src/usage.ts";

function profileOf(frontmatter: string): AgentProfile {
  const parsed = parseAgentProfile(`---\ndescription: d\n${frontmatter}---\nbody\n`, {
    path: "C:/repo/.pi/agents/x.md",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.profile;
}

describe("工具池折算", () => {
  test("白名单 → tools；disallowedTools → excludeTools；* → 不传 tools", () => {
    expect(toolSelectionFor(profileOf("tools: read, grep\ndisallowedTools: write\n"))).toEqual({
      tools: ["read", "grep"],
      excludeTools: ["write"],
    });
    expect(toolSelectionFor(profileOf('tools: "*"\n'))).toEqual({});
    expect(toolSelectionFor(EXPLORE_AGENT)).toEqual({ tools: ["read", "grep", "find", "ls", "bash"] });
    expect(toolSelectionFor(GENERAL_PURPOSE_AGENT)).toEqual({});
  });

  test("`+x` / `-x` 语义原样透传（由 pi 解释）", () => {
    expect(toolSelectionFor(profileOf("tools: +web_search, -bash\n")).tools).toEqual([
      "+web_search",
      "-bash",
    ]);
  });

  test("工具数：白名单数减掉 disallowedTools；* 给内置默认的 4 个", () => {
    expect(describeTools(EXPLORE_AGENT)).toEqual({
      summary: "read, grep, find, ls, bash",
      count: 5,
    });
    expect(describeTools(profileOf("tools: read, grep, find\ndisallowedTools: find\n"))).toEqual({
      summary: "read, grep, find，减 find",
      count: 2,
    });
    expect(describeTools(GENERAL_PURPOSE_AGENT).count).toBe(4);
    expect(describeTools(profileOf('tools: "*"\ndisallowedTools: write\n')).summary).toContain(
      "减 write",
    );
  });
});

describe("模型与思考档位", () => {
  test("model 解析：inherit / provider-id", () => {
    expect(parseModelSpec("inherit")).toEqual({ kind: "inherit" });
    expect(parseModelSpec("")).toEqual({ kind: "inherit" });
    expect(parseModelSpec("anthropic/claude-opus-4-5")).toEqual({
      kind: "explicit",
      provider: "anthropic",
      id: "claude-opus-4-5",
    });
    expect(parseModelSpec("anthropic/claude-3/opus")).toEqual({
      kind: "explicit",
      provider: "anthropic",
      id: "claude-3/opus",
    });
  });

  test("只有模型名没有 provider 视为非法（会退回 inherit，并由调用方明说）", () => {
    expect(parseModelSpec("claude-opus-4-5")).toEqual({ kind: "inherit" });
    expect(isMalformedModelSpec("claude-opus-4-5")).toBe(true);
    expect(isMalformedModelSpec("inherit")).toBe(false);
    expect(isMalformedModelSpec("anthropic/x")).toBe(false);
  });

  test("thinking：inherit 要显式传会话档位；显式档位照传", () => {
    expect(resolveThinking("inherit", "high")).toEqual({ level: "high", inheritedButUnknown: false });
    expect(resolveThinking("inherit", undefined)).toEqual({ inheritedButUnknown: true });
    expect(resolveThinking("off", "high")).toEqual({ level: "off", inheritedButUnknown: false });
  });

  test("displayModel：inherit 显示成实际模型；显式找不到时明说回退", () => {
    const session = { provider: "anthropic", id: "opus" };
    expect(describeModel(parseModelSpec("inherit"), session, false)).toBe("inherit → anthropic/opus");
    expect(describeModel(parseModelSpec("openai/gpt-5"), session, true)).toContain("档案指定");
    expect(describeModel(parseModelSpec("openai/gpt-5"), session, false)).toContain("找不到");
  });
});

describe("结果形状", () => {
  const details: SubagentDetails = {
    agent: "Explore",
    status: "completed",
    turns: 6,
    toolCalls: 11,
    durationMs: 37_200,
    usage: usageFromSessionStats({
      tokens: { input: 48_000, output: 300, cacheRead: 0, cacheWrite: 0, total: 48_300 },
      cost: 0.12,
    }),
    truncated: false,
  };

  test("摘要行按设计 §5 的格式", () => {
    expect(formatTrailer(details)).toBe(
      "[subagent] agent=Explore status=completed turns=6 tool_calls=11 duration=37.2s tokens=48.3k",
    );
    expect(formatDuration(420)).toBe("420ms");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  test("usage 折算：token 分项照抄、代价总额进 cost.total（pi 的合计要这个字段）", () => {
    expect(details.usage.cost.total).toBe(0.12);
    expect(details.usage.totalTokens).toBe(48_300);
  });

  test("content = 正文 + 提示 + 摘要行", () => {
    const content = composeResultContent({
      text: "结论在 src/a.ts",
      details,
      notes: ["[subagent] 模型回退提示"],
      truncationNote: "[subagent] 结果已截断",
      emptyText: "（空）",
    });
    expect(content).toContain("结论在 src/a.ts");
    expect(content).toContain("模型回退提示");
    expect(content).toContain("结果已截断");
    expect(content.trimEnd().endsWith(formatTrailer(details))).toBe(true);
  });

  test("没有产出时正文给明确的一句话，而不是空白", () => {
    const content = composeResultContent({ text: "  ", details });
    expect(content.startsWith("(subagent produced no text)")).toBe(true);
  });
});

describe("同类扩展冲突检测", () => {
  const own = "E:/repo/packages/pi-subagent-lite/extensions/subagent-lite.ts";

  test("本插件自己的 subagent 工具不算冲突（文件路径与内联路径都不算）", () => {
    expect(
      findForeignSubagentTools(
        [{ name: "subagent", sourceInfo: { path: own } }],
        { ownPath: own },
      ),
    ).toEqual([]);
    expect(
      findForeignSubagentTools(
        [{ name: "subagent", sourceInfo: { path: "<inline:2>" } }],
        { ownPath: own },
      ),
    ).toEqual([]);
  });

  test("别人注册的 Agent / Task，以及别人替换掉的 subagent 都算冲突", () => {
    const found = findForeignSubagentTools(
      [
        { name: "Agent", sourceInfo: { path: "C:/Users/me/.pi/agent/npm/node_modules/other-subagents/dist/index.js" } },
        { name: "Task", sourceInfo: { path: "D:/other/task-extension.ts" } },
        { name: "subagent", sourceInfo: { path: "D:/other/subagents/index.ts" } },
        { name: "read", sourceInfo: { path: "builtin:read" } },
        { name: "subagent", sourceInfo: { path: own } },
      ],
      { ownPath: own },
    );
    expect(found.map((candidate) => candidate.name)).toEqual(["Agent", "Task", "subagent"]);
    expect(describeConflicts(found)[0]).toContain("不并存");
    expect(describeConflicts(found)[0]).toContain("pi uninstall");
  });

  test("路径分隔符与大小写不影响自我识别（Windows）", () => {
    expect(
      findForeignSubagentTools([{ name: "subagent", sourceInfo: { path: own.toUpperCase() } }], {
        ownPath: own,
      }),
    ).toEqual([]);
  });
});

describe("/agents 报告", () => {
  const listing: AgentListing = {
    agents: [EXPLORE_AGENT],
    skipped: [{ path: "C:/repo/.pi/agents/broken.md", reason: "前置元数据解析失败：缺少结束的 ---" }],
    warnings: [
      "[C:/repo/.pi/agents/Explore.md] 使用了旧字段名 display_name，等价于 name；建议改成 name",
      "Explore（C:/repo/.pi/agents/Explore.md，project-pi）覆盖了 内置代理 Explore（同名整文件替换，字段不合并）",
    ],
    scannedDirs: ["C:/repo/.pi/agents"],
  };
  // 内置 Explore 已被覆盖，用一条等价档案代表"生效的那个"
  const effective = profileOf("name: Explore\ntools: read\ndisallowedTools: write\nmaxTurns: 3\n");
  const listingWithPath: AgentListing = {
    ...listing,
    agents: [{ ...effective, source: { layer: "project-pi", kind: "file", path: "C:/repo/.pi/agents/Explore.md" } }],
  };

  test("每个生效代理给模型、工具数、提示词模式与来源", () => {
    const report = formatAgentsReport({
      listing: listingWithPath,
      sessionModel: { provider: "anthropic", id: "opus" },
      canResolve: () => false,
    });
    expect(report).toContain("inherit → anthropic/opus");
    expect(report).toContain("工具 1 个：read，减 write");
    expect(report).toContain("maxTurns 3");
    expect(report).toContain("来源 C:/repo/.pi/agents/Explore.md（project-pi）");
  });

  test("被跳过的文件与原因、旧字段名警告、覆盖告警都出现", () => {
    const report = formatAgentsReport({
      listing: listingWithPath,
      sessionModel: { provider: "anthropic", id: "opus" },
      canResolve: () => false,
    });
    expect(report).toContain("跳过的档案：");
    expect(report).toContain("C:/repo/.pi/agents/broken.md：前置元数据解析失败");
    expect(report).toContain("使用了旧字段名 display_name");
    expect(report).toContain("覆盖与提示：");
    expect(report).toContain("覆盖了 内置代理 Explore");
  });

  test("冲突与扫描目录出现在报告里", () => {
    const report = formatAgentsReport({
      listing: listingWithPath,
      canResolve: () => false,
      conflicts: ["检测到另一个子代理扩展注册了工具 Agent"],
    });
    expect(report).toContain("同类扩展冲突");
    expect(report).toContain("工具 Agent");
    expect(report).toContain("扫描的目录：C:/repo/.pi/agents");
  });

  test("内置代理显示为「内置（代码）」", () => {
    const report = formatAgentsReport({
      listing: { ...listing, skipped: [], warnings: [], scannedDirs: [] },
      canResolve: () => false,
    });
    expect(report).toContain("来源 内置（代码）（builtin）");
    expect(report).toContain("扫描的目录：无（只有内置代理）");
  });
});
