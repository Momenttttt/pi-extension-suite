/**
 * S1：守卫注入路径的解析（显式配置、自动解析、失败降级）。
 *
 * 真实加载路径（jiti）下 `import.meta.resolve` 会抛，所以 `src/guard.ts` 里做了兼容；
 * 这里的默认依赖用例顺便验证"在本仓库里真的能解析到 pi-read-guard"。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  defaultGuardResolveDeps,
  describeGuardInjection,
  guardNeedsWarning,
  resolveGuardInjection,
  type GuardResolveDeps,
} from "../src/guard.ts";

const workspaces: Array<() => void> = [];

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-guard-"));
  workspaces.push(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

afterEach(() => {
  for (const cleanup of workspaces.splice(0)) cleanup();
});

/** 造一个"装好的守卫包"：`package.json` 的 pi.extensions 指向扩展文件。 */
function fakeGuardPackage(options: { entry?: string; writeEntry?: boolean } = {}): {
  packageJsonPath: string;
  extensionPath: string | undefined;
} {
  const root = workspace();
  const pkgDir = join(root, "node_modules", "@momenttttt", "pi-read-guard");
  mkdirSync(join(pkgDir, "extensions"), { recursive: true });
  const entry = options.entry ?? "./extensions/read-guard.ts";
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@momenttttt/pi-read-guard", pi: { extensions: [entry] } }),
    "utf8",
  );
  const extensionPath = join(pkgDir, "extensions", "read-guard.ts");
  if (options.writeEntry !== false) writeFileSync(extensionPath, "export default () => {};\n", "utf8");
  return { packageJsonPath: join(pkgDir, "package.json"), extensionPath };
}

const realDeps: GuardResolveDeps = {
  resolveSpecifier: (specifier) => specifier, // 用例里直接给路径，不需要真的按包名解析
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
};

describe("自动解析", () => {
  test("解析到包 → 从 pi.extensions 拼出扩展文件路径", () => {
    const { packageJsonPath, extensionPath } = fakeGuardPackage();
    const injection = resolveGuardInjection({}, { ...realDeps, resolveSpecifier: () => packageJsonPath });
    expect(injection.status).toBe("injected");
    expect(injection.paths).toEqual([extensionPath]);
    expect(injection.detail).toContain("自动解析");
  });

  test("file:// URL 也认（import.meta.resolve 在原生 ESM 下给的是 URL）", () => {
    const { packageJsonPath, extensionPath } = fakeGuardPackage();
    const injection = resolveGuardInjection(
      {},
      { ...realDeps, resolveSpecifier: () => pathToFileURL(packageJsonPath).href },
    );
    expect(injection.paths).toEqual([extensionPath]);
  });

  test("包声明里没有 pi.extensions → 未注入", () => {
    const root = workspace();
    const pkgDir = join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    const packageJsonPath = join(pkgDir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ name: "x" }), "utf8");
    const injection = resolveGuardInjection({}, { ...realDeps, resolveSpecifier: () => packageJsonPath });
    expect(injection.status).toBe("missing");
    expect(injection.paths).toEqual([]);
    expect(injection.detail).toContain("pi.extensions");
  });

  test("声明指向的文件不存在 → 未注入", () => {
    const { packageJsonPath } = fakeGuardPackage({ writeEntry: false });
    const injection = resolveGuardInjection({}, { ...realDeps, resolveSpecifier: () => packageJsonPath });
    expect(injection.status).toBe("missing");
    expect(injection.detail).toContain("不存在");
  });

  test("解析器抛异常（jiti 下 import.meta.resolve 就是这样）→ 未注入且原因带出来", () => {
    const injection = resolveGuardInjection(
      {},
      {
        ...realDeps,
        resolveSpecifier: () => {
          throw new TypeError("Invalid relative URL or base scheme is not hierarchical");
        },
      },
    );
    expect(injection.status).toBe("missing");
    expect(injection.paths).toEqual([]);
    expect(injection.detail).toContain("自动解析");
    expect(injection.detail).toContain("Invalid relative URL");
  });

  test("默认依赖在本仓库里真的能解析到 pi-read-guard 的扩展文件", () => {
    const injection = resolveGuardInjection({}, defaultGuardResolveDeps());
    expect(injection.status).toBe("injected");
    expect(injection.paths).toHaveLength(1);
    expect(injection.paths[0]?.replace(/\\/g, "/")).toMatch(
      /packages\/pi-read-guard\/extensions\/read-guard\.ts$/,
    );
  });
});

describe("显式配置优先", () => {
  test("写 [] = 关闭注入（不报错、不告警）", () => {
    const injection = resolveGuardInjection({ guardExtensionPaths: [] }, realDeps);
    expect(injection.status).toBe("disabled");
    expect(injection.paths).toEqual([]);
    expect(guardNeedsWarning(injection)).toBe(false);
  });

  test("显式路径存在 → 用它，不走自动解析", () => {
    const { extensionPath } = fakeGuardPackage();
    const injection = resolveGuardInjection({ guardExtensionPaths: [extensionPath as string] }, realDeps);
    expect(injection.status).toBe("injected");
    expect(injection.paths).toEqual([extensionPath]);
    expect(injection.detail).toContain("配置指定");
  });

  test("显式路径都不存在 → 未注入 + 告警", () => {
    const injection = resolveGuardInjection(
      { guardExtensionPaths: ["C:/nope/read-guard.ts"] },
      realDeps,
    );
    expect(injection.status).toBe("missing");
    expect(injection.paths).toEqual([]);
    expect(guardNeedsWarning(injection)).toBe(true);
    expect(injection.detail).toContain("C:/nope/read-guard.ts");
  });

  test("部分存在 → 只注入存在的那些，并告警", () => {
    const { extensionPath } = fakeGuardPackage();
    const injection = resolveGuardInjection(
      { guardExtensionPaths: [extensionPath as string, "C:/nope/x.ts"] },
      realDeps,
    );
    expect(injection.status).toBe("partial");
    expect(injection.paths).toEqual([extensionPath]);
    expect(guardNeedsWarning(injection)).toBe(true);
  });
});

describe("可显示状态", () => {
  test("describeGuardInjection 是一行、带前缀，/agents 与启动告警共用", () => {
    const injection = resolveGuardInjection({ guardExtensionPaths: [] }, realDeps);
    expect(describeGuardInjection(injection)).toMatch(/^读守卫注入：/);
    expect(describeGuardInjection(injection)).toContain("已关闭");
  });
});
