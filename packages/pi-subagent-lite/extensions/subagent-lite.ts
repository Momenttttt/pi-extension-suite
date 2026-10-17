/**
 * 扩展入口：md 档案定义的子代理 + 模型可调用的 `subagent` 工具。
 *
 * 分层（越靠下越纯，纯层不 import pi，便于 S1 单测）：
 *   - `src/frontmatter.ts`  YAML 子集解析
 *   - `src/profile.ts`      档案字段、旧字段名兼容、解析告警
 *   - `src/builtin-agents.ts` 两个内置代理（数据）
 *   - `src/discovery.ts`    层序、项目目录发现、同名整文件替换
 *   - `src/selection.ts`    工具池/模型/思考档位的折算
 *   - `src/registry.ts`     同类扩展冲突检测
 *   - `src/report.ts`       `/agents` 文本
 *   - `src/result.ts` / `src/usage.ts`  结果形状、摘要行、用量折算
 *   - 本文件                事件与工具接线、子会话装配
 *
 * 三处"实测出来的契约"，改动前先看注释：
 *   - `pi.getAllTools()` 在扩展加载期不可用（抛 "Extension runtime not initialized"），
 *     只能在 `session_start` 或工具/命令上下文里调
 *   - `createAgentSession` 若不传 `modelRuntime`，子会话会自己建一个——父会话里由扩展注册的
 *     provider 在子会话里**不存在**，`model: inherit` 会直接失败（详见 `parentModelRuntime`）
 *   - 子会话的守卫注入路径不能只靠 `import.meta.resolve`（jiti 下会抛），详见 `src/guard.ts`
 */
import { fileURLToPath } from "node:url";

import type {
  AgentSession,
  ExtensionContext,
  ExtensionFactory,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/**
 * pi 的包根**不导出** `Model` / `ThinkingLevel`（它们在 `@earendil-works/pi-ai` /
 * `pi-agent-core` 里，而 pi 的 exports map 不暴露那两个入口）。从 `ExtensionContext`
 * 的字段上取类型，既不碰内网路径，也保证跟着本机 pi 的版本走。
 */
type SessionModel = NonNullable<ExtensionContext["model"]>;
type SessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

import { DEFAULT_AGENT_NAME } from "../src/builtin-agents.ts";
import { loadConfig, resolveAgentDir, type SubagentLiteConfig } from "../src/config.ts";
import { loadAgentListing, type AgentListing } from "../src/discovery.ts";
import {
  describeGuardInjection,
  guardNeedsWarning,
  resolveGuardInjection,
  type GuardInjection,
} from "../src/guard.ts";
import type { AgentProfile } from "../src/profile.ts";
import { describeConflicts, findForeignSubagentTools } from "../src/registry.ts";
import { formatAgentsReport, startupWarning } from "../src/report.ts";
import {
  MAX_RESULT_BYTES,
  composeResultContent,
  type SubagentDetails,
  type SubagentStatus,
} from "../src/result.ts";
import {
  isMalformedModelSpec,
  parseModelSpec,
  resolveThinking,
  toolSelectionFor,
} from "../src/selection.ts";
import { EMPTY_USAGE, usageFromSessionStats } from "../src/usage.ts";

/** 本扩展文件自己的路径（冲突检测用来判"这个 subagent 工具是不是我们的"）。 */
const OWN_EXTENSION_PATH = fileURLToPath(import.meta.url);

const SUBAGENT_PARAMS = Type.Object({
  description: Type.String({
    description: "Short (3-8 word) description of the delegated task, for display.",
  }),
  prompt: Type.String({
    description:
      "The full task for the subagent. It cannot see this conversation, so include all context it needs.",
  }),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Agent profile to run: Explore (read-only search) or general-purpose (default). Use /agents to list the loaded profiles.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Model override in "provider/model" form, or "inherit". Defaults to the selected profile\'s model.',
    }),
  ),
});

type SubagentParams = Static<typeof SUBAGENT_PARAMS>;

