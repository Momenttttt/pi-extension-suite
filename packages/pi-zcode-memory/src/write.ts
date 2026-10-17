/**
 * `memory_write` 的落盘实现。
 *
 * 顺序：校验 → 原子写事实文件 → 维护索引行。索引更新失败时不回滚事实文件——事实文件本身
 * 是完整可读的，索引行下一次写入会补上；反过来（索引指了不存在的文件）更糟。
 *
 * frontmatter 只写设计 §2.2 规定的键，**不写** `originSessionId`：那是读文件的一方在缺失时
 * 自己补的惰性字段，我们不伪造不属于自己的会话 id；也不加自定义键（未知键行为未核实）。
 */
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile, SymlinkWriteRefusedError } from "./atomic.ts";
import { MemoryWriteError } from "./errors.ts";
import { renderMemoryFile } from "./frontmatter.ts";
import { updateMemoryIndex } from "./index-file.ts";
import type { MemoryType } from "./paths.ts";

export type MemoryWriteMode = "create" | "upsert";

/** 文件名只允许安全字符；首字符必须是字母或数字（挡掉 `.`/`..`/隐藏文件与盘符写法）。 */
const MEMORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `name` → 事实文件名。`.` 与路径分隔符一律拒绝。 */
export function memoryFilenameFor(name: string): { filename: string; slug: string } {
  const trimmed = name.trim();
  const slug = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  if (slug.length === 0) {
    throw new MemoryWriteError(
      "invalid_name",
      "Memory name must not be empty.",
      "Use a short kebab-case name, for example user-api-preference.",
    );
  }
  if (!MEMORY_NAME_PATTERN.test(slug)) {
    throw new MemoryWriteError(
      "invalid_name",
      `name "${name}" is not a valid memory filename: only letters, digits, dots, underscores and hyphens are allowed; it cannot start with a dot or a hyphen, and it cannot contain path separators.`,
      "Use a short kebab-case name, for example user-api-preference.",
    );
  }
  return { filename: `${slug}.md`, slug };
}

export interface WriteMemoryInput {
  /** 记忆目录。 */
  root: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  mode: MemoryWriteMode;
}

export interface WriteMemoryOutcome {
  filename: string;
  absolutePath: string;
  indexPath: string;
  fileAction: "created" | "overwritten";
  indexAction: "inserted" | "updated" | "unchanged";
}

export async function writeMemory(input: WriteMemoryInput): Promise<WriteMemoryOutcome> {
  const { filename, slug } = memoryFilenameFor(input.name);
  const description = input.description.replace(/\s+/gu, " ").trim();
  if (description.length === 0) {
    throw new MemoryWriteError(
      "invalid_input",
      "description must not be empty: it is the one-line hook in the index line, and what ZCode uses to judge relevance when recalling a memory.",
      "Write one sentence saying what this memory is.",
    );
  }
  if (!input.body.trim()) {
    throw new MemoryWriteError(
      "invalid_input",
      "body must not be empty: a memory file has to carry the concrete fact (the body may link other memories with [[other-memory-name]]).",
    );
  }

  // 目录按计算结果 mkdir -p（三级回退第 3 步：尚无记忆时写入才创建）
  await mkdir(input.root, { recursive: true }).catch((error: unknown) => {
    throw new MemoryWriteError(
      "io",
      `Failed to create the memory directory: ${input.root} (${describe(error)})`,
      "Check the directory permissions and retry.",
    );
  });

  const absolutePath = join(input.root, filename);
  const existing = await lstatOrUndefined(absolutePath);
  if (existing?.isSymbolicLink()) {
    throw new MemoryWriteError(
      "symlink",
      `Refusing to write through a symbolic link: ${absolutePath}.`,
      "Pass the real file path instead.",
    );
  }
  if (input.mode === "create" && existing !== undefined) {
    throw new MemoryWriteError(
      "exists",
      `Memory ${filename} already exists; create mode does not overwrite an existing memory.`,
      'Use mode: "upsert", or choose a different name.',
    );
  }

  const content = renderMemoryFile({ name: slug, description, type: input.type, body: input.body });
  try {
    await atomicWriteFile(absolutePath, content);
  } catch (error) {
    if (error instanceof SymlinkWriteRefusedError) {
      throw new MemoryWriteError("symlink", error.message, "Pass the real file path instead.");
    }
    throw new MemoryWriteError(
      "io",
      `Failed to write the memory file: ${absolutePath} (${describe(error)})`,
      "Retry later.",
    );
  }

  let indexAction: WriteMemoryOutcome["indexAction"];
  try {
    const index = await updateMemoryIndex(input.root, { filename, title: slug, description });
    indexAction = index.action;
  } catch (error) {
    if (error instanceof MemoryWriteError && error.code === "index_conflict") {
      throw new MemoryWriteError(
        "index_conflict",
        `The memory file was written (${filename}), but MEMORY.md was changed by another process at the same time, so its index line was not updated.`,
        "Re-read the memory and retry this write so the index line gets added.",
      );
    }
    throw error;
  }

  return {
    filename,
    absolutePath,
    indexPath: join(input.root, "MEMORY.md"),
    fileAction: existing === undefined ? "created" : "overwritten",
    indexAction,
  };
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw new MemoryWriteError("io", `Failed to check the target file: ${path} (${describe(error)})`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
