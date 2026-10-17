/**
 * 与 pi-read-guard 的读态互通：**发布方**的本地契约。
 *
 * 机制选择：`pi.events` 共享事件总线。理由：
 *   - 两个包都从 pi 拿到同一个总线，不需要新增配置文件契约；
 *   - 耦合只剩一个字符串 + 一份形状；发布方 `emit`、接收方 `on`，任一方缺席都不报错；
 *   - 相比"由配置声明的读态提供方"，少一层配置形状与解析规则，收益相同。
 *
 * 按 ADR-0001（四个独立包、无内部共享包）与 CODING_STANDARDS 规则 5，这里**刻意重复**
 * 声明常量与类型，不 import `pi-read-guard`。对齐点见
 * `packages/pi-read-guard/src/bridge.ts`（接收方）——改形状时两边要一起改。
 */
import { createHash } from "node:crypto";

export const READ_STATE_EVENT = "read-guard/file-read";

/** 一次"某记忆文件刚被读过"的登记。 */
export interface ReadStateEventPayload {
  /** 绝对路径：发布方与接收方可能不在同一个 cwd 下。 */
  path: string;
  /** 读时的文件 mtime（毫秒）。 */
  mtimeMs: number;
  sizeBytes: number;
  /** 完整文本内容的 sha256；截断读时**不带**。 */
  contentHash?: string;
  kind: "full" | "ranged" | "truncated";
}

export interface ReadStatePayloadInput {
  absolutePath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** 完整正文（未截断时）的 sha256；截断读或拿不到全文时不传。 */
  contentHash?: string;
  truncated: boolean;
}

/**
 * 生成发布载荷。
 *
 * 截断读一律 `kind: "truncated"` 且不带 hash——read-guard 会把它当成"读得不完整"，
 * 不允许它成为写水位（与内置 `read` 的 `details.truncation` 同一条规则）。
 */
export function buildReadStatePayload(input: ReadStatePayloadInput): ReadStateEventPayload {
  return {
    path: input.absolutePath,
    mtimeMs: input.mtimeMs,
    sizeBytes: input.sizeBytes,
    kind: input.truncated ? "truncated" : "full",
    ...(!input.truncated && input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
  };
}

/** 与 read-guard 的 `hashContent` 同构：sha256(utf8 文本原样)。 */
export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
