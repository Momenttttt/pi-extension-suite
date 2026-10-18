/**
 * 扩展入口：让 pi 与 ZCode 共用同一份项目记忆。
 *
 * 互通是这个包存在的理由，也是唯一一条外部约束：目录布局、索引格式、事实文件 frontmatter
 * 必须与 ZCode 读写的那一套一致，因为那些文件由它创建、也由它召回。除此之外本包不依赖它，
 * 代码里也不复述它的内部实现。
 *
 * 分层（越靠下越纯，纯层不 import pi，便于 S1 单测）：
 *   - `src/paths.ts`        目录算法
 *   - `src/resolve.ts`      三级回退
 *   - `src/config.ts`       全局 + 项目配置深合并
 *   - `src/frontmatter.ts`  事实文件 frontmatter 解析与生成
 *   - `src/list.ts` / `src/read.ts`   memory_list / memory_read 的落盘逻辑
 *   - `src/atomic.ts` / `src/index-file.ts` / `src/write.ts`   memory_write
 *   - `src/index-content.ts` / `src/injection.ts` / `src/status.ts`   索引注入与 /memory
 *   - 本文件               事件与工具接线
 *
 * 并发：所有写入都走 pi 的 `withFileMutationQueue(root, ...)` 串行；跨进程的部分不做锁，
 * 靠写前 revision 比对 + 重读重试自愈——**不**静默覆盖别人的改动。
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { buildReadStatePayload, READ_STATE_EVENT } from "../src/bridge.ts";
import { loadConfig, type ZcodeMemoryConfig } from "../src/config.ts";
import { MemoryWriteError, type MemoryWriteErrorCode } from "../src/errors.ts";
import { INDEX_MESSAGE_TYPE, INJECTED_ENTRY_TYPE, decideInjection, rebuildInjectedHash } from "../src/injection.ts";
import { formatMemoryIndexForInjection, memoryIndexHash } from "../src/index-content.ts";
import { listMemoryFiles, type MemoryListEntry } from "../src/list.ts";
import { MEMORY_TYPES } from "../src/paths.ts";
import { locateMemory, truncateMemoryBody } from "../src/read.ts";
import { resolveMemoryDir, type MemoryDirResolution } from "../src/resolve.ts";
import { formatMemoryStatus } from "../src/status.ts";
import { writeMemory } from "../src/write.ts";

const INDEX_FILENAME = "MEMORY.md";

/** 工具结果详情：给脚本/后续扩展判断用，模型看不到（除 content 外）。 */
interface MemoryToolDetails {
  dir?: string;
  filename?: string;
  absolutePath?: string;
  /** 失败原因码：写入失败是 `MemoryWriteErrorCode`，读取失败是定位错误码。 */
  code?: string;
}

