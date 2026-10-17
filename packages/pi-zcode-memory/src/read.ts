/**
 * `memory_read` 的定位与读取。
 *
 * - 定位：按 frontmatter `name`、或按文件名（相对记忆目录，支持子目录）精确匹配；
 *   多处命中时报错而不是猜一个。
 * - 正文上限：先取前 200 行，再按 4096 字节截断到完整行的边界；任一超限都算截断。
 *   这两个数就是一条记忆在会话里实际可用的量——读到上限的内容不该被当成全文。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { hashMemoryContent } from "./bridge.ts";
import { normalizeMemoryText, parseMemoryDocument, type MemoryFrontmatter } from "./frontmatter.ts";
import { listMemoryFiles } from "./list.ts";

export const MEMORY_BODY_LINE_LIMIT = 200;
export const MEMORY_BODY_BYTE_LIMIT = 4096;

export interface LocatedMemory {
  /** 相对记忆目录的路径，统一 `/` 分隔。 */
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  /** sha256(磁盘上的原始 utf8 文本)，与 read-guard 的 `hashContent` 同构。 */
  contentHash: string;
  frontmatter: MemoryFrontmatter;
  body: string;
}

export interface LocateError {
  code: "not_found" | "ambiguous" | "outside_root" | "unreadable";
  message: string;
}

export type LocateResult = { ok: true; value: LocatedMemory } | { ok: false; error: LocateError };

/** 把引用折成记忆目录内的绝对路径；越界返回 undefined。 */
export function resolveUnderRoot(root: string, reference: string): string | undefined {
  const cleaned = reference.trim().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
  if (cleaned.length === 0) return undefined;
  if (cleaned.startsWith("/") || /^[A-Za-z]:/u.test(cleaned)) return undefined;
  const absolute = resolve(root, cleaned);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return absolute;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function locateMemory(root: string, reference: string): LocateResult {
  const ref = reference.trim().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
  if (ref.length === 0) {
    return { ok: false, error: { code: "not_found", message: "The reference is empty: pass the memory's name or filename." } };
  }

  // 1) 直接当相对路径试：`foo.md`、`sub/foo.md`，以及（允许的）MEMORY.md
  const direct = resolveUnderRoot(root, ref);
  if (direct !== undefined && isFile(direct)) {
    const located = readLocated(root, direct);
    if (located.ok) return located;
  }
  // 2) 没有 `.md` 后缀时补一次
  if (!ref.endsWith(".md")) {
    const withSuffix = resolveUnderRoot(root, `${ref}.md`);
    if (withSuffix !== undefined && isFile(withSuffix)) {
      const located = readLocated(root, withSuffix);
      if (located.ok) return located;
    }
  }

  // 3) 扫目录按 name / 文件名匹配
  const matches = new Map<string, string>();
  for (const entry of listMemoryFiles(root)) {
    const withoutExtension = entry.filename.replace(/\.md$/iu, "");
    const filenameBase = basename(withoutExtension);
    if (entry.name === ref || entry.filename === ref || withoutExtension === ref || filenameBase === ref) {
      matches.set(entry.filename, entry.filename);
    }
  }
  if (matches.size === 1) {
    const filename = [...matches.keys()][0]!;
    const absolute = resolve(root, filename);
    const located = readLocated(root, absolute);
    if (located.ok) return located;
  }
  if (matches.size > 1) {
    return {
      ok: false,
      error: {
        code: "ambiguous",
        message: `"${reference}" matches more than one memory; pass the filename instead: ${[...matches.keys()].join(", ")}`,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "not_found",
      message: `No memory "${reference}" in the memory directory. Use memory_list first to see which memories exist.`,
    },
  };
}

function readLocated(root: string, absolutePath: string): LocateResult {
  let stat;
  let content: string;
  try {
    stat = statSync(absolutePath);
    content = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unreadable",
        message: `Read failed: ${absolutePath} (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
  const normalized = normalizeMemoryText(content);
  const document = parseMemoryDocument(normalized);
  return {
    ok: true,
    value: {
      filename: relative(root, absolutePath).split("\\").join("/"),
      absolutePath,
      sizeBytes: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      contentHash: hashMemoryContent(content),
      frontmatter: document.frontmatter,
      body: document.body,
    },
  };
}

export interface TruncatedBody {
  text: string;
  truncated: boolean;
  /** 截断原因，用于提示文案；未截断时 undefined。 */
  reason?: "lines" | "bytes" | "both";
}

export function truncateMemoryBody(body: string): TruncatedBody {
  const lines = body === "" ? [""] : body.split("\n");
  const lineTruncated = lines.length > MEMORY_BODY_LINE_LIMIT;
  const lineLimited = lineTruncated ? lines.slice(0, MEMORY_BODY_LINE_LIMIT).join("\n") : body;

  const selected: string[] = [];
  let selectedBytes = 0;
  let byteTruncated = false;
  for (const line of lineLimited.split("\n")) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const nextBytes = selectedBytes + separatorBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > MEMORY_BODY_BYTE_LIMIT) {
      byteTruncated = true;
      break;
    }
    selected.push(line);
    selectedBytes = nextBytes;
  }

  const reason: TruncatedBody["reason"] =
    lineTruncated && byteTruncated ? "both" : lineTruncated ? "lines" : byteTruncated ? "bytes" : undefined;
  return {
    text: selected.join("\n"),
    truncated: lineTruncated || byteTruncated,
    ...(reason === undefined ? {} : { reason }),
  };
}
