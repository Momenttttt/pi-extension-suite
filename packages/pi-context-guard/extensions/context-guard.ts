/**
 * 扩展入口：补上 pi 缺的两层客户端上下文能力——微压缩（较早的工具结果换占位符）与
 * snip（模型可主动指认一段历史，让它从模型上下文里消失，可撤销）。
 *
 * pi 原生的压缩（compaction）保持原样，本插件不重写它（ADR-0004）：不动摘要提示词、
 * 不动阈值、不动 overflow 恢复。我们只做三件事：
 *   1. `context` 事件里做**请求局部**改写：占位符 + 用户消息短 id 投影。只改本次请求，
 *      不落盘（pi 的契约：`context` 变换后 Pi 会把 prompt/tool 状态恢复回去）。
 *   2. 用 `pi.appendEntry` 冻结"清理水位"，让相邻请求拿到同一清理集合（决策稳定，
 *      否则 prompt 缓存前缀每次请求都被改写）。
 *   3. snip：工具只入队 + 持久化；真正的 `context_edit` 由 `turn_end`（首选）或
 *      `agent_before_settle`（兜底）提交——pi 只有边界处理器能写条目。
 *
 * 分层（越靠下越纯，纯层不 import pi，便于 S1 单测）：
 *   - `src/messages.ts` 消息结构工具
 *   - `src/clear.ts`    可清理白名单、选择集、占位符替换
 *   - `src/trigger.ts`  两档触发（空闲 / 体积）与降压力
 *   - `src/snip.ts`     短 id 投影、区间解析与校验
 *   - `src/state.ts`    水位、统计、待提交队列、失败计数
 *   - `src/config.ts`   全局 + 项目配置深合并
 *   - 本文件            事件/工具/命令接线
 *
 * 关于 `{ cancel: true }` 的实测结论（票据 10 的"先实测"项，跑法见
 * `test/compaction-fuse.test.ts`）：在 `reason: "threshold"` 场景下 `session_before_compact`
 * 返回 `{ cancel: true }` 的真实行为是——pi 抛 "Compaction cancelled" 并立刻吞掉，发
 * `session_compact_failed`（`aborted: true`、`errorMessage: undefined`），**不压缩、不重试**；
 * 下一轮只要上下文还超阈值就再取消一次，于是上下文继续涨到 overflow。overflow 路径上的
 * 取消还会直接掐掉唯一一次 compact-and-retry 恢复。所以本插件**绝不返回 cancel**；
 * 失败熔断做成"降压力"：记失败次数、下一次请求强制按体积档清一次、连续 ≥3 次明确告警。
 */
import { Text } from "@earendil-works/pi-tui";
import type {
  BoundaryResult,
  ContextEditEntryDraft,
  CustomEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  applyClearPlaceholders,
  selectClearableResults,
  type ClearableToolOptions,
} from "../src/clear.ts";
import { loadConfig, type ContextGuardConfig } from "../src/config.ts";
import {
  isRecord,
  isUserMessage,
  messageTimestampMs,
  type MessageLike,
} from "../src/messages.ts";
import {
  appendShortIdToContent,
  resolveSnipTargets,
  shortIdOf,
  type ProjectedItem,
} from "../src/snip.ts";
import {
  ContextGuardState,
  PENDING_SNIP_ENTRY,
  PENDING_UNSNIP_ENTRY,
  shouldWarnCompactionFailures,
  SNIP_APPLIED_ENTRY,
  UNSNIP_APPLIED_ENTRY,
  WATERMARK_ENTRY,
  type SnipAuditData,
} from "../src/state.ts";
import { decideClearTrigger } from "../src/trigger.ts";

/** `/ctx` 的子命令（也是参数补全的来源）。 */
/**
 * `/ctx` 的子命令。
 *
 * 这里**特意不叫 `compact`**：pi 内建有一个 `/compact`（"Manually compact the session context"），
 * 那是"调模型把较早历史总结成摘要"的有损操作；我们做的是"把较早的工具结果换成占位符"的机械清理
 * ——不调模型、可逆、也不影响自动压缩的触发点。同一个词指两件事正是 GLOSSARY 明令禁止的混用
 * （压缩 vs 微压缩），放到斜杠命令上就是给用户下绊子。所以叫 `prune`。
 */
