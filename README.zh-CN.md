# pi 扩展四件套

[English](README.md)

[![check](https://github.com/Momenttttt/pi-extension-suite/actions/workflows/check.yml/badge.svg)](https://github.com/Momenttttt/pi-extension-suite/actions/workflows/check.yml)
[![pi-read-guard](https://img.shields.io/npm/v/@momenttttt/pi-read-guard?label=pi-read-guard)](https://www.npmjs.com/package/@momenttttt/pi-read-guard)
[![pi-context-guard](https://img.shields.io/npm/v/@momenttttt/pi-context-guard?label=pi-context-guard)](https://www.npmjs.com/package/@momenttttt/pi-context-guard)
[![pi-subagent-lite](https://img.shields.io/npm/v/@momenttttt/pi-subagent-lite?label=pi-subagent-lite)](https://www.npmjs.com/package/@momenttttt/pi-subagent-lite)
[![pi-zcode-memory](https://img.shields.io/npm/v/@momenttttt/pi-zcode-memory?label=pi-zcode-memory)](https://www.npmjs.com/package/@momenttttt/pi-zcode-memory)

给 pi（`@earendil-works/pi-coding-agent`）写的四个扩展，同一个仓库。每个包单独安装、单独使用，兄弟包不在时照常工作，需要哪个装哪个。

## 四个包

| 包 | 它补的是什么 |
| --- | --- |
| [`@momenttttt/pi-read-guard`](packages/pi-read-guard/README.md) | 给内置 `edit` / `write` 加上先读后写硬约束：已存在的文件必须在本会话里读过，而且读过之后没被改动过，才允许覆盖。 |
| [`@momenttttt/pi-context-guard`](packages/pi-context-guard/README.md) | 补上 pi 缺的两层客户端上下文能力。微压缩把较早的工具结果换成占位符，默认只在会话空闲后自动跑；裁剪由模型指认一段不再需要的历史，可撤销，原始记录仍在会话文件里。pi 原生的压缩不动。 |
| [`@momenttttt/pi-subagent-lite`](packages/pi-subagent-lite/README.md) | 进程内、默认隔离的子代理：内置 `Explore` 与 `general-purpose`，也可以用自己的 md 档案。子代理对话不落盘，也不能再派子代理。 |
| [`@momenttttt/pi-zcode-memory`](packages/pi-zcode-memory/README.md) | 与 ZCode 共用同一份项目记忆：`memory_list` / `memory_read` / `memory_write` 读写同一批文件，会话开始只注入 `MEMORY.md` 索引。 |

安装、配置、设计取舍与已知边界都在各包 README 里。

## 安装

```bash
pi install npm:@momenttttt/pi-read-guard
pi install npm:@momenttttt/pi-context-guard
pi install npm:@momenttttt/pi-subagent-lite
pi install npm:@momenttttt/pi-zcode-memory
```

不想要的就不装。四包之间没有依赖，没有哪个包 import 兄弟包；下面这些联动在对方缺席时静默降级。

想不安装的情况下先试试某个包的效果：

```bash
pi -e ./packages/pi-read-guard/extensions/read-guard.ts
pi -e ./packages/pi-context-guard/extensions/context-guard.ts
pi -e ./packages/pi-subagent-lite/extensions/subagent-lite.ts
pi -e ./packages/pi-zcode-memory/extensions/zcode-memory.ts
```

想先验证再装的话，检查项在本地就能跑，不需要网络：

```bash
npm install
npm run check   # typecheck + 测试
```

## 四包怎么配合

三处交叉，都是软连接：

- **`pi-subagent-lite` → `pi-read-guard`**。子代理会话默认加载守卫，委派出去的写操作同样过门禁。解析不到守卫时子代理照样跑，只是关掉注入并明确告警。
- **`pi-zcode-memory` → `pi-read-guard`**。用 `memory_read` 读过的文件会在 pi 的事件总线上留下读态，守卫认它算读过，不再要求重读。
- **`pi-context-guard` ← 另外两个**。记忆索引是 custom 消息，`subagent` 与 `memory_read` 的结果默认不在清理范围内，上下文层不会把前两个包刚放到模型眼前的东西抹掉。

## 环境要求

- pi 1.3.0 或更新（四个包都按它的扩展类型契约开发、测试）
- Node.js 22.19 或更新

个人维护的项目，不收 PR 与外部 issue，fork 随意。MIT 许可，见 [LICENSE](LICENSE)。
