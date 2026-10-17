/**
 * 扩展入口：让 pi 与 ZCode 共用同一份项目记忆。
 *
 * 分层（越靠下越纯，纯层不 import pi，便于 S1 单测）：
 *   - `src/paths.ts`        目录算法（ZCode 复刻）
 *   - `src/resolve.ts`      三级回退
 *   - `src/config.ts`       全局 + 项目配置深合并
 *   - `src/frontmatter.ts`  事实文件 frontmatter 解析与生成
 *   - `src/list.ts` / `src/read.ts`   memory_list / memory_read 的落盘逻辑
 *   - `src/atomic.ts` / `src/index-file.ts` / `src/write.ts`   memory_write
 *   - `src/index-content.ts` / `src/injection.ts` / `src/status.ts`   索引注入与 /memory
 *   - 本文件               事件与工具接线
 *
 * 并发：所有写入都走 pi 的 `withFileMutationQueue(root, ...)` 串行；跨进程的部分不做锁，
 * 靠写前 revision 比对 + 重读重试（与 ZCode 前台写的策略一致）。
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
      "列出与 ZCode 共用的项目记忆目录里的事实文件（文件名 / name / description / type / 修改时间）。" +
      "记忆是长期事实，不是待办清单；要看正文用 memory_read，要写新事实用 memory_write。" +
      "这个列表来自磁盘文件，不依赖 MEMORY.md 索引是否完好。",
    promptSnippet: "列出与 ZCode 共用的项目记忆（长期事实）",
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
      description: "记忆的 name（frontmatter 里的 name）或文件名，例如 user-api-preference 或 user-api-preference.md；也支持子目录下的文件名。",
    }),
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description:
      "读取一条项目记忆的 frontmatter 摘要与正文。参数是记忆的 name 或文件名。" +
      "正文超过 200 行或 4096 字节时按 ZCode 召回的上限截断，并提示去哪里读全文——" +
      "也就是说，这里看到的就是会话里实际可用的量。",
    promptSnippet: "读取一条项目记忆的正文",
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
          content: [{ type: "text", text: `读取记忆失败：${located.error.message}` }],
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
        "记忆的名字，同时用作文件名（不带 .md 也行），惯例是 kebab-case 的 3–4 个词，例如 user-api-preference。",
    }),
    description: Type.String({
      description: "一句话描述这条记忆是什么；会写进 frontmatter 和 MEMORY.md 的索引行，也是 ZCode 召回时判断相关性的依据。",
    }),
    type: Type.Union(
      MEMORY_TYPES.map((value) => Type.Literal(value)),
      {
        description:
          "user（用户是谁）/ feedback（用户给过的工作方式反馈）/ project（进行中的项目事实）/ reference（外部资源位置）。",
      },
    ),
    body: Type.String({
      description: "记忆正文：一个文件一个事实。feedback / project 型按惯例写 **Why:** 与 **How to apply:**；相关记忆用 [[name]] 互链。",
    }),
    mode: Type.Union([Type.Literal("create"), Type.Literal("upsert")], {
      description: "create 遇到同名记忆报错；upsert 覆盖它并更新索引行。",
    }),
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "把一条长期事实写进与 ZCode 共用的项目记忆目录，并维护 MEMORY.md 的索引行。" +
      "记忆是长期事实（用户偏好、用户给过的工作方式反馈、项目约束、外部资源），**不是待办清单**、" +
      "也不是会随对话结束的临时状态；仓库代码、git 历史或本次任务里已经能查到的信息不要写进来。" +
      "写前先想清楚有没有已存在的记忆覆盖同一件事：有就 upsert 更新它，而不是建重复条目。",
    promptSnippet: "把长期事实写进与 ZCode 共用的项目记忆（非待办）",
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
        const action = outcome.fileAction === "created" ? "新建" : "覆盖更新";
        const indexAction =
          outcome.indexAction === "inserted" ? "新增一行" : outcome.indexAction === "updated" ? "更新该行" : "无需改动";
        return {
          content: [
            {
              type: "text",
              text:
                `已${action}记忆 ${outcome.filename}；MEMORY.md 索引${indexAction}。\n` +
                `记忆目录：${dir}\n` +
                `ZCode 侧要等它重新读索引（新会话 / 冷恢复 / /clear）才能看到这次改动；这只是同步延迟，不是写入失败。`,
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
            content: [{ type: "text", text: `写入记忆失败：${error.message}${hint}` }],
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
  const warnings = resolution.warnings.map((warning) => `\n注意：${warning}`).join("");
  return (
    `该项目尚无 ZCode 记忆：按算法算出的目录不存在（${resolution.computedDir}）。` +
    `memory_write 会创建它；如果 ZCode 侧确实已经写过记忆，用配置里的 dir 显式指定目录。` +
    `${warnings}`
  );
}

function formatMemoryListResult(resolution: MemoryDirResolution): string {
  const dir = resolution.dir;
  if (dir === undefined) return noMemoryDirText(resolution);
  const entries = listMemoryFiles(dir);
  const warnings = resolution.warnings.map((warning) => `注意：${warning}`).join("\n");
  const header = `记忆目录：${dir}\n事实文件：${entries.length} 个`;
  const body =
    entries.length === 0
      ? "（没有事实文件）"
      : entries
          .map((entry) => {
            const mtime = new Date(entry.mtimeMs).toISOString();
            if (entry.malformed) {
              return `- ${entry.filename}（frontmatter 无法解析：按 ZCode 规则视为无描述条目；修改时间 ${mtime}）`;
            }
            const type = entry.type === undefined ? "" : ` [${entry.type}]`;
            const description = entry.description === undefined ? "" : ` — ${entry.description}`;
            const name = entry.name === undefined ? "" : ` ${entry.name}`;
            return `- ${entry.filename}${type}${name}${description}（修改时间 ${mtime}）`;
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
  lines.push(`文件：${memory.filename}`);
  lines.push(
    frontmatter.malformed
      ? "frontmatter：无法解析（按 ZCode manifest 规则视为无描述条目）"
      : `name：${frontmatter.name ?? "（无）"}；description：${frontmatter.description ?? "（无描述）"}；type：${frontmatter.type ?? "（未标注）"}`,
  );
  lines.push(`大小：${memory.sizeBytes} 字节；修改时间：${new Date(memory.mtimeMs).toISOString()}`);
  lines.push("");
  lines.push(truncated.text.length === 0 ? "（正文为空）" : truncated.text);
  if (truncated.truncated) {
    const why =
      truncated.reason === "lines"
        ? "前 200 行"
        : truncated.reason === "bytes"
          ? "4096 字节"
          : "前 200 行 / 4096 字节";
    lines.push("");
    lines.push(`（正文已截断：与 ZCode 召回一致，这里最多读取${why}。完整内容请用内置 read 工具读 ${memory.absolutePath}。）`);
  }
  return lines.join("\n");
}

function buildInjectionText(dir: string, indexText: string, truncated: boolean): string {
  const lines = [
    "以下是你在这个项目里的跨会话自动记忆索引。它记录的是长期事实（用户是谁、给过的工作方式反馈、项目在做的事、外部资源位置），不是本轮任务的待办清单。",
    "",
    `记忆目录：${dir}`,
    `索引：${join(dir, INDEX_FILENAME)}（只有索引会出现在上下文里；正文按需用 memory_read 读，不要凭索引行臆断正文内容）`,
  ];
  if (truncated) lines.push("本次注入的索引是截断后的片段（见末尾 WARNING）。");
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
