/**
 * snip（历史裁剪）的纯决策层：短 id 投影、区间解析与校验。
 *
 * 术语（GLOSSARY）：裁剪 = 由模型指认一段历史，让它在模型上下文里消失；不总结、不改写、
 * 可撤销。**不是删除历史**——原始条目仍在会话文件里；也**不是压缩**（压缩是有损总结）。
 *
 * 短 id 只给**用户消息**追加 `\n[id:xxxxxx]`，而且只改请求副本，存储不动；
 * id 由消息的稳定属性派生（`sha256(role + ":" + timestamp)` 前 6 位 base36）。
 * 不用会话条目 id 的原因：`context` 回调里拿不到条目 id（设计 §3.2）。
 */
import { createHash } from "node:crypto";

import { isRecord, isUserMessage, messageTimestampMs, type MessageLike } from "./messages.ts";

/** 会话条目与它投影出的消息组成的对（stub 类型的收窄形状，见 state/replay 的写法）。 */
export interface ProjectedItem {
  entryId: string;
  message: MessageLike;
}

/**
 * 条目是否可被 pi 的 `context_edit` 编辑。
 *
 * pi 的 `appendContextEdit` 只接受 `custom_message`，以及 role ∈ {user, assistant, toolResult}
 * 的 `message` 条目；其余（`compaction`、`branch_summary`、system 消息、`custom`、`context_edit`
 * 等）一律抛 `Invalid boundary entries: Entry … does not contribute editable model content`。
 * 关键：拒绝是**整批**的——批次里混进一条不合格的，同一次 snip 的全部编辑都白做。
 *
 * 会被投影成模型内容、却不可编辑的条目正是压缩摘要（`compaction`）与 `branch_summary`，
 * 所以"区间跨过一次自动压缩"就足以让整次裁剪失败。
 */
export function isContextEditable(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.type === "custom_message") return true;
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (!isRecord(message)) return false;
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/** 一条用户消息在投影里的位置与它的短 id。 */
export interface UserAnchor {
  /** 该消息在 items 里的下标。 */
  position: number;
  entryId: string;
  id: string;
  timestamp: number;
  /** 前 40 字预览，错误提示里给模型指路。 */
  preview: string;
}

/** `sha256(role + ":" + timestamp)` 前 6 位 base36。 */
export function shortIdOf(role: string, timestamp: number): string {
  const digest = createHash("sha256").update(`${role}:${timestamp}`, "utf8").digest("hex");
  const base36 = BigInt(`0x${digest}`).toString(36);
  return base36.slice(0, 6).padStart(6, "0");
}

/** 收集所有可指认的用户消息锚点（缺 timestamp 的旧消息跳过——派生不出稳定 id）。 */
export function collectUserAnchors(items: readonly ProjectedItem[]): UserAnchor[] {
  const anchors: UserAnchor[] = [];
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position];
    if (!item || !isUserMessage(item.message)) continue;
    const timestamp = messageTimestampMs(item.message);
    if (timestamp === undefined) continue;
    anchors.push({
      position,
      entryId: item.entryId,
      id: shortIdOf("user", timestamp),
      timestamp,
      preview: previewOf(item.message),
    });
  }
  return anchors;
}

/** 给用户消息正文追加 `\n[id:xxxxxx]`；返回新内容，不改原对象。 */
export function appendShortIdToContent(content: unknown, id: string): unknown {
  const suffix = `\n[id:${id}]`;
  if (typeof content === "string") return content + suffix;
  if (!Array.isArray(content)) return content;
  const blocks = content.map((block) => ({ ...(block as Record<string, unknown>) }));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "text" && typeof block.text === "string") {
      block.text = `${block.text}${suffix}`;
      return blocks;
    }
  }
  blocks.push({ type: "text", text: suffix.trimStart() });
  return blocks;
}

export interface SnipResolution {
  ok: true;
  /** 区间覆盖的会话条目 id（去重、保持分支顺序）。 */
  targetIds: string[];
  fromIndex: number;
  toIndex: number;
  shortIds: string[];
}

export interface SnipRejection {
  ok: false;
  error: string;
  /** 当前可用的短 id，按分支顺序。 */
  available: string[];
}

/**
 * 把 `from` / `to` 两个短 id 解析成"要省略的会话条目 id 列表"。
 *
 * 校验（设计 §3.2）：
 *   - 端点必须存在，否则列出可用 id
 *   - `from` 不能晚于 `to`
 *   - 不能裁到**当前回合**：区间终点必须是本回合用户消息之前的某条用户消息
 *     （本回合 = 分支里最后一条用户消息；它之后的助手/工具条目都还没定型）
 */
export function resolveSnipTargets(
  items: readonly ProjectedItem[],
  from: string,
  to: string,
): SnipResolution | SnipRejection {
  const anchors = collectUserAnchors(items);
  const available = anchors.map((anchor) => anchor.id);
  const fromIndex = anchors.findIndex((anchor) => anchor.id === from);
  const toIndex = anchors.findIndex((anchor) => anchor.id === to);

  if (fromIndex < 0 || toIndex < 0) {
    const missing = fromIndex < 0 ? from : to;
    return {
      ok: false,
      error: `No such short id: ${missing}. Available ids (in time order): ${formatAvailable(anchors)}`,
      available,
    };
  }
  if (countMatches(anchors, from) > 1 || countMatches(anchors, to) > 1) {
    return {
      ok: false,
      error: "That short id matches more than one message (identical timestamps), so the endpoint is ambiguous. Use a different id.",
      available,
    };
  }
  if (fromIndex > toIndex) {
    return {
      ok: false,
      error: `Bad range: from must come before to. Available ids (in time order): ${formatAvailable(anchors)}`,
      available,
    };
  }
  if (toIndex === anchors.length - 1) {
    return {
      ok: false,
      error: `Cannot snip the current turn: ${to} is this turn's user message. Only earlier history can be snipped. Available ids (in time order): ${formatAvailable(anchors)}`,
      available,
    };
  }

  const startPosition = anchors[fromIndex]?.position ?? 0;
  const endPosition = anchors[toIndex]?.position ?? startPosition;
  const targetIds: string[] = [];
  for (const item of items.slice(startPosition, endPosition + 1)) {
    if (!targetIds.includes(item.entryId)) targetIds.push(item.entryId);
  }
  return {
    ok: true,
    targetIds,
    fromIndex,
    toIndex,
    shortIds: anchors.slice(fromIndex, toIndex + 1).map((anchor) => anchor.id),
  };
}

function countMatches(anchors: readonly UserAnchor[], id: string): number {
  let count = 0;
  for (const anchor of anchors) if (anchor.id === id) count += 1;
  return count;
}

function formatAvailable(anchors: readonly UserAnchor[]): string {
  if (anchors.length === 0) return "(none: no user message with a timestamp yet)";
  return anchors.map((anchor) => `${anchor.id} "${anchor.preview}"`).join(", ");
}

function previewOf(message: MessageLike): string {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
                ? String((block as { text?: unknown }).text ?? "")
                : "[image]",
            )
            .join("")
        : "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed;
}