const CTX_SUBCOMMANDS = ["prune", "undo-snip"] as const;

const contextGuard: ExtensionFactory = (pi: ExtensionAPI): void => {
  const state = new ContextGuardState();
  let config: ContextGuardConfig | undefined;

  const configOf = (ctx: ExtensionContext): ContextGuardConfig => {
    config ??= loadConfig(ctx.cwd);
    return config;
  };

  const clearOptionsOf = (configNow: ContextGuardConfig): ClearableToolOptions => ({
    clearSubagentResults: configNow.clearSubagentResults,
    clearMemoryResults: configNow.clearMemoryResults,
  });

  /** 当前分支投影成"条目 id + 消息"的对，短 id 解析与恢复原文都基于它。 */
  const branchItems = (ctx: ExtensionContext): ProjectedItem[] => {
    const items: ProjectedItem[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      for (const message of sessionEntryToContextMessages(entry)) {
        items.push({ entryId: entry.id, message: message as unknown as MessageLike });
      }
    }
    return items;
  };

  const customEntries = (ctx: ExtensionContext): unknown[] =>
    ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom");

  /** 从原条目取回投影正文，供撤销时的恢复性 `context_edit` 用。 */
  const originalContentOf = (ctx: ExtensionContext, entryId: string): unknown => {
    const entry = ctx.sessionManager.getEntry(entryId);
    if (!entry) return undefined;
    const messages = sessionEntryToContextMessages(entry) as unknown[];
    const first = messages[0];
    return isRecord(first) ? first.content : undefined;
  };

  // ------------------------------------------------------------------ 生命周期

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    state.hydrate(customEntries(ctx));
  });

  // 切分支：水位与已裁剪集合都要按新分支重建（旧分支的条目不代表当前历史）
  pi.on("session_tree", (_event, ctx) => {
    state.hydrate(customEntries(ctx));
  });

  // 压缩成功：投影换了一套，水位重置；统计与待提交队列保留（设计 §6.5）
  pi.on("session_compact", () => {
    state.onCompaction();
  });

  pi.on("session_compact_failed", (event, ctx) => {
    state.recordFailure();
    if (shouldWarnCompactionFailures(state.failures)) {
      notify(ctx, 
        `context-guard：连续 ${state.failures} 次压缩失败（reason: ${event.reason}），已改为按体积档降压力；建议手动 /compact 或换模型。`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    state.reset();
  });

  // ------------------------------------------------------------------ 微压缩 + 短 id 投影

  pi.on("context", (event, ctx) => {
    const configNow = configOf(ctx);
    if (!configNow.enabled) return;

    const messages = event.messages as unknown as MessageLike[];
    const options = clearOptionsOf(configNow);

    // 选择集只依赖消息序列 + 冻结水位；触发档位可以看时间，但结果一旦推进就冻结下来。
    const base = selectClearableResults({
      messages,
      options,
      keepRecent: configNow.keepRecent,
      watermark: state.watermark,
      extend: false,
    });
    const decision = decideClearTrigger({
      selection: base,
      messages,
      keepRecent: configNow.keepRecent,
      maxClearableBytes: configNow.maxClearableBytes,
      gapThresholdMinutes: configNow.gapThresholdMinutes,
      now: Date.now(),
      autoVolumeTrigger: configNow.autoVolumeTrigger,
      pressureRelief: state.reliefPending,
    });
    const plan = decision.extend
      ? selectClearableResults({
          messages,
          options,
          keepRecent: configNow.keepRecent,
          watermark: state.watermark,
          extend: true,
        })
      : base;
    if (decision.extend && plan.extended) {
      state.promoteWatermark(plan, decision.mode);
      state.reliefPending = false;
    }

    const projected = projectShortIds(messages);
    const cleared = applyClearPlaceholders(projected.messages, plan.targets, configNow.placeholder);
    if (!cleared.changed && !projected.changed) return;
    // `context` 只认消息数组本身；这里返回的就是 provider 会收到的转录（不落盘）。
    return { messages: cleared.messages as never };
  });

  // ------------------------------------------------------------------ 边界提交

  const commitBoundary = (ctx: ExtensionContext): BoundaryResult | undefined => {
    const entries: SessionBoundaryDraft[] = [];
    if (state.pendingOps().length > 0) {
      const drained = state.drain(Date.now());
      const snipEdits: ContextEditEntryDraft[] = drained.snips.map((op) => ({
        type: "context_edit",
        targetId: op.entryId,
        replacement: null,
      }));
      const restoreEdits: ContextEditEntryDraft[] = [];
      for (const op of drained.restores) {
        const content = originalContentOf(ctx, op.entryId);
        if (content === undefined) continue;
        restoreEdits.push({
          type: "context_edit",
          targetId: op.entryId,
          replacement: { content: content as never },
        });
      }
      entries.push(...snipEdits, ...restoreEdits);
      if (snipEdits.length > 0) {
        entries.push(
          customDraft<SnipAuditData>(SNIP_APPLIED_ENTRY, {
            count: snipEdits.length,
            targetIds: snipEdits.map((draft) => draft.targetId),
            shortIds: drained.snips.map((op) => op.shortId ?? ""),
            at: Date.now(),
          }),
        );
      }
      if (restoreEdits.length > 0) {
        entries.push(
          customDraft<SnipAuditData>(UNSNIP_APPLIED_ENTRY, {
            count: restoreEdits.length,
            targetIds: restoreEdits.map((draft) => draft.targetId),
            shortIds: [],
            at: Date.now(),
          }),
        );
      }
    }
    if (state.consumeWatermarkDirty()) {
      entries.push(customDraft(WATERMARK_ENTRY, state.watermarkData(Date.now())));
    }
    return entries.length > 0 ? { entries } : undefined;
  };

  pi.on("turn_end", (_event, ctx) => commitBoundary(ctx));
  pi.on("agent_before_settle", (_event, ctx) => commitBoundary(ctx));

  // ------------------------------------------------------------------ snip 工具

  pi.registerTool({
    name: "snip",
    label: "Snip history",
    description:
      "把一段较早的对话历史从模型上下文中裁剪掉，让后续请求变小。被裁剪的消息仍在会话文件里，可用 /ctx undo-snip 撤销。只在早期内容确定不再需要时使用；不要裁当前正在进行的回合。",
    promptSnippet: "裁剪不再需要的较早历史（无损、可撤销）",
    promptGuidelines: [
      "对话很长、早期的工具结果不再需要时，用 snip 裁剪更早的历史，而不是要求用户重开会话。",
    ],
    parameters: Type.Object({
      from: Type.String({
        description: "区间起点：某条用户消息末尾 [id:xxxxxx] 里的 6 位短 id",
      }),
      to: Type.String({
        description: "区间终点：同一套短 id；必须晚于 from，且不能是本回合的用户消息",
      }),
      reason: Type.Optional(Type.String({ description: "裁剪理由，会记进会话审计条目" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const configNow = configOf(ctx);
      if (!configNow.enabled) {
        throw new Error("context-guard 已禁用（enabled: false），snip 不可用。");
      }
      const resolved = resolveSnipTargets(branchItems(ctx), params.from, params.to);
      if (!resolved.ok) throw new Error(resolved.error);

      for (const entryId of resolved.targetIds) {
        state.queueSnip(entryId, resolved.shortIds[0]);
      }
      pi.appendEntry(PENDING_SNIP_ENTRY, {
        targetIds: resolved.targetIds,
        shortIds: resolved.shortIds,
        ...(params.reason === undefined ? {} : { reason: params.reason }),
        at: Date.now(),
      });
      const count = resolved.targetIds.length;
      return {
        content: [
          {
            type: "text" as const,
            text: `已排队裁剪 ${count} 条历史（${resolved.shortIds[0]}..${resolved.shortIds[resolved.shortIds.length - 1]}），本回合结束后生效，模型下一回合就看不到它们；原始记录仍在会话里，可用 /ctx undo-snip 撤销。`,
          },
        ],
        details: { count, shortIds: resolved.shortIds, reason: params.reason },
      };
    },
  });

  // ------------------------------------------------------------------ /ctx 状态命令

  pi.registerCommand("ctx", {
    description: "上下文占用与清理状态；子命令 prune / undo-snip",
    getArgumentCompletions: (prefix) =>
      CTX_SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({
        value: sub,
        label: sub,
        description:
          sub === "prune"
            ? "立刻按体积档清理较早的工具结果（不调模型、可逆；与 pi 内建的 /compact 不是一回事）"
            : "撤销最近一次裁剪",
      })),
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "prune") {
        runManualCompact(pi, state, ctx, configOf(ctx));
        return;
      }
      if (sub === "undo-snip") {
        runUndoSnip(pi, state, ctx);
        return;
      }
      notify(ctx, statusReport(state, ctx), state.failures >= 3 ? "warning" : "info");
    },
  });

  // ------------------------------------------------------------------ 渲染

  pi.registerEntryRenderer<SnipAuditData>(SNIP_APPLIED_ENTRY, (entry, _options, theme) =>
    new Text(theme.fg("dim", `已裁剪 ${entry.data?.count ?? 0} 条历史（可撤销）`), 0, 0),
  );
  pi.registerEntryRenderer<SnipAuditData>(UNSNIP_APPLIED_ENTRY, (entry, _options, theme) =>
    new Text(theme.fg("dim", `已恢复 ${entry.data?.count ?? 0} 条历史`), 0, 0),
  );
};

function customDraft<T>(customType: string, data: T): CustomEntryDraft {
  return { type: "custom", customType, data };
}

/**
 * 用户消息短 id 投影：只在请求副本上追加 `\n[id:xxxxxx]`（存储副本不动）。
 *
 * 幂等：内容已经以 `[id:...]` 结尾的消息不重复追加，避免扩展重入或测试叠加时出现双后缀。
 */
function projectShortIds(messages: readonly MessageLike[]): {
  messages: MessageLike[];
  changed: boolean;
} {
  let changed = false;
  const rewritten = messages.map((message) => {
    if (!isUserMessage(message)) return message;
    const timestamp = messageTimestampMs(message);
    if (timestamp === undefined) return message;
    if (hasTrailingShortId(message.content)) return message;
    changed = true;
    return { ...message, content: appendShortIdToContent(message.content, shortIdOf("user", timestamp)) };
  });
  return { messages: changed ? rewritten : [...messages], changed };
}

const SHORT_ID_SUFFIX = /\[id:[0-9a-z]{6}\]\s*$/;

function hasTrailingShortId(content: unknown): boolean {
  if (typeof content === "string") return SHORT_ID_SUFFIX.test(content);
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if (typeof text === "string") return SHORT_ID_SUFFIX.test(text);
  }
  return false;
}

/**
 * `/ctx prune`：用**体积档的选择集**立刻清一次（不等空闲）。
 *
 * 命令在主线程执行，可以安全地直接推进水位并落盘；下一次请求就会变小。
 *
 * 体积档的定义本身包含阈值：保留尾部之外的可清理正文合计要超过 `maxClearableBytes`
 * （设计 §2.3）。所以这里先按 `extend: false` 算一遍统计、比对阈值，只有真的越线才动手；
 * 不然"体积档选择集"就只是"清掉所有能清的"，与文档承诺的不是同一个东西。
 */
function runManualCompact(
  pi: ExtensionAPI,
  state: ContextGuardState,
  ctx: ExtensionContext,
  configNow: ContextGuardConfig,
): void {
  const messages = ctx.sessionManager
    .buildSessionProjection()
    .messages as unknown as MessageLike[];
  const options = {
    clearSubagentResults: configNow.clearSubagentResults,
    clearMemoryResults: configNow.clearMemoryResults,
  };
  const measurement = selectClearableResults({
    messages,
    options,
    keepRecent: configNow.keepRecent,
    watermark: state.watermark,
    extend: false,
  });
  if (measurement.pendingBytesBeyondKeepRecent <= configNow.maxClearableBytes) {
    notify(ctx,
      `context-guard：保留最近 ${configNow.keepRecent} 条之外的可清理正文只有 ≈${formatBytes(measurement.pendingBytesBeyondKeepRecent)}，` +
        `没超过体积档阈值 ${formatBytes(configNow.maxClearableBytes)}，这次的体积档不适用。` +
        "（空闲档会在会话空闲后自动清；要调整阈值改 maxClearableBytes。）",
      "info",
    );
    return;
  }
  const plan = selectClearableResults({
    messages,
    options,
    keepRecent: configNow.keepRecent,
    watermark: state.watermark,
    extend: true,
  });
  if (!plan.extended) {
    notify(ctx, 
      `context-guard：没有可清理的结果（保留最近 ${configNow.keepRecent} 条，或已全部清理）。`,
      "info",
    );
    return;
  }
  state.promoteWatermark(plan, "manual");
  pi.appendEntry(WATERMARK_ENTRY, state.watermarkData(Date.now()));
  notify(ctx, 
    `context-guard：已清理 ${plan.extendedTargets.length} 条较早的工具结果（≈${formatBytes(plan.extendedTargets.reduce((sum, target) => sum + target.bytes, 0))} 正文），下一次请求生效。`,
    "info",
  );
}

/** `/ctx undo-snip`：把最近一次仍生效的裁剪排进恢复队列，下一个回合边界提交。 */
function runUndoSnip(pi: ExtensionAPI, state: ContextGuardState, ctx: ExtensionContext): void {
  const targets = state.activeSnipTargets();
  if (targets.length === 0) {
    notify(ctx, "context-guard：没有可撤销的裁剪。", "info");
    return;
  }
  for (const entryId of targets) state.queueSnip(entryId, undefined, "restore");
  pi.appendEntry(PENDING_UNSNIP_ENTRY, { targetIds: targets, at: Date.now() });
  notify(ctx, 
    `context-guard：已排队恢复 ${targets.length} 条历史，将在下一次回合边界生效（原始记录从未离开会话文件）。`,
    "info",
  );
}

/** `/ctx` 状态：占用、清理统计、CC 对照、子命令、失败计数。 */
function statusReport(state: ContextGuardState, ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const usageLine = usage
    ? `上下文占用：${usage.tokens ?? "?"} / ${usage.contextWindow} tokens${
        usage.percent === null ? "" : `（${usage.percent.toFixed(1)}%）`
      }`
    : "上下文占用：暂不可用（还没有一次模型应答）";
  const lines = [
    usageLine,
    `清理统计：本会话已清理 ${state.totalCount} 条较早的工具结果，省下 ≈${formatBytes(state.totalBytes)} 正文${
      state.lastMode === "" ? "" : `（最近档位：${state.lastMode}）`
    }`,
    `决策稳定性：清理集合按冻结水位计算，相邻请求一致（水位${state.watermark ? "已冻结" : "未推进"}）`,
    `裁剪：${state.activeSnipCount()} 条已裁剪（可撤销）`,
    `压缩失败：连续 ${state.failures} 次${state.failures >= 3 ? "——建议手动 /compact 或换模型" : ""}`,
    "CC 对照：pi 默认阈值 = 窗口 − reserveTokens(16384)，比 Claude Code 更早触发；要贴近 CC 可设 compaction.reserveTokens = 33000",
    "子命令：/ctx prune 立刻清理较早的工具结果（不调模型、可逆；区别于 pi 内建的 /compact 汇总）；/ctx undo-snip 撤销最近一次裁剪",
  ];
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
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

export default contextGuard;
export { contextGuard as contextGuardFactory };
export type { ContextGuardConfig };
