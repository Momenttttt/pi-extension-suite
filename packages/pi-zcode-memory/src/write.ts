/**
 * `memory_write` 的落盘实现。
 *
 * 顺序：校验 → 原子写事实文件 → 维护索引行。索引更新失败时不回滚事实文件——事实文件本身
 * 是完整可读的，索引行下一次写入会补上；反过来（索引指了不存在的文件）更糟。
 *
 * frontmatter 只写设计 §2.2 规定的键，**不写** `originSessionId`：ZCode 只在它缺失时自己补，
 * 我们不伪造 ZCode 的会话 id；也不加自定义键（未知键行为未核实）。
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
    throw new MemoryWriteError("invalid_name", "记忆的 name 不能为空。", "给一个 kebab-case 的短名字，例如 user-api-preference。");
  }
  if (!MEMORY_NAME_PATTERN.test(slug)) {
    throw new MemoryWriteError(
      "invalid_name",
      `name「${name}」不是合法的记忆文件名：只允许字母、数字、点、下划线和短横线，且不能以点或横线开头，不能包含路径分隔符。`,
      "改用 kebab-case 的短名字，例如 user-api-preference。",
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
      "description 不能为空：它是索引行里的一句话钩子，也是 ZCode 召回时判断相关性的依据。",
      "用一句话写清这条记忆是什么。",
    );
  }
  if (!input.body.trim()) {
    throw new MemoryWriteError(
      "invalid_input",
      "body 不能为空：记忆文件要放进具体事实（正文里可直接用 [[其它记忆名]] 互链）。",
    );
  }

  // 目录按计算结果 mkdir -p（三级回退第 3 步：尚无记忆时写入才创建）
  await mkdir(input.root, { recursive: true }).catch((error: unknown) => {
    throw new MemoryWriteError("io", `创建记忆目录失败：${input.root}（${describe(error)}）`, "检查目录权限后重试。");
  });

  const absolutePath = join(input.root, filename);
  const existing = await lstatOrUndefined(absolutePath);
  if (existing?.isSymbolicLink()) {
    throw new MemoryWriteError("symlink", `拒绝写入符号链接：${absolutePath}。`, "请传入真实文件路径。");
  }
  if (input.mode === "create" && existing !== undefined) {
    throw new MemoryWriteError(
      "exists",
      `记忆 ${filename} 已存在；create 模式不覆盖已有记忆。`,
      "改用 mode: \"upsert\"，或换一个 name。",
    );
  }

  const content = renderMemoryFile({ name: slug, description, type: input.type, body: input.body });
  try {
    await atomicWriteFile(absolutePath, content);
  } catch (error) {
    if (error instanceof SymlinkWriteRefusedError) {
      throw new MemoryWriteError("symlink", error.message, "请传入真实文件路径。");
    }
    throw new MemoryWriteError("io", `写入记忆文件失败：${absolutePath}（${describe(error)}）`, "稍后重试。");
  }

  let indexAction: WriteMemoryOutcome["indexAction"];
  try {
    const index = await updateMemoryIndex(input.root, { filename, title: slug, description });
    indexAction = index.action;
  } catch (error) {
    if (error instanceof MemoryWriteError && error.code === "index_conflict") {
      throw new MemoryWriteError(
        "index_conflict",
        `记忆文件已写入（${filename}），但 MEMORY.md 同时被其它进程改动，索引行没有更新。`,
        "重新读取记忆后重试本条写入，把索引行补上。",
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
    throw new MemoryWriteError("io", `检查目标文件失败：${path}（${describe(error)}）`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