const zcodeMemory: ExtensionFactory = (pi: ExtensionAPI): void => {
  /** 当前上下文投影里仍存活的注入 hash；`session_start` 起重建，压缩/切分支后失效重算。 */
  let injectedHash: string | undefined;
  /** `/memory reload` 置位：下一次运行强制重新注入。 */
  let forceInject = false;
  let missingDirWarned = false;

  const resolveFor = (ctx: ExtensionContext): { config: ZcodeMemoryConfig; resolution: MemoryDirResolution } => {
    const config = loadConfig(ctx.cwd);
    // 配置里的相对路径按会话 cwd 解析，避免受进程启动目录影响
    const configuredDir =
      config.dir === undefined ? undefined : isAbsolute(config.dir) ? config.dir : resolve(ctx.cwd, config.dir);
    const resolution = resolveMemoryDir({
      cwd: ctx.cwd,
      ...(configuredDir === undefined ? {} : { configDir: configuredDir }),
    });
    return { config, resolution };
  };

  const rebuildInjectionState = (ctx: ExtensionContext): void => {
    // 会话投影只包含压缩后的保留尾部：注入消息被摘要掉后这里就找不到它了
    const projection = ctx.sessionManager.buildSessionProjection();
    injectedHash = rebuildInjectedHash(projection.entries.map((entry) => entry.sourceEntry));
  };

  pi.on("session_start", (_event, ctx) => {
    forceInject = false;
    missingDirWarned = false;
    rebuildInjectionState(ctx);
  });

  pi.on("session_compact", (_event, ctx) => rebuildInjectionState(ctx));
  pi.on("session_tree", (_event, ctx) => rebuildInjectionState(ctx));
  pi.on("session_shutdown", () => {
    injectedHash = undefined;
    forceInject = false;
  });

  // ---------------------------------------------------------------------------
  // 工具：memory_list / memory_read / memory_write
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description:
      "List the fact files in the project memory directory shared with ZCode (filename / name / description / type / modified time). " +
      "Memories are long-term facts, not a to-do list; use memory_read to see a body and memory_write to store a new fact. " +
      "This list comes from the files on disk, so it does not depend on the MEMORY.md index being intact.",
    promptSnippet: "List project memories shared with ZCode (long-term facts)",
    parameters: Type.Object({}),
    exposure: "direct",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { resolution } = resolveFor(ctx);
      const text = formatMemoryListResult(resolution);
      return { content: [{ type: "text", text }], details: detailsOf(resolution) };
    },
  });

  const memoryReadParams = Type.Object({
    name: Type.String({
      description:
        "The memory's name (the name in its frontmatter) or its filename, for example user-api-preference or user-api-preference.md; filenames in subdirectories work too.",
    }),
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read one project memory's frontmatter summary and body. The parameter is the memory's name or filename. " +
      "A body longer than 200 lines or 4096 bytes is truncated at the same limit ZCode uses when it recalls a memory, " +
      "and the result says where to read the full text — so what you see here is what is actually usable in a session. " +
      "Memory files are managed through these tools only: read a memory with memory_read, never with the built-in read tool. " +
      "The only exception is a truncated body: the result then says where to read the rest.",
    promptSnippet: "Read the body of one project memory",
    parameters: memoryReadParams,
    exposure: "direct",
    async execute(_toolCallId, params: Static<typeof memoryReadParams>, _signal, _onUpdate, ctx) {
      const { resolution } = resolveFor(ctx);
      const dir = resolution.dir;
      if (dir === undefined) {
        return {
          content: [{ type: "text", text: noMemoryDirText(resolution) }],
          details: detailsOf(resolution),
          isError: true,
        };
      }
      const located = locateMemory(dir, params.name);
      if (!located.ok) {
        return {
          content: [{ type: "text", text: `Failed to read memory: ${located.error.message}` }],
          details: { dir, code: located.error.code } satisfies MemoryToolDetails,
          isError: true,
        };
      }
      const memory = located.value;
      const truncated = truncateMemoryBody(memory.body);
      const text = formatMemoryReadResult(memory, truncated);
      // 读态互通（票据 08）：在共享事件总线上登记"这个记忆文件刚被读成什么程度"。
      // 没有安装 pi-read-guard 时总线上没有订阅者，emit 是 no-op——双方都不需要硬依赖。
      // 截断读发布 kind: "truncated" 且不带 hash，read-guard 不会放行后续 edit。
      pi.events.emit(
        READ_STATE_EVENT,
        buildReadStatePayload({
          absolutePath: memory.absolutePath,
          mtimeMs: memory.mtimeMs,
          sizeBytes: memory.sizeBytes,
          contentHash: memory.contentHash,
          truncated: truncated.truncated,
        }),
      );
      return {
        content: [{ type: "text", text }],
        details: {
          dir,
          filename: memory.filename,
          absolutePath: memory.absolutePath,
        } satisfies MemoryToolDetails,
      };
    },
  });

  const memoryWriteParams = Type.Object({
    name: Type.String({
      description:
        "The memory's name, also used as its filename (.md optional); by convention a kebab-case slug of 3-4 words, for example user-api-preference.",
    }),
    description: Type.String({
      description:
        "One sentence describing what this memory is; it goes into the frontmatter and the MEMORY.md index line, and it is what ZCode uses to judge relevance when recalling memories.",
    }),
    type: Type.Union(
      MEMORY_TYPES.map((value) => Type.Literal(value)),
      {
        description:
          "user (who the user is) / feedback (working-style feedback the user gave) / project (ongoing project facts) / reference (where an external resource lives).",
      },
    ),
    body: Type.String({
      description:
        "The memory body: one fact per file. For feedback / project memories the convention is **Why:** and **How to apply:**; link related memories with [[name]].",
    }),
    mode: Type.Union([Type.Literal("create"), Type.Literal("upsert")], {
      description: "create errors when a memory with that name exists; upsert overwrites it and updates the index line.",
    }),
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Write one long-term fact into the project memory directory shared with ZCode, and maintain its MEMORY.md index line. " +
      "Memories are long-term facts (user preferences, working-style feedback the user gave, project constraints, external resources), **not a to-do list**, " +
      "and not temporary state that ends with the conversation; do not write down information that the repository code, git history, or this task already answers. " +
      "Before writing, work out whether an existing memory covers the same thing: if so, upsert it rather than creating a duplicate entry. " +
      "Memory files are managed through these tools only: create or change a memory with memory_write, never with the built-in write or edit. " +
      "Only this tool keeps the fact file and its MEMORY.md index line in sync; a fact written by hand has no index line, and later sessions cannot see it.",
    promptSnippet: "Write a long-term fact into the project memory shared with ZCode (not a to-do)",
    parameters: memoryWriteParams,
    exposure: "direct",
    async execute(_toolCallId, params: Static<typeof memoryWriteParams>, _signal, _onUpdate, ctx) {
      const { resolution } = resolveFor(ctx);
      // 尚无记忆时按计算路径创建（三级回退第 3 步）；配置给了目录就以配置为准
      const dir = resolution.dir ?? resolution.computedDir;
      try {
        // 全部写入串行化：同一记忆目录下的读-改-写不会互相踩
        const outcome = await withFileMutationQueue(dir, () =>
          writeMemory({
            root: dir,
            name: params.name,
            description: params.description,
            type: params.type,
            body: params.body,
            mode: params.mode,
          }),
        );
        const action = outcome.fileAction === "created" ? "Created" : "Overwrote";
        const indexAction =
          outcome.indexAction === "inserted"
            ? "index line added"
            : outcome.indexAction === "updated"
              ? "index line updated"
              : "index line unchanged";
        return {
          content: [
            {
              type: "text",
              text:
                `${action} memory ${outcome.filename}; MEMORY.md ${indexAction}.\n` +
                `Memory directory: ${dir}\n` +
                `ZCode sees this change only after it re-reads the index (new session / cold resume / /clear); that is a sync delay, not a failed write.`,
            },
          ],
          details: {
            dir,
            filename: outcome.filename,
            absolutePath: outcome.absolutePath,
          } satisfies MemoryToolDetails,
        };
      } catch (error) {
        if (error instanceof MemoryWriteError) {
          const hint = error.hint === undefined ? "" : `\n${error.hint}`;
          return {
            content: [{ type: "text", text: `Failed to write memory: ${error.message}${hint}` }],
            details: { dir, code: error.code } satisfies MemoryToolDetails,
            isError: true,
          };
        }
        throw error;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // 索引注入：一次注入 + 标记；hash 变化 / 被压缩掉 / /memory reload 时重注
  // ---------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    // `pi.sendMessage(..., { triggerTurn: true })` 起的运行不算用户轮
    if (event.messageType === "custom") return undefined;
    const { config, resolution } = resolveFor(ctx);
    if (!config.enabled || !config.injectIndex) return undefined;
    const dir = resolution.dir;
    if (dir === undefined) {
      warnMissingMemoryDir(ctx, resolution);
      return undefined;
    }
    const indexPath = join(dir, INDEX_FILENAME);
    let raw: string;
    try {
      raw = await readFile(indexPath, "utf8");
    } catch {
      // 没有索引（或读不了）就不注入；清掉状态，等索引出现后重新注入
      injectedHash = undefined;
      return undefined;
    }
    const formatted = formatMemoryIndexForInjection(raw);
    if (formatted.text.length === 0) return undefined;
    const hash = memoryIndexHash(formatted.text);
    const decision = decideInjection({
      messageType: event.messageType,
      enabled: config.enabled,
      injectIndex: config.injectIndex,
      indexPresent: true,
      indexHash: hash,
      injectedHash,
      force: forceInject,
    });
    if (!decision.inject) return undefined;

    injectedHash = hash;
    forceInject = false;
    pi.appendEntry(INJECTED_ENTRY_TYPE, { indexHash: hash });
    return {
      message: {
        customType: INDEX_MESSAGE_TYPE,
        content: buildInjectionText(dir, formatted.text, formatted.truncated),
        display: false,
        details: { indexHash: hash },
      },
    };
  });

  // ---------------------------------------------------------------------------
  // /memory：状态 + 索引体检；/memory reload 强制下次运行重新注入
  // ---------------------------------------------------------------------------

  pi.registerCommand("memory", {
    description: "查看共享记忆目录状态与索引体检；/memory reload 让下一次运行重新注入索引",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();
      if (subcommand === "reload") {
        forceInject = true;
        notify(ctx, "memory：下一次运行会重新注入 MEMORY.md 索引。", "info");
        return;
      }
      if (subcommand.length > 0 && subcommand !== "status") {
        notify(ctx, "memory：用法是 /memory（状态）或 /memory reload（强制重新注入）。", "warning");
        return;
      }
      const { resolution } = resolveFor(ctx);
      const dir = resolution.dir;
      let indexContent: string | undefined;
      if (dir !== undefined) {
        try {
          indexContent = await readFile(join(dir, INDEX_FILENAME), "utf8");
        } catch {
          indexContent = undefined;
        }
      }
      const files: MemoryListEntry[] = dir === undefined ? [] : listMemoryFiles(dir);
      const text = formatMemoryStatus({
        resolution,
        indexContent,
        files,
        injectionLabel: injectionLabel(resolution, indexContent, injectedHash, forceInject),
      });
      notify(ctx, text, "info");
    },
  });

  function warnMissingMemoryDir(ctx: ExtensionContext, resolution: MemoryDirResolution): void {
    if (missingDirWarned) return;
    missingDirWarned = true;
    const hint = resolution.warnings.length > 0 ? ` ${resolution.warnings[resolution.warnings.length - 1]}` : "";
    notify(ctx, `memory：这次没有注入记忆索引——该项目尚无 ZCode 记忆。${hint}`, "warning");
  }
};

