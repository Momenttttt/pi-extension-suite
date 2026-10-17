/** 写入路径上的可预期失败；`code` 供扩展折算成工具错误文案。 */
export type MemoryWriteErrorCode =
  | "invalid_name"
  | "exists"
  | "symlink"
  | "index_conflict"
  | "io"
  | "invalid_input";

export class MemoryWriteError extends Error {
  readonly code: MemoryWriteErrorCode;
  /** 给模型的下一步建议；拼进工具错误文案。 */
  readonly hint?: string;

  constructor(code: MemoryWriteErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "MemoryWriteError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}
