/**
 * 同类扩展冲突检测。
 *
 * pi 的工具注册是"后写者胜"且**不报错**，所以"本机装了另一个子代理扩展"必须由我们主动发现
 * （设计 §6.8）。我们**不追求并存**：发现别人的 `Agent` / `Task` / `subagent` 工具就明确警告
 * 并建议卸载。
 *
 * 难点是"别人的"怎么判：`pi.getAllTools()` 只给 `sourceInfo`。规则：
 *   - `Agent` / `Task`：我们从不注册这两个名字，一律算别人的
 *   - `subagent`：等于本插件自己的工具名。它来自本插件的文件路径、或来自非文件路径（内联/合成，
 *     测试里就是这种），都算我们的；来自另一个真实文件路径才算是别人替换了我们
 */

/** `getAllTools()` 里我们需要的字段（结构化收窄，不依赖 pi 的类型）。 */
export interface ToolSourceLike {
  name: string;
  sourceInfo?: { path?: string; source?: string } | undefined;
}

export interface ConflictCandidate {
  name: string;
  path: string;
}

export const FOREIGN_SUBAGENT_TOOL_NAMES = ["Agent", "Task", "subagent"] as const;

/** 本插件注册的工具名（注册名与模型看到的调用名一致）。 */
export const OWN_TOOL_NAME = "subagent";

export interface FindForeignToolsOptions {
  /** 本插件扩展文件的路径（`fileURLToPath(import.meta.url)`）。 */
  ownPath?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 非文件路径：`builtin:xxx`、`<inline:2>` 这类合成路径。 */
export function isSyntheticPath(path: string): boolean {
  return path.startsWith("builtin:") || path.startsWith("<");
}

export function findForeignSubagentTools(
  tools: readonly ToolSourceLike[],
  options: FindForeignToolsOptions = {},
): ConflictCandidate[] {
  const ownPath = options.ownPath === undefined ? undefined : normalizePath(options.ownPath);
  const found: ConflictCandidate[] = [];

  for (const tool of tools) {
    if (!(FOREIGN_SUBAGENT_TOOL_NAMES as readonly string[]).includes(tool.name)) continue;
    const path = tool.sourceInfo?.path ?? "";
    if (tool.name === OWN_TOOL_NAME) {
      if (path === "" || isSyntheticPath(path)) continue;
      if (ownPath !== undefined && normalizePath(path) === ownPath) continue;
    }
    found.push({ name: tool.name, path: path === "" ? "未知来源" : path });
  }

  return found;
}

/** 冲突告警文案（含卸载建议）。 */
export function describeConflicts(candidates: readonly ConflictCandidate[]): string[] {
  return candidates.map(
    (candidate) =>
      `检测到另一个子代理扩展注册了工具 ${candidate.name}（来源：${candidate.path}）。` +
      "pi 的工具注册是后写者胜且不报错，与本插件**不并存**：" +
      "请卸载那个扩展（`pi uninstall`，或从 settings 的 extensions 列表移除）后重启。",
  );
}
