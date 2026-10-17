/**
 * 索引注入的纯决策部分：什么时候注入、会话里怎么重建"已注入"标记。
 *
 * 不 import pi；会话条目只按结构化字段读，便于 S1 单测。
 */

/** 会话标记条目的 customType（`pi.appendEntry` 写入，不进模型上下文）。 */
export const INJECTED_ENTRY_TYPE = "zcode-memory/injected";

/** 注入消息的 customType（`display: false` 的 custom 消息）。 */
export const INDEX_MESSAGE_TYPE = "zcode-memory/index";

/** 重建状态时只关心这些字段。 */
export interface InjectionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

export interface InjectionDecisionInput {
  messageType: "user" | "custom";
  enabled: boolean;
  injectIndex: boolean;
  indexPresent: boolean;
  /** 当前索引格式化后的 hash。 */
  indexHash: string | undefined;
  /** 当前会话里仍存活的注入 hash。 */
  injectedHash: string | undefined;
  /** `/memory reload` 置位。 */
  force: boolean;
}

export type InjectionSkipReason =
  | "disabled"
  | "custom-run"
  | "no-index"
  | "already-injected";

export type InjectionDecision =
  | { inject: true; reason: "first" | "changed" | "reload" | "lost" }
  | { inject: false; reason: InjectionSkipReason };

export function decideInjection(input: InjectionDecisionInput): InjectionDecision {
  if (!input.enabled || !input.injectIndex) return { inject: false, reason: "disabled" };
  // `pi.sendMessage(..., { triggerTurn: true })` 起的运行不注入：那不是用户轮
  if (input.messageType === "custom") return { inject: false, reason: "custom-run" };
  if (!input.indexPresent || input.indexHash === undefined) return { inject: false, reason: "no-index" };
  if (input.force) return { inject: true, reason: "reload" };
  if (input.injectedHash === input.indexHash) return { inject: false, reason: "already-injected" };
  if (input.injectedHash === undefined) return { inject: true, reason: "first" };
  return { inject: true, reason: "changed" };
}

function hashOfMarkerData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as { indexHash?: unknown }).indexHash;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 从**当前上下文投影**的条目里重建"仍存活的注入 hash"。
 *
 * 传入的必须是 `buildSessionProjection()` 的条目（已按压缩保留尾部裁剪）：注入消息被摘要掉
 * 之后投影里就没有它了，调用方据此重新注入。标记条目与注入消息成对出现，缺一即视为丢失。
 */
export function rebuildInjectedHash(entries: readonly InjectionEntryLike[]): string | undefined {
  const messageHashes = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== INDEX_MESSAGE_TYPE) continue;
    if (entry.details === undefined) continue;
    const fromDetails = hashOfMarkerData(entry.details);
    if (fromDetails !== undefined) messageHashes.add(fromDetails);
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== INJECTED_ENTRY_TYPE) continue;
    const hash = hashOfMarkerData(entry.data);
    if (hash !== undefined && messageHashes.has(hash)) return hash;
  }
  return undefined;
}
