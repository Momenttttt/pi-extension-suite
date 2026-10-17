/**
 * 事实文件 frontmatter 的解析与生成。
 *
 * 解析规则：
 *   - 只在前 30 行里找 frontmatter：扫描窗口必须有界，否则一个没有 frontmatter 的文件要被
 *     整份读进来才能判定（列表扫描对每个文件都做一次这件事）；定成 30 是因为读这些文件的
 *     一侧也只看这么多——闭合行更靠后的文件在两边都算"无描述条目"
 *   - 首行必须是 `---`，闭合行必须是单独的 `---`
 *   - YAML 解析失败或结果不是映射 → 视为"无描述条目"，不抛错
 *   - `type` 取 `metadata.type`，退回顶层 `type`；只认四个枚举值
 *
 * 生成规则（设计 §2.2）：只写 `name` / `description` / `metadata.node_type` / `metadata.type`，
 * **不写** `originSessionId`：那是读文件的一方在缺失时自己补的惰性字段，我们不伪造不属于
 * 自己的会话 id；也不加自定义键（未知键行为未核实）。
 */
import { parse as parseYaml } from "yaml";

import { MEMORY_TYPES, type MemoryType } from "./paths.ts";

/** 扫描窗口：frontmatter 必须在前 30 行内闭合。 */
export const FRONTMATTER_SCAN_LINES = 30;

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryType;
  /** 缺 frontmatter、闭合行找不到、YAML 坏、或不是映射时为 true。 */
  malformed: boolean;
}

export interface MemoryDocument {
  frontmatter: MemoryFrontmatter;
  /** frontmatter 之后的正文；没有合法 frontmatter 时是整份文档。 */
  body: string;
}

/** 统一 BOM 与行尾：解析与读取共用这一条归一化，后面按行处理都只面对 `\n`。 */
export function normalizeMemoryText(content: string): string {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
}

/** 找 frontmatter 的闭合行下标（在前 `FRONTMATTER_SCAN_LINES` 行内），找不到返回 -1。 */
function findFrontmatterEnd(lines: readonly string[]): number {
  const limit = Math.min(lines.length, FRONTMATTER_SCAN_LINES);
  for (let index = 1; index < limit; index += 1) {
    if (lines[index] === "---") return index;
  }
  return -1;
}

export function parseMemoryDocument(content: string): MemoryDocument {
  const normalized = normalizeMemoryText(content);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: { malformed: true }, body: normalized };
  }
  const end = findFrontmatterEnd(lines);
  if (end < 0) {
    return { frontmatter: { malformed: true }, body: normalized };
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/u, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return { frontmatter: { malformed: true }, body };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { frontmatter: { malformed: true }, body };
  }
  const record = parsed as Record<string, unknown>;
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const typeCandidate = metadata?.type ?? record.type;
  const frontmatter: MemoryFrontmatter = { malformed: false };
  if (typeof record.name === "string" && record.name.trim().length > 0) frontmatter.name = record.name.trim();
  if (typeof record.description === "string" && record.description.length > 0) {
    frontmatter.description = record.description;
  }
  if (typeof typeCandidate === "string" && (MEMORY_TYPES as readonly string[]).includes(typeCandidate)) {
    frontmatter.type = typeCandidate as MemoryType;
  }
  return { frontmatter, body };
}

export function parseMemoryFrontmatter(content: string): MemoryFrontmatter {
  return parseMemoryDocument(content).frontmatter;
}

export interface RenderMemoryFileInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * 生成事实文件全文。
 *
 * YAML 标量按需加双引号（YAML 兼容 JSON 引号）：description 里常见的 `:`、`#`、引号都不会
 * 弄坏解析。name 已由写入层校验成安全字符。
 */
export function renderMemoryFile(input: RenderMemoryFileInput): string {
  const body = input.body.replace(/\r\n/gu, "\n").replace(/\n*$/u, "");
  const frontmatter = [
    "---",
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    "metadata:",
    "  node_type: memory",
    `  type: ${input.type}`,
    "---",
  ].join("\n");
  return body.length > 0 ? `${frontmatter}\n${body}\n` : `${frontmatter}\n`;
}

const SPECIAL_SCALAR = /^(?:true|false|null|yes|no|on|off|~)$/iu;
const PLAIN_SCALAR = /^[\p{L}\p{N}][\p{L}\p{N} .,;!?()[\]{}'"\\/&%*+\-=<>@^`|~$_-]*$/u;

/** 需要时才加引号：保持文件可读，同时保证任何合法输入都能被 YAML 解析回原值。 */
function yamlScalar(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (
    singleLine.length > 0 &&
    PLAIN_SCALAR.test(singleLine) &&
    !SPECIAL_SCALAR.test(singleLine) &&
    !/^\d/u.test(singleLine) &&
    !/:\s/u.test(singleLine) &&
    !/\s#/u.test(singleLine)
  ) {
    return singleLine;
  }
  return JSON.stringify(singleLine);
}
