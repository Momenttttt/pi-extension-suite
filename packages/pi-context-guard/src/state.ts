/**
 * 插件状态：清理水位、累计统计、snip 待提交队列、压缩失败计数。
 *
 * 两类状态的归宿不同：
 *   - **水位与统计**用 `pi.appendEntry("ctx-guard/clear-watermark", ...)` 持久化，
 *     进的是会话条目但不进模型上下文；resume / 切分支时从当前分支重建。
 *   - **待提交队列**用 `pi.appendEntry("ctx-guard/pending-snip", ...)` 持久化；
 *     真正的 `context_edit` 只能由边界处理器（`turn_end` / `agent_before_settle`）提交，
 *     工具自己写不了条目（设计 §3.2）。
 *
 * 本文件是纯层：不 import pi；条目只按结构字段读，形状不认识就跳过。
 */
import type { ClearSelection, ClearWatermark } from "./clear.ts";
import { isRecord } from "./messages.ts";

export const WATERMARK_ENTRY = "ctx-guard/clear-watermark";
export const PENDING_SNIP_ENTRY = "ctx-guard/pending-snip";
export const PENDING_UNSNIP_ENTRY = "ctx-guard/pending-unsnip";
export const SNIP_APPLIED_ENTRY = "ctx-guard/snip-applied";
export const UNSNIP_APPLIED_ENTRY = "ctx-guard/unsnip-applied";

/** 水位条目的载荷（诊断字段与人读无关紧要的部分都记下来）。 */
export interface ClearWatermarkData {
  toolCallId?: string;
  /** 水位处覆盖的候选条数（锚点丢失时的回落依据）。 */
  coveredCount: number;
  /** 本会话累计清理条数（每条只计一次）。 */
  totalCount: number;
  /** 本会话累计省下的正文字节。 */
  totalBytes: number;
  /** 最近一次推进水位的档位。 */
  mode: string;
  at: number;
}

export interface PendingSnipData {
  targetIds: string[];
  shortIds: string[];
  reason?: string;
  at: number;
}

export interface SnipAuditData {
  count: number;
  targetIds: string[];
  shortIds: string[];
  reason?: string;
  at: number;
}

export type PendingKind = "snip" | "restore";

export interface PendingOp {
  entryId: string;
  kind: PendingKind;
  shortId?: string;
}

/** 提交时返回给扩展层的一组草稿素材。 */
export interface DrainedOps {
  snips: PendingOp[];
  restores: PendingOp[];
}

export class ContextGuardState {
  /** 冻结的清理水位；undefined = 本分支还没清过（或压缩后已重置）。 */
  watermark: ClearWatermark | undefined;
  totalCount = 0;
  totalBytes = 0;
  lastMode = "";
  /** 连续压缩失败次数（`session_compact` 成功即清零）。 */
  failures = 0;
  /** 压缩失败后要求"下一次请求先降压力清一次"。 */
  reliefPending = false;
  private watermarkDirty = false;
  private readonly pending = new Map<string, PendingOp>();
  /** 已提交的裁剪：条目 id → 短 id（供 `/ctx` 与撤销用）。 */
  private readonly activeSnips = new Map<string, string>();

  /** 推进水位并累计统计（只算本次新选中的目标）。 */
  promoteWatermark(selection: ClearSelection, mode: string): void {
    if (!selection.extended || !selection.watermark) return;
    this.watermark = selection.watermark;
    this.totalCount += selection.extendedTargets.length;
    for (const target of selection.extendedTargets) this.totalBytes += target.bytes;
    this.lastMode = mode;
    this.watermarkDirty = true;
  }

  consumeWatermarkDirty(): boolean {
    const dirty = this.watermarkDirty;
    this.watermarkDirty = false;
    return dirty;
  }

  watermarkData(now: number): ClearWatermarkData {
    return {
      ...(this.watermark?.toolCallId === undefined ? {} : { toolCallId: this.watermark.toolCallId }),
      coveredCount: this.watermark?.clearedCount ?? 0,
      totalCount: this.totalCount,
      totalBytes: this.totalBytes,
      mode: this.lastMode,
      at: now,
    };
  }

  queueSnip(entryId: string, shortId: string | undefined, kind: PendingKind = "snip"): void {
    this.pending.set(entryId, {
      entryId,
      kind,
      ...(shortId === undefined ? {} : { shortId }),
    });
  }

  pendingOps(): PendingOp[] {
    return [...this.pending.values()];
  }

