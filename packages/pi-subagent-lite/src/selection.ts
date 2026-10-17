/**
 * 档案 → SDK 选项的折算：工具池、模型、思考档位、system prompt 模式。
 *
 * 纯层（不 import pi）：pi 的 `tools` / `excludeTools` 语义在这里被翻译成可断言的数据。
 */
import type { AgentProfile, AgentThinking } from "./profile.ts";

/** `createAgentSession` 的工具相关选项。 */
export interface ToolSelection {
  /** 白名单；`undefined` 表示不传该选项（走 SDK 默认集）。 */
  tools?: string[];
  excludeTools?: string[];
}

/** Explore 默认工具池（也是"只读"能拿到的最大集合）。 */
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;

/**
 * 档案的 `tools` / `disallowedTools` → SDK 选项。
 *
 * pi 的语义：纯名字列表 = **替换**默认集；含 `+x`/`-x` 的列表 = 在默认集上增删。档案里的
 * `tools: "*"` 折成"不传该选项"，让 SDK 用它自己的默认集（read/bash/edit/write + 扩展工具）。
 * `disallowedTools` 一律走 `excludeTools`（在 `tools` 之后生效）。
 */
export function toolSelectionFor(profile: AgentProfile): ToolSelection {
  const selection: ToolSelection = {};
  if (profile.tools !== "*") {
    selection.tools = [...profile.tools];
  }
  if (profile.disallowedTools.length > 0) {
    selection.excludeTools = [...profile.disallowedTools];
  }
  return selection;
}

/** `/agents` 里的工具集摘要（外加可数的个数；`*` 是默认集，只能给出内置默认的 4 个）。 */
export function describeTools(profile: AgentProfile): { summary: string; count: number } {
  if (profile.tools === "*") {
    const excluded =
      profile.disallowedTools.length > 0 ? `，减 ${profile.disallowedTools.join(", ")}` : "";
    return {
      summary: `默认集 read/bash/edit/write + 扩展工具${excluded}`,
      count: 4 - profile.disallowedTools.filter((name) => /^(read|bash|edit|write)$/.test(name)).length,
    };
  }
  const excluded =
    profile.disallowedTools.length > 0 ? `，减 ${profile.disallowedTools.join(", ")}` : "";
  return {
    summary: `${profile.tools.join(", ")}${excluded}`,
    count: profile.tools.filter((name) => !profile.disallowedTools.includes(name)).length,
  };
}

export type ModelSpec = { kind: "inherit" } | { kind: "explicit"; provider: string; id: string };

/**
 * 档案里的 `model` 值。
 *
 * - `inherit`（默认）= 跟随会话模型（ADR-0003）
 * - `provider/model` = 显式指定，父会话的 `ctx.modelRegistry.find(provider, id)` 解析
 */
export function parseModelSpec(value: string): ModelSpec {
  const text = value.trim();
  if (text === "" || text === "inherit") return { kind: "inherit" };
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    // 只写模型名没法定位 provider；当作没写，交给 inherit（并在告警里说清楚）
    return { kind: "inherit" };
  }
  return { kind: "explicit", provider: text.slice(0, slash), id: text.slice(slash + 1) };
}

/** 显式的 model 值是否长得像 `provider/id`（给告警用）。 */
export function isMalformedModelSpec(value: string): boolean {
  const text = value.trim();
  if (text === "" || text === "inherit") return false;
  return parseModelSpec(text).kind === "inherit";
}

export interface ThinkingResolution {
  /** 要传给 `createAgentSession` 的值；`undefined` = 不传，走 SDK/设置默认。 */
  level?: string;
  /** 档案要求跟随会话，但会话当前没有 thinking 信息。 */
  inheritedButUnknown: boolean;
}

/**
 * `thinking` → `createAgentSession` 的 `thinkingLevel`。
 *
 * `inherit` 且会话有档位就显式传（与 model 同理：不传会落到设置默认，而不是会话当前值）；
 * 会话没给（`ctx.thinkingLevel === undefined`）就不传。
 */
export function resolveThinking(
  thinking: AgentThinking,
  sessionLevel: string | undefined,
): ThinkingResolution {
  if (thinking !== "inherit") return { level: thinking, inheritedButUnknown: false };
  if (sessionLevel === undefined || sessionLevel === "") {
    return { inheritedButUnknown: true };
  }
  return { level: sessionLevel, inheritedButUnknown: false };
}

/** `/agents` 与工具结果里的模型显示。 */
export function describeModel(
  spec: ModelSpec,
  sessionModel: { provider: string; id: string } | undefined,
  resolved: boolean,
): string {
  if (spec.kind === "inherit") {
    if (sessionModel === undefined) return "inherit（会话当前没有模型）";
    return `inherit → ${sessionModel.provider}/${sessionModel.id}`;
  }
  const target = `${spec.provider}/${spec.id}`;
  return resolved ? `${target}（档案指定）` : `${target}（档案指定，但 modelRegistry 里找不到 → 回退会话模型）`;
}
