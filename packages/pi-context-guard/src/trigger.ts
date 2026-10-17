/**
 * 触发层（纯函数）：决定"这次请求要不要推进清理水位、以哪一档的理由"。
 *
 * 关键约束（设计 §2.5）：**触发判断可以看时间，选择集不行**。这里只输出一个
 * `extend` 布尔与理由；真正冻结水位、让相邻请求拿到同一清理集合的活由扩展层做。
 *
 * 两档（设计 §2.3）：
 *   - 空闲档：距上一条 assistant 消息 ≥ gapThresholdMinutes（默认 60）——服务端
 *     prompt 缓存 TTL 是 1 小时，空闲到此本来就冷，此时改前缀代价最低。默认开。
 *   - 体积档：保留尾部之外的可清理正文 > maxClearableBytes（默认 256 KiB）。
 *     手动 `/ctx prune` 走它；`autoVolumeTrigger: true` 才自动。
 */
import type { ClearSelection } from "./clear.ts";
import { isAssistantMessage, messageTimestampMs, type MessageLike } from "./messages.ts";

export type ClearTriggerMode = "none" | "idle" | "volume" | "relief";

export interface ClearTriggerInput {
  /** 上一次选择集（`extend: false` 时算出来的统计）。 */
  selection: ClearSelection;
  messages: readonly MessageLike[];
  keepRecent: number;
  maxClearableBytes: number;
  gapThresholdMinutes: number;
  now: number;
  /** 体积档是否自动。 */
  autoVolumeTrigger: boolean;
  /** 压缩连续失败后的降压力：下一次请求强制按体积档清一次。 */
  pressureRelief: boolean;
}

export interface ClearTriggerDecision {
  mode: ClearTriggerMode;
  extend: boolean;
  /** 给 `/ctx` 与诊断看的一句话理由。 */
  reason: string;
  /** 距上一条 assistant 消息的空闲分钟数；没有 assistant 消息时为 null。 */
  idleMinutes: number | null;
  idleQualified: boolean;
  volumeQualified: boolean;
}

/** 距最后一条 assistant 消息的空闲毫秒数；没有 assistant 消息时 undefined。 */
export function idleMsSinceLastAssistant(
  messages: readonly MessageLike[],
  now: number,
): number | undefined {
  let last: number | undefined;
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    const timestamp = messageTimestampMs(message);
    if (timestamp === undefined) continue;
    if (last === undefined || timestamp > last) last = timestamp;
  }
  if (last === undefined) return undefined;
  return Math.max(0, now - last);
}

export function decideClearTrigger(input: ClearTriggerInput): ClearTriggerDecision {
  const keepRecent = Math.max(1, Math.floor(input.keepRecent));
  const pendingCount = input.selection.pendingCount;
  const enoughResults = pendingCount > keepRecent;

  const idleMs = idleMsSinceLastAssistant(input.messages, input.now);
  const idleMinutes = idleMs === undefined ? null : idleMs / 60_000;
  const idleQualified = enoughResults && idleMinutes !== null && idleMinutes >= input.gapThresholdMinutes;

  const volumeQualified = enoughResults && input.selection.pendingBytesBeyondKeepRecent > input.maxClearableBytes;

  if (input.pressureRelief && enoughResults) {
    return decision("relief", true, "压缩连续失败后的降压力清理", idleMinutes, idleQualified, volumeQualified);
  }
  if (input.autoVolumeTrigger && volumeQualified) {
    return decision("volume", true, "体积超过 maxClearableBytes", idleMinutes, idleQualified, volumeQualified);
  }
  if (idleQualified) {
    return decision("idle", true, `空闲 ${Math.floor(idleMinutes)} 分钟`, idleMinutes, idleQualified, volumeQualified);
  }
  return decision("none", false, "", idleMinutes, idleQualified, volumeQualified);
}

function decision(
  mode: ClearTriggerMode,
  extend: boolean,
  reason: string,
  idleMinutes: number | null,
  idleQualified: boolean,
  volumeQualified: boolean,
): ClearTriggerDecision {
  return { mode, extend, reason, idleMinutes, idleQualified, volumeQualified };
}
