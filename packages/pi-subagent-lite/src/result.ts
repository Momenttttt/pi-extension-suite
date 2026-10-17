/**
 * 工具结果的形状与文案：`content` 末尾的一行摘要、`details` 的结构、用量折算与体积上限。
 *
 * 纯层：不 import pi。`details` 里的 `usage` 要能直接喂回 pi 的工具结果（pi 会把工具的
 * `usage` 计入父会话合计），所以这里的形状与 pi-ai 的 `Usage` 对齐——但类型自己声明，
 * 免得依赖 pi 根不导出的内网类型。
 */
import type { SubagentUsage } from "./usage.ts";

export type SubagentStatus = "completed" | "aborted" | "error" | "max_turns";

/** 工具结果 `details`。 */
export interface SubagentDetails {
  agent: string;
  status: SubagentStatus;
  turns: number;
  toolCalls: number;
  durationMs: number;
  usage: SubagentUsage;
  truncated: boolean;
  /** 实际使用的模型（`provider/id`），便于和档案声明对账（设计 §6.1）。 */
  model?: string;
  /** SDK 报告"没能按请求的模型起会话"时的提示（设计 §6.7：回退必须明说）。 */
  modelFallback?: string;
  /** 运行失败时的原因（`status: "error"` 时才有）。 */
  error?: string;
}

/** 结果体积上限：与 CC 的 `maxResultSizeChars`（100k 字符）同量级。 */
export const MAX_RESULT_BYTES = 100_000;

/** `37200` → `37.2s`；不足 1s 保留毫秒。 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/** `48312` → `48.3k`。 */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 结果最后一行：`agent` / `status` / `turns` / `tool_calls` / `duration` / `tokens`。 */
export function formatTrailer(details: SubagentDetails): string {
  return (
    `[subagent] agent=${details.agent} status=${details.status} turns=${details.turns}` +
    ` tool_calls=${details.toolCalls} duration=${formatDuration(details.durationMs)}` +
    ` tokens=${formatTokens(details.usage.totalTokens)}`
  );
}

export interface ComposeContentOptions {
  /** 子代理的最终文本（可能为空）。 */
  text: string;
  details: SubagentDetails;
  /** 正文被截断时的说明行。 */
  truncationNote?: string;
  /** 其它需要明说的提示（模型回退、空产出等）。 */
  notes?: string[];
  /** 完全没有产出时正文用哪句话。 */
  emptyText?: string;
}

/** 组装 `content`：正文 + 明说出来的提示 + 最后一行摘要。 */
export function composeResultContent(options: ComposeContentOptions): string {
  const body = options.text.trim();
  const lines: string[] = [body === "" ? (options.emptyText ?? "（子代理没有产出文本）") : body];
  for (const note of options.notes ?? []) lines.push("", note);
  if (options.truncationNote !== undefined) lines.push("", options.truncationNote);
  lines.push("", formatTrailer(options.details));
  return lines.join("\n");
}
