/**
 * 桩 provider 测试骨架（S2 接缝）。
 *
 * 把待测扩展装进一个**真实的** `AgentSession`，再注册一个自写 `streamSimple` 的 provider
 * 产出脚本化应答。断言因此可以落在两处：
 *   - 工具结果（模型实际看到了什么）
 *   - 桩 provider 收到的请求本身（请求是否变小、索引是否注入、门禁是否拦下）
 *
 * 这条路线取自 pi 官方示例：`examples/sdk/02-custom-model.ts`（自定义 provider）与
 * `examples/sdk/12-full-control.ts`（自定义 ResourceLoader）。
 *
 * 为什么不用 pi 内置的 faux provider：它不暴露"收到的请求"，而本项目的验收标准
 * 大部分落在"发出去的请求本身"上。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionError,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/**
 * 消息与助手应答的最小结构类型。
 *
 * pi 的包根**不导出** `Message` / `AssistantMessage` 这些模型消息类型（它们来自
 * `@earendil-works/pi-ai`，而 pi 的 exports map 不暴露该入口）。测试只做结构化断言，
 * 所以这里自己声明需要的形状，而不是去够别的包的内网类型。
 */
type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

interface TranscriptMessage {
  role: string;
  content?: string | MessageBlock[];
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

interface AssistantLike {
  role: "assistant";
  content: MessageBlock[];
  api: string;
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  stopReason: string;
  timestamp: number;
}

/** 一次被桩 provider 收到的请求。 */
export interface CapturedRequest {
  messages: TranscriptMessage[];
  /** 请求里 system 消息拼起来的文本。 */
  systemText: string;
  /** 请求里所有消息的可读文本拼接（含 toolCall 的 name 与参数）。 */
  allText: string;
  /** 请求的体积（UTF-8 字节），用于断言"请求变小了"。 */
  bytes: number;
}

/** 桩 provider 的应答脚本。 */
export type StubStep =
  | { text: string }
  | { toolCall: { name: string; arguments: Record<string, unknown>; id?: string } }
  | { text: string; toolCall: { name: string; arguments: Record<string, unknown>; id?: string } };

export interface TestSessionOptions {
  /** 待测扩展。 */
  extension: ExtensionFactory;
  /** 工作目录（自建临时目录或传入固定目录）。 */
  cwd: string;
  /** 附加扩展（例如测试子代理时再装一个假工具）。 */
  extraExtensions?: ExtensionFactory[];
  /** 桩应答脚本，按调用顺序消费；用完后回一句 `"done"`。 */
  responses?: StubStep[];
  /** 设置覆盖；默认关掉自动压缩，让断言不受压缩干扰。 */
  settings?: Record<string, unknown>;
  /** agent 目录；默认落在 `<cwd>/.pi-agent`。 */
  agentDir?: string;
  /**
   * 会话落盘目录。给了就用 `SessionManager.create(cwd, sessionDir)`，会话会写成真的
   * 会话文件——测 resume / 压缩 / 换分支这类生命周期行为必须这样（`inMemory` 没有文件）。
   */
  sessionDir?: string;
  /** 从一个已有会话文件恢复：`SessionManager.open(path, sessionDir, cwd)`。 */
  resumeFrom?: string;
  /** 从内存里的条目起会话（避免碰磁盘）。 */
  inMemoryEntries?: unknown[];
  /**
   * 允许本轮出现扩展错误。
   *
   * 默认**不允许**：`run()` 会在本轮结束时检查有没有新的扩展错误，有就直接抛出。扩展抛错往往
   * 正是用例要抓的病灶，而它在测试里本来是无声的（见 `TestSession.extensionErrors`）。
   * 只有专门测错误路径的用例才传 `true`。
   */
  allowExtensionErrors?: boolean;
}

export interface TestSession {
  session: AgentSession;
  /** 桩 provider 依次收到的请求。 */
  requests: CapturedRequest[];
  /**
   * pi 报上来的扩展错误（`bindExtensions` 的 `onError` 载荷）。
   *
   * 扩展抛错在真机上只进 TUI 通知（`~/.pi/agent/crashes.json` 不收），测试里如果不接这个回调
   * 就完全看不见：`turn_end` 的边界提交整批失败，而断言看到的只是"什么都没发生"。
   * 接上之后，"本轮没有新错误"由 `run()` 默认把住（见 `allowExtensionErrors`）。
   */
  extensionErrors: ExtensionError[];
  /** 当前会话文件；用 `SessionManager.inMemory` 或还没写盘时为 undefined。 */
  sessionFile: () => string | undefined;
  /** 追加应答脚本（在调用 `run` 之前用）。 */
  pushResponses: (...steps: StubStep[]) => void;
  /** 跑一轮，返回本轮结束后的最后助手文本。 */
  run: (text: string) => Promise<string>;
  dispose: () => void;
}

const STUB_PROVIDER = "pi-suite-stub";
const STUB_MODEL_ID = "stub-model";

/**
 * 极简的 `AssistantMessageEventStream` 替身。
 *
 * pi 只依赖它的三件事：推事件、`end` 收尾、`result()` 拿最终消息。这里不 import pi-ai 的
 * 内部路径——pi 的 exports map 不暴露它，测试也不该依赖别的包的内网结构。
 *
 * 关键点：**构造时就启动推送**（排到微任务队列），而不是等第一次迭代或 `result()`。
 * 消费者可能先建异步迭代器再调 `result()`，迟启动会让两边互相等，表现为整轮卡死。
 */
function makeEventStream(produce: () => AssistantLike) {
  const queue: unknown[] = [];
  const waiting: Array<(value: IteratorResult<unknown>) => void> = [];
  let finished = false;
  let finalMessage: AssistantLike | undefined;

  const push = (event: unknown) => {
    const waiter = waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };

  const finish = () => {
    finished = true;
    for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
  };

  const iterator: AsyncIterator<unknown> = {
    next: () => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  };

  queueMicrotask(() => {
    try {
      const produced = produce();
      finalMessage = produced;
      push({ type: "start", partial: produced });
      produced.content.forEach((block, index) => {
        if (block.type === "text") {
          push({ type: "text_start", contentIndex: index, partial: produced });
          push({ type: "text_delta", contentIndex: index, delta: block.text, partial: produced });
          push({ type: "text_end", contentIndex: index, content: block.text, partial: produced });
        } else if (block.type === "toolCall") {
          push({ type: "toolcall_start", contentIndex: index, partial: produced });
          push({
            type: "toolcall_delta",
            contentIndex: index,
            delta: JSON.stringify(block.arguments),
            partial: produced,
          });
          push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: produced });
        } else if (block.type === "thinking") {
          push({ type: "thinking_start", contentIndex: index, partial: produced });
          push({ type: "thinking_delta", contentIndex: index, delta: block.thinking, partial: produced });
          push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: produced });
        }
      });
      push({
        type: "done",
        reason: produced.stopReason === "toolUse" ? "toolUse" : "stop",
        message: produced,
      });
      finish();
    } catch (error) {
      push({ type: "error", reason: "error", error: { role: "assistant", content: [] } });
      finish();
    }
  });

  return {
    push,
    end(final?: AssistantLike) {
      finalMessage ??= final;
      finish();
    },
    result: async (): Promise<AssistantLike> => {
      while (!finished) await new Promise((resolve) => setTimeout(resolve, 2));
      return finalMessage as AssistantLike;
    },
    [Symbol.asyncIterator]: () => iterator,
  };
}

