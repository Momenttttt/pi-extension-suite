/**
 * 配置读取：全局 `<agent-dir>/extensions/context-guard.json` + 项目 `<cwd>/.pi/context-guard.json`，
 * 深合并、防御式解析。四个包形状一致，所以四个包的实现也长得一样（照 `pi-read-guard/src/config.ts`）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultPlaceholder } from "./clear.ts";

export interface ContextGuardConfig {
  enabled: boolean;
  /** 最近 N 个可清理结果不动（下限 1）。语义是**条数**，不是 token。 */
  keepRecent: number;
  /** 体积档阈值：保留尾部之外的可清理正文合计超过它才触发（默认 256 KiB）。 */
  maxClearableBytes: number;
  /** 空闲档：距上一条 assistant 消息的空闲分钟数（默认 60，即服务端 prompt 缓存 TTL）。 */
  gapThresholdMinutes: number;
  /** 体积档是否自动（默认 false：会话中途改写历史风险偏高，留给手动 `/ctx prune`）。 */
  autoVolumeTrigger: boolean;
  /** 插件 04 的 `subagent` 结果是否可清理（默认 false）。 */
  clearSubagentResults: boolean;
  /** 插件 01 的 `memory_read` 结果是否可清理（默认 false）。 */
  clearMemoryResults: boolean;
  /** 占位符文案。留出接口是为了以后能改措辞，v1 不暴露给配置。 */
  placeholder: (toolName: string) => string;
}

export const DEFAULT_CONTEXT_GUARD_CONFIG: ContextGuardConfig = {
  enabled: true,
  keepRecent: 5,
  maxClearableBytes: 256 * 1024,
  gapThresholdMinutes: 60,
  autoVolumeTrigger: false,
  clearSubagentResults: false,
  clearMemoryResults: false,
  placeholder: defaultPlaceholder,
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
export function parseContextGuardConfig(raw: unknown): ContextGuardConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_CONTEXT_GUARD_CONFIG };
  const config = { ...DEFAULT_CONTEXT_GUARD_CONFIG };
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (isPositiveInteger(raw.keepRecent)) config.keepRecent = Math.max(1, raw.keepRecent);
  if (isPositiveInteger(raw.maxClearableBytes)) config.maxClearableBytes = raw.maxClearableBytes;
  if (isNonNegativeNumber(raw.gapThresholdMinutes)) config.gapThresholdMinutes = raw.gapThresholdMinutes;
  if (typeof raw.autoVolumeTrigger === "boolean") config.autoVolumeTrigger = raw.autoVolumeTrigger;
  if (typeof raw.clearSubagentResults === "boolean") config.clearSubagentResults = raw.clearSubagentResults;
  if (typeof raw.clearMemoryResults === "boolean") config.clearMemoryResults = raw.clearMemoryResults;
  return config;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 定位全局配置目录。
 *
 * 优先读 pi 自己的环境变量 `PI_CODING_AGENT_DIR`（`pi --help` 列的就是它，pi 内部的
 * `getAgentDir()` 也认这个），再退回 `~/.pi/agent`。
 *
 * 注意别写成 `PI_AGENT_DIR`：那不是 pi 认的名字，设了它 pi 自己的扩展/设置仍然走
 * `~/.pi/agent`，于是"我们的全局配置"与"pi 的全局资源"会分叉到两个目录。
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** 全局 → 项目，深合并。 */
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): ContextGuardConfig {
  const agentDir = options.agentDir ?? resolveAgentDir(options.env ?? process.env);
  const globalRaw = readJsonIfExists(join(agentDir, "extensions", "context-guard.json"));
  const projectRaw = readJsonIfExists(join(cwd, ".pi", "context-guard.json"));
  return parseContextGuardConfig(deepMerge(globalRaw, projectRaw));
}
