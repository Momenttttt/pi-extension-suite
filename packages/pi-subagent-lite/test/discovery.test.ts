/**
 * S1：层序、项目目录发现与同名整文件替换（真建临时目录，走真 fs）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadAgentListing, projectAgentDirs } from "../src/discovery.ts";

const workspaces: Array<() => void> = [];

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-discovery-"));
  workspaces.push(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

afterEach(() => {
  for (const cleanup of workspaces.splice(0)) cleanup();
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function profile(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} 的说明\n${extra}---\n${name} 的正文\n`;
}

/** 一个带 git 根的工作区：`<ws>/.git` 让向上发现在此打住。 */
function gitWorkspace(): { root: string; agentDir: string; nested: string } {
  const root = workspace();
  mkdirSync(join(root, ".git"), { recursive: true });
  const agentDir = join(root, ".pi", "agent");
  const nested = join(root, "packages", "inner");
  mkdirSync(nested, { recursive: true });
  return { root, agentDir, nested };
}

describe("层序与覆盖（ADR-0002：整文件替换）", () => {
  test("内置 < 用户级 < .agents < .pi，且覆盖有告警", () => {
    const { root, agentDir } = gitWorkspace();
    write(join(agentDir, "agents", "Explore.md"), profile("Explore", "tools: read\n"));
    write(join(root, ".agents", "agents", "Explore.md"), profile("Explore", "tools: read, grep\n"));
    write(join(root, ".pi", "agents", "Explore.md"), profile("Explore", "tools: read, grep, find\n"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    const explore = listing.agents.find((agent) => agent.name === "Explore");
    expect(explore?.tools).toEqual(["read", "grep", "find"]);
    expect(explore?.source.layer).toBe("project-pi");
    expect(explore?.source.path).toBe(join(root, ".pi", "agents", "Explore.md"));

    // 三次覆盖：内置 → 用户 → .agents → .pi
    const overrides = listing.warnings.filter((warning) => warning.includes("覆盖了"));
    expect(overrides).toHaveLength(3);
    expect(overrides.at(-1)).toContain(join(root, ".pi", "agents", "Explore.md"));
  });

  test("整文件替换：被覆盖的一方不留任何字段", () => {
    const { root, agentDir } = gitWorkspace();
    // 内置 Explore 有 5 个只读工具；用户档案只写 name/description，tools 应回到默认全量
    write(join(agentDir, "agents", "Explore.md"), profile("Explore"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    const explore = listing.agents.find((agent) => agent.name === "Explore");
    expect(explore?.tools).toBe("*");
    expect(explore?.injectAgentsMd).toBe(true);
    expect(explore?.body).toBe("Explore 的正文");
  });

  test("新增档案与内置代理并存，general-purpose 与 Explore 都在", () => {
    const { root, agentDir } = gitWorkspace();
    write(join(agentDir, "agents", "reviewer.md"), profile("reviewer"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.agents.map((agent) => agent.name)).toEqual([
      "Explore",
      "general-purpose",
      "reviewer",
    ]);
  });

  test("非递归：代理目录的子目录不加载", () => {
    const { root, agentDir } = gitWorkspace();
    write(join(agentDir, "agents", "nested", "deep.md"), profile("deep"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.agents.some((agent) => agent.name === "deep")).toBe(false);
  });

  test("错误目录（~/.pi/agents 而不是 ~/.pi/agent/agents）不被加载", () => {
    const { root } = gitWorkspace();
    const agentDir = join(root, "home", ".pi", "agent");
    // 用户常犯的错：把档案放在 `<agent-dir>/../agents`（即 ~/.pi/agents），也就是 agent 的兄弟目录
    write(join(root, "home", ".pi", "agents", "mistake.md"), profile("mistake"));
    // 正确位置放一个，确保这个用例不是因为"整个用户层没被扫"而通过
    write(join(agentDir, "agents", "right.md"), profile("right"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.agents.some((agent) => agent.name === "mistake")).toBe(false);
    expect(listing.agents.some((agent) => agent.name === "right")).toBe(true);
  });
});

describe("项目目录向上发现", () => {
  test("从 cwd 向上到 git root：最近的一层胜出", () => {
    const { root, agentDir, nested } = gitWorkspace();
    write(join(root, ".pi", "agents", "reviewer.md"), profile("reviewer", "model: top/model\n"));
    write(join(nested, ".pi", "agents", "reviewer.md"), profile("reviewer", "model: near/model\n"));

    const dirs = projectAgentDirs(nested);
    expect(dirs[0]).toBe(nested);
    expect(dirs).toContain(root);

    const listing = loadAgentListing({ cwd: nested, agentDir });
    const reviewer = listing.agents.find((agent) => agent.name === "reviewer");
    expect(reviewer?.model).toBe("near/model");
    expect(reviewer?.source.path).toBe(join(nested, ".pi", "agents", "reviewer.md"));
  });

  test("git root 之上的目录不参与（`.git` 处停）", () => {
    const outer = workspace();
    mkdirSync(join(outer, ".pi", "agents"), { recursive: true });
    write(join(outer, ".pi", "agents", "outer.md"), profile("outer"));
    const root = join(outer, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });

    expect(projectAgentDirs(root)).not.toContain(outer);
    const listing = loadAgentListing({ cwd: root, agentDir: join(root, ".pi", "agent") });
    expect(listing.agents.some((agent) => agent.name === "outer")).toBe(false);
  });

  test("只看含 .pi/ 或 .agents/ 的目录", () => {
    const { root, nested } = gitWorkspace();
    const plain = join(root, "no-marker");
    mkdirSync(plain, { recursive: true });
    expect(projectAgentDirs(plain)).not.toContain(plain);
    expect(projectAgentDirs(nested)).not.toContain(nested.replace(/\\/g, "/") + "/x");
  });
});

describe("解析失败不阻断启动", () => {
  test("坏档案进 skipped 并带原因，好档案照常生效", () => {
    const { root, agentDir } = gitWorkspace();
    write(join(agentDir, "agents", "broken.md"), "---\nname: broken\n"); // 缺结束的 ---
    write(join(agentDir, "agents", "nodesc.md"), "---\nname: nodesc\n---\nbody\n");
    write(join(agentDir, "agents", "off.md"), profile("off", "enabled: false\n"));
    write(join(agentDir, "agents", "fine.md"), profile("fine"));

    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.agents.some((agent) => agent.name === "fine")).toBe(true);

    const reasons = new Map(listing.skipped.map((entry) => [entry.path.split(/[\\/]/).pop(), entry.reason]));
    expect(reasons.get("broken.md")).toContain("结束的 ---");
    expect(reasons.get("nodesc.md")).toContain("description");
    expect(reasons.get("off.md")).toBe("enabled: false");
  });

  test("旧字段名的警告带上文件路径，便于 /agents 定位", () => {
    const { root, agentDir } = gitWorkspace();
    const path = join(agentDir, "agents", "legacy.md");
    write(path, "---\ndisplay_name: legacy\ndescription: d\n---\nbody\n");

    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.warnings.some((warning) => warning.startsWith(`[${path}]`))).toBe(true);
    expect(listing.warnings.join("\n")).toContain("display_name");
  });
});

describe("内置层", () => {
  test("没有任何档案时只有两个内置代理", () => {
    const { root, agentDir } = gitWorkspace();
    const listing = loadAgentListing({ cwd: root, agentDir });
    expect(listing.agents.map((agent) => agent.name)).toEqual(["Explore", "general-purpose"]);
    expect(listing.scannedDirs).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });

  test("Explore 内置定义：五个只读工具、不读 AGENTS.md、不设 maxTurns", () => {
    const { root, agentDir } = gitWorkspace();
    const listing = loadAgentListing({ cwd: root, agentDir });
    const explore = listing.agents.find((agent) => agent.name === "Explore");
    expect(explore?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(explore?.injectAgentsMd).toBe(false);
    expect(explore?.maxTurns).toBeUndefined();
    expect(explore?.source).toEqual({ layer: "builtin", kind: "builtin" });
  });

  test("general-purpose 内置定义：全量工具、读 AGENTS.md", () => {
    const { root, agentDir } = gitWorkspace();
    const listing = loadAgentListing({ cwd: root, agentDir });
    const general = listing.agents.find((agent) => agent.name === "general-purpose");
    expect(general?.tools).toBe("*");
    expect(general?.injectAgentsMd).toBe(true);
  });
});
