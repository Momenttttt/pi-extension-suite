/**
 * `MEMORY.md` 索引行的维护。
 *
 * 索引由模型维护，我们只在 `memory_write` 时插入/更新对应的一行：
 *   `- [标题](file.md) — 一句话钩子`
 *
 * 写前比对 revision（`mtime:<截断毫秒>:size:<字节>`）；不一致就重读重试一次，再失败报错让
 * 模型重试——**不**静默覆盖别人的改动。这里不是跨进程锁，只是把"读-改-写"的窗口缩到最小；
 * 跨进程的并发靠 revision 前进被发现，下一次写读到新内容后自己继续。
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic.ts";
import { MemoryWriteError } from "./errors.ts";

export const INDEX_FILENAME = "MEMORY.md";

export interface IndexRevision {
  /** `mtime:<截断毫秒>:size:<字节>`。 */
  id: string;
  mtimeMs: number;
  sizeBytes: number;
}

export function revisionIdFromStat(stat: { mtimeMs: number; size: number }): string {
  return `mtime:${Math.trunc(stat.mtimeMs)}:size:${stat.size}`;
}

export async function revisionOf(path: string): Promise<IndexRevision | undefined> {
  try {
    const info = await stat(path);
    return { id: revisionIdFromStat(info), mtimeMs: info.mtimeMs, sizeBytes: info.size };
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

/** 两次 revision 是否一致；"之前不存在、现在也不存在"算一致。 */
export function sameRevision(left: IndexRevision | undefined, right: IndexRevision | undefined): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return left.id === right.id;
}

export interface IndexLineInput {
  /** 相对记忆目录的文件名（统一 `/`）。 */
  filename: string;
  title: string;
  description: string;
}

export interface UpsertLineResult {
  content: string;
  action: "inserted" | "updated" | "unchanged";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function indexLineOf(input: IndexLineInput): string {
  const hook = input.description.replace(/\s+/gu, " ").trim();
  const link = `- [${input.title}](${input.filename})`;
  return hook.length > 0 ? `${link} — ${hook}` : link;
}

/**
 * 插入或更新一行；已存在等价行时返回 `unchanged`（不写盘）。
 * 若同一文件已有重复行，保留第一行位置、删掉其余，顺带修掉历史重复。
 */
export function upsertMemoryIndexLine(content: string, input: IndexLineInput): UpsertLineResult {
  const line = indexLineOf(input);
  const linkPattern = new RegExp(`\\]\\(\\s*${escapeRegExp(input.filename)}\\s*\\)`, "u");
  const lines = content.length === 0 ? [] : content.split("\n");
  let replaced = false;
  let removedDuplicate = false;
  const next: string[] = [];
  for (const existing of lines) {
    if (linkPattern.test(existing)) {
      if (!replaced) {
        next.push(line);
        replaced = true;
      } else {
        removedDuplicate = true;
      }
      continue;
    }
    next.push(existing);
  }
  if (replaced) {
    const updated = next.join("\n");
    if (updated === content && !removedDuplicate) return { content, action: "unchanged" };
    return { content: ensureTrailingNewline(updated), action: "updated" };
  }
  const base = content.length === 0 ? "" : ensureTrailingNewline(content);
  return { content: `${base}${line}\n`, action: "inserted" };
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function readIndexOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) return "";
    throw new MemoryWriteError("io", `Failed to read the index: ${path} (${describe(error)})`, "Retry later.");
  }
}

export interface UpdateIndexOutcome {
  indexPath: string;
  action: "inserted" | "updated" | "unchanged";
}

export interface UpdateIndexOptions {
  /** 测试注入：替换 revision 读取，用来确定性地演练"连续两次都读到改动"的失败路径。 */
  revisionReader?: (path: string) => Promise<IndexRevision | undefined>;
}

/** 在 `<root>/MEMORY.md` 里插入/更新一行；revision 不一致时重读重试一次。 */
export async function updateMemoryIndex(
  root: string,
  input: IndexLineInput,
  options: UpdateIndexOptions = {},
): Promise<UpdateIndexOutcome> {
  const indexPath = join(root, INDEX_FILENAME);
  const readRevision = options.revisionReader ?? revisionOf;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readRevision(indexPath);
    const existing = await readIndexOrEmpty(indexPath);
    const result = upsertMemoryIndexLine(existing, input);
    if (result.action === "unchanged") {
      return { indexPath, action: "unchanged" };
    }
    const now = await readRevision(indexPath);
    if (!sameRevision(before, now)) {
      // 读之后有人改过：这次结果作废，重读一次再试
      continue;
    }
    await atomicWriteFile(indexPath, result.content).catch((error: unknown) => {
      throw new MemoryWriteError(
        "io",
        `Failed to write the index: ${indexPath} (${describe(error)})`,
        "Retry later.",
      );
    });
    return { indexPath, action: result.action };
  }
  throw new MemoryWriteError(
    "index_conflict",
    `MEMORY.md was changed by another process after you read it (${indexPath}). The index was not written this time, so someone else's changes are not overwritten.`,
    "Re-read the memory and retry this write.",
  );
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
