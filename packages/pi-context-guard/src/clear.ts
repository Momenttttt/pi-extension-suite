/**
 * 微压缩（microcompact）的纯决策层：可清理工具白名单、选择集、占位符替换。
 *
 * 术语（GLOSSARY）：
 *   - 微压缩 = 把**较早**的工具结果正文换成占位符的机械清理；不调用模型。
 *   - 裁剪（snip）是另一层（见 snip.ts），两者不能混用。
 *
 * 两个刻意的行为：
 *   1. **不落盘**：这里只生产"改写后的消息数组"，交给 `context` 事件的返回值；
 *      会话条目保持原文（设计 §2.2）。
 *   2. **决策只依赖输入**：选择集是"消息序列 + 冻结水位"的函数，不看当前时间——
 *      触发时机由 trigger.ts 决定，一旦决定推进水位就冻结下来，否则相邻两次请求
 *      的改写结果会抖动，让 prompt 缓存前缀每次都失效（设计 §2.5）。
 */
import { contentByteSize, isRecord, isToolResultMessage, type MessageLike } from "./messages.ts";

/**
 * 基础可清理工具，对齐 Claude Code 的 `COMPACTABLE_TOOLS`（设计 §2.4 的映射表）：
 * `FileRead, Bash, PowerShell, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite`
 * → pi 侧 `read / bash / powershell / grep / find / ls / edit / write`。
 *
 * `ls` 是 pi 独有（对齐 Glob 的位置），输出小但同样可重跑。
 */
export const BASE_CLEARABLE_TOOLS: readonly string[] = [
  "read",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
];

/** MCP 工具永不清理：非幂等/不可重跑风险高，对齐 CC 排除 MCP 的立场。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 工具编排入口永不清理：它们的输出是"如何继续"的结构化结论，重跑代价高。 */
export const NEVER_CLEARABLE_TOOLS: ReadonlySet<string> = new Set(["codemode", "tool_search"]);

/** `subagent` / `memory_read` 默认排除、可配置开启（设计 §2.4 的两条例外）。 */
export const OPTIONAL_CLEARABLE_TOOLS = ["subagent", "memory_read"] as const;

export interface ClearableToolOptions {
  /** 插件 04（subagent）的结果：默认 false——子代理报告是结论，不是原始输出。 */
  clearSubagentResults: boolean;
  /** 插件 01（memory）的结果：默认 false——记忆是长期事实，清掉后模型可能不再回看。 */
  clearMemoryResults: boolean;
}

/** 占位符开头（检测"已清理过"用的稳定前缀；文案本体见 DEFAULT_PLACEHOLDER）。 */
export const PLACEHOLDER_LEAD = "[较早的工具结果已清理";

/** 占位符文案：本项目自写，不逐字搬 CC 的 `[Old tool result content cleared]`。 */
export function defaultPlaceholder(toolName: string): string {
  return `${PLACEHOLDER_LEAD}以节省上下文：${toolName}。需要时重新执行该工具即可]`;
}

/** 该内容是否已经是本插件写的占位符（已清理过的不重复处理）。 */
export function isPlaceholderContent(content: unknown): boolean {
  if (typeof content === "string") return content.startsWith(PLACEHOLDER_LEAD);
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  return (
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.startsWith(PLACEHOLDER_LEAD)
  );
}

export function isClearableToolName(toolName: string, options: ClearableToolOptions): boolean {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return false;
  if (NEVER_CLEARABLE_TOOLS.has(toolName)) return false;
  if (BASE_CLEARABLE_TOOLS.includes(toolName)) return true;
  if (toolName === "subagent") return options.clearSubagentResults;
  if (toolName === "memory_read") return options.clearMemoryResults;
  return false;
}

/** 一个候选：白名单内、非错误、带 toolCallId 的工具结果。 */
export interface ClearCandidate {
  /** 在消息序列里的下标。 */
  index: number;
  toolCallId: string;
  toolName: string;
  /** 正文字节数。 */
  bytes: number;
  /** 内容已经是占位符（上次改写的结果或别处留下的）。 */
  alreadyCleared: boolean;
}

/** 冻结水位：清到哪里为止。`toolCallId` 是主锚点（跨消息重排稳定），条数是锚点丢失时的回落。 */
export interface ClearWatermark {
  toolCallId?: string;
  clearedCount: number;
}

export interface ClearSelectionInput {
  messages: readonly MessageLike[];
  options: ClearableToolOptions;
  /** 最近 N 个可清理结果不动（默认 5，下限 1）。 */
  keepRecent: number;
  /** 冻结水位；undefined 表示还没清过。 */
  watermark?: ClearWatermark;
  /** 本次是否推进水位（触发层已决定）。 */
  extend: boolean;
}

export interface ClearTarget {
  index: number;
  toolCallId: string;
  toolName: string;
  bytes: number;
}