function detailsOf(resolution: MemoryDirResolution): MemoryToolDetails {
  return resolution.dir === undefined ? {} : { dir: resolution.dir };
}

function noMemoryDirText(resolution: MemoryDirResolution): string {
  const warnings = resolution.warnings.map((warning) => `\nNote: ${warning}`).join("");
  return (
    `This project has no ZCode memory yet: the computed directory does not exist (${resolution.computedDir}). ` +
    `memory_write creates it; if ZCode really has written memories for this project, set dir in the config to point at that directory. ` +
    `${warnings}`
  );
}

function formatMemoryListResult(resolution: MemoryDirResolution): string {
  const dir = resolution.dir;
  if (dir === undefined) return noMemoryDirText(resolution);
  const entries = listMemoryFiles(dir);
  const warnings = resolution.warnings.map((warning) => `Note: ${warning}`).join("\n");
  const header = `Memory directory: ${dir}\nFact files: ${entries.length}`;
  const body =
    entries.length === 0
      ? "(no fact files)"
      : entries
          .map((entry) => {
            const mtime = new Date(entry.mtimeMs).toISOString();
            if (entry.malformed) {
              return `- ${entry.filename} (frontmatter cannot be parsed: treated as an entry with no description; modified ${mtime})`;
            }
            const type = entry.type === undefined ? "" : ` [${entry.type}]`;
            const description = entry.description === undefined ? "" : ` — ${entry.description}`;
            const name = entry.name === undefined ? "" : ` ${entry.name}`;
            return `- ${entry.filename}${type}${name}${description} (modified ${mtime})`;
          })
          .join("\n");
  return warnings.length === 0 ? `${header}\n${body}` : `${warnings}\n${header}\n${body}`;
}

