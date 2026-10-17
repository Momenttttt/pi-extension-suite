# @momenttttt/pi-context-guard

补上 pi 缺的两层客户端上下文能力：**微压缩**（microcompact，较早的工具结果换成占位符）与**裁剪**（snip，模型可主动指认一段不再需要的历史，可撤销）。

pi 原生的**压缩**（compaction）保持原样，本包不重写它——不动摘要提示词、不动阈值、不动 overflow 恢复。

> 三个词在本包里语义相反，不要混用：**压缩** = 用一次模型调用把较早的历史总结成摘要；**微压缩** = 把较早的工具结果正文换成占位符的机械清理；**裁剪** = 由模型指认一段历史，让它在模型上下文里消失（无损、可撤销）。

## 安装

```bash
pi install npm:@momenttttt/pi-context-guard
```

本地开发：

```bash
pi -e ./packages/pi-context-guard/extensions/context-guard.ts
```

## 微压缩：两档触发

| 档 | 条件 | 默认 |
| --- | --- | --- |
| 空闲档 | 距上一条 assistant 消息 ≥ `gapThresholdMinutes`（60 分钟）且可清理结果条数 > `keepRecent` | **自动** |
| 体积档 | 可清理正文（UTF-8 字节）合计 > `maxClearableBytes`（256 KiB）且条数 > `keepRecent` | **手动**：`/ctx compact`；`autoVolumeTrigger: true` 改为自动 |

空闲档默认 60 分钟，恰好是服务端 prompt 缓存 TTL——空闲到此缓存本来就冷，此时改写历史前缀的缓存代价最低。

清理只改**本次请求**：`context` 事件里把选中的工具结果 `content` 换成一句占位符，不动 `isError` / `details`，不落盘，会话文件里的原文原样保留。

### 哪些工具的结果会被清理

对齐 Claude Code 的清单：`read`、`bash`、`powershell`、`grep`、`find`、`ls`、`edit`、`write` 会；MCP 工具、`codemode`、`tool_search` **不会**（非幂等/不可重跑风险高）。

两个本套件自己的工具默认**不清理**，可配置打开：

- `subagent`（`@momenttttt/pi-subagent-lite`）——子代理的报告是"结论"而不是原始输出，清掉会让模型忘记已得结论、被迫重新委派 → `clearSubagentResults: true`
- `memory_read`（`@momenttttt/pi-zcode-memory`）——记忆正文虽可按名重读，但它是长期事实 → `clearMemoryResults: true`

### 决策稳定性

清理集合只依赖**消息序列 + 冻结的清理水位**（用 `pi.appendEntry` 持久化）。相邻两次请求拿到同一集合，所以改写后的前缀逐字节一致，不会每轮都把缓存前缀打碎。

## 裁剪：`snip`

模型可以调用 `snip({ from, to, reason? })`，用短 id 指认一段较早的历史。短 id 是**只在请求里**给用户消息追加的 `\n[id:xxxxxx]` 后缀（由 `sha256(role + ":" + timestamp)` 前 6 位 base36 派生），存储副本不动。

- 裁剪通过在 `turn_end`（首选）或 `agent_before_settle`（兜底）提交一条 pi 原生的 `context_edit{replacement: null}` 实现——pi 的读时投影，**原始条目仍在会话文件里**。
- `context_edit` 进的是 pi 自己的投影，所以 pi 重算 `tokensBefore` 时会看到裁剪后的历史——这是 pi 的机制（`docs/compaction.md` 明写"基于重建后的、经过 context 编辑的投影"），不是我们额外做的。**本项目没有断言"裁剪把自动压缩推迟了多少"的测试**：那需要真模型跑两条路径对比，属节点外的验收，别把它当成已测行为。
- 禁止裁当前正在进行的回合；区间端点必须存在，报错时列出可用 id。
- `/ctx undo-snip` 提交一条恢复性 `context_edit`（内容取自原条目），并渲染一行"已恢复 N 条历史"。
- 会话里会出现一条 `custom` 审计条目，渲染成"已裁剪 N 条历史（可撤销）"，避免用户以为消息丢了。

## 配置

两个位置，深合并，项目覆盖全局：

- 全局：`<agent-dir>/extensions/context-guard.json`（默认 `~/.pi/agent/extensions/context-guard.json`）
- 项目：`<cwd>/.pi/context-guard.json`

```json
{
  "enabled": true,
  "keepRecent": 5,
  "maxClearableBytes": 262144,
  "gapThresholdMinutes": 60,
  "autoVolumeTrigger": false,
  "clearSubagentResults": false,
  "clearMemoryResults": false
}
```

