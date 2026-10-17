/**
 * snip（历史裁剪）的纯决策层：短 id 投影、区间解析与校验。
 *
 * 术语（GLOSSARY）：裁剪 = 由模型指认一段历史，让它在模型上下文里消失；不总结、不改写、
 * 可撤销。**不是删除历史**——原始条目仍在会话文件里；也**不是压缩**（压缩是有损总结）。
 *
 * 短 id 对齐 CC 的做法：只给**用户消息**追加 `\n[id:xxxxxx]`，只改请求副本，存储不动；
 * id 由消息的稳定属性派生（`sha256(role + ":" + timestamp)` 前 6 位 base36）。
 * 不用会话条目 id 的原因：`context` 回调里拿不到条目 id（设计 §3.2）。
 */
import { createHash } from "node:crypto";

import { isUserMessage, messageTimestampMs, type MessageLike } from "./messages.ts";

/** 会话条目与它投影出的消息组成的对（stub 类型的收窄形状，见 state/replay 的写法）。 */
export interface ProjectedItem {
  entryId: string;
  message: MessageLike;
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
      error: `找不到短 id：${missing}。可用 id（按时间顺序）：${formatAvailable(anchors)}`,
      available,
    };
  }
  if (countMatches(anchors, from) > 1 || countMatches(anchors, to) > 1) {
    return {
      ok: false,
      error: "该短 id 对应多条消息（时间戳相同），无法确定端点。请换用另一个 id。",
      available,
    };
  }
  if (fromIndex > toIndex) {
    return {
      ok: false,
      error: `区间顺序错误：from 必须早于 to。可用 id（按时间顺序）：${formatAvailable(anchors)}`,
      available,
    };
  }
  if (toIndex === anchors.length - 1) {
    return {
      ok: false,
      error: `不能裁剪当前回合：${to} 是本回合的用户消息。只能裁它之前的历史。可用 id（按时间顺序）：${formatAvailable(anchors)}`,
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
  if (anchors.length === 0) return "（无，还没有带时间戳的用户消息）";
  return anchors.map((anchor) => `${anchor.id}「${anchor.preview}」`).join("、");
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
                : "[图片]",
            )
            .join("")
        : "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed;
}
