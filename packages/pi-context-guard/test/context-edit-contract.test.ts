/**
 * 契约差分：`isContextEditable`（本地镜像）与 pi 的 `appendContextEdit`（真身）逐条对答案。
 *
 * `src/snip.ts` 的 `isContextEditable` 是 pi 白名单的本地镜像，剪裁前靠它把不可编辑的条目挡在
 * 目标集之外——否则 pi 会**整批**拒收 `context_edit`（票据 context-guard-snip-boundary/01：
 * 会话里 44 个目标，落地 0 条）。镜像与真身一旦漂移，症状是"裁剪静默失败"而不是本地报错，
 * 所以这里拿 pi 公开导出的 `SessionManager.appendContextEdit` 当校验探针，逐类型造条目对答案：
 *
 *   接受：`custom_message`，以及 role ∈ {user, assistant, toolResult} 的 `message`
 *   拒绝：`compaction`、system 消息、`custom`、`context_edit` 自身，以及不投影模型内容的
 *         `model_change` / `session_info` 之类
 *
 * pi 哪天扩白名单（或改拒绝文案），这条会先红——那时要同时改 `src/snip.ts` 与本文件的 `expected`。
 * `branch_summary` 没有公开的 append 方法，只能从 `appendMessage` 的注释得知它与 `compaction`
 * 一样走顶层条目（"These need to be appended via appendCompaction() and appendBranchSummary()"），
 * 所以它按 `compaction` 那一路对待：不可编辑。
 *
 * 条目全部手工构造（不装扩展、不跑回合）：这条用例问的是 pi 的契约，不是插件的行为，
 * 让它只依赖 `SessionManager` 一个公开类。
 */
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { isContextEditable } from "../src/snip.ts";
import { createTempWorkspace } from "./test-session.ts";

const workspaces: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of workspaces.splice(0)) cleanup();
});

/** 拿真 `appendContextEdit` 当探针：不抛就是接受，抛了就把文案一起收下。 */
function piVerdict(manager: SessionManager, entryId: string): { accepts: boolean; error: string } {
  try {
    manager.appendContextEdit(entryId, null);
    return { accepts: true, error: "" };
  } catch (error) {
    return { accepts: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 逐类型造出来的探针：`expected` 是两边**都**该给出的答案。 */
interface Probe {
  what: string;
  id: string;
  expected: boolean;
}

describe("appendContextEdit 的接受规则", () => {
  test("逐类型：本地镜像与 pi 的接受/拒绝逐条一致", () => {
    const { cwd, cleanup } = createTempWorkspace();
    workspaces.push(cleanup);
    const manager = SessionManager.inMemory(cwd);

    // 四个 role 的消息条目。只喂 `role` + `content`：pi 的这条契约只看条目类型与 role，
    // 而 pi-ai 的 `Message` 类型不在包根的导出面上（见 test-session.ts 的同款说明）。
    const message = (role: string, extra: Record<string, unknown> = {}): string =>
      manager.appendMessage({ role, content: "契约探针", ...extra } as never);

    const probes: Probe[] = [
      { what: "message/user", id: message("user"), expected: true },
      { what: "message/assistant", id: message("assistant"), expected: true },
      {
        what: "message/toolResult",
        id: message("toolResult", { toolCallId: "call_probe", toolName: "read" }),
        expected: true,
      },
      { what: "message/system", id: message("system"), expected: false },
      {
        what: "custom",
        id: manager.appendCustomEntry("contract/custom", { probe: true }),
        expected: false,
      },
      {
        what: "custom_message",
        id: manager.appendCustomMessageEntry("contract/custom-message", "契约探针", false),
        expected: true,
      },
      {
        what: "compaction",
        id: manager.appendCompaction("契约探针的摘要", null, 1000),
        expected: false,
      },
      {
        what: "model_change",
        id: manager.appendModelChange("contract-provider", "contract-model"),
        expected: false,
      },
      { what: "session_info", id: manager.appendSessionInfo("契约探针"), expected: false },
    ];

    const mismatches: string[] = [];
    for (const probe of probes) {
      const verdict = piVerdict(manager, probe.id);
      const local = isContextEditable(manager.getEntry(probe.id));
      if (local !== probe.expected || verdict.accepts !== probe.expected) {
        mismatches.push(
          `${probe.what}: isContextEditable=${local} pi=${verdict.accepts}` +
            (verdict.error === "" ? "" : `（pi 说：${verdict.error}）`),
        );
      }
    }
    expect(mismatches).toEqual([]);

    // 拒绝的文案本身是我们诊断的抓手：真机上用户截图里就是这一句。pi 改字面量也要让这条红。
    const compactionVerdict = piVerdict(
      manager,
      probes.find((probe) => probe.what === "compaction")!.id,
    );
    expect(compactionVerdict.accepts).toBe(false);
    expect(compactionVerdict.error).toContain("does not contribute editable model content");

    // `context_edit` 条目本身也不可编辑（一次编辑不能再被编辑）。它只在被接受时才会写进分支，
    // 所以放在最后造。
    const editId = manager.appendContextEdit(probes[0]!.id, null);
    const editEntry = manager.getEntry(editId);
    expect(editEntry?.type).toBe("context_edit");
    expect(isContextEditable(editEntry)).toBe(false);
    expect(piVerdict(manager, editId).accepts).toBe(false);
  });
});
