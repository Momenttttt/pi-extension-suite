/**
 * `/agents` 的报告文本与启动告警文案。
 *
 * 文本生成放在纯层，扩展层只负责 `ctx.ui.notify(...)`：这样"显示什么"可以被单测，
 * 也避免把排版逻辑塞进事件接线里。
 */
import type { AgentListing } from "./discovery.ts";
import { parseModelSpec, describeModel, describeTools } from "./selection.ts";

export interface AgentReportEntry {
  name: string;
  source: string;
  layer: string;
  model: string;
  tools: string;
  toolCount: number;
  promptMode: string;
  injectAgentsMd: boolean;
  maxTurns?: number;
  /** 该档案自己的告警（旧字段名等）。 */
  warnings: string[];
}

export interface AgentsReportInput {
  listing: AgentListing;
  /** 会话当前模型，用来把 `inherit` 显示成实际模型。 */
  sessionModel?: { provider: string; id: string };
  /** 显式 model 是否在 modelRegistry 里解析得到。 */
  canResolve: (provider: string, id: string) => boolean;
  /** `session_start` 扫出来的同类扩展冲突（若有）。 */
  conflicts?: string[];
  /** 子会话守卫注入状态（`describeGuardInjection` 的输出）。 */
  guard?: string;
}

/** 把生效档案折算成报告行（真实模型、工具数、提示词模式、来源路径）。 */
export function reportEntries(input: AgentsReportInput): AgentReportEntry[] {
  const { listing } = input;
  const warningsByPath = new Map<string, string[]>();
  for (const warning of listing.warnings) {
    const separator = warning.indexOf("] ");
    if (!warning.startsWith("[") || separator < 0) continue;
    const path = warning.slice(1, separator);
    const bucket = warningsByPath.get(path) ?? [];
    bucket.push(warning.slice(separator + 2));
    warningsByPath.set(path, bucket);
  }

  return listing.agents.map((agent) => {
    const spec = parseModelSpec(agent.model);
    const resolved =
      spec.kind === "explicit" ? input.canResolve(spec.provider, spec.id) : false;
    const tools = describeTools(agent);
    const entry: AgentReportEntry = {
      name: agent.name,
      source: agent.source.kind === "builtin" ? "内置（代码）" : (agent.source.path ?? "未知"),
      layer: agent.source.layer,
      model: describeModel(spec, input.sessionModel, resolved),
      tools: tools.summary,
      toolCount: tools.count,
      promptMode: agent.promptMode,
      injectAgentsMd: agent.injectAgentsMd,
      warnings:
        agent.source.path === undefined ? [] : (warningsByPath.get(agent.source.path) ?? []),
    };
    if (agent.maxTurns !== undefined) entry.maxTurns = agent.maxTurns;
    return entry;
  });
}

/** `/agents` 的正文。 */
export function formatAgentsReport(input: AgentsReportInput): string {
  const lines: string[] = ["subagent-lite：生效的代理档案"];
  const entries = reportEntries(input);

  for (const entry of entries) {
    const maxTurns = entry.maxTurns === undefined ? "不限" : String(entry.maxTurns);
    lines.push(
      `- ${entry.name}｜模型 ${entry.model}｜工具 ${entry.toolCount} 个：${entry.tools}` +
        `｜提示词 ${entry.promptMode}｜AGENTS.md ${entry.injectAgentsMd ? "读" : "不读"}｜maxTurns ${maxTurns}` +
        `｜来源 ${entry.source}（${entry.layer}）`,
    );
    for (const warning of entry.warnings) {
      lines.push(`  · ${warning}`);
    }
  }

  if (input.listing.skipped.length > 0) {
    lines.push("跳过的档案：");
    for (const skipped of input.listing.skipped) {
      lines.push(`- ${skipped.path}：${skipped.reason}`);
    }
  }

  const otherWarnings = input.listing.warnings.filter((warning) => !warning.startsWith("["));
  if (otherWarnings.length > 0) {
    lines.push("覆盖与提示：");
    for (const warning of otherWarnings) lines.push(`- ${warning}`);
  }

  if (input.conflicts !== undefined && input.conflicts.length > 0) {
    lines.push("同类扩展冲突：");
    for (const conflict of input.conflicts) lines.push(`- ${conflict}`);
  }

  if (input.guard !== undefined) {
    lines.push(input.guard);
  }

  if (input.listing.scannedDirs.length > 0) {
    lines.push(`扫描的目录：${input.listing.scannedDirs.join("、")}`);
  } else {
    lines.push("扫描的目录：无（只有内置代理）");
  }

  return lines.join("\n");
}

/** 启动时给用户的告警（覆盖、旧字段、跳过、冲突）。没有告警时返回 undefined。 */
export function startupWarning(input: AgentsReportInput): string | undefined {
  const lines: string[] = [];
  for (const skipped of input.listing.skipped) {
    lines.push(`档案被跳过：${skipped.path}（${skipped.reason}）`);
  }
  for (const warning of input.listing.warnings) {
    lines.push(warning);
  }
  for (const conflict of input.conflicts ?? []) {
    lines.push(conflict);
  }
  if (input.guard !== undefined && input.guard.includes("未注入")) {
    lines.push(input.guard);
  }
  if (lines.length === 0) return undefined;
  return ["subagent-lite 启动提示：", ...lines].join("\n");
}
