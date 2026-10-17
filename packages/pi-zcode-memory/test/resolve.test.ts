/**
 * S1：三级回退（设计 §5.1）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { computeMemoryDir, sanitizeProjectSlug } from "../src/paths.ts";
import { resolveMemoryDir } from "../src/resolve.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function layout(): { home: string; cwd: string; storageRoot: string; projectsRoot: string; computedDir: string } {
  const home = tempDir("pi-memory-home-");
  const cwd = tempDir("pi-memory-cwd-");
  const storageRoot = join(home, ".zcode", "cli");
  const computedDir = computeMemoryDir({ cwd, storageRoot });
  return {
    home,
    cwd,
    storageRoot,
    projectsRoot: join(storageRoot, "memories", "projects"),
    computedDir,
  };
}

describe("resolveMemoryDir", () => {
  test("第 1 级：配置 dir 最高优先级（即使计算路径存在）", () => {
    const { cwd, storageRoot, computedDir } = layout();
    mkdirSync(computedDir, { recursive: true });
    const configured = join(tempDir("pi-memory-config-"), "memory");
    const resolution = resolveMemoryDir({
      cwd,
      configDir: configured,
      storageRoot,
      platform: "win32",
    });
    expect(resolution.source).toBe("config");
    expect(resolution.dir).toBe(configured);
    expect(resolution.warnings).toEqual([]);
  });

  test("第 2 级：计算路径存在则用它", () => {
    const { cwd, storageRoot, computedDir } = layout();
    mkdirSync(computedDir, { recursive: true });
    const resolution = resolveMemoryDir({ cwd, storageRoot, platform: "win32" });
    expect(resolution.source).toBe("computed");
    expect(resolution.dir).toBe(computedDir);
    expect(resolution.warnings).toEqual([]);
  });

  test("第 3 级：同 slug 恰好一个候选 → 用它并打警告", () => {
    const { cwd, storageRoot, projectsRoot, computedDir } = layout();
    const slug = sanitizeProjectSlug(basename(cwd));
    const candidate = join(projectsRoot, `${slug}-deadbeefdeadbeef`, "memory");
    mkdirSync(candidate, { recursive: true });
    const resolution = resolveMemoryDir({ cwd, storageRoot, platform: "win32" });
    expect(resolution.source).toBe("fallback");
    expect(resolution.dir).toBe(candidate);
    expect(resolution.computedDir).toBe(computedDir);
    expect(resolution.warnings.join("\n")).toContain("hash 不同");
  });

  test("多个同 slug 候选 → 不猜，视为尚无记忆", () => {
    const { cwd, storageRoot, projectsRoot } = layout();
    const slug = sanitizeProjectSlug(basename(cwd));
    mkdirSync(join(projectsRoot, `${slug}-1111111111111111`, "memory"), { recursive: true });
    mkdirSync(join(projectsRoot, `${slug}-2222222222222222`, "memory"), { recursive: true });
    const resolution = resolveMemoryDir({ cwd, storageRoot, platform: "win32" });
    expect(resolution.source).toBe("none");
    expect(resolution.dir).toBeUndefined();
    expect(resolution.warnings.join("\n")).toContain("无法判定");
  });

  test("存在 project- 前缀目录 → 提示 workspace identity", () => {
    const { cwd, storageRoot, projectsRoot } = layout();
    mkdirSync(join(projectsRoot, "project-3333333333333333", "memory"), { recursive: true });
    const resolution = resolveMemoryDir({ cwd, storageRoot, platform: "win32" });
    expect(resolution.source).toBe("none");
    expect(resolution.warnings.join("\n")).toContain("workspace identity");
  });

  test("什么都没有 → 尚无记忆且不建目录", () => {
    const { cwd, storageRoot, projectsRoot } = layout();
    const resolution = resolveMemoryDir({ cwd, storageRoot, platform: "win32" });
    expect(resolution.source).toBe("none");
    expect(resolution.dir).toBeUndefined();
    expect(resolution.warnings.join("\n")).toContain("尚无 ZCode 记忆");
    // 不创建目录
    expect(() => writeFileSync(join(projectsRoot, "sentinel"), "")).toThrow();
  });

  test("homeDir 推导 storageRoot（默认路径形状）", () => {
    const { home, cwd } = layout();
    const resolution = resolveMemoryDir({ cwd, homeDir: home, platform: "win32" });
    expect(resolution.computedDir.startsWith(join(home, ".zcode", "cli", "memories", "projects"))).toBe(true);
  });
});
