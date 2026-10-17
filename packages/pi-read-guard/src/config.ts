/**
 * 配置读取：全局 `<agent-dir>/extensions/read-guard.json` + 项目 `<cwd>/.pi/read-guard.json`，
 * 深合并、防御式解析。四个包形状一致，所以四个包的实现也长得一样。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_WRITE_GATE_MESSAGES, type WriteGateMessages } from "./gate.ts";

export type GuardMode = "block" | "warn";

export interface ReadGuardConfig {
  enabled: boolean;
  mode: GuardMode;
  /** glob 豁免。默认空——包括记忆目录在内，一律受约束。 */
  exempt: string[];
  /** 阻断文案。留出接口是为了以后能改措辞，v1 不暴露给配置。 */
  messages: WriteGateMessages;
}

export interface RawReadGuardConfig {
  enabled?: unknown;
  mode?: unknown;
  exempt?: unknown;
}

export const DEFAULT_READ_GUARD_CONFIG: ReadGuardConfig = {
  enabled: true,
  mode: "block",
  exempt: [],
  messages: DEFAULT_WRITE_GATE_MESSAGES,
};

function readJsonIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // 配置坏了不能让插件崩，退化成默认值
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深合并：只对普通对象递归，数组与标量后写者胜。 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/** 把外部 JSON 折算成可信配置；非法值一律退回默认值。 */
export function parseReadGuardConfig(raw: unknown): ReadGuardConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_READ_GUARD_CONFIG };
  const config = { ...DEFAULT_READ_GUARD_CONFIG };
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (raw.mode === "warn" || raw.mode === "block") config.mode = raw.mode;
  if (Array.isArray(raw.exempt)) {
    config.exempt = raw.exempt.filter((value): value is string => typeof value === "string");
  }
  return config;
}

/** 定位全局配置目录：`PI_AGENT_DIR` 优先，否则 `~/.pi/agent`。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** 全局 → 项目，深合并。 */
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): ReadGuardConfig {
  const agentDir = options.agentDir ?? resolveAgentDir(options.env ?? process.env);
  const globalRaw = readJsonIfExists(join(agentDir, "extensions", "read-guard.json"));
  const projectRaw = readJsonIfExists(join(cwd, ".pi", "read-guard.json"));
  return parseReadGuardConfig(deepMerge(globalRaw, projectRaw));
}
