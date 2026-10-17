/**
 * S2 共用装载：临时工作目录 + 临时记忆目录 + 项目配置指向该目录。
 *
 * 记忆目录用配置里的 `dir` 显式指定，测试绝不碰真实 `~/.zcode`；`PI_AGENT_DIR` 也指向
 * 临时目录，避免读到开发机上的全局配置。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestSession, type StubStep, type TestSession } from "./test-session.ts";
import zcodeMemory from "../extensions/zcode-memory.ts";

const cleanups: Array<() => void> = [];
let previousAgentDir: string | undefined;

export interface MemoryWorkspace {
  cwd: string;
  memDir: string;
  agentDir: string;
}

export function createMemoryWorkspace(prefix = "pi-memory-e2e-"): MemoryWorkspace {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const memDir = mkdtempSync(join(tmpdir(), `${prefix}store-`));
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}agent-`));
  cleanups.push(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "zcode-memory.json"), `${JSON.stringify({ dir: memDir }, null, 2)}\n`, "utf8");
  return { cwd, memDir, agentDir };
}

export function cleanupMemoryWorkspaces(): void {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousAgentDir;
}

export async function sessionWithMemory(
  workspace: MemoryWorkspace,
  responses: StubStep[],
  options: { sessionDir?: string; resumeFrom?: string } = {},
): Promise<TestSession> {
  return createTestSession({
    extension: zcodeMemory,
    cwd: workspace.cwd,
    agentDir: workspace.agentDir,
    responses,
    ...options,
  });
}

/** 写一个"ZCode 写过"的事实文件：frontmatter 带 metadata 与 originSessionId。 */
export function writeZcodeStyleFact(
  memDir: string,
  filename: string,
  fields: { name: string; description: string; type: string; body: string },
): void {
  const content = [
    "---",
    `name: ${fields.name}`,
    `description: ${fields.description}`,
    "metadata:",
    "  node_type: memory",
    "  originSessionId: 6f0f0f0f-0000-4000-8000-000000000000",
    `  type: ${fields.type}`,
    "---",
    "",
    fields.body,
    "",
  ].join("\n");
  writeFileSync(join(memDir, filename), content, "utf8");
}
