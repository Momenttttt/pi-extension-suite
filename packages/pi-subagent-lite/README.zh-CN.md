# @momenttttt/pi-subagent-lite

[English](README.md) · [pi 扩展四件套](https://github.com/Momenttttt/pi-extension-suite)

进程内、默认隔离的轻量子代理。

- 两个内置代理：`Explore`（只读广搜）、`general-purpose`（通用委派）
- 代理由 md 档案定义，放在三个可预期的目录里；同名档案**整份替换**
- 子代理对话不落盘、不继承父会话历史，也**不能再派子代理**（递归不可能）
- 模型侧工具名 `subagent`

## 安装

```bash
pi install npm:@momenttttt/pi-subagent-lite
```

想不安装先试试这个包的效果：

```bash
pi -e ./packages/pi-subagent-lite/extensions/subagent-lite.ts
```

## 用法

模型调用：

```
subagent(description, prompt, subagent_type?, model?)
```

`description` 与 `prompt` 必填；省略 `subagent_type` 走 `general-purpose`。子代理看不到当前对话，所有需要的上下文都要写进 `prompt`。工具结果 = 子代理的最终文本 + 一行摘要（`agent` / `status` / `turns` / `tool_calls` / `duration` / `tokens`），结构化同项在 `details` 里。

`/agents` 列出最终生效的代理（来源、解析出的实际模型、工具数与个数、提示词模式、是否读 `AGENTS.md`、`maxTurns`），以及被跳过的文件与原因、覆盖告警、与同类扩展的冲突。

## 代理档案

```markdown
---
name: reviewer            # 省略时用文件名
description: 何时该用这个代理
tools: read, grep, find   # 字符串或数组；"*" 或省略 = 该 SDK 的默认全量
disallowedTools: write    # 从 tools 结果里再减
model: inherit            # inherit（默认，跟随会话模型）或 provider/model
thinking: inherit         # inherit 或 off/minimal/low/medium/high/xhigh/max
maxTurns: 12              # 可选；不写则不限
promptMode: append        # append（默认，追加到 pi 标准提示词之后）| replace
injectAgentsMd: true      # 子代理是否读项目 AGENTS.md
enabled: true
---

正文会追加进子代理的系统提示词（`promptMode: replace` 时整段替换）。
```

**加载层序**（低 → 高，同名整文件替换，覆盖时打告警）：

| 层 | 位置 |
| --- | --- |
| 内置 | 代码里的 `Explore` 与 `general-purpose` |
| 用户级 | `<agent-dir>/agents/*.md`（默认 `~/.pi/agent/agents`） |
| 项目级（兼容） | `<repo>/.agents/agents/*.md` |
| 项目级（权威） | `<repo>/.pi/agents/*.md` |

项目目录从当前工作目录向上找，遇到含 `.pi/` 或 `.agents/` 的目录即取，走到 git 根为止，**最近的一层赢**。目录非递归（只看那一层）。解析失败只让该文件进 `/agents` 的“跳过 + 原因”，不阻断启动。

旧字段名兼容（读到旧名会给警告，不静默）：`display_name` → `name`、`prompt_mode` → `promptMode`、`disallowed_tools` → `disallowedTools`、`max_turns` → `maxTurns`。

## 配置

两个位置，深合并，项目覆盖全局：

- 全局：`<agent-dir>/extensions/subagent-lite.json`
- 项目：`<cwd>/.pi/subagent-lite.json`

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后 `subagent` 工具仍在（工具无法注销），但每次调用会直接回一条“已在配置里关闭”，不跑子会话；冲突检测与守卫注入告警也停用 |
| `guardExtensionPaths` | 不写 = 自动 | 子会话额外加载的扩展路径。不写就自动解析 `@momenttttt/pi-read-guard` 并在子会话里注入它；写 `[]` 显式关闭；写路径列表则只用这些路径 |

## 设计取舍

**Explore 的只读是提示词级的约定，不是沙箱。** `Explore` 保留完整 `bash`，工具池里只是没有 `edit` / `write`；只读语义由它系统提示词里那两段禁令承担（允许的只读命令类别 + 明确禁止的类别 + “拿不准就先报告”）。用命令策略去“硬化”它是一条可被怪写法绕过的假沙箱，还会让“Explore 能做什么”变成本项目独有语义。README 与提示词都不暗示有强制只读：模型若无视提示词，仍可能写出文件。

**两个内置代理都跟随会话模型（`model: inherit`），不写死模型。** 好处是能力与成本口径一致、切换模型时子代理跟着切；代价是 Explore 类广搜的账单跟着会话模型走，可能比固定用一个便宜模型贵。需要省钱就在档案里给单个代理写 `model: provider/id`，`/agents` 会显示每个代理解析出的实际模型，避免“以为用的是便宜模型”。

**同名档案整份替换，不做字段合并。** 想只改内置 Explore 的模型，就得把它的定义整份抄下来改。这是可接受的成本，换来的是一份代理定义永远自洽（不会出现半新半旧的字段）。pi 自己的资源覆盖也是整文件语义。

**子代理会话不落盘。** 落盘的动机通常是支撑 resume/续聊；本插件不需要 resume，于是不写盘：不占磁盘，也不把子代理读过的敏感内容落到盘上。将来的 resume 要重新评估这个决定。

**用量回传给父会话。** pi 的会话合计依赖工具结果里的 `usage`，所以一律回传，账要准。

**`details.truncated` 只管正文截断，`maxTurns` 到点停由 `status: "max_turns"` 表达。** 设计文档把“结果被截断”和“没跑完”合用一个布尔字段，这里拆开：一个布尔表达不了两件事，而 `status` 本来就能区分。

**`turns` 是近似值。** 按 assistant 消息条数计数（实测 `message_end` 每条消息一次，次数与 `turn_end` 一致），不是“模型轮次”的严格口径；中途被中断时 pi 还会补一条空的 assistant 消息，所以中断场景下它会多算一条。`maxTurns` 只用于“到点就停”，宁可早停不跑飞。

**`maxTurns` 默认不设。** 不控成本，跑到自然结束；跑飞时靠父级中断（Esc → `ctx.signal` → 子会话 `abort()`）兜底。

**子代理默认也受“先读后写”约束，但读态表是空的。** 子会话默认注入 `pi-read-guard`（自动按包名解析，`guardExtensionPaths` 可指定或关闭），子代理必须自己读一遍才能改，读态表不继承父会话，代价是少量额外 token。解析不到守卫时**不中断**子代理：只把注入关掉、明确告警，`/agents` 里也显示“未注入”。

**守卫路径的解析方式与设计文档不同，这是实测的结果。** 设计写的是 `import.meta.resolve("@momenttttt/pi-read-guard")`，但 pi 用 jiti 加载扩展（模块被转成 `data:` URL），在那里 `import.meta.resolve` 会抛 `Invalid relative URL or base scheme is not hierarchical`；而且包名本身也没有 `main`/`exports`，解析出来的不是扩展文件。实现改成：优先 `import.meta.resolve`，抛了就退回 `createRequire(import.meta.url).resolve`，先解析 `<包>/package.json`、再按它的 `pi.extensions` 清单拼出扩展文件路径（两条路都实测过）。

**子会话复用父会话的模型运行时。** 不这么做时 `model: inherit` 在子会话里会失败：父会话里由扩展注册的 provider（代理 provider 等）只存在于父会话的运行时中，子会话自建的那个不认识它。pi 没有公开的取法，所以这里按结构校验后复用；拿不到就退回“子会话自建”，并在工具结果里明说，不静默假设。

## 边界与已知限制

- **与同类子代理扩展不并存。** pi 的工具注册是后写者胜且不报错，所以本插件在 `session_start` 扫 `pi.getAllTools()`，发现别人注册的 `Agent` / `Task` / `subagent` 就明确告警并建议卸载（`/agents` 里也列出来）。
- **子会话的隔离靠 `noExtensions: true`。** 它同时也让子代理结构上不可能再派子代理。副作用是子代理拿不到扩展工具，只有守卫这一条例外（`additionalExtensionPaths` 在 `noExtensions: true` 下依然生效，实测过）。
- **子代理只拿到 `prompt` + 自己的系统提示词**，不继承父会话历史（不做 fork、没有上下文继承开关；v1 也不做后台执行与完成通知）。
- **同一条助手消息里并行的多个 `general-purpose` 子代理可能互相踩文件**（它们都能写）。Explore 只读，并行安全。v1 不强制串行，只在提示词与档案里提示。
- **结果体积上限 100k 字节**（UTF-8，`truncateHead`，超出时正文里注明）。
- **后台执行、技能预加载、worktree 隔离、每代理持久记忆**都不做（后台执行列 v2）。

## 先验证再安装

```bash
npm install
npm run check        # typecheck + 测试
```

检查在本地跑，不需要网络：覆盖档案解析与层序、委派一个真实会话、用量回传，以及中断处理。

## License

MIT
