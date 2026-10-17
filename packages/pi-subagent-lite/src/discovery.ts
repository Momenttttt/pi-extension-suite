/**
 * 档案发现与层序合并。
 *
 * 层序（低 → 高）：内置 < 用户级 `<agent-dir>/agents` < `<repo>/.agents/agents` < `<repo>/.pi/agents`；
 * 项目目录从 cwd 向上走到 git root 为止，**越近优先级越高**；目录非递归（只看该目录一层）。
 * 同名**整文件替换**并打覆盖告警，不做字段合并（ADR-0002）。
 *
 * 解析失败只进 `skipped`（带原因），不阻断启动（设计 §6.5）。
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { BUILTIN_AGENTS } from "./builtin-agents.ts";
import { parseAgentProfile, type AgentLayer, type AgentProfile } from "./profile.ts";

/** 一个加载层要扫的目录。 */
export interface AgentDirSpec {
  layer: AgentLayer;
  dir: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface AgentListing {
  /** 生效的档案（按名字排序），值已按层序覆盖完毕。 */
  agents: AgentProfile[];
  /** 被解析失败/缺字段/被 `enabled: false` 跳过的文件。 */
  skipped: SkippedFile[];
  /** 覆盖告警、旧字段名告警、字段取值告警；`[路径] 原因` 形状。 */
  warnings: string[];
  /** 扫描过（存在）的目录，供 `/agents` 说明来源。 */
  scannedDirs: string[];
}

export interface LoadAgentListingOptions {
  cwd: string;
  /** 全局配置目录，通常是 `~/.pi/agent`。 */
  agentDir: string;
}

/**
 * 项目级代理目录，**最近者在前**。
 *
 * 从 cwd 向上：含 `.pi/` 或 `.agents/` 的目录才算项目根候选；遇到 `.git` 就停（说明这一段
 * 属于同一个仓库），即走到 git 根为止。
 */
export function projectAgentDirs(cwd: string): string[] {
  const found: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".pi")) || existsSync(join(dir, ".agents"))) {
      found.push(dir);
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** 全部扫描目录，按**由低到高**的优先级排列（后写入者胜）。 */
export function agentDirSpecs(options: LoadAgentListingOptions): AgentDirSpec[] {
  const project = projectAgentDirs(options.cwd).reverse();
  const specs: AgentDirSpec[] = [{ layer: "user", dir: join(options.agentDir, "agents") }];
  for (const dir of project) {
    // 同一层里 `.pi` 输给…不，`.pi` 是权威层，所以放在 `.agents` 之后写入。
    specs.push({ layer: "project-agents", dir: join(dir, ".agents", "agents") });
    specs.push({ layer: "project-pi", dir: join(dir, ".pi", "agents") });
  }
  return specs;
}

/** 读取一层目录里的 `*.md`（非递归，按文件名排序，保证结果稳定）。 */
export function listProfileFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function loadAgentListing(options: LoadAgentListingOptions): AgentListing {
  const byName = new Map<string, AgentProfile>();
  const warnings: string[] = [];
  const skipped: SkippedFile[] = [];
  const scannedDirs: string[] = [];

  // 内置层：代码里的两个代理，最低优先级。
  for (const agent of BUILTIN_AGENTS) {
    byName.set(agent.name, agent);
  }

  for (const spec of agentDirSpecs(options)) {
    const files = listProfileFiles(spec.dir);
    if (files.length === 0) continue;
    scannedDirs.push(spec.dir);
    for (const path of files) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        skipped.push({ path, reason: `读取失败：${error instanceof Error ? error.message : String(error)}` });
        continue;
      }

      const parsed = parseAgentProfile(text, { path, kind: "file", layer: spec.layer });
      for (const warning of parsed.warnings) warnings.push(`[${path}] ${warning}`);
      if (!parsed.ok) {
        skipped.push({ path, reason: parsed.error });
        continue;
      }
      if (!parsed.profile.enabled) {
        skipped.push({ path, reason: "enabled: false" });
        continue;
      }

      const previous = byName.get(parsed.profile.name);
      if (previous !== undefined) {
        warnings.push(
          `${describeSource(parsed.profile)} 覆盖了 ${describeSource(previous)}（同名整文件替换，字段不合并）`,
        );
      }
      byName.set(parsed.profile.name, parsed.profile);
    }
  }

  return {
    agents: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    skipped,
    warnings,
    scannedDirs,
  };
}

/** 给告警用的人类可读来源（内置层没有路径）。 */
export function describeSource(agent: AgentProfile): string {
  if (agent.source.kind === "builtin") return `内置代理 ${agent.name}`;
  return `${agent.name}（${agent.source.path ?? "未知路径"}，${agent.source.layer}）`;
}