function makeAssistantMessage(
  model: { provider: string; id: string },
  step: StubStep,
): AssistantLike {
  const content: MessageBlock[] = [];
  if ("text" in step && step.text) content.push({ type: "text", text: step.text });
  if ("toolCall" in step) {
    content.push({
      type: "toolCall",
      id: step.toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      name: step.toolCall.name,
      arguments: step.toolCall.arguments,
    });
  }
  return {
    role: "assistant",
    content,
    api: "pi-messages",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolCall" in step ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** 消息内容统一成块数组（有些消息类型把 content 写成裸字符串）。 */
function blocksOf(message: TranscriptMessage): MessageBlock[] {
  return typeof message.content === "string" ? [] : (message.content ?? []);
}

function textOf(message: TranscriptMessage): string {
  if (message.role === "system" || message.role === "user" || message.role === "toolResult") {
    return typeof message.content === "string"
      ? message.content
      : blocksOf(message)
          .map((block) => ("text" in block ? block.text : "[image]"))
          .join("");
  }
  if (message.role === "assistant") {
    return blocksOf(message)
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return `[thinking] ${block.thinking}`;
        if (block.type === "toolCall") {
          return `[toolCall ${block.name} ${JSON.stringify(block.arguments)}]`;
        }
        return `[${block.type}]`;
      })
      .join("\n");
  }
  return "";
}

