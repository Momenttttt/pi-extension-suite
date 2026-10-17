/**
 * 桩 provider 收到请求后的观测量。
 *
 * harness 自带的 `bytes` 把图片块折叠成 `[image]`（它是给人读的文本视图），
 * 但"请求变小了吗"必须包含 base64 图片本体，所以这里用 JSON 序列化量原始体积。
 */
import { PLACEHOLDER_LEAD } from "../src/clear.ts";
import type { CapturedRequest } from "./test-session.ts";

interface BlockLike {
  type?: unknown;
  text?: unknown;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 请求的消息数组的 UTF-8 字节量（图片 base64 计入）。 */
export function requestBytes(request: CapturedRequest): number {
  return Buffer.byteLength(JSON.stringify(request.messages), "utf8");
}

/**
 * 两次请求共享的消息前缀长度——provider 端 prompt 缓存前缀的代理指标。
 *
 * 语义：从第 `n` 条消息开始内容不同，则前 `n` 条消息的缓存可以命中。
 */
export function commonPrefixMessages(a: CapturedRequest, b: CapturedRequest): number {
  const max = Math.min(a.messages.length, b.messages.length);
  let count = 0;
  while (count < max && JSON.stringify(a.messages[count]) === JSON.stringify(b.messages[count])) {
    count += 1;
  }
  return count;
}

/** 请求里已经被换成占位符的工具结果 toolCallId。 */
export function clearedToolCallIds(request: CapturedRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "toolResult") continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const first = content[0] as BlockLike | undefined;
      if (isRecord(first) && typeof first.text === "string") text = first.text;
    }
    if (text.startsWith(PLACEHOLDER_LEAD)) ids.push(String(message.toolCallId));
  }
  return ids;
}

export function containsPlaceholder(request: CapturedRequest): boolean {
  return request.allText.includes(PLACEHOLDER_LEAD);
}

/** 请求里是否还有图片块（base64 大块）。 */
export function imageBlockCount(request: CapturedRequest): number {
  let count = 0;
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "image") count += 1;
    }
  }
  return count;
}

/** 请求里某条工具结果消息的正文（找不到返回 undefined）。 */
export function toolResultContent(
  request: CapturedRequest,
  toolCallId: string,
): unknown {
  for (const message of request.messages) {
    if (message.role === "toolResult" && message.toolCallId === toolCallId) return message.content;
  }
  return undefined;
}

/** 请求里第一条工具结果消息的 toolCallId（脚本化的 read 都是顺序执行的）。 */
export function firstToolCallId(request: CapturedRequest): string | undefined {
  for (const message of request.messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      return message.toolCallId;
    }
  }
  return undefined;
}

/** 请求里所有用户消息的短 id（按出现顺序）。 */
export function userShortIds(request: CapturedRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((block) => {
                const text = (block as { text?: unknown }).text;
                return typeof text === "string" ? text : "";
              })
              .join("")
          : "";
    for (const match of text.matchAll(/\[id:([0-9a-z]{6})\]/g)) ids.push(match[1] ?? "");
  }
  return ids;
}
