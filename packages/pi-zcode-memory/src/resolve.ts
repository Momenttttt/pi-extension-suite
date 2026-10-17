/**
 * 记忆目录定位的三级回退（设计文档 §5.1）：
 *
 *   1. 配置里的 `dir`（最高优先级，任何异常场景的兜底）
 *   2. 按路径算法算出的目录**存在** → 用它
 *   3. 计算路径不存在时，`memories/projects/` 下若恰好一个 `<slug>-*` 目录 → 用它并警告
 *      都没有 → 视为"该项目尚无记忆"，不创建目录
 *   4. 第 3 步失败但存在 `project-*` 目录 → 提示目录可能是按 workspace identity 建的
 *      （slug 固定为 `project`，hash 输入不是工作区路径）
 *
 * 只做字符串路径判定，不做 realpath / `~` 展开：hash 的输入就是 `resolve(cwd)` 这个字符串，
 * realpath 会把符号链接、短路径折成另一种写法，算出来的目录反而对不上。
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
    options.storageRoot ?? resolveZcodeStorageRoot(options.homeDir ?? homedir(), options.platform);
  const dirInput: MemoryDirInput = {
    cwd: options.cwd,
    storageRoot,
    ...(options.workspaceIdentity === undefined ? {} : { workspaceIdentity: options.workspaceIdentity }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const parts = computeProjectDirParts(dirInput);
  const projectsRoot = projectsRootOf(storageRoot, options.platform);
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
        `The computed memory directory does not exist: ${computedDir}; using the only candidate with the same slug instead: ${dir}. ` +
          `Different hashes on the two sides usually mean the workspace path is written differently from the one the memory directory was computed from; set dir explicitly in the config.`,
      ],
    };
  }

  const warnings: string[] = [];
  if (candidates.length > 1) {
    warnings.push(
      `The computed memory directory does not exist, and ${projectsRoot} holds ${candidates.length} directories starting with ${parts.slug}-, so there is no way to tell which one to use.`,
    );
  } else {
    warnings.push(`This project has no ZCode memory yet (the computed directory does not exist: ${computedDir}).`);
  }

  if (listNames(projectsRoot).some((name) => name.startsWith("project-"))) {
    warnings.push(
      "Found memory directories with the project- prefix: a workspace identity may be in use (slug fixed to project, hash input not the workspace path). " +
        "Set dir explicitly in this package's config.",
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