function captureRequest(messages: TranscriptMessage[]): CapturedRequest {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message))
    .join("\n");
  const allText = messages.map((message) => textOf(message)).join("\n");
  return { messages: [...messages], systemText, allText, bytes: Buffer.byteLength(allText, "utf8") };
}

/**
 * 建一个装着待测扩展的真实会话。
 *
 * 用 `DefaultResourceLoader({ extensionFactories })` 把扩展塞进真实 `AgentSession`，
 * 只替换"装了哪些扩展"，其余（内置工具、会话、压缩、事件分发）都保持 pi 的真实行为。
 */
export async function createTestSession(options: TestSessionOptions): Promise<TestSession> {
  const { cwd } = options;
  const agentDir = options.agentDir ?? join(cwd, ".pi-agent");
  const requests: CapturedRequest[] = [];
  const extensionErrors: ExtensionError[] = [];
  const script: StubStep[] = [...(options.responses ?? [])];

  const stubFactory: ExtensionFactory = (pi) => {
    pi.registerProvider(STUB_PROVIDER, {
      baseUrl: "http://127.0.0.1:1/stub",
      apiKey: "stub-key",
      api: "pi-messages",
      models: [
        {
          id: STUB_MODEL_ID,
          name: "Stub Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
      ],
      streamSimple: (model, context) => {
        requests.push(captureRequest(context.messages as unknown as TranscriptMessage[]));
        const step = script.shift() ?? { text: "done" };
        const message = makeAssistantMessage({ provider: model.provider, id: model.id }, step);
        return makeEventStream(() => message) as never;
      },
    });
  };

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [stubFactory, options.extension, ...(options.extraExtensions ?? [])],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const sessionManager = options.resumeFrom
    ? SessionManager.open(options.resumeFrom, options.sessionDir, cwd)
    : options.sessionDir
      ? SessionManager.create(cwd, options.sessionDir)
      : SessionManager.inMemory(cwd);

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      ...(options.settings as object),
    }),
    model: {
      provider: STUB_PROVIDER,
      id: STUB_MODEL_ID,
      name: "Stub Model",
      api: "pi-messages",
      baseUrl: "http://127.0.0.1:1/stub",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    } as never,
  });

  const errors = extensionsResult.errors ?? [];
  if (errors.length > 0) {
    throw new Error(`扩展加载失败：${JSON.stringify(errors, null, 2)}`);
  }

  // `createAgentSession` 只建会话、**不**派发 `session_start`——那一步在 `bindExtensions()`
  // 里（`dist/core/session-start` 的调用点在 agent-session.js:2651）。真实运行由 CLI / RPC
  // 的宿主调用它。少了这一句，所有依赖 `session_start` 的扩展行为（读态重建、索引注入、
  // 工具冲突扫描）在测试里都不会发生，而 `tool_call` / `tool_result` 照常工作——
  // 表现为"测试通过但扩展没初始化"，非常难查。
  //
  // `onError` 是扩展抛错的唯一出口（`ExtensionBindings.onError`），宿主拿它写日志、弹通知；
  // 不接就等同于把错误丢掉。
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });

  return {
    session,
    requests,
    extensionErrors,
    sessionFile: () => session.sessionFile,
    pushResponses: (...steps: StubStep[]) => script.push(...steps),
    run: async (text: string) => {
      const before = extensionErrors.length;
      await session.prompt(text);
      const fresh = extensionErrors.slice(before);
      if (fresh.length > 0 && options.allowExtensionErrors !== true) {
        throw new Error(
          `本轮出现 ${fresh.length} 条扩展错误（要允许的话给 createTestSession 传 allowExtensionErrors: true）：\n` +
            fresh.map((error) => `  [${error.event}] ${error.extensionPath}: ${error.error}`).join("\n"),
        );
      }
      return session.getLastAssistantText() ?? "";
    },
    dispose: () => session.dispose(),
  };
}

/** 建一个临时工作目录；返回的 `cleanup` 在用例结束时调用。 */
export function createTempWorkspace(prefix = "pi-suite-"): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  return {
    cwd,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
