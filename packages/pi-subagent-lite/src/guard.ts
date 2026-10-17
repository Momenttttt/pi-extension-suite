/**
 * 子会话的守卫注入：把 pi-read-guard 的扩展路径解析出来，交给
 * `DefaultResourceLoader.additionalExtensionPaths`（实测在 `noExtensions: true` 下依然生效）。
 *
 * **两个实测出来的坑**（改这里之前先看）：
 *
 * 1. 设计文档写的是 `import.meta.resolve("@momenttttt/pi-read-guard")`。实测在 pi 的真实加载路径
 *    （jiti）下**不可用**：jiti 把模块转成 `data:` URL，`import.meta.resolve` 会抛
 *    `TypeError: ... Invalid relative URL or base scheme is not hierarchical`。这里先用
 *    `import.meta.resolve`（原生 ESM 环境下正确），抛了就退回 `createRequire(import.meta.url)
 *    .resolve(...)`（jiti 下实测可用）。
 * 2. 解析包名本身也拿不到扩展文件：本包的 pi 清单在 `package.json` 的 `pi.extensions` 里，而且
 *    package.json 没有 `main`/`exports`，所以先解析 `.../package.json`，读清单，再拼出扩展文件路径。
 *
 * 解析不到**不中断**子代理：返回空路径 + 一句可显示的原因（`/agents` 与启动告警都用它）。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARD_PACKAGE_NAME = "@momenttttt/pi-read-guard";

export interface GuardConfigLike {
  /** `undefined` = 自动解析；`[]` = 显式关闭；非空 = 显式路径。 */
  guardExtensionPaths?: string[] | undefined;
}

export interface GuardResolveDeps {
  /** 解析包内文件，返回路径或 file URL。 */
  resolveSpecifier: (specifier: string) => string;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
}

export type GuardInjectionStatus = "injected" | "disabled" | "missing" | "partial";

export interface GuardInjection {
  /** 交给 `additionalExtensionPaths` 的路径（解析失败时为空数组）。 */
  paths: string[];
  status: GuardInjectionStatus;
  /** 面向用户的一句话（不含路径前缀），`/agents` 与启动告警共用。 */
  detail: string;
}

/** 原生 ESM 下 `import.meta.resolve` 可用；jiti 下它会抛，于是退回 CJS 解析。 */
function resolveSpecifierCompat(specifier: string): string {
  const metaResolve = (import.meta as { resolve?: (value: string) => string }).resolve;
  if (typeof metaResolve === "function") {
    try {
      return metaResolve(specifier);
    } catch {
      // jiti：import.meta 是 data: URL，相对解析必然失败
    }
  }
  return createRequire(import.meta.url).resolve(specifier);
}

export function defaultGuardResolveDeps(): GuardResolveDeps {
  return {
    resolveSpecifier: resolveSpecifierCompat,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

function toPath(value: string): string {
  return value.startsWith("file:") ? fileURLToPath(value) : value;
}

/**
 * 解析要注入子会话的守卫扩展路径。
 *
 * 顺序与优先级：
 *   - 显式 `guardExtensionPaths`（含 `[]` 关闭）永远优先，绝不猜测
 *   - 否则自动解析 `GUARD_PACKAGE_NAME` 的 `pi.extensions` 清单
 *   - 任何一步失败 → 空路径 + `missing`（调用方只告警，不中断子代理）
 */
export function resolveGuardInjection(
  config: GuardConfigLike,
  deps: GuardResolveDeps = defaultGuardResolveDeps(),
): GuardInjection {
  const explicit = config.guardExtensionPaths;
  if (explicit !== undefined) {
    if (explicit.length === 0) {
      return {
        paths: [],
        status: "disabled",
        detail: "已关闭（配置 guardExtensionPaths: []）",
      };
    }
    const found = explicit.filter((path) => deps.exists(path));
    const missed = explicit.filter((path) => !deps.exists(path));
    if (found.length === 0) {
      return {
        paths: [],
        status: "missing",
        detail: `未注入：配置指定的路径都不存在（${missed.join("、")}）`,
      };
    }
    if (missed.length > 0) {
      return {
        paths: found,
        status: "partial",
        detail: `部分注入：${found.join("、")}；未找到 ${missed.join("、")}`,
      };
    }
    return { paths: found, status: "injected", detail: `已注入（配置指定：${found.join("、")}）` };
  }

  try {
    const packageJsonPath = toPath(deps.resolveSpecifier(`${GUARD_PACKAGE_NAME}/package.json`));
    const manifest = JSON.parse(deps.readFile(packageJsonPath)) as {
      pi?: { extensions?: unknown };
    };
    const entries = Array.isArray(manifest.pi?.extensions)
      ? manifest.pi.extensions.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (entries.length === 0) {
      return {
        paths: [],
        status: "missing",
        detail: `未注入：${GUARD_PACKAGE_NAME} 的 package.json 里没有 pi.extensions 条目`,
      };
    }
    const base = dirname(packageJsonPath);
    const resolved = entries
      .map((entry) => (isAbsolute(entry) ? entry : resolve(base, entry)))
      .filter((path) => deps.exists(path));
    if (resolved.length === 0) {
      return {
        paths: [],
        status: "missing",
        detail: `未注入：${GUARD_PACKAGE_NAME} 的 pi.extensions 指向的扩展文件不存在`,
      };
    }
    return {
      paths: resolved,
      status: "injected",
      detail: `已注入（自动解析 ${GUARD_PACKAGE_NAME}：${resolved.join("、")}）`,
    };
  } catch (error) {
    return {
      paths: [],
      status: "missing",
      detail: `未注入：自动解析 ${GUARD_PACKAGE_NAME} 失败（${
        error instanceof Error ? error.message : String(error)
      }）`,
    };
  }
}

/** 需要用户知道的一行（`/agents` 与启动告警共用）。 */
export function describeGuardInjection(injection: GuardInjection): string {
  return `读守卫注入：${injection.detail}`;
}

/** 解析失败/部分成功时该不该鸣笛。 */
export function guardNeedsWarning(injection: GuardInjection): boolean {
  return injection.status === "missing" || injection.status === "partial";
}
