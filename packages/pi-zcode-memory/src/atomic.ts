/**
 * 原子写：同目录临时文件（`O_EXCL`）→ 写入 → fsync → rename；不跟随符号链接。
 *
 * 失败就报错让模型重试，不做"open 失败就改用 `O_TRUNC` 直写目标"的降级：那一步会破坏原子性，
 * 留下一个只写了一半的文件。
 */
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export class SymlinkWriteRefusedError extends Error {
  constructor(path: string) {
    super(`Refusing to write through a symbolic link: ${path}. Pass the real target path instead.`);
    this.name = "SymlinkWriteRefusedError";
  }
}

/** 临时文件名：同目录才能保证 rename 是原子的；`.tmp.<pid>.<random>` 避免并发撞名。 */
function tempPathFor(path: string): string {
  return join(dirname(path), `.${basenameOf(path)}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
}

function basenameOf(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? path : path.slice(separator + 1);
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  let existingMode: number | undefined;
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink()) throw new SymlinkWriteRefusedError(path);
    existingMode = target.mode;
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }

  const tempPath = tempPathFor(path);
  const buffer = Buffer.from(content, "utf8");
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW);
    try {
      await handle.writeFile(buffer);
      if (existingMode !== undefined) {
        // 原子写会用临时文件的 inode 覆盖目标；先复制原权限，避免抹掉执行位
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
