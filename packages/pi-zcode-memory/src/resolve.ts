/**
 * 记忆目录定位的三级回退（设计文档 §5.1）：
 *
 *   1. 配置里的 `dir`（最高优先级，任何异常场景的兜底）
 *   2. 按 ZCode 算法算出的路径**存在** → 用它
 *   3. 计算路径不存在时，`memories/projects/` 下若恰好一个 `<slug>-*` 目录 → 用它并警告
 *      都没有 → 视为"该项目尚无 ZCode 记忆"，不创建目录
 *   4. 第 3 步失败但存在 `project-*` 目录 → 提示 ZCode 可能用了 workspace identity
 *
 * 只做字符串路径判定，不做 realpath / `~` 展开——与 ZCode 的 `resolve(cwd)` 对齐。
 */
import { existsSync, readdirSync, statSync } from "node:fs";

import { homedir } from "node:os";
import { join } from "node:path";

import {
  computeMemoryDir,
  computeProjectDirParts,
  projectsRootOf,
  resolveZcodeStorageRoot,
  type MemoryDirInput,
} from "./paths.ts";

export type MemoryDirSource = "config" | "computed" | "fallback" | "none";

export interface MemoryDirResolution {
  /** 最终使用的记忆目录；`none` 时为 undefined。 */
  dir: string | undefined;
  source: MemoryDirSource;
  /** 按算法算出的目录（`memory_write` 在 `none` 时按它创建）。 */
  computedDir: string;
  /** `<storageRoot>/memories/projects`，回退扫描与提示用。 */
  projectsRoot: string;
  /** 计算路径与账户目录不一致时为什么。 */
  warnings: string[];
}

export interface ResolveMemoryDirOptions {
  cwd: string;
  /** 显式配置的目录。 */
  configDir?: string;
  /** 覆盖 home（测试用）。默认 `homedir()`。 */
  homeDir?: string;
  /** 覆盖存储根（测试用）；给了就不再由 homeDir 推导。 */
  storageRoot?: string;
  workspaceIdentity?: string;
  platform?: NodeJS.Platform;
  /** 注入文件系统判定（测试用）。默认真实 fs。 */
  pathExists?: (path: string) => boolean;
  listDirNames?: (path: string) => string[];
}

export function resolveMemoryDir(options: ResolveMemoryDirOptions): MemoryDirResolution {
  const storageRoot =
    options.storageRoot ?? resolveZcodeStorageRoot(options.homeDir ?? homedir());
  const dirInput: MemoryDirInput = {
    cwd: options.cwd,
    storageRoot,
    ...(options.workspaceIdentity === undefined ? {} : { workspaceIdentity: options.workspaceIdentity }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const parts = computeProjectDirParts(dirInput);
  const projectsRoot = projectsRootOf(storageRoot);
  const computedDir = computeMemoryDir(dirInput);
  const exists = options.pathExists ?? isDirectory;
  const listNames = options.listDirNames ?? listDirectoryNames;

  if (options.configDir !== undefined) {
    // 配置是显式覆盖：不要求目录已存在（memory_write 会创建它）。
    return { dir: options.configDir, source: "config", computedDir, projectsRoot, warnings: [] };
  }

  if (exists(computedDir)) {
    return { dir: computedDir, source: "computed", computedDir, projectsRoot, warnings: [] };
  }

  const candidates = listNames(projectsRoot).filter((name) => name.startsWith(`${parts.slug}-`));
  if (candidates.length === 1) {
    const dir = join(projectsRoot, candidates[0]!, "memory");
    return {
      dir,
      source: "fallback",
      computedDir,
      projectsRoot,
      warnings: [
        `按算法算出的记忆目录不存在：${computedDir}；已改用同 slug 的唯一候选：${dir}。` +
          `两边 hash 不同通常意味着工作区路径写法与 ZCode 不一致，建议在配置里显式指定 dir。`,
      ],
    };
  }

  const warnings: string[] = [];
  if (candidates.length > 1) {
    warnings.push(
      `按算法算出的记忆目录不存在，且 ${projectsRoot} 下有 ${candidates.length} 个以 ${parts.slug}- 开头的目录，无法判定该用哪一个。`,
    );
  } else {
    warnings.push(`该项目尚无 ZCode 记忆（按算法算出的目录不存在：${computedDir}）。`);
  }

  if (listNames(projectsRoot).some((name) => name.startsWith("project-"))) {
    warnings.push(
      "检测到 project- 前缀的记忆目录：ZCode 可能使用了 workspace identity（slug 固定为 project，hash 输入不是工作区路径）。" +
        "请在本包的配置里显式指定 dir。",
    );
  }

  return { dir: undefined, source: "none", computedDir, projectsRoot, warnings };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 该目录下是否存在 `MEMORY.md`（存在才算"有索引可注入"）。 */
export function hasMemoryIndex(dir: string): boolean {
  return existsSync(join(dir, "MEMORY.md"));
}
