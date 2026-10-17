/**
 * 微压缩与 snip 共用的消息结构工具（纯层，不 import pi，可在 S1 里直接测）。
 *
 * `context` 事件给的是 pi 的 `AgentMessage[]`，但 pi 包根**不导出** `Message` /
 * `AssistantMessage` 这些模型消息类型（它们来自 `@earendil-works/pi-ai`，而 pi 的
 * exports map 不暴露该入口——实测）。所以这里只声明我们真正读的字段，运行时逐项校验；
 * pi 升版给消息加字段也不会让插件崩。
 */
export interface MessageLike {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolResultMessage(message: MessageLike): boolean {
  return message.role === "toolResult";
}

export function isUserMessage(message: MessageLike): boolean {
  return message.role === "user";
}

export function isAssistantMessage(message: MessageLike): boolean {
  return message.role === "assistant";
}

/** 数字时间戳（毫秒）；缺失或非有限值时返回 undefined。 */
export function messageTimestampMs(message: MessageLike): number | undefined {
  const value = message.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return undefined;
}

/**
 * 消息正文的 UTF-8 字节数，用 JSON 序列化后的长度衡量。
 *
 * 用它而不是"文本长度"的理由：图片块的 `data` 是 base64，正是 503 字节墙的主要来源；
 * 走 JSON 能把块结构、字段名都算进去，与实际请求体积同量级。
 */
export function contentByteSize(content: unknown): number {
  if (content === undefined || content === null) return 0;
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(content), "utf8");
  } catch {
    return 0;
  }
}

/** 全部是文本块时给拼接结果；含图片等其它块时返回 undefined。 */
export function textOfContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("");
}