export interface ClearSelection {
  /** 本次应替换的结果（含水位冻结的旧目标），按消息顺序。 */
  targets: ClearTarget[];
  /** 本次推进新选中的目标（统计只算这些，避免每次请求重复累计）。 */
  extendedTargets: ClearTarget[];
  /** 实际会省下的正文字节（只算尚未替换的）。 */
  freedBytes: number;
  /** 当前尚未清理的可清理结果数。 */
  pendingCount: number;
  /** 保留尾部之外、尚未清理的正文体积——体积档的触发依据。 */
  pendingBytesBeyondKeepRecent: number;
  /** 推进后的水位；没有可清目标时为 undefined。 */
  watermark: ClearWatermark | undefined;
  /** 本次是否真的推进了水位。 */
  extended: boolean;
}

/** 扫出所有候选（含已清理的，为了水位与统计的连续性）。 */
export function scanClearableResults(
  messages: readonly MessageLike[],
  options: ClearableToolOptions,
): ClearCandidate[] {
  const candidates: ClearCandidate[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !isToolResultMessage(message)) continue;
    if (message.isError === true) continue;
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    if (!toolName || !toolCallId) continue;
    if (!isClearableToolName(toolName, options)) continue;
    candidates.push({
      index,
      toolCallId,
      toolName,
      bytes: contentByteSize(message.content),
      alreadyCleared: isPlaceholderContent(message.content),
    });
  }
  return candidates;
}

/**
 * 选择集：`冻结段 ∪ 本次推进段`，再减去已清理过的（不重复处理）。
 *
 * | 输入 | 结论 |
 * | --- | --- |
 * | 水位锚点在候选里 | 冻结段 = 该候选及其之前 |
 * | 水位锚点丢失（裁剪/压缩/切分支） | 按水位条数回落，选前 `clearedCount` 个 |
 * | `extend = true` | 再选到"倒数第 keepRecent 个可清理结果"之前 |
 * | 候选数 ≤ keepRecent | 不推进（保留尾部就是全部） |
 */
export function selectClearableResults(input: ClearSelectionInput): ClearSelection {
  const keepRecent = Math.max(1, Math.floor(input.keepRecent));
  const candidates = scanClearableResults(input.messages, input.options);

  // 水位与推进都按"候选序列里的位置"计算；消息下标只用于改写。
  const frozenEnd = resolveFrozenEnd(candidates, input.watermark);
  const pending = candidates
    .map((candidate, position) => ({ candidate, position }))
    .filter((entry) => !entry.candidate.alreadyCleared);
  const keepStart = pending.length - keepRecent;
  const beyond = keepStart > 0 ? pending.slice(0, keepStart) : [];

  let endPosition = frozenEnd;
  if (input.extend) {
    for (const entry of beyond) endPosition = Math.max(endPosition, entry.position);
  }
  const extended = endPosition > frozenEnd;

  const targets: ClearTarget[] = [];
  const extendedTargets: ClearTarget[] = [];
  candidates.slice(0, endPosition + 1).forEach((candidate, position) => {
    if (candidate.alreadyCleared) return;
    const target = {
      index: candidate.index,
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      bytes: candidate.bytes,
    };
    targets.push(target);
    if (position > frozenEnd) extendedTargets.push(target);
  });

  const watermark =
    endPosition >= 0
      ? { toolCallId: candidates[endPosition]?.toolCallId, clearedCount: endPosition + 1 }
      : undefined;

  return {
    targets,
    extendedTargets,
    freedBytes: sumBytes(targets),
    pendingCount: pending.length,
    pendingBytesBeyondKeepRecent: sumBytes(beyond.map((entry) => entry.candidate)),
    watermark,
    extended,
  };
}

/** 冻结段末端下标：优先锚点，锚点没了按条数回落，都没有则 -1。 */
function resolveFrozenEnd(
  candidates: readonly ClearCandidate[],
  watermark: ClearWatermark | undefined,
): number {
  if (!watermark) return -1;
  if (watermark.toolCallId !== undefined) {
    const anchor = candidates.findIndex((candidate) => candidate.toolCallId === watermark.toolCallId);
    if (anchor >= 0) return anchor;
  }
  const fallback = Math.min(Math.max(0, Math.floor(watermark.clearedCount)), candidates.length);
  return fallback > 0 ? fallback - 1 : -1;
}

function sumBytes(targets: readonly { bytes: number }[]): number {
  let total = 0;
  for (const target of targets) total += target.bytes;
  return total;
}

/**
 * 把目标结果的 `content` 换成占位符文本块。
 *
 * 三件不能动的事：`isError`、`details`、其它字段一概保留（`toolCallId` / `toolName` /
 * `timestamp` 是配对与渲染的依据）；原始消息对象不改（返回新数组），会话与 pi 的投影不受影响。
 */
export function applyClearPlaceholders(
  messages: readonly MessageLike[],
  targets: readonly ClearTarget[],
  placeholder: (toolName: string) => string = defaultPlaceholder,
): { messages: MessageLike[]; changed: boolean } {
  if (targets.length === 0) return { messages: [...messages], changed: false };
  const byIndex = new Map(targets.map((target) => [target.index, target]));
  const rewritten = messages.map((message, index) => {
    const target = byIndex.get(index);
    if (!target) return message;
    return {
      ...message,
      content: [{ type: "text", text: placeholder(target.toolName) }],
    };
  });
  return { messages: rewritten, changed: true };
}
