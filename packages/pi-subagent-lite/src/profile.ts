/**
 * 代理档案：从 md 的 frontmatter + 正文解析出可执行的定义，并识别旧字段名。
 *
 * 纯层：只碰文本与路径字符串，不 import pi。层序与覆盖在 `discovery.ts`，工具/模型折算在
 * `selection.ts`。
 */
import { parseFrontmatterDocument } from "./frontmatter.ts";

/** 思考档位沿用 pi 的 `ThinkingLevel`；档案里写 `inherit` 表示跟随会话。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinking = "inherit" | (typeof THINKING_LEVELS)[number];

/** 工具集合：`"*"` 表示该 SDK 的默认全量，数组表示白名单。 */
export type AgentTools = "*" | string[];

export type AgentPromptMode = "append" | "replace";

/** 加载层，从低到高（见 ADR-0002 与设计 §3.2）。 */
export type AgentLayer = "builtin" | "user" | "project-agents" | "project-pi";

export interface AgentSource {
  layer: AgentLayer;
  /** 内置代理没有文件路径。 */
  path?: string;
  /** 代理身份由加载器持有，frontmatter 伪造不了（ADR-0002）。 */
  kind: "builtin" | "file";
}

export interface AgentProfile {
  name: string;
  description: string;
  tools: AgentTools;
  disallowedTools: string[];
  /** `inherit` 或 `provider/model`。 */
  model: string;
  thinking: AgentThinking;
  /** 只有档案显式写了才启用上限（不写 = 不限）。 */
  maxTurns?: number;
  promptMode: AgentPromptMode;
  injectAgentsMd: boolean;
  enabled: boolean;
  /** 追加（或替换，见 promptMode）进子代理系统提示词的正文。 */
  body: string;
  source: AgentSource;
}

export interface ParsedProfile {
  ok: true;
  profile: AgentProfile;
  warnings: string[];
}

export interface FailedProfile {
  ok: false;
  error: string;
  warnings: string[];
}

export type ProfileParseResult = ParsedProfile | FailedProfile;

/**
 * 旧字段名兼容表（旧档案的字段名 → 本插件名）。
 *
 * 用户本机可能已有 `~/.pi/agent/agents/Explore.md`，用的是 `display_name` / `prompt_mode`；
 * 不能让它静默失效，所以读到旧名一律给一条警告。
 */
export const PROFILE_ALIASES: Readonly<Record<string, string>> = {
  display_name: "name",
  prompt_mode: "promptMode",
  disallowed_tools: "disallowedTools",
  max_turns: "maxTurns",
};

export interface ParseProfileOptions {
  /** 文件路径（用于 name 回退与来源记录）。 */
  path?: string;
  /** 内置代理：来源写 builtin，且没有路径。 */
  kind?: "builtin" | "file";
  layer?: AgentLayer;
  /** 覆盖内置默认值（内置代理直接在代码里给全字段，通常不需要）。 */
  defaults?: Partial<AgentProfile>;
}

/** 解析一个档案文件（或一段内置定义）。解析失败不抛，返回 `ok: false` + 原因。 */
export function parseAgentProfile(text: string, options: ParseProfileOptions = {}): ProfileParseResult {
  const warnings: string[] = [];
  let data: Record<string, unknown>;
  let body: string;

  try {
    const document = parseFrontmatterDocument(text);
    data = document.data;
    body = document.body;
  } catch (error) {
    return {
      ok: false,
      error: `前置元数据解析失败：${error instanceof Error ? error.message : String(error)}`,
      warnings,
    };
  }

  const readString = (canonical: string): { value?: string; present: boolean } => {
    warnAlias(data, canonical, warnings);
    if (data[canonical] !== undefined && data[canonical] !== null) {
      const raw = data[canonical];
      if (typeof raw === "string") return { value: raw.trim(), present: true };
      if (typeof raw === "number" || typeof raw === "boolean") {
        return { value: String(raw), present: true };
      }
      warnings.push(`字段 ${canonical} 不是字符串，已忽略`);
      return { present: true };
    }
    const alias = aliasOf(canonical);
    if (alias !== undefined && data[alias] !== undefined && data[alias] !== null) {
      const raw = data[alias];
      if (typeof raw === "string") return { value: raw.trim(), present: true };
      if (typeof raw === "number" || typeof raw === "boolean") {
        return { value: String(raw), present: true };
      }
      return { present: true };
    }
    return { present: false };
  };

  const readBoolean = (canonical: string, fallback: boolean): boolean => {
    warnAlias(data, canonical, warnings);
    const alias = aliasOf(canonical);
    const raw = data[canonical] ?? (alias === undefined ? undefined : data[alias]);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string" && /^(true|false)$/i.test(raw.trim())) {
      return raw.trim().toLowerCase() === "true";
    }
    warnings.push(`字段 ${canonical} 不是布尔值，按默认 ${fallback} 处理`);
    return fallback;
  };

  const fallbackName = options.kind === "builtin" ? undefined : nameFromPath(options.path);
  const nameRead = readString("name");
  let name = nameRead.value;
  if (name === undefined || name === "") {
    if (fallbackName !== undefined) {
      name = fallbackName;
      if (!nameRead.present) {
        warnings.push(`未写 name，按文件名取名为 ${fallbackName}`);
      }
    }
  }
  if (name === undefined || name === "") {
    return { ok: false, error: "缺少 name（也没有可用的文件名）", warnings };
  }
  if (data["source"] !== undefined) {
    warnings.push("source 由加载器持有，frontmatter 里的 source 已忽略");
  }

  const descriptionRead = readString("description");
  if (descriptionRead.value === undefined || descriptionRead.value === "") {
    return { ok: false, error: "缺少 description", warnings };
  }

  const defaults = options.defaults;
  const tools = readToolsFor(data, "tools", warnings) ?? defaults?.tools ?? "*";
  const disallowedRead = readToolsFor(data, "disallowedTools", warnings);
  if (disallowedRead === "*") {
    warnings.push("disallowedTools 不接受 *（要全量就别写该字段），已忽略");
  }
  const disallowedTools = Array.isArray(disallowedRead)
    ? disallowedRead
    : (defaults?.disallowedTools ?? []);

  const model = readString("model").value ?? defaults?.model ?? "inherit";
  const thinking = readThinking(data, warnings) ?? defaults?.thinking ?? "inherit";
  const maxTurns = readMaxTurns(data, warnings) ?? defaults?.maxTurns;
  const promptMode = readPromptMode(data, warnings) ?? defaults?.promptMode ?? "append";
  const injectAgentsMd = readBoolean("injectAgentsMd", defaults?.injectAgentsMd ?? true);
  const enabled = readBoolean("enabled", defaults?.enabled ?? true);

  const profile: AgentProfile = {
    name,
    description: descriptionRead.value,
    tools,
    disallowedTools,
    model,
    thinking,
    promptMode,
    injectAgentsMd,
    enabled,
    body,
    source: {
      layer: options.layer ?? defaults?.source?.layer ?? "user",
      kind: options.kind ?? defaults?.source?.kind ?? "file",
      ...((options.path ?? defaults?.source?.path) === undefined
        ? {}
        : { path: (options.path ?? defaults?.source?.path) as string }),
    },
  };
  if (maxTurns !== undefined) profile.maxTurns = maxTurns;

  return { ok: true, profile, warnings };
}