function formatMemoryReadResult(
  memory: {
    filename: string;
    absolutePath: string;
    sizeBytes: number;
    mtimeMs: number;
    frontmatter: { name?: string; description?: string; type?: string; malformed: boolean };
  },
  truncated: { text: string; truncated: boolean; reason?: "lines" | "bytes" | "both" },
): string {
  const frontmatter = memory.frontmatter;
  const lines: string[] = [];
  lines.push(`File: ${memory.filename}`);
  lines.push(
    frontmatter.malformed
      ? "frontmatter: cannot be parsed (treated as an entry with no description)"
      : `name: ${frontmatter.name ?? "(none)"}; description: ${frontmatter.description ?? "(no description)"}; type: ${frontmatter.type ?? "(not set)"}`,
  );
  lines.push(`Size: ${memory.sizeBytes} bytes; modified: ${new Date(memory.mtimeMs).toISOString()}`);
  lines.push("");
  lines.push(truncated.text.length === 0 ? "(body is empty)" : truncated.text);
  if (truncated.truncated) {
    const why =
      truncated.reason === "lines"
        ? "the first 200 lines"
        : truncated.reason === "bytes"
          ? "4096 bytes"
          : "the first 200 lines / 4096 bytes";
    lines.push("");
    lines.push(
      `(body truncated: at most ${why} is read here, the same limit ZCode uses when recalling a memory. Use the built-in read tool to read the full content at ${memory.absolutePath}.)`,
    );
  }
  return lines.join("\n");
}

