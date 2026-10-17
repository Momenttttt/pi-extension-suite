/**
 * ZCode 记忆目录的路径算法（纯函数，不 import pi）。
 *
 * 逐条复刻 ZCode：
 *   - `apps/zcode-cli/packages/bootstrap/src/app/paths.ts` 的 `getCliStorageRoot`
 *   - `apps/zcode-cli/packages/core/src/memory/project-root.ts` 的 `resolveProjectMemoryRoot`
 *
 * 与 ZCode 的差异只有一处：`platform` 是参数而不是读 `process.platform`，这样 S1 单测能在
 * 非 win32 的机器上验证大小写折叠分支。
 */
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

/** 记忆目录里索引文件的名字。 */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** 事实文件 frontmatter 允许的 `type`。对齐 ZCode `MEMORY_RECALL_TYPES`。 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryDirInput {
  /** 工作目录；ZCode 侧传的是会话的工作区路径。 */
  cwd: string;
  /** CLI 存储根：`<home>/.zcode/cli`。 */
  storageRoot: string;
  /**
   * ZCode 的外部工作区标识（远程/托管工作区才有）。
   * 独立 CLI 与桌面普通项目都是 undefined，此时 slug 取 basename、hash 取路径。
   */
  workspaceIdentity?: string;
  /** 默认 `process.platform`；只有 win32 才折叠 keySource 的大小写。 */
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

/** `getCliStorageRoot`：basename 已是 `cli` 就不追加。 */
export function ensureCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

/** `expand("~/.zcode")` 之后再走 `getCliStorageRoot`。 */
export function resolveZcodeStorageRoot(homeDir: string): string {
  return ensureCliStorageRoot(join(homeDir, ".zcode"));
}

/** ZCode 的 slug 清洗：小写 → 非 `[a-z0-9._-]` 换 `-` → 去首尾 `-` → 截 48 → 空则 `project`。 */
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
  const identity = input.workspaceIdentity?.trim();
  const resolvedCwd = resolve(input.cwd);
  const keySource =
    identity || ((input.platform ?? process.platform) === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = identity ? "project" : sanitizeProjectSlug(basename(resolvedCwd) || "project");
  return { slug, hash, dirName: `${slug}-${hash}` };
}

/** `memories/projects/` 根：三级回退第 3 步扫描的目录。 */
export function projectsRootOf(storageRoot: string): string {
  return join(storageRoot, "memories", "projects");
}

/** `<storageRoot>/memories/projects/<slug>-<hash>/memory`。 */
export function computeMemoryDir(input: MemoryDirInput): string {
  const parts = computeProjectDirParts(input);
  return join(projectsRootOf(input.storageRoot), parts.dirName, "memory");
}
