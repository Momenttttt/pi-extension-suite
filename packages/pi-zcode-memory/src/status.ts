/**
 * `/memory` 的状态与索引体检。
 *
 * 索引体检只做两件确定的事：索引行指向的文件不存在（孤儿行）、磁盘上的事实文件没出现在
 * 索引里（未入索引）。索引可能被模型写坏（重复、失效链接），`memory_list` 走文件系统兜底。
 */
import { INDEX_CHARACTER_LIMIT, INDEX_LINE_LIMIT } from "./index-content.ts";
import { INDEX_FILENAME } from "./index-file.ts";
import type { MemoryListEntry } from "./list.ts";
import type { MemoryDirResolution } from "./resolve.ts";

export interface IndexHealth {
  indexLineCount: number;
  /** 索引里的链接目标（相对记忆目录，`/` 分隔）。 */
  linkTargets: string[];
  /** 指向不存在文件的索引行。 */
  orphanIndexLines: string[];
  /** 磁盘上有、但索引里没有链接的事实文件。 */
  unindexedFiles: string[];
}

const LINK_TARGET_PATTERN = /\]\(\s*([^)\s]+)\s*\)/gu;

/** 抽出索引里的相对 `.md` 链接目标。 */
export function extractIndexTargets(indexContent: string): string[] {
  const targets: string[] = [];
  for (const match of indexContent.matchAll(LINK_TARGET_PATTERN)) {
    const target = match[1]!.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
    if (target.startsWith("http://") || target.startsWith("https://")) continue;
    if (!target.endsWith(".md")) continue;
    if (target.split("/").pop() === INDEX_FILENAME) continue;
    targets.push(target);
  }
  return targets;
}

/** 文件内容的"实际行数"：末尾换行不算一行。 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

export function inspectMemoryIndex(input: {
  indexContent: string | undefined;
  files: readonly MemoryListEntry[];
}): IndexHealth {
  const indexContent = input.indexContent ?? "";
  const linkTargets = extractIndexTargets(indexContent);
  const fileNames = new Set(input.files.map((entry) => entry.filename));
  const targetNames = new Set(linkTargets);
  return {
    indexLineCount: countLines(indexContent),
    linkTargets,
    orphanIndexLines: [...new Set(linkTargets)].filter((target) => !fileNames.has(target)),
    unindexedFiles: input.files.map((entry) => entry.filename).filter((filename) => !targetNames.has(filename)),
  };
}

export interface MemoryStatusInput {
  resolution: MemoryDirResolution;
  /** `MEMORY.md` 的内容；不存在/读不了时 undefined。 */
  indexContent: string | undefined;
  files: readonly MemoryListEntry[];
  /** 由扩展算出的注入状态描述。 */
  injectionLabel: string;
}

function sourceLabel(source: MemoryDirResolution["source"]): string {
  switch (source) {
    case "config":
      return "配置指定";
    case "computed":
      return "按算法计算（路径存在）";
    case "fallback":
      return "同 slug 唯一候选回退";
    case "none":
      return "尚无记忆";
  }
}

function preview(values: readonly string[], limit = 10): string {
  if (values.length === 0) return "无";
  const shown = values.slice(0, limit).join("、");
  return values.length > limit ? `${shown} 等 ${values.length} 项` : shown;
}

export function formatMemoryStatus(input: MemoryStatusInput): string {
  const { resolution, files } = input;
  const health = inspectMemoryIndex({ indexContent: input.indexContent, files });
  const lines: string[] = [];
  lines.push(`记忆目录：${resolution.dir ?? "未解析到"}`);
  lines.push(`来源：${sourceLabel(resolution.source)}`);
  if (resolution.dir === undefined || resolution.source !== "computed") {
    lines.push(`计算路径：${resolution.computedDir}`);
  }
  lines.push(
    input.indexContent === undefined
      ? `索引 ${INDEX_FILENAME}：不存在（注入会跳过；memory_write 会创建它）`
      : `索引 ${INDEX_FILENAME}：${health.indexLineCount} 行（注入上限 ${INDEX_LINE_LIMIT} 行 / ${INDEX_CHARACTER_LIMIT} 字符）`,
  );
  lines.push(`事实文件：${files.length} 个`);
  lines.push(
    `索引体检：孤儿索引行 ${health.orphanIndexLines.length} 条（${preview(health.orphanIndexLines)}）；` +
      `未入索引的文件 ${health.unindexedFiles.length} 个（${preview(health.unindexedFiles)}）`,
  );
  lines.push(`索引注入：${input.injectionLabel}`);
  for (const warning of resolution.warnings) lines.push(`注意：${warning}`);
  return lines.join("\n");
}
