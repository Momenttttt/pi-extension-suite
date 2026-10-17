/**
 * 纯决策层：路径键归一化与写入门禁判定。
 *
 * 这里不 import pi，也不碰文件系统（hash 从外面传进来），所以每条规则都能用
 * 单元测试逐条钉住。扩展层的职责只是把真实事件折算成这里的输入。
 */
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

/** 读到的程度。范围读与截断读都不是"整个文件"。 */
export type ReadKind = "full" | "ranged" | "truncated";

/** 水位来源，只用于诊断，不参与判定。 */
export type ReadSource = "read" | "write" | "edit" | "resume" | "external";

export interface ReadStateEntry {
  /** 规范化后的路径键（见 normalizePathKey）。 */
  key: string;
  absolutePath: string;
  /** floor(statSync().mtimeMs)，对齐 CC 的 Math.floor(mtimeMs)。 */
  mtimeMs: number;
  sizeBytes: number;
  /** sha256(文本内容)。范围读 / 截断读 / 图片 / edit 记录没有。 */
  contentHash?: string;
  kind: ReadKind;
  source: ReadSource;
  readAtMs: number;
}

export interface PathKeyOptions {
  cwd: string;
  /** 是否折叠大小写。默认按平台决定（win32 折叠）。 */
  caseInsensitive?: boolean;
  /**
   * 用哪套路径语义。默认当前平台。
   *
   * 之所以是个参数而不是直接读 `process.platform`：这个模块是纯决策层，路径语义（分隔符、
   * 盘符、大小写）本身就是规则的一部分，必须能在**任何机器上**被单测覆盖两种语义。
   * 直接绑运行时的话，CI 跑在 Linux 上就永远测不到 win32 分支，而 win32 才是用户实际在用的。
   */
  platform?: NodeJS.Platform;
}

/** 平台默认是否折叠大小写。 */
export function defaultCaseInsensitive(platform: string = process.platform): boolean {
  return platform === "win32";
}

