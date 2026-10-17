/**
 * 扫记忆目录里的"事实文件"（对齐 ZCode `memory/recall/manifest.ts` 的 `scanMemoryManifest`）。
 *
 * 与 ZCode 的差异：manifest 用在模型召回里、上限 200 条；`memory_list` 是给人/模型看的工具，
 * 不设条数上限（一个项目的记忆文件本来就不多），但保持同样的候选判定与排序。
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { MEMORY_INDEX_FILENAME, type MemoryType } from "./paths.ts";
import { parseMemoryFrontmatter } from "./frontmatter.ts";

export interface MemoryListEntry {
  /** 相对记忆目录的路径，统一 `/` 分隔。 */
  filename: string;
  name?: string;
  description?: string;
  type?: MemoryType;
  mtimeMs: number;
  /** frontmatter 坏了（ZCode manifest 规则：记成"无描述条目"）。 */
  malformed: boolean;
}

/** 单个事实文件最多读这么多字节来解析 frontmatter；防止误把大文件整份读进来。 */
const FRONTMATTER_READ_BYTES = 64 * 1024;

export function listMemoryFiles(root: string): MemoryListEntry[] {
  const entries: MemoryListEntry[] = [];
  collect(root, root, entries);
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function collect(root: string, directory: string, out: MemoryListEntry[]): void {
  let dirents;
  try {
    dirents = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const path = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      // 不跟随目录符号链接：ZCode 的 listDirectory 把 symlink 单独归类，只有指向文件的才算候选。
      if (!dirent.isSymbolicLink()) collect(root, path, out);
      continue;
    }
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      try {
        isFile = statSync(path).isFile();
      } catch {
        // 失效链接与"读不了的事实文件"一样，跳过即可
        isFile = false;
      }
    }
    if (!isFile) continue;
    if (!isMemoryCandidate(dirent.name)) continue;
    const entry = readEntry(root, path);
    if (entry) out.push(entry);
  }
}

function isMemoryCandidate(filename: string): boolean {
  return filename.endsWith(".md") && basename(filename) !== MEMORY_INDEX_FILENAME;
}

function readEntry(root: string, path: string): MemoryListEntry | undefined {
  let stat;
  let head: string;
  try {
    stat = statSync(path);
    head = readHead(path);
  } catch {
    // 单个文件读不了不影响其它条目（对齐 ZCode 的 Promise.allSettled 语义）
    return undefined;
  }
  const frontmatter = parseMemoryFrontmatter(head);
  const filename = relative(root, path).split(sep).join("/");
  return {
    filename,
    mtimeMs: Math.trunc(stat.mtimeMs),
    malformed: frontmatter.malformed,
    ...(frontmatter.name === undefined ? {} : { name: frontmatter.name }),
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    ...(frontmatter.type === undefined ? {} : { type: frontmatter.type }),
  };
}

/** 只读文件头这么多字节：frontmatter 只需前 30 行。 */
function readHead(path: string): string {
  const buffer = Buffer.allocUnsafe(FRONTMATTER_READ_BYTES);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