function buildInjectionText(dir: string, indexText: string, truncated: boolean): string {
  const lines = [
    "Below is the cross-session automatic memory index for this project. It records long-term facts (who the user is, working-style feedback they gave, what the project is doing, where external resources live), not a to-do list for this turn.",
    "",
    `Memory directory: ${dir}`,
    `Index: ${join(dir, INDEX_FILENAME)} (only the index appears in context; read bodies on demand with memory_read, and do not infer a body's content from its index line)`,
  ];
  if (truncated) lines.push("The index injected this time is a truncated excerpt (see the WARNING at the end).");
  lines.push("", indexText);
  return lines.join("\n");
}

function injectionLabel(
  resolution: MemoryDirResolution,
  indexContent: string | undefined,
  injectedHash: string | undefined,
  force: boolean,
): string {
  if (resolution.dir === undefined) return "未注入（尚无记忆目录）";
  if (indexContent === undefined) return "未注入（索引不存在）";
  if (force) return "已排队：下一次运行重新注入";
  if (injectedHash === undefined) return "未注入（下一次运行会注入）";
  return `已注入（hash ${injectedHash.slice(0, 12)}…）`;
}

/**
 * 按设计共同约定 7：所有 UI 交互先看 `ctx.hasUI`。
 *
 * 非交互模式（print / json）没有 UI；显式守一道不是为了防崩，而是让"这里依赖渲染"
 * 在代码里看得见——真实运行里 `ctx.ui` 的无操作实现会吞掉内容，静默通过很难被发现。
 */
function notify(
  ctx: { hasUI: boolean; ui: { notify(message: string, kind?: "info" | "warning" | "error"): void } },
  message: string,
  kind?: "info" | "warning" | "error",
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, kind);
}

export default zcodeMemory;
export { zcodeMemory as zcodeMemoryFactory };
export type { ZcodeMemoryConfig };
