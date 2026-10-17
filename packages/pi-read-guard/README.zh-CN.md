# @momenttttt/pi-read-guard

[English](README.md) · [pi 扩展四件套](https://github.com/Momenttttt/pi-extension-suite)

给 pi 内置的 `edit` / `write` 加上**先读后写**硬约束：写一个已存在的文件之前，必须在**本会话**里读过它，而且读过之后它没有被改动过。

pi 的 `write` 是全量覆盖、没有任何前置检查；`edit` 虽然要精确匹配，但也没有“读后文件被外部改动”的概念。这个包补上这一层。

## 安装

```bash
pi install npm:@momenttttt/pi-read-guard
```

也可以不装，直接加载检出里的工作副本：

```bash
pi -e ./packages/pi-read-guard/extensions/read-guard.ts
```

## 它拦什么

| 情形 | 结果 |
| --- | --- |
| 目标文件不存在（新建） | 放行 |
| 本会话没读过这个文件 | **阻断**，理由告诉你先读 |
| 读到的是被截断的内容（`read` 报了 truncation） | **阻断**，理由指路分段读或改用定点修改 |
| 读过、之后文件被改动（mtime 前进且内容不同） | **阻断**，理由要求重读 |
| 读过、文件只是被 touch 过（mtime 变、内容没变） | 放行 |
| 只读过一段（`offset`/`limit`），文件之后没动 | 放行 |
| 只读过一段，文件之后动了 | **阻断**（重读） |

阻断理由的**最后一行**是固定格式的代码行，便于别的扩展或脚本判断：

```
(read-guard: not_read)
```

三个代码：`not_read`（没读过）、`truncated_read`（读到的是截断内容）、`modified_since_read`（读后被改动）。
pi 的 `tool_call` 结果只有 `{ block, reason, terminate }` 三个字段、没有结构化的 `details`，所以代码只能落在
`reason` 文本里，这是这套契约里唯一能被下游读到的地方。

## 配置

两个位置，深合并，项目覆盖全局：

- 全局：`<agent-dir>/extensions/read-guard.json`（默认 `~/.pi/agent/extensions/read-guard.json`）
- 项目：`<cwd>/.pi/read-guard.json`

```json
{
  "enabled": true,
  "mode": "block",
  "exempt": ["**/generated/**"]
}
```

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后完全不干预 |
| `mode` | `"block"` | `"block"` 拒绝调用；`"warn"` 只提示、仍放行（迁移期用） |
| `exempt` | `[]` | 路径豁免。默认为空，**包括记忆目录在内**一律受约束 |

配置解析失败（文件坏了、JSON 不合法）不会让插件崩，退回默认值。

## 设计取舍

**为什么 `write` 也允许“只读过一段”就覆盖？**
这一版**刻意**选了偏宽的规则：范围读在文件 mtime 未变时算合格水位，`edit` 与 `write` 走同一套规则。更严的做法（“必须完整读过才能覆盖”）会阻断“读了相关片段后重写整个文件”这种常见工作流，代价大于收益；真正危险的情形（没读全就覆盖）已经被**截断读**拦住了，而 pi 的 `details.truncation` 正是为此提供的信号。剩下的范围读是模型的明确选择。

**为什么在 win32 上折叠路径大小写？**
折的理由：NTFS 上 `C:\Foo\a.ts` 与 `c:\foo\A.ts` 是同一个文件，不折会产生“明明读过却要求重读”的假阳性。代价是在大小写敏感的卷（极少）上可能把两个文件当成同一个。

**记忆文件也受约束。** 没有给记忆目录预设豁免，记忆文件走内置 `edit`/`write` 时同样要先读。

## 边界与已知限制

- **这不是锁。** 只在工具调用前拦一次，门禁通过到真正写盘之间有毫秒级窗口，外部进程仍可能在窗口内改动文件。
- **只覆盖内置 `edit` / `write` 两个工具名。** MCP 的文件工具、其它扩展的文件工具、`bash` 重定向、`apply_patch` 类工具都不受约束。`bash` 的改动不主动失效读态，靠下一次 `edit`/`write` 的 mtime 检查兜底。
- **mtime 精度。** Windows / FAT / 网络盘上 mtime 粒度可能到 2 秒，快速“读—改—写”可能撞上“相等即放行”。这是这个方案的固有局限。
- **恢复会话时的水位是估计值。** pi 的会话文件里没有“读时的 mtime”，所以 resume / 压缩后重建读态时用那条工具结果消息的时间戳当水位。文件在会话挂起期间被改动、改动时间又早于该消息时间戳时，会被判成“新鲜”。概率低，且不会比“完全不检查”更差。
- **`/compact` 之后被摘要掉的读记录自然失效**，模型需要重读。这是有意的保守行为。
- **误报要付的代价**：外部格式化器改动文件后模型会被要求重读一次。这是设计意图，不是 bug。

## 先验证再安装

```bash
npm install
npm run check        # typecheck + 测试
```

检查在本地跑，不需要网络：它装起一个真实的 pi 会话，断言门禁的放行与阻断，以及模型实际收到的请求。

## License

MIT
