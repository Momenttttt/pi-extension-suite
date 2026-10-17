/**
 * 共享记忆目录的路径算法（纯函数，不 import pi）。
 *
 * 规则：
 *   - 存储根：`<home>/.zcode`，basename 已是 `cli` 就不再追加
 *   - 项目目录：`memories/projects/<slug>-<hash16>/memory`
 *   - hash 输入：工作区标识（远程/托管工作区才有），否则 `resolve(cwd)`；**仅 win32** 折叠大小写
 *   - slug：小写、非 `[a-z0-9._-]` 换 `-`、去首尾 `-`、截 48、空则 `project`
 *
 * **`platform` 是参数而不是读 `process.platform`**：路径语义（分隔符、盘符、大小写）本身就是
 * 这条算法的一部分，必须在**任何机器上**都能被单测覆盖两种语义——CI 跑在 Linux 上，
 * 如果绑运行时平台，win32 分支（也就是用户实际在用的那套）永远测不到。
 */
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

/** 记忆目录里索引文件的名字。 */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** 事实文件 frontmatter 允许的 `type`。 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryDirInput {
  /** 工作目录（会话的工作区路径）。 */
  cwd: string;
  /** CLI 存储根：`<home>/.zcode/cli`。 */
  storageRoot: string;
  /**
   * 外部工作区标识（远程/托管工作区才有）。
   * 独立 CLI 与桌面普通项目都是 undefined，此时 slug 取 basename、hash 取路径。
   */
  workspaceIdentity?: string;
  /** 用哪套路径语义。默认当前平台；只有 win32 才折叠 keySource 的大小写。 */
  platform?: NodeJS.Platform;
}

export interface ProjectDirParts {
  /** 目录名里的 slug 段（identity 存在时固定为 `project`）。 */
  slug: string;
  /** 16 个 hex 字符。 */
  hash: string;
  /** `<slug>-<hash>`。 */
  dirName: string;
}

/** 按平台挑 path 实现：win32 一套，其余走 POSIX。 */
export function pathImpl(platform: NodeJS.Platform | undefined) {
  return (platform ?? process.platform) === "win32" ? win32 : posix;
}

/** 存储根归一化：basename 已是 `cli` 就不再追加。 */
export function ensureCliStorageRoot(storageRoot: string, platform?: NodeJS.Platform): string {
  const impl = pathImpl(platform);
  return impl.basename(storageRoot) === "cli" ? storageRoot : impl.join(storageRoot, "cli");
}

/** 由 home 推导存储根：`<home>/.zcode` 再归一化。 */
export function resolveZcodeStorageRoot(homeDir: string, platform?: NodeJS.Platform): string {
  const impl = pathImpl(platform);
  return ensureCliStorageRoot(impl.join(homeDir, ".zcode"), platform);
}

/** slug 清洗：小写 → 非 `[a-z0-9._-]` 换 `-` → 去首尾 `-` → 截 48 → 空则 `project`。 */
export function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}

/** 目录名（`<slug>-<hash16>`）与它的输入。 */
export function computeProjectDirParts(input: MemoryDirInput): ProjectDirParts {
  const impl = pathImpl(input.platform);
  const identity = input.workspaceIdentity?.trim();
  const resolvedCwd = impl.resolve(input.cwd);
  const keySource =
    identity || ((input.platform ?? process.platform) === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = identity ? "project" : sanitizeProjectSlug(impl.basename(resolvedCwd) || "project");
  return { slug, hash, dirName: `${slug}-${hash}` };
}

/** `memories/projects/` 根：三级回退第 3 步扫描的目录。 */
export function projectsRootOf(storageRoot: string, platform?: NodeJS.Platform): string {
  return pathImpl(platform).join(storageRoot, "memories", "projects");
}

/** `<storageRoot>/memories/projects/<slug>-<hash>/memory`。 */
export function computeMemoryDir(input: MemoryDirInput): string {
  const parts = computeProjectDirParts(input);
  return pathImpl(input.platform).join(projectsRootOf(input.storageRoot, input.platform), parts.dirName, "memory");
}
