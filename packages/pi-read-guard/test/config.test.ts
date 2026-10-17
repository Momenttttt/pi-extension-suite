/**
 * S1 单测：配置读取与豁免（票据 02 的 `exempt` / `mode` 配置项）。
 *
 * 配置是四个包共用的形状：全局 `<agent-dir>/extensions/<name>.json` + 项目
 * `<cwd>/.pi/<name>.json`，深合并、防御式解析。这里连着"配置坏了怎么办"一起钉住。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_READ_GUARD_CONFIG,
  deepMerge,
  loadConfig,
  parseReadGuardConfig,
  resolveAgentDir,
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("parseReadGuardConfig", () => {
  test("非对象一律退回默认值", () => {
    for (const raw of [null, undefined, 42, "x", [], true]) {
      expect(parseReadGuardConfig(raw)).toEqual(DEFAULT_READ_GUARD_CONFIG);
    }
  });

  test("认 enabled / mode / exempt，非法值各自退回默认", () => {
    expect(parseReadGuardConfig({ enabled: false, mode: "warn", exempt: ["a/**"] })).toMatchObject({
      enabled: false,
      mode: "warn",
      exempt: ["a/**"],
    });
    expect(parseReadGuardConfig({ mode: "nonsense" }).mode).toBe("block");
    expect(parseReadGuardConfig({ enabled: "yes" }).enabled).toBe(true);
    expect(parseReadGuardConfig({ exempt: [1, "ok", null] }).exempt).toEqual(["ok"]);
    expect(parseReadGuardConfig({ exempt: "not-an-array" }).exempt).toEqual([]);
  });
});

describe("deepMerge", () => {
  test("普通对象递归合并，数组与标量后写者胜", () => {
    const merged = deepMerge(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
      { b: 2, nested: { y: 3 }, list: [9] },
    );
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3 }, list: [9] });
  });
});

describe("resolveAgentDir", () => {
  test("PI_AGENT_DIR 优先", () => {
    expect(resolveAgentDir({ PI_AGENT_DIR: "D:\\agent" })).toBe("D:\\agent");
  });

  test("没设或为空串时退回 ~/.pi/agent", () => {
    expect(resolveAgentDir({})).toMatch(/[\\/]\.pi[\\/]agent$/);
    expect(resolveAgentDir({ PI_AGENT_DIR: "   " })).toMatch(/[\\/]\.pi[\\/]agent$/);
  });
});

describe("loadConfig：全局 + 项目深合并", () => {
  test("项目覆盖全局，未覆盖的字段保留全局值", () => {
    const cwd = tempDir("pi-rg-cwd-");
    const agentDir = tempDir("pi-rg-agent-");
    writeJson(join(agentDir, "extensions", "read-guard.json"), { mode: "warn", exempt: ["a/**"] });
    writeJson(join(cwd, ".pi", "read-guard.json"), { mode: "block" });

    const config = loadConfig(cwd, { agentDir });
    expect(config.mode).toBe("block");
    expect(config.exempt).toEqual(["a/**"]);
  });

  test("两个文件都不存在时给默认值", () => {
    const cwd = tempDir("pi-rg-cwd-");
    const agentDir = tempDir("pi-rg-agent-");
    expect(loadConfig(cwd, { agentDir })).toEqual(DEFAULT_READ_GUARD_CONFIG);
  });

  test("文件坏了（非法 JSON）不崩，退回默认值", () => {
    const cwd = tempDir("pi-rg-cwd-");
    const agentDir = tempDir("pi-rg-agent-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "read-guard.json"), "{ this is not json", "utf8");

    expect(loadConfig(cwd, { agentDir })).toEqual(DEFAULT_READ_GUARD_CONFIG);
  });
});