/** 旧字段名只要出现就给警告（哪怕同名的规范字段也在），"不静默"是硬要求。 */
function warnAlias(data: Record<string, unknown>, canonical: string, warnings: string[]): void {
  const alias = aliasOf(canonical);
  if (alias === undefined) return;
  if (data[alias] === undefined || data[alias] === null) return;
  warnings.push(`使用了旧字段名 ${alias}，等价于 ${canonical}；建议改成 ${canonical}`);
}

function aliasOf(canonical: string): string | undefined {
  for (const [alias, target] of Object.entries(PROFILE_ALIASES)) {
    if (target === canonical) return alias;
  }
  return undefined;
}

function nameFromPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const base = path.split(/[\\/]/).pop() ?? path;
  const withoutExt = base.replace(/\.md$/i, "");
  return withoutExt === "" ? undefined : withoutExt;
}

/** `tools` / `disallowedTools`：字符串（逗号分隔）、数组、`"*"`。 */
function readToolsFor(
  data: Record<string, unknown>,
  canonical: string,
  warnings: string[],
): AgentTools | undefined {
  const alias = aliasOf(canonical);
  warnAlias(data, canonical, warnings);
  let raw = data[canonical];
  if (raw === undefined && alias !== undefined) {
    raw = data[alias];
  }
  if (raw === undefined || raw === null) return undefined;

  const listOf = (values: unknown[]): string[] => {
    const names: string[] = [];
    for (const value of values) {
      if (typeof value === "string") {
        for (const part of value.split(",")) {
          const name = part.trim();
          if (name !== "") names.push(name);
        }
      } else {
        warnings.push(`字段 ${canonical} 里有非字符串项，已忽略`);
      }
    }
    return names;
  };

  if (Array.isArray(raw)) {
    const names = listOf(raw);
    if (names.length === 1 && names[0] === "*") return "*";
    return names;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "*" || trimmed === "") return trimmed === "*" ? "*" : undefined;
    return listOf([trimmed]);
  }
  warnings.push(`字段 ${canonical} 只能是字符串或数组，已忽略`);
  return undefined;
}

function readThinking(data: Record<string, unknown>, warnings: string[]): AgentThinking | undefined {
  const raw = data["thinking"];
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? raw.trim() : String(raw);
  if (value === "inherit") return "inherit";
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as AgentThinking;
  warnings.push(
    `thinking 只能是 inherit 或 ${THINKING_LEVELS.join(" / ")}（收到 ${value}），按 inherit 处理`,
  );
  return "inherit";
}

function readMaxTurns(data: Record<string, unknown>, warnings: string[]): number | undefined {
  const alias = "max_turns";
  let raw = data["maxTurns"];
  if (raw === undefined && data[alias] !== undefined) {
    raw = data[alias];
    warnings.push(`使用了旧字段名 ${alias}，等价于 maxTurns；建议改成 maxTurns`);
  }
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value <= 0) {
    warnings.push("maxTurns 不是正整数，已忽略（不设上限）");
    return undefined;
  }
  return value;
}

function readPromptMode(
  data: Record<string, unknown>,
  warnings: string[],
): AgentPromptMode | undefined {
  const alias = "prompt_mode";
  let raw = data["promptMode"];
  if (raw === undefined && data[alias] !== undefined) {
    raw = data[alias];
    warnings.push(`使用了旧字段名 ${alias}，等价于 promptMode；建议改成 promptMode`);
  }
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? raw.trim() : String(raw);
  if (value === "append" || value === "replace") return value;
  warnings.push(`promptMode 只能是 append 或 replace（收到 ${value}），按 append 处理`);
  return "append";
}
