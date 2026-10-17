/**
 * 扫记忆目录里的"事实文件"。
 *
 * 候选与排序都是对外承诺的一部分：递归扫 `.md`、排除索引自身；不递归进目录符号链接，
 * 但指向文件的符号链接算候选；单个文件读不了只跳过它自己，不牵连其它条目；结果按 mtime
 * 倒序（最近改动的排在前面）。不设条数上限——事实文件本来就不多，`memory_list` 给的是完整列表。
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
  /** frontmatter 坏了：记成"无描述条目"，不抛错。 */
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
      // 不递归进目录符号链接；指向文件的链接在下面单独判。
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
    // 单个文件读不了不影响其它条目
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
