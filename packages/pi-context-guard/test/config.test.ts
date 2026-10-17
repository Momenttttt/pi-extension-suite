/**
 * S1：配置读取（全局 + 项目深合并、防御式解析）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_CONTEXT_GUARD_CONFIG,
  deepMerge,
  loadConfig,
  parseContextGuardConfig,
} from "../src/config.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("默认值", () => {
  test("空闲档默认开（60 分钟），体积档自动化默认关，keepRecent 5", () => {
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.gapThresholdMinutes).toBe(60);
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.autoVolumeTrigger).toBe(false);
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.keepRecent).toBe(5);
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.maxClearableBytes).toBe(256 * 1024);
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.clearSubagentResults).toBe(false);
    expect(DEFAULT_CONTEXT_GUARD_CONFIG.clearMemoryResults).toBe(false);
  });
});

describe("防御式解析", () => {
  test("非法值一律退回默认值", () => {
    const parsed = parseContextGuardConfig({
      enabled: "yes",
      keepRecent: -3,
      maxClearableBytes: 0,
      gapThresholdMinutes: "60",
      autoVolumeTrigger: 1,
      clearSubagentResults: "true",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.keepRecent).toBe(5);
    expect(parsed.maxClearableBytes).toBe(256 * 1024);
    expect(parsed.gapThresholdMinutes).toBe(60);
    expect(parsed.autoVolumeTrigger).toBe(false);
    expect(parsed.clearSubagentResults).toBe(false);
  });

  test("合法值照收；keepRecent 下限 1", () => {
    const parsed = parseContextGuardConfig({
      keepRecent: 1,
      maxClearableBytes: 1024,
      gapThresholdMinutes: 0,
      autoVolumeTrigger: true,
      clearSubagentResults: true,
      clearMemoryResults: true,
    });
    expect(parsed.keepRecent).toBe(1);
    expect(parsed.gapThresholdMinutes).toBe(0);
    expect(parsed.autoVolumeTrigger).toBe(true);
    expect(parsed.clearSubagentResults).toBe(true);
    expect(parsed.clearMemoryResults).toBe(true);
  });

  test("非对象输入（配置写成了数组）退回默认", () => {
    expect(parseContextGuardConfig([]).keepRecent).toBe(5);
    expect(parseContextGuardConfig(null).keepRecent).toBe(5);
  });
});

describe("深合并与加载", () => {
  test("对象递归合并，标量后写者胜", () => {
    const merged = deepMerge(
      { a: { x: 1, y: 2 }, b: 1 },
      { a: { y: 3 }, b: 4 } as Record<string, unknown>,
    ) as { a: Record<string, unknown>; b: number };
    expect(merged).toEqual({ a: { x: 1, y: 3 }, b: 4 });
  });

  test("项目配置覆盖全局同名字段，其余字段保留", () => {
    const agentDir = tempDir("cg-agent-");
    const cwd = tempDir("cg-project-");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "context-guard.json"),
      JSON.stringify({ keepRecent: 9, gapThresholdMinutes: 5 }),
      "utf8",
    );
    writeFileSync(join(cwd, ".pi", "context-guard.json"), JSON.stringify({ keepRecent: 2 }), "utf8");

    const config = loadConfig(cwd, { agentDir, env: {} });
    expect(config.keepRecent).toBe(2);
    expect(config.gapThresholdMinutes).toBe(5);
    expect(config.maxClearableBytes).toBe(256 * 1024);
  });

  test("配置文件坏掉不抛异常，退化成默认", () => {
    const agentDir = tempDir("cg-agent-");
    const cwd = tempDir("cg-project-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "context-guard.json"), "{ not json", "utf8");
    const config = loadConfig(cwd, { agentDir, env: {} });
    expect(config.keepRecent).toBe(5);
  });
});
