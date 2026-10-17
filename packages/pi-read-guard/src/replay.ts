/**
 * 从会话条目重建读态表。
 *
 * pi 的会话是树 + append-only 投影，所以"重建"有三种触发：
 *   - `session_start`（resume / fork）/ `session_tree`（切分支）：按当前分支 replay
 *   - `session_compact`：**不清空**，用 `firstKeptEntryId` 之后的保留尾部重建
 *     （落在摘要区里的读记录自然消失 → 模型必须重读，这是正确的保守行为）
 *
 * 两条硬要求：
 *
 * 1. **只信结构化字段，绝不去解析工具输出的文本。** ZCode 的
 *    `17-read-file-state-resume.md` 明确要求这一点——工具输出是给人看的，格式随时可改。
 *
 * 2. **会话文件里没有"读时的 mtime"**（本机 pi 1.3.0 会话实测：`toolResult` 只带
 *    `toolCallId` / `toolName` / `details` / `isError`）。所以路径与 `offset`/`limit`
 *    要从**同一 `toolCallId` 的助手 ToolCall**里取，而水位只能用该 toolResult 消息的
 *    `timestamp` 当估计值——与 CC 的 re-seed 同一取舍。这带来的误判方向是安全的：
 *    文件在会话挂起期间被改动、改动时间早于该消息时间戳时，会被判成"新鲜"。
 */
import { hashContent, normalizePathKey, type ReadKind, type ReadStateEntry } from "./gate.ts";

/**
 * 与 pi 的 `SessionEntry` 结构对齐的最小形状：只声明我们真正读的字段，其余一概当作未知。
 *
 * 不直接 import pi 的 `SessionEntry`：那份联合类型里 `message` 是 `AgentMessage`，而
 * `replay` 是纯函数层，不应该需要整个模型消息联合才能被测。结构化收窄就够，也不怕
 * pi 升版后给条目加字段。
 */
export interface SessionEntryLike {
  id: string;
  type: string;
  timestamp?: string;
  parentId?: string | null;
  message?: unknown;
  [key: string]: unknown;
}

/** 会话条目里我们真正读的 message 形状。 */
interface EntryMessage {
  role?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

export interface ReplayOptions {
  cwd: string;
  /**
   * 压缩后只重建这个条目之后的保留尾部。省略时处理整条分支。
   * `null` 表示自保留压缩（不保留任何前置条目），此时结果为空表。
   */
  firstKeptEntryId?: string | null;
}

/** 一次工具调用的输入，从助手 ToolCall 里取。 */
interface ToolCallInput {
  name: string;
  arguments: Record<string, unknown>;
}

/** 把助手消息里的 toolCall 收集成 `id → {name, arguments}`。 */
function collectToolCalls(entries: readonly SessionEntryLike[]): Map<string, ToolCallInput> {
  const calls = new Map<string, ToolCallInput>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = messageOf(entry);
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type !== "toolCall") continue;
      const id = typeof block.id === "string" ? block.id : undefined;
      const name = typeof block.name === "string" ? block.name : undefined;
      if (!id || !name) continue;
      calls.set(id, { name, arguments: isRecord(block.arguments) ? block.arguments : {} });
    }
  }
  return calls;
}

/**
 * 把一串条目折算成读态。
 *
 * 规则（设计 §5）：
 *   - 完整 `read`：水位用该 toolResult 消息的 `timestamp`，hash 由转录里的内容重算
 *   - 范围读：跳过（与 CC 一致：范围读不是 resume 后的合格水位）
 *   - 截断读：恢复为 `truncated`
 *   - `write`：hash 由 tool input 的 `content` 重算
 *   - `edit`：不记 hash
 *   - 结构化字段不全的条目一律跳过
 */
export function replayReadState(
  table: { replaceAll: (entries: Iterable<ReadStateEntry>) => void },
  branchEntries: readonly SessionEntryLike[],
  options: ReplayOptions,
): ReadStateEntry[] {
  const entries = sliceKeptTail(branchEntries, options.firstKeptEntryId);
  const toolCalls = collectToolCalls(entries);
  const byKey = new Map<string, ReadStateEntry>();

  for (const entry of entries) {
    const record = readStateFromEntry(entry, toolCalls, options.cwd);
    if (!record) continue;
    // 后来的条目覆盖先前的：同一路径可能读多次、写多次
    byKey.set(record.key, record);
  }

  const result = [...byKey.values()];
  table.replaceAll(result);
  return result;
}

function sliceKeptTail(
  branchEntries: readonly SessionEntryLike[],
  firstKeptEntryId: string | null | undefined,
): readonly SessionEntryLike[] {
  if (firstKeptEntryId === undefined) return branchEntries;
  if (firstKeptEntryId === null) return [];
  const position = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  // 找不到保留起点时宁可从空表开始（保守：全部要求重读），也不要把摘要区当成有效读记录
  if (position < 0) return [];
  return branchEntries.slice(position);
}

/** 一个 toolResult 条目 → 最多一条读态记录。 */
function readStateFromEntry(
  entry: SessionEntryLike,
  toolCalls: ReadonlyMap<string, ToolCallInput>,
  cwd: string,
): ReadStateEntry | undefined {
  if (entry.type !== "message") return undefined;
  const message = messageOf(entry);
  if (!message || message.role !== "toolResult") return undefined;
  if (message.isError === true) return undefined;

  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  if (!toolCallId) return undefined;
  const call = toolCalls.get(toolCallId);
  if (!call) return undefined;

  const toolName = call.name;
  if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return undefined;

  const path = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
  if (!path) return undefined;

  const readAtMs = messageTimestamp(message, entry);
  if (readAtMs === undefined) return undefined;

  const key = normalizePathKey(path, { cwd });

  if (toolName === "write") {
    const content = typeof call.arguments.content === "string" ? call.arguments.content : undefined;
    return {
      key,
      absolutePath: path,
      mtimeMs: readAtMs,
      sizeBytes: 0,
      contentHash: content === undefined ? undefined : hashContent(content),
      kind: "full",
      source: "resume",
      readAtMs,
    };
  }

  if (toolName === "edit") {
    return {
      key,
      absolutePath: path,
      mtimeMs: readAtMs,
      sizeBytes: 0,
      contentHash: undefined,
      kind: "full",
      source: "resume",
      readAtMs,
    };
  }

  const kind = classifyRead(call.arguments, message);
  if (kind === "ranged") return undefined;
  const text = textOfToolResult(message.content);
  return {
    key,
    absolutePath: path,
    mtimeMs: readAtMs,
    sizeBytes: 0,
    contentHash: kind === "full" && text !== undefined ? hashContent(text) : undefined,
    kind,
    source: "resume",
    readAtMs,
  };
}

function classifyRead(args: Record<string, unknown>, message: EntryMessage): ReadKind {
  if (isTruncated(message)) return "truncated";
  if (typeof args.offset === "number" || typeof args.limit === "number") return "ranged";
  return "full";
}

function isTruncated(message: EntryMessage): boolean {
  const details = message.details;
  if (!isRecord(details)) return false;
  const truncation = details.truncation;
  return truncation !== undefined && truncation !== null;
}

function messageTimestamp(message: EntryMessage, entry: SessionEntryLike): number | undefined {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return Math.floor(message.timestamp);
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** toolResult 的文本内容；含图片块时返回 undefined（无法用文本重算 hash）。 */
function textOfToolResult(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("");
}

function messageOf(entry: SessionEntryLike): EntryMessage | undefined {
  return isRecord(entry.message) ? (entry.message as EntryMessage) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
