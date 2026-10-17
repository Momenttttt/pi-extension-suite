/**
 * 扩展入口：给内置 `edit` / `write` 加上"先读 + 读水位新鲜度"硬约束。
 *
 * 分层（越靠下越纯，纯层不 import pi，便于 S1 单测）：
 *   - `src/gate.ts`    路径键、门禁判定表、阻断文案
 *   - `src/state.ts`   读态表（记录 / LRU）
 *   - `src/replay.ts`  从会话条目重建读态（resume / 压缩 / 切分支）
 *   - `src/config.ts`  全局 + 项目配置深合并
 *   - `src/bridge.ts`  与记忆插件的读态互通契约
 *   - 本文件           事件接线：把 pi 的真实事件折算成上面的输入
 *
 * 注意：pi 1.3.0 的 `types.d.ts` 导出了 `isToolResultEvent`，但
 * **运行时并没有实现**（已实测：`import` 得到 `undefined`，调用即抛）。这里只使用
 * 实测存在的 `isReadToolResult` / `isEditToolResult` / `isWriteToolResult` 与
 * `isToolCallEventType`。
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  isEditToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";

import { READ_STATE_EVENT, type ReadStateEventPayload } from "../src/bridge.ts";
import { loadConfig, type ReadGuardConfig } from "../src/config.ts";
import {
  decideWriteGate,
  displayPathOf,
  hashContent,
  normalizePathKey,
  type WriteGateCode,
} from "../src/gate.ts";
import { replayReadState, type SessionEntryLike } from "../src/replay.ts";
import { ReadStateTable } from "../src/state.ts";

const readGuard: ExtensionFactory = (pi: ExtensionAPI): void => {
  const table = new ReadStateTable();
  let config: ReadGuardConfig | undefined;
  /** 最近一次回调给出的会话 cwd，供事件总线的读态登记算路径键用。 */
  let sessionCwd: string | undefined;

  const configOf = (ctx: ExtensionContext): ReadGuardConfig => {
    sessionCwd = ctx.cwd;
    config ??= loadConfig(ctx.cwd);
    return config;
  };

  const rebuild = (ctx: ExtensionContext, firstKeptEntryId?: string | null): void => {
    const manager = ctx.sessionManager;
    // 重建是"整表替换"而不是"继续累积"：表的内容必须完全由当前分支的条目决定，
    // 否则上一次会话（或另一条分支）留下的记录会污染判定。
    // `getBranch()` 返回 pi 的 `SessionEntry` 联合类型；replay 只读结构化字段，
    // 收窄到自己的最小形状即可（也为将来 pi 给条目加字段留出余量）。
    const branch = manager.getBranch() as unknown as SessionEntryLike[];
    replayReadState(table, branch, {
      cwd: manager.getCwd() || ctx.cwd,
      ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
    });
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    rebuild(ctx);
  });

  // 换分支：另一条分支上的读记录不能串台
  pi.on("session_tree", (_event, ctx) => {
    rebuild(ctx);
  });

  // 压缩：**不清空整表**，只按 `firstKeptEntryId` 之后的保留尾部重建。
  // 落在摘要区里的读记录自然消失 → 模型必须重读，这是正确的保守行为。
  pi.on("session_compact", (event, ctx) => {
    rebuild(ctx, event.compactionEntry.firstKeptEntryId);
  });

  pi.on("session_shutdown", () => {
    table.clear();
  });

  // 记忆插件通过共享事件总线登记"某路径刚被读过"。任一方缺席时静默降级。
  pi.events.on(READ_STATE_EVENT, (payload) => {
    const record = payload as ReadStateEventPayload | undefined;
    if (!record || typeof record.path !== "string" || typeof record.mtimeMs !== "number") return;
    // 事件的载荷没有 cwd（发布方只有一个路径），但接收方总会先经过至少一次带 ctx 的回调
    // （`session_start` 最迟在第一次工具调用前必然跑到），所以用记下来的会话 cwd 算键，
    // 而不是 `process.cwd()`——后者在宿主从别处启动 pi 时是错的。
    const cwd = sessionCwd ?? process.cwd();
    table.set({
      key: normalizePathKey(record.path, { cwd }),
      absolutePath: record.path,
      mtimeMs: record.mtimeMs,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : 0,
      contentHash: typeof record.contentHash === "string" ? record.contentHash : undefined,
      kind: record.kind === "ranged" || record.kind === "truncated" ? record.kind : "full",
      source: "external",
      readAtMs: Date.now(),
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    const configNow = configOf(ctx);
    if (!configNow.enabled) return;

    // `tool_result` 的 `input` 在 pi 里类型是 `Record<string, unknown>`（不像 `tool_call`
    // 会按工具名收窄），但运行时就是该工具的原始参数。这里按工具名取值并逐项校验，
    // 不信任形状。
    if (isReadToolResult(event) && !event.isError) {
      recordReadResult(event.input, event.details, event.content, ctx.cwd);
      return;
    }
    if (isWriteToolResult(event) && !event.isError) {
      const path = stringField(event.input, "path");
      const content = stringField(event.input, "content");
      if (path !== undefined && content !== undefined) recordWrittenFile(path, content, ctx.cwd);
      return;
    }
    if (isEditToolResult(event) && !event.isError) {
      const path = stringField(event.input, "path");
      if (path !== undefined) recordEditedFile(path, ctx.cwd);
      return;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    const configNow = configOf(ctx);
    if (!configNow.enabled) return;

    const key = normalizePathKey(event.input.path, { cwd: ctx.cwd });
    const absolutePath = absolutePathOf(event.input.path, ctx.cwd);

    let currentMtimeMs: number | undefined;
    try {
      currentMtimeMs = Math.floor(statSync(absolutePath).mtimeMs);
    } catch {
      currentMtimeMs = undefined;
    }

    // 只有 mtime 前进时才有必要读盘算内容 hash（内容等价逃逸）
    let currentContentHash: string | undefined;
    const entry = table.get(key);
    if (
      currentMtimeMs !== undefined &&
      entry?.kind === "full" &&
      entry.contentHash !== undefined &&
      currentMtimeMs > entry.mtimeMs
    ) {
      currentContentHash = await hashFile(absolutePath);
    }

    const decision = decideWriteGate(
      {
        key,
        displayPath: displayPathOf(absolutePath, ctx.cwd),
        currentMtimeMs,
        currentContentHash,
        entry,
      },
      configNow.messages,
    );
    if (decision.action === "allow") return;

    if (configNow.mode === "warn") {
      ctx.ui.notify(`read-guard（warn）：${decision.reason ?? "写入未通过读水位检查"}`, "warning");
      return;
    }

    return {
      block: true,
      reason: withCode(decision.reason ?? "写入被 read-guard 阻断", decision.code),
    };
  });

  function recordReadResult(
    input: Record<string, unknown>,
    details: unknown,
    content: ReadonlyArray<{ type?: string; text?: string }>,
    cwd: string,
  ): void {
    const path = stringField(input, "path");
    if (path === undefined) return;
    const absolutePath = absolutePathOf(path, cwd);
    const stat = statOrUndefined(absolutePath);
    if (!stat) return;

    const truncation = (details as { truncation?: unknown } | undefined)?.truncation;
    const text = textOfContent(content);
    const hasRange = typeof input.offset === "number" || typeof input.limit === "number";
    // 图片内容（拿不到文本）记 ranged：给一个弱水位，避免"读过图再写同名文本文件"被误拒
    const kind = truncation ? "truncated" : text === undefined || hasRange ? "ranged" : "full";

    table.set({
      key: normalizePathKey(path, { cwd }),
      absolutePath,
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      contentHash: kind === "full" && text !== undefined ? hashContent(text) : undefined,
      kind,
      source: "read",
      readAtMs: Date.now(),
    });
  }

  function recordWrittenFile(path: string, content: string, cwd: string): void {
    const absolutePath = absolutePathOf(path, cwd);
    const stat = statOrUndefined(absolutePath);
    if (!stat) return;
    table.set({
      key: normalizePathKey(path, { cwd }),
      absolutePath,
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      contentHash: hashContent(content),
      kind: "full",
      source: "write",
      readAtMs: Date.now(),
    });
  }

  function recordEditedFile(path: string, cwd: string): void {
    const absolutePath = absolutePathOf(path, cwd);
    const stat = statOrUndefined(absolutePath);
    if (!stat) return;
    // edit 不额外读盘算 hash：没有 hash 意味着"mtime 一动就必须重读"，偏保守但便宜
    table.set({
      key: normalizePathKey(path, { cwd }),
      absolutePath,
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      contentHash: undefined,
      kind: "full",
      source: "edit",
      readAtMs: Date.now(),
    });
  }
};

export default readGuard;
export { readGuard as readGuardFactory };
export type { ReadGuardConfig };

function withCode(reason: string, code: WriteGateCode | undefined): string {
  return code ? `${reason}\n（read-guard: ${code}）` : reason;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function absolutePathOf(path: string, cwd: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(path)) return path;
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${path}`;
}

function statOrUndefined(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
  } catch {
    return undefined;
  }
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    return hashContent((await readFile(path)).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 全部是文本块时才给拼接结果；含图片等其它块时返回 undefined。 */
function textOfContent(content: ReadonlyArray<{ type?: string; text?: string }>): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("");
}
