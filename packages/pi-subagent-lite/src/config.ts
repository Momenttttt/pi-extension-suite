/**
 * 配置读取：全局 `<agent-dir>/extensions/subagent-lite.json` + 项目 `<cwd>/.pi/subagent-lite.json`，
 * 深合并、防御式解析。四个包形状一致，所以四个包的实现也长得一样。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubagentLiteConfig {
  enabled: boolean;
  /**
   * 子会话额外加载的守卫扩展路径。
   *
   * **不写 = 自动解析** `@momenttttt/pi-read-guard`（解析不到就降级成不注入 + 告警，见 `guard.ts`）；
   * 写 `[]` = 显式关闭；写路径列表 = 只用这些路径。
   */
  guardExtensionPaths?: string[];
}

export interface RawSubagentLiteConfig {
  enabled?: unknown;
  guardExtensionPaths?: unknown;
}

export const DEFAULT_SUBAGENT_LITE_CONFIG: SubagentLiteConfig = {
  enabled: true,
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
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/** 把外部 JSON 折算成可信配置；非法值一律退回默认值。 */
export function parseSubagentLiteConfig(raw: unknown): SubagentLiteConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_SUBAGENT_LITE_CONFIG };
  const config: SubagentLiteConfig = { ...DEFAULT_SUBAGENT_LITE_CONFIG };
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  // 只有真的写了这个键才覆盖"自动解析"的默认（写 [] 表示显式关闭）
  if (Array.isArray(raw.guardExtensionPaths)) {
    config.guardExtensionPaths = raw.guardExtensionPaths.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
  }
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
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): SubagentLiteConfig {
  const agentDir = options.agentDir ?? resolveAgentDir(options.env ?? process.env);
  const globalRaw = readJsonIfExists(join(agentDir, "extensions", "subagent-lite.json"));
  const projectRaw = readJsonIfExists(join(cwd, ".pi", "subagent-lite.json"));
  return parseSubagentLiteConfig(deepMerge(globalRaw, projectRaw));
}