配置解析失败（文件坏了、JSON 不合法）不会让插件崩，退回默认值。

## `/ctx`

一条命令看清状态：上下文占用（tokens / 窗口 / 百分比）、本会话清理统计（条数与省下的字节）、裁剪条数、压缩失败次数、CC 对照提示。

- `/ctx compact` — 用体积档的选择集**立刻**清一次，不等空闲。**阈值仍然生效**：保留尾部之外的可清理正文没超过 `maxClearableBytes` 时它不会动手（体积档的定义本身就包含阈值），只会告诉你还差多少
- `/ctx undo-snip` — 撤销最近一次裁剪

## 设计取舍

**为什么默认救不了正在跑的长会话？**
空闲档只在会话空闲 ≥ 60 分钟后才动手——这是与 Claude Code 默认保持一致，也因为它让改写历史前缀的代价落在缓存本来就冷的时候。**代价必须说清：一个持续活跃、图片越堆越多的会话不会被自动救**，需要手动 `/ctx compact` 一次，或者打开 `autoVolumeTrigger`。装上本包不等于"再也不会撞字节墙"。

**为什么 `snip` 工具一直对模型可见，而不是按需激活？**
按需激活（注册为 `deferred`，上下文用量超阈值时用 `pi.setActiveTools()` 打开）会**改变工具列表**。pi 会为工具集变化在转录里追加记录，provider 无法表达该增量时会收到完整检查点，**可能作废缓存前缀**——省下的提示词成本不如缓存失效亏得多。代价是每轮多几十 token 的提示词，接受。

**为什么清理不会清空 pi-read-guard 的读态？**
清理是"这次请求给模型看什么"的优化，不是磁盘世界变了。pi-read-guard 的读态表因此不随之失效（这一点与 Claude Code 的"压缩即清空读态"相反）。若模型据此编辑文件，mtime 校验仍是最后防线。

**为什么压缩失败不做"跳过"而是"降压力"？**
本机实测（`test/compaction-fuse.test.ts`）：在 `reason: "threshold"` 场景下让 `session_before_compact` 返回 `{ cancel: true }`，pi 会抛 `Compaction cancelled` 并立刻吞掉、发一条 `session_compact_failed`（`aborted: true`、`errorMessage: undefined`），**不压缩、不重试**；下一轮只要上下文还超阈值就再取消一次，于是上下文继续涨到 overflow。overflow 路径上取消更糟——那是唯一一次 compact-and-retry 恢复机会。所以本插件**从不返回 cancel**：失败被计数、显示在 `/ctx`，下一次请求改为强制按体积档先清一次（真的降低压力），连续 ≥3 次时在 UI 明确告警。

**为什么不是"重写 pi 的 compaction"？**
核对后，Claude Code 五层管线里已有三层被 pi 原生覆盖且质量不低（阈值触发、overflow 恢复、与 CC 基本同构的摘要结构 + 迭代式更新）。真正缺的只有微压缩、裁剪与跨工具结果预算。重写已有的三层会把维护成本翻倍而收益近零。

## 边界与已知限制

- **微压缩不影响 pi 的自动压缩阈值。** 它只改单次请求，不在 pi 的投影里，所以能让请求变小（治 503 字节墙），但不会推迟压缩触发。想推迟触发请用 `snip`（`context_edit` 会进投影）。
- **没有模拟服务端缓存编辑。** `cache_edits` / `cache_reference` 那套是 Anthropic 专有 beta，客户端不可复现；我们能做的是"改本地请求"，代价是缓存前缀失效——用触发时机把代价压到低于收益。
- **占位符会改变模型对历史的判断。** 文案里明确写了"需要时可重新执行"，但模型仍可能因此改变计划。
- **模型可能滥用 `snip`。** 三重兜底：区间校验、不允许裁当前回合、`/ctx` 可撤销。不做自动裁剪（那其实就是微压缩）。
- **裁剪只影响模型看到的投影**，会话文件与 TUI 里消息都还在。
- **结果预算层（对超大工具结果截断）没有实现。** pi 内置工具已自带截断，真正需要它的场景是 MCP/自定义工具。

## 开发

```bash
npm install
npm run check        # typecheck + test + 文档交叉引用
git config core.hooksPath .githooks   # 提交身份与提交信息格式钩子
```

测试分两层：纯决策函数单测（选择集、触发条件、短 id 与区间解析、水位与统计），以及"进程内真实会话 + 桩 provider"的端到端测试——后者断言的是**桩 provider 收到的请求本身**（请求是否变小、占位符是否出现、被裁剪的那段是否消失、相邻请求是否逐字节一致）。

## License

MIT