interface SessionState {
  config: SubagentLiteConfig;
  listing: AgentListing;
  conflicts: string[];
  /** 子会话要注入的扩展路径（票据 14：守卫）。 */
  guard: GuardInjection;
  agentDir: string;
}

/** 子会话装配的入参（`createChildSession` 是装配的唯一入口）。 */
interface ChildSessionRequest {
  cwd: string;
  agentDir: string;
  profile: AgentProfile;
  model: SessionModel | undefined;
  thinkingLevel: SessionThinkingLevel | undefined;
  /** 父会话的 model runtime；拿不到时退回"子会话自建"（见 `parentModelRuntime`）。 */
  modelRuntime: ModelRuntime | undefined;
  /** 子会话额外加载的扩展路径（票据 14 的守卫注入走这里）。 */
  extensionPaths: string[];
}

const subagentLite: ExtensionFactory = (pi) => {
  let state: SessionState | undefined;

  /** 读配置 + 扫档案 + 扫同类工具。任何一步失败都不能让插件崩。 */
  const reload = (ctx: ExtensionContext): SessionState => {
    const agentDir = resolveAgentDir();
    const config = loadConfig(ctx.cwd, { agentDir });
    const listing = loadAgentListing({ cwd: ctx.cwd, agentDir });
    state = {
      config,
      listing,
      conflicts: config.enabled ? collectConflicts(pi) : [],
      guard: resolveGuardInjection(config),
      agentDir,
    };
    return state;
  };

  /** `pi.getAllTools()` 依赖扩展运行时已绑定；加载期调用会抛，所以容错成"暂时没冲突"。 */
  const collectConflicts = (api: typeof pi): string[] => {
    try {
      const tools = api.getAllTools();
      return describeConflicts(findForeignSubagentTools(tools, { ownPath: OWN_EXTENSION_PATH }));
    } catch {
      return [];
    }
  };

  const stateOf = (ctx: ExtensionContext): SessionState => state ?? reload(ctx);

  pi.on("session_start", (_event, ctx) => {
    const current = reload(ctx);
    if (!current.config.enabled) return;
    const warning = startupWarning({
      listing: current.listing,
      conflicts: current.conflicts,
      canResolve: (provider, id) => ctx.modelRegistry.find(provider, id) !== undefined,
      ...(ctx.model ? { sessionModel: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
    });
    if (warning !== undefined) ctx.ui.notify(warning, current.conflicts.length > 0 ? "error" : "warning");
    if (guardNeedsWarning(current.guard)) {
      // 降级要明说：不注入守卫时子代理不再受"先读后写"约束
      ctx.ui.notify(describeGuardInjection(current.guard), "warning");
    }
  });

  pi.on("session_shutdown", () => {
    state = undefined;
  });

  pi.registerCommand("agents", {
    description: "列出 subagent-lite 生效的代理档案、被跳过的文件与冲突",
    handler: async (_args, ctx) => {
      const current = stateOf(ctx);
      ctx.ui.notify(
        formatAgentsReport({
          listing: current.listing,
          canResolve: (provider, id) => ctx.modelRegistry.find(provider, id) !== undefined,
          conflicts: current.conflicts,
          guard: describeGuardInjection(current.guard),
          ...(ctx.model ? { sessionModel: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
        }),
        "info",
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate one self-contained task to a subagent that runs in this process with its own isolated context: it sees only the prompt you pass, plus its own system prompt. Use it to keep large searches or multi-step edits out of this conversation. Explore is read-only search; general-purpose can edit files. The subagent cannot delegate further and cannot see this conversation, so pass everything it needs in prompt; it returns its final text plus a one-line summary.",
    promptSnippet:
      "Delegate a self-contained task to a subagent with its own isolated context (Explore: read-only search, general-purpose: can edit).",
    promptGuidelines: [
      "Use subagent for work that would flood this context (broad searches, multi-file changes); the subagent does not see this conversation, so pass all needed context in prompt.",
    ],
    parameters: SUBAGENT_PARAMS,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      return runSubagent(ctx, params, signal ?? ctx.signal);
    },
  });

  /** `subagent` 工具的全部逻辑。 */
  async function runSubagent(
    ctx: ExtensionContext,
    params: SubagentParams,
    signal: AbortSignal | undefined,
  ) {
    const current = stateOf(ctx);
    if (!current.config.enabled) {
      return errorResult("subagent-lite 已在配置里关闭（enabled: false）。");
    }

    const requested = (params.subagent_type ?? DEFAULT_AGENT_NAME).trim();
    const profile = findProfile(current.listing, requested);
    if (profile === undefined) {
      const names = current.listing.agents.map((agent) => agent.name).join("、");
      return errorResult(`没有名为 ${requested} 的代理档案。可用：${names}（/agents 看详情）。`);
    }

    if (params.model !== undefined && isMalformedModelSpec(params.model)) {
      return errorResult(
        `model 参数 "${params.model}" 无法解析：只接受 "provider/model" 形式或 "inherit"。`,
      );
    }

    const modelChoice = resolveModel(ctx, profile, params.model);
    if (modelChoice.error !== undefined) return errorResult(modelChoice.error);

    const notes: string[] = [];
    if (modelChoice.note !== undefined) notes.push(modelChoice.note);

    const thinking = resolveThinking(profile.thinking, ctx.thinkingLevel);
    if (thinking.inheritedButUnknown) {
      notes.push("[subagent] 会话没有 thinking 档位信息，thinking 走 pi 的默认值。");
    }

    const modelRuntime = parentModelRuntime(ctx);
    if (modelRuntime === undefined) {
      // 不静默降级：父会话里由扩展注册的 provider 在自建 runtime 的子会话里不存在
      notes.push(
        "[subagent] 拿不到父会话的 model runtime，子会话将自建一个：" +
          "由扩展注册的 provider 在子代理里可能不可用（models.json 里的 provider 不受影响）。",
      );
    }

    const started = Date.now();
    let child: AgentSession | undefined;
    let turns = 0;
    let lastText = "";
    let abortReason: "parent" | "turns" | undefined;
    let sessionError: string | undefined;

    try {
      const created = await createChildSession({
        cwd: ctx.cwd,
        agentDir: current.agentDir,
        profile,
        model: modelChoice.model,
        thinkingLevel: thinking.level as SessionThinkingLevel | undefined,
        modelRuntime,
        extensionPaths: current.guard.paths,
      });
      child = created.session;
      if (created.modelFallbackMessage !== undefined) {
        notes.push(`[subagent] pi 报告模型回退：${created.modelFallbackMessage}`);
      }

      // 计数：实测 `message_end` 每条消息都发一次，`role === "assistant"` 即一条模型消息，
      // 与 `turn_end` 的次数一致（`turn_end` 只在工具批次结束后发，语义更粗）。
      const unsubscribe = child.subscribe((event) => {
        if (event.type !== "message_end") return;
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant") return;
        turns += 1;
        const text = textOfAssistant(message.content);
        if (text !== "") lastText = text;
        if (profile.maxTurns !== undefined && turns >= profile.maxTurns && abortReason === undefined) {
          abortReason = "turns";
          void child?.abort();
        }
      });

      const onParentAbort = () => {
        if (abortReason === undefined) abortReason = "parent";
        void child?.abort();
      };
      signal?.addEventListener("abort", onParentAbort, { once: true });
      if (signal?.aborted) onParentAbort();

      try {
        await child.prompt(params.prompt, { expandPromptTemplates: false });
      } catch (error) {
        sessionError = error instanceof Error ? error.message : String(error);
      } finally {
        signal?.removeEventListener("abort", onParentAbort);
        unsubscribe();
      }

      const stats = child.getSessionStats();
      const status: SubagentStatus = statusOf(sessionError, abortReason ?? (signal?.aborted ? "parent" : undefined));
      const details: SubagentDetails = {
        agent: profile.name,
        status,
        turns,
        toolCalls: stats.toolCalls,
        durationMs: Date.now() - started,
        usage: usageFromSessionStats(stats),
        // 只表示正文被 100k 上限截断；maxTurns 到点停由 status 表达（设计文档把两者混用
        // 同一个字段，这里拆开——合成一个布尔就把"结果被截断"和"没跑完"两件事糊住了）
        truncated: false,
        model: `${child.model?.provider ?? modelChoice.model?.provider ?? "?"}/${child.model?.id ?? modelChoice.model?.id ?? "?"}`,
      };
      if (created.modelFallbackMessage !== undefined) details.modelFallback = created.modelFallbackMessage;
      if (sessionError !== undefined) details.error = sessionError;

      const text = lastText === "" ? (child.getLastAssistantText() ?? "") : lastText;
      return buildResult({ text, details, notes, emptyText: emptyTextFor(details, sessionError) });
    } finally {
      child?.dispose();
    }
  }
};

/**
 * 子会话装配的唯一入口。
 *
 * 票据 14（守卫注入）也走这里：`extensionPaths` 由 `src/guard.ts` 解析（默认自动找
 * `@momenttttt/pi-read-guard`，`DefaultResourceLoader.additionalExtensionPaths` 在
 * `noExtensions: true` 下依然生效，已实测）。解析失败只降级成空列表 + 一行告警，不中断子代理。
 *
 * 设计 §5 的选项表逐条落在这里：
 *   - `noExtensions: true` 必需：默认 loader 会重新发现扩展目录，把我们自己再加载一遍；
 *     它同时让子代理**结构上不可能**再 spawn 子代理
 *   - `model` / `thinkingLevel` 必须显式传：不传会落到"设置里的默认模型"，不是会话当前模型
 *   - `promptMode` 决定 `systemPrompt`（replace）还是 `appendSystemPrompt`（append）
 *   - `sessionManager: SessionManager.inMemory()`：子代理会话不落盘（设计 §7「明确不做」）
 *   - `settingsManager` 不传：压缩阈值等与父会话同源
 */
export async function createChildSession(
  request: ChildSessionRequest,
): Promise<{ session: AgentSession; modelFallbackMessage?: string }> {
  const tools = toolSelectionFor(request.profile);
  const loader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: request.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: !request.profile.injectAgentsMd,
    ...(request.extensionPaths.length > 0
      ? { additionalExtensionPaths: [...request.extensionPaths] }
      : {}),
    ...(request.profile.body === ""
      ? {}
      : request.profile.promptMode === "replace"
        ? { systemPrompt: request.profile.body }
        : { appendSystemPrompt: [request.profile.body] }),
  });
  await loader.reload();

  const result = await createAgentSession({
    cwd: request.cwd,
    agentDir: request.agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(request.cwd),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    ...(request.modelRuntime === undefined ? {} : { modelRuntime: request.modelRuntime }),
    ...(tools.tools === undefined ? {} : { tools: tools.tools }),
    ...(tools.excludeTools === undefined ? {} : { excludeTools: tools.excludeTools }),
  });

  return result.modelFallbackMessage === undefined
    ? { session: result.session }
    : { session: result.session, modelFallbackMessage: result.modelFallbackMessage };
}

/**
 * 父会话的 `ModelRuntime`（子会话必须复用它，**这是设计 §5 表格里漏掉的一环**）。
 *
 * 实测：不传 `modelRuntime` 时 `createAgentSession` 会自建一个，而扩展在父会话里
 * `pi.registerProvider(...)` 注册的 provider 只存在于父会话的 runtime 里。于是
 * `model: inherit` 在子会话里会失败（实测报 "No API key found for <provider>"），
 * 用代理 provider / 自定义 provider 的用户一委派就废。
 *
 * pi 没有公开的取法（`ExtensionContext.modelRegistry` 是唯一把手，它的 `runtime` 字段是 TS
 * private），所以这里按结构校验它、拿不到就降级为"子会话自建"并告警，不做静默假设。
 */
function parentModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  const candidate = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  if (candidate === undefined || candidate === null) return undefined;
  const runtime = candidate as Partial<ModelRuntime>;
  if (typeof runtime.streamSimple !== "function" || typeof runtime.getModel !== "function") {
    return undefined;
  }
  return candidate as ModelRuntime;
}

/** 档案 `model` 与工具 `model` 参数的解析：显式找不到就回退会话模型（并明说）。 */
function resolveModel(
  ctx: ExtensionContext,
  profile: AgentProfile,
  override: string | undefined,
): { model: SessionModel | undefined; note?: string; error?: string } {
  const spec = parseModelSpec(override ?? profile.model);
  if (spec.kind === "inherit") {
    if (ctx.model === undefined) {
      return { model: undefined, error: "父会话当前没有模型，无法派子代理。" };
    }
    return { model: ctx.model };
  }

  const found = ctx.modelRegistry.find(spec.provider, spec.id);
  if (found !== undefined) return { model: found };
  return {
    model: ctx.model,
    note:
      `[subagent] 档案指定的模型 ${spec.provider}/${spec.id} 在 modelRegistry 里找不到，` +
      `已回退到会话模型 ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}。`,
  };
}

function findProfile(listing: AgentListing, requested: string): AgentProfile | undefined {
  const exact = listing.agents.find((agent) => agent.name === requested);
  if (exact !== undefined) return exact;
  const lower = requested.toLowerCase();
  const matches = listing.agents.filter((agent) => agent.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

function statusOf(error: string | undefined, abortReason: "parent" | "turns" | undefined): SubagentStatus {
  if (error !== undefined) return "error";
  if (abortReason === "turns") return "max_turns";
  if (abortReason === "parent") return "aborted";
  return "completed";
}

function emptyTextFor(details: SubagentDetails, error: string | undefined): string {
  if (details.status === "max_turns") {
    return `（子代理达到 maxTurns 上限被中断，没有产出最终文本）`;
  }
  if (details.status === "aborted") return "（子代理被中断，没有产出最终文本）";
  if (details.status === "error") return `（子代理运行失败：${error ?? "未知原因"}）`;
  return "（子代理没有产出文本）";
}

/** 截断 + 组装 content。超过 100k 字节用 `truncateHead`，并在正文里注明。 */
function buildResult(options: {
  text: string;
  details: SubagentDetails;
  notes: string[];
  emptyText: string;
}) {
  const { text, details } = options;
  let body = text;
  let truncationNote: string | undefined;

  if (Buffer.byteLength(body, "utf8") > MAX_RESULT_BYTES) {
    const truncated = truncateHead(body, {
      maxBytes: MAX_RESULT_BYTES,
      maxLines: Number.MAX_SAFE_INTEGER,
    });
    body = truncated.content;
    truncationNote =
      `[subagent] 结果已截断：正文 ${truncated.totalBytes} 字节超过 ${MAX_RESULT_BYTES} 字节上限，` +
      "只保留开头部分。";
    details.truncated = true;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: composeResultContent({
          text: body,
          details,
          notes: options.notes,
          emptyText: options.emptyText,
          ...(truncationNote === undefined ? {} : { truncationNote }),
        }),
      },
    ],
    details,
    usage: details.usage,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      agent: "",
      status: "error" as const,
      turns: 0,
      toolCalls: 0,
      durationMs: 0,
      usage: EMPTY_USAGE,
      truncated: false,
      error: message,
    },
    isError: true,
  };
}

/** 助手消息里的文本块拼接（子代理的"最终文本"）。 */
function textOfAssistant(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block !== null && typeof block === "object" && (block as { type?: string }).type === "text") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text.trim();
}

export default subagentLite;
export { subagentLite as subagentLiteFactory };
export type { SubagentLiteConfig };