/** 按平台挑路径实现：win32 一套，其余走 POSIX。 */
export function pathImpl(platform: string = process.platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * 把工具输入里的路径变成读态表的键。
 *
 * 1. 相对路径按会话 cwd 解析为绝对路径
 * 2. 归一化 `.`/`..`，并把分隔符统一成 `/`（同一个文件在 `\\` 与 `/` 下必须是同一个键；
 *    **只在 win32 语义下**把 `\` 当分隔符——POSIX 上反斜杠是合法文件名字符）
 * 3. NFC 归一化（macOS 上同一文件名可能是 NFC 也可能是 NFD）
 * 4. 折叠大小写（仅 win32 默认）——NTFS 上 `C:\Foo\a.ts` 与 `c:\foo\A.ts` 是同一个文件，
 *    不折叠会产生"明明读过却要求重读"的假阳性。代价是大小写敏感卷上可能把两个文件当同一个。
 */
export function normalizePathKey(path: string, options: PathKeyOptions): string {
  const platform = options.platform ?? process.platform;
  const impl = pathImpl(platform);
  const isWindows = platform === "win32";
  // 统一分隔符只是为了"同一个文件同一个键"；POSIX 语义下不能动反斜杠
  const toForward = (value: string) => (isWindows ? value.split("\\").join("/") : value);

  const slashed = toForward(path);
  const cwd = toForward(options.cwd);
  const absolute = impl.isAbsolute(slashed) ? impl.normalize(slashed) : impl.resolve(cwd, slashed);
  const caseInsensitive = options.caseInsensitive ?? defaultCaseInsensitive(platform);
  const nfc = toForward(absolute).normalize("NFC");
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}

/** 计算文本内容的 sha256，与 pi / CC 的水位比较口径一致（十六进制小写）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type WriteGateAction = "allow" | "block";

/**
 * 阻断原因。pi 的 `tool_call` 结果只有 `{ block, reason, terminate }`，没有结构化的
 * `details`，所以这个代码最终以固定格式落在 `reason` 的最后一行（由扩展层拼上去）。
 */
export type WriteGateCode = "not_read" | "truncated_read" | "modified_since_read";

export interface WriteGateDecision {
  action: WriteGateAction;
  code?: WriteGateCode;
  /** 阻断时给模型看的文案（由调用方按事件语言组装，这里只给结构）。 */
  reason?: string;
}

export interface WriteGateInput {
  /** 目标路径规范化后的键。 */
  key: string;
  /** 目标路径的显示形式，用于文案。 */
  displayPath: string;
  /** 目标文件当前的 mtime；不存在（新建）时为 undefined。 */
  currentMtimeMs: number | undefined;
  /** 目标文件当前内容的 hash；读不到（二进制 / 不可读）时为 undefined。 */
  currentContentHash: string | undefined;
  /** 读态表里的记录；没读过时为 undefined。 */
  entry: ReadStateEntry | undefined;
}

export interface WriteGateMessages {
  notRead: (displayPath: string) => string;
  truncatedRead: (displayPath: string) => string;
  modifiedSinceRead: (displayPath: string) => string;
}

export const DEFAULT_WRITE_GATE_MESSAGES: WriteGateMessages = {
  notRead: (path) =>
    `文件 ${path} 尚未在本会话中读取过。请先用 read 读取它，再写入；如果这是有意创建的新文件，请确认路径正确。`,
  truncatedRead: (path) =>
    `你读到的 ${path} 内容是被截断的，不是完整文件，因此不能用来整文件覆盖。请用 read 的 offset/limit 分段读完整，或用 edit 做定点修改。`,
  modifiedSinceRead: (path) =>
    `${path} 在你读取之后被改动过（可能是你、用户或其它工具造成的）。请重新读取后再写。`,
};

/**
 * 写入门禁判定表。`edit` 与 `write` 走同一套规则（对齐 Claude Code）：
 *
 * | 条件 | 结论 |
 * | --- | --- |
 * | 目标文件不存在 | 放行（新建） |
 * | 表中无该路径 | 阻断「未读」 |
 * | 截断读 | 阻断「读得不完整」 |
 * | mtime 前进 + 完整读 + 内容等价 | 放行（内容等价逃逸） |
 * | mtime 前进 | 阻断「读后被改动」 |
 * | mtime 相等或后退 | 放行 |
 *
 * 范围读在 mtime 未变时是合格水位；它没有 contentHash，所以 mtime 一前进就必须重读。
 */
export function decideWriteGate(
  input: WriteGateInput,
  messages: WriteGateMessages = DEFAULT_WRITE_GATE_MESSAGES,
): WriteGateDecision {
  // 新建：目标还不存在，不可能覆盖掉任何东西
  if (input.currentMtimeMs === undefined) return { action: "allow" };

  const entry = input.entry;
  if (!entry) {
    return {
      action: "block",
      code: "not_read",
      reason: messages.notRead(input.displayPath),
    };
  }

  if (entry.kind === "truncated") {
    return {
      action: "block",
      code: "truncated_read",
      reason: messages.truncatedRead(input.displayPath),
    };
  }

  // mtime 相等或后退：相等不检查（mtime 粒度可能粗），后退视为回滚
  if (input.currentMtimeMs <= entry.mtimeMs) return { action: "allow" };

  // mtime 前进：只有「完整读 + 内容等价」可以逃逸（被 touch 过 vs 被改过）
  if (entry.kind === "full" && entry.contentHash !== undefined) {
    if (input.currentContentHash !== undefined && input.currentContentHash === entry.contentHash) {
      return { action: "allow" };
    }
  }

  return {
    action: "block",
    code: "modified_since_read",
    reason: messages.modifiedSinceRead(input.displayPath),
  };
}

/** 会话 cwd 与路径之间只差一个分隔符时，展示用的相对路径更短。 */
export function displayPathOf(
  absolutePath: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const { sep } = pathImpl(platform);
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}
