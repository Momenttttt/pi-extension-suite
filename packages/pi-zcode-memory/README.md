# @momenttttt/pi-zcode-memory

让 pi 与 ZCode 共用同一份项目记忆。

- 三个工具：`memory_list`、`memory_read`、`memory_write`
- 会话开始时只把 `MEMORY.md` 索引注入一次；正文永不自动注入，按需读
- 目录算法、索引格式、事实文件 frontmatter 逐条对齐 ZCode，两边读写同一批文件
- `/memory` 查看状态与索引体检，`/memory reload` 强制下一次运行重新注入

## 安装

```bash
pi install npm:@momenttttt/pi-zcode-memory
```

本地开发：

```bash
pi -e ./packages/pi-zcode-memory/extensions/zcode-memory.ts
```

## 记忆目录怎么定位

按 ZCode 的算法计算（`apps/zcode-cli/packages/core/src/memory/project-root.ts`）：

```
~/.zcode -> 追加 cli（basename 已是 cli 则不追加）
<storageRoot>/memories/projects/<slug>-<hash16>/memory/
hash16 = sha256(win32 ? resolve(cwd).toLowerCase() : resolve(cwd)).slice(0, 16)
slug   = 小写、非 [a-z0-9._-] 换 -、去首尾 -、截 48、空则 project
```

实际使用时有三级回退：

1. 配置里的 `dir`（最高优先级；ZCode 用了 workspace identity 或路径写法不一致时用它）
2. 算法算出的路径存在 → 用它
3. 不存在时，`memories/projects/` 下恰好一个 `<slug>-*` 目录 → 用它并警告；
   否则视为"该项目尚无 ZCode 记忆"（不创建目录；`memory_write` 时才按计算路径创建）

检测到 `project-` 前缀目录时会提示：ZCode 可能用了 workspace identity（slug 固定为 `project`，
hash 输入不是路径）。独立 CLI 与普通桌面项目不会出现这种情况。

## 配置

两个位置，深合并，项目覆盖全局：

- 全局：`<agent-dir>/extensions/zcode-memory.json`（默认 `~/.pi/agent/extensions/zcode-memory.json`）
- 项目：`<cwd>/.pi/zcode-memory.json`

```json
{
  "enabled": true,
  "dir": "D:/zcode/cli/memories/projects/chat-ace14747b286680c/memory",
  "injectIndex": true
}
```

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后工具仍注册，但不注入索引（工具本身仍可用） |
| `dir` | 无 | 显式记忆目录。任意异常场景的兜底 |
| `injectIndex` | `true` | 是否做索引注入 |

配置解析失败（文件坏了、JSON 不合法）不会让插件崩，退回默认值。

## 工具

| 工具 | 行为 |
| --- | --- |
| `memory_list` | 递归扫记忆目录（排除 `MEMORY.md`、不跟随目录符号链接），返回文件名 / name / description / type / mtime。坏 frontmatter 按 ZCode manifest 规则降级成"无描述条目"，不抛错 |
| `memory_read` | 按 name 或文件名定位；返回 frontmatter 摘要 + 正文。正文按 ZCode 召回上限截断（前 200 行 / 4096 字节）并提示去哪里读全文 |
| `memory_write` | `name` / `description` / `type` / `body` / `mode: create\|upsert`。原子写事实文件 + 维护 `MEMORY.md` 索引行 |

写入的 frontmatter 只有四个键：

```yaml
---
name: <kebab-case-slug>
description: <一行描述>
metadata:
  node_type: memory
  type: user | feedback | project | reference
---
```

**不写** `originSessionId`（ZCode 只在它缺失时自己补，我们不伪造 ZCode 的会话 id），
也不在 `metadata` 里加自定义键。

## 设计取舍

**为什么索引只注入一次，而不是每轮重注？**
对齐 ZCode：只有 `MEMORY.md` 进上下文，正文按需读。注入形态是 `before_agent_start` 返回的
一条 `display: false` custom 消息（不是塞进 system prompt）。之后用
`pi.appendEntry("zcode-memory/injected", { indexHash })` 记标记；`session_start`
（new / resume / fork）按当前会话投影重建标记。重新注入只有三种情况：索引内容 hash 变化、
注入消息被压缩摘要掉（不在保留尾部里）、`/memory reload`。`messageType === "custom"`
的运行（`pi.sendMessage(..., { triggerTurn: true })` 起的）直接跳过。

