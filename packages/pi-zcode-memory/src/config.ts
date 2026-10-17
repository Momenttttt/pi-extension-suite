/**
 * 配置读取：全局 `<agent-dir>/extensions/zcode-memory.json` + 项目 `<cwd>/.pi/zcode-memory.json`，
 * 深合并、防御式解析。形状与另外三个包一致。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ZcodeMemoryConfig {
  enabled: boolean;
  /**
   * 显式指定记忆目录（最高优先级）。ZCode 用了 workspace identity、或工作区路径写法
   * 与 ZCode 不一致时，这是唯一可靠的兜底。
   */
  dir: string | undefined;
  /** 是否做索引注入。默认开。
   *  单独留开关是为了排查"注入内容干扰上下文"一类问题，不面向常规使用。 */
  injectIndex: boolean;
}

export const DEFAULT_ZCODE_MEMORY_CONFIG: ZcodeMemoryConfig = {
  enabled: true,
  dir: undefined,
  injectIndex: true,
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
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/** 把外部 JSON 折算成可信配置；非法值一律退回默认值。 */
export function parseZcodeMemoryConfig(raw: unknown): ZcodeMemoryConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_ZCODE_MEMORY_CONFIG };
  const config = { ...DEFAULT_ZCODE_MEMORY_CONFIG };
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.injectIndex === "boolean") config.injectIndex = raw.injectIndex;
  if (typeof raw.dir === "string" && raw.dir.trim().length > 0) config.dir = raw.dir.trim();
  return config;
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
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): ZcodeMemoryConfig {
  const agentDir = options.agentDir ?? resolveAgentDir(options.env ?? process.env);
  const globalRaw = readJsonIfExists(join(agentDir, "extensions", "zcode-memory.json"));
  const projectRaw = readJsonIfExists(join(cwd, ".pi", "zcode-memory.json"));
  return parseZcodeMemoryConfig(deepMerge(globalRaw, projectRaw));
}