  /** 取走待提交队列并更新"已裁剪"视图。 */
  drain(now: number): DrainedOps {
    const ops = [...this.pending.values()];
    this.pending.clear();
    const snips: PendingOp[] = [];
    const restores: PendingOp[] = [];
    for (const op of ops) {
      if (op.kind === "snip") {
        this.activeSnips.set(op.entryId, op.shortId ?? "");
        snips.push(op);
      } else {
        this.activeSnips.delete(op.entryId);
        restores.push(op);
      }
    }
    if (ops.length > 0) this.lastCommitAt = now;
    return { snips, restores };
  }

  lastCommitAt: number | undefined;

  activeSnipTargets(): string[] {
    return [...this.activeSnips.keys()];
  }

  activeSnipCount(): number {
    return this.activeSnips.size;
  }

  /** 压缩成功后：水位重置（投影换了一套），统计与队列保留。 */
  onCompaction(): void {
    this.watermark = undefined;
    this.watermarkDirty = false;
    this.reliefPending = false;
    this.failures = 0;
    this.lastMode = "";
  }

  recordFailure(): void {
    this.failures += 1;
    this.reliefPending = true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.reliefPending = false;
  }

  reset(): void {
    this.watermark = undefined;
    this.totalCount = 0;
    this.totalBytes = 0;
    this.lastMode = "";
    this.failures = 0;
    this.reliefPending = false;
    this.watermarkDirty = false;
    this.lastCommitAt = undefined;
    this.pending.clear();
    this.activeSnips.clear();
  }

  /**
   * 从当前分支重建：按条目顺序重放本插件的 custom 条目。
   *
   * 重放规则（resume / 切分支 / 重载都走这里）：
   *   - `pending-snip` → 入队；`snip-applied` → 出队并记入"已裁剪"
   *   - `pending-unsnip` → 入队恢复；`unsnip-applied` → 出队并移出"已裁剪"
   *   - `clear-watermark` → 后者胜出（append-only 分支里最新的那条就是当前水位）
   */
  hydrate(branchEntries: readonly unknown[]): void {
    this.watermark = undefined;
    this.totalCount = 0;
    this.totalBytes = 0;
    this.lastMode = "";
    this.watermarkDirty = false;
    this.pending.clear();
    this.activeSnips.clear();

    for (const entry of branchEntries) {
      if (!isRecord(entry) || entry.type !== "custom") continue;
      const customType = entry.customType;
      const data = entry.data;
      if (customType === WATERMARK_ENTRY && isRecord(data)) {
        const coveredCount = numberOr(data.coveredCount, 0);
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
        // coveredCount 为 0 且没有锚点 => 水位本来就没推进过
        this.watermark = coveredCount > 0 || toolCallId !== undefined
          ? { ...(toolCallId === undefined ? {} : { toolCallId }), clearedCount: coveredCount }
          : undefined;
        this.totalCount = numberOr(data.totalCount, 0);
        this.totalBytes = numberOr(data.totalBytes, 0);
        this.lastMode = typeof data.mode === "string" ? data.mode : "";
      } else if (customType === PENDING_SNIP_ENTRY && isRecord(data)) {
        for (const targetId of stringArray(data.targetIds)) {
          this.pending.set(targetId, { entryId: targetId, kind: "snip" });
        }
      } else if (customType === PENDING_UNSNIP_ENTRY && isRecord(data)) {
        for (const targetId of stringArray(data.targetIds)) {
          this.pending.set(targetId, { entryId: targetId, kind: "restore" });
        }
      } else if (customType === SNIP_APPLIED_ENTRY && isRecord(data)) {
        const shortIds = stringArray(data.shortIds);
        stringArray(data.targetIds).forEach((targetId, index) => {
          this.pending.delete(targetId);
          this.activeSnips.set(targetId, shortIds[index] ?? "");
        });
      } else if (customType === UNSNIP_APPLIED_ENTRY && isRecord(data)) {
        for (const targetId of stringArray(data.targetIds)) {
          this.pending.delete(targetId);
          this.activeSnips.delete(targetId);
        }
      }
    }
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 是否该就连续压缩失败明确告警。
 *
 * 对齐 CC 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`：达到 3 次起告警，
 * 之后每 3 次再提醒一次（避免每轮刷屏）。这里只管阈值判断，告警文案在扩展层。
 */
export function shouldWarnCompactionFailures(failures: number): boolean {
  return failures >= 3 && failures % 3 === 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
