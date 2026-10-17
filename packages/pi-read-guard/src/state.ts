/**
 * 读态表：记录"哪些路径被读过、读到什么程度、当时的时间戳"。
 *
 * 上限（LRU）是为了长会话的内存，不是语义：取 200 条 / 16 MiB。
 * 只在扩展进程内存里，不落盘。
 */
import type { ReadStateEntry } from "./gate.ts";

export interface ReadStateTableOptions {
  maxEntries?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class ReadStateTable {
  /** key → entry。Map 的插入顺序即 LRU 顺序（重设会移到末尾）。 */
  private readonly entries = new Map<string, ReadStateEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: ReadStateTableOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): ReadStateEntry | undefined {
    return this.entries.get(key);
  }

  set(entry: ReadStateEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.evict();
  }

  /** 清空整表（`session_shutdown`）。 */
  clear(): void {
    this.entries.clear();
  }

  /** 从另一个表整体替换内容（重建时用）。 */
  replaceAll(entries: Iterable<ReadStateEntry>): void {
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.key, entry);
    this.evict();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.sizeBytes;
    while (bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      bytes -= entry?.sizeBytes ?? 0;
      this.entries.delete(oldest.value);
    }
  }
}