**为什么 `memory_write` 走 `withFileMutationQueue` + revision 重试，而不是做跨进程锁？**
ZCode 的前台写本来就没有跨进程锁（只有 Dream 持 `.consolidate-lock`），它靠
`expectedRevision`（`mtime:<截断毫秒>:size:<字节>`）发现并发。我们对齐同一条自愈路径：
进程内用 pi 的写队列串行；`MEMORY.md` 写前比对 revision，不一致就重读重试一次，再失败
就报错让模型重试——**不静默覆盖**。这会让 ZCode 下一次写看到 `stale_write`，它重读后
即可继续，属于它设计内的行为。

**为什么 `memory_read` 后要发读态事件？**
用 `memory_read` 读过的记忆，紧接着用内置 `edit` 修改时不应该再被
[pi-read-guard](https://github.com/Momenttttt/pi-extension-suite) 要求"先读"。两个包通过
`pi.events` 共享总线互通（频道 `read-guard/file-read`）：发布方只 `emit`，接收方只 `on`，
任一方缺席时静默降级，没有 import 依赖。相比"配置声明的读态提供方"，少一层配置形状与
解析规则，收益相同。截断读发布 `kind: "truncated"` 且不带内容 hash —— 截断读不能成为
写水位，和内置 `read` 的 `details.truncation` 是同一条规则。

**为什么正文读取要模仿 ZCode 的截断上限？**
`memory_read` 返回的就是"会话里实际可用的量"：ZCode 召回一条记忆时最多取前 200 行 /
4096 字节，完整内容始终可以用内置 `read` 读。这样模型不会误以为工具给了全文。

**为什么目录算法不做 `~` 展开、不做 realpath？**
对齐 ZCode 的 `resolve(cwd)`：hash 的输入就是路径字符串。realpath 会把符号链接/短路径
折成另一个字符串，反而算错目录。win32 折叠大小写也只跟 ZCode 一致，目的是让同一目录的
不同写法落到同一个 hash。

## 边界与已知限制

- **与 ZCode 是最终一致，不是实时同步。** ZCode 的 `MEMORY.md` **整个运行期只读一次**
  （`runtime.memoryIndexContent` 只在首次上下文初始化时赋值），刷新点只有首次初始化、
  冷恢复、`/clear`。**压缩不是刷新点**——陈旧索引会活过压缩。所以 pi 写完记忆后，
  ZCode 那个正在跑的会话看不到，要到新会话/冷恢复才可见；事实文件正文不被缓存，
  比索引新鲜。
- **ZCode 的 `Write` 是整体覆盖。** 它拿着旧快照写 `MEMORY.md` 时，我们的外部改动会被
  整份盖掉（它不会合并）。缓解只有"每次写前读一次"和"不要在 ZCode 正主动写记忆时批量写"。
- **索引可能被模型写坏。** `memory_list` 走文件系统兜底；`/memory` 给出孤儿索引行与
  未入索引文件的体检，但**不自动修正**索引。
- **frontmatter 只在前 30 行内解析。** 与 ZCode manifest 的预览窗口一致；闭合行更靠后的
  文件在 ZCode 侧同样会被当成"无描述条目"。
- **写入拒绝跟随符号链接。** 目标是符号链接时报错，要求传真实路径。
- **`memory_read` 截断读不会成为写水位**：接着用内置 `edit` 改同一文件仍会被
  pi-read-guard 要求重读（先读后写约束的预期行为）。
- **没有删除工具、没有自动抽取。** v1 需要"忘记"时用内置 `bash rm`；提炼记忆走显式
  工具调用，不在后台跑模型。
- **索引是 `custom_message`**，不在 pi-context-guard 微压缩的可清理白名单里，不会被清理。

## 开发

```bash
npm install
npm run check        # typecheck + test + 文档交叉引用
git config core.hooksPath .githooks   # 提交身份与提交信息格式钩子
```

测试分两层：纯函数单测（目录算法、frontmatter、解析/截断、索引行、注入决策），以及
"进程内真实会话 + 桩 provider"的端到端测试（工具输出、索引注入、与 read-guard 的互通）。

## License

MIT
