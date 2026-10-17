# pi extension suite

[中文文档](README.zh-CN.md)

[![check](https://github.com/Momenttttt/pi-extension-suite/actions/workflows/check.yml/badge.svg)](https://github.com/Momenttttt/pi-extension-suite/actions/workflows/check.yml)
[![pi-read-guard](https://img.shields.io/npm/v/@momenttttt/pi-read-guard?label=pi-read-guard)](https://www.npmjs.com/package/@momenttttt/pi-read-guard)
[![pi-context-guard](https://img.shields.io/npm/v/@momenttttt/pi-context-guard?label=pi-context-guard)](https://www.npmjs.com/package/@momenttttt/pi-context-guard)
[![pi-subagent-lite](https://img.shields.io/npm/v/@momenttttt/pi-subagent-lite?label=pi-subagent-lite)](https://www.npmjs.com/package/@momenttttt/pi-subagent-lite)
[![pi-zcode-memory](https://img.shields.io/npm/v/@momenttttt/pi-zcode-memory?label=pi-zcode-memory)](https://www.npmjs.com/package/@momenttttt/pi-zcode-memory)

Four extensions for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`), in one repository. Each package installs on its own and keeps working when its siblings are absent, so take only what you need.

## Packages

| Package | What it adds |
| --- | --- |
| [`@momenttttt/pi-read-guard`](packages/pi-read-guard/README.md) | Read-before-write as a hard rule for the built-in `edit` / `write` tools: a file that already exists must have been read in this session, and must not have changed since, before pi may overwrite it. |
| [`@momenttttt/pi-context-guard`](packages/pi-context-guard/README.md) | Two client-side context layers pi does not have: **microcompact** (older tool results swapped for placeholders, by default only when the session has been idle) and **snip** (the model asks for a stretch of history to be dropped; undoable, and the session file keeps everything). pi's own compaction is left untouched. |
| [`@momenttttt/pi-subagent-lite`](packages/pi-subagent-lite/README.md) | In-process, isolated subagents: the built-in `Explore` and `general-purpose` agents, plus markdown profiles for your own. Nothing is written to disk and subagents cannot spawn subagents. |
| [`@momenttttt/pi-zcode-memory`](packages/pi-zcode-memory/README.md) | One project-memory directory shared with ZCode: `memory_list` / `memory_read` / `memory_write` over the same files, with only the `MEMORY.md` index injected at session start. |

Each package README carries its own install notes, configuration, design tradeoffs and known limits.

## Install

```bash
pi install npm:@momenttttt/pi-read-guard
pi install npm:@momenttttt/pi-context-guard
pi install npm:@momenttttt/pi-subagent-lite
pi install npm:@momenttttt/pi-zcode-memory
```

Drop the ones you do not want. There are no cross-package dependencies: nothing imports a sibling, and the optional links below quietly do nothing when the other side is missing.

To try a package without installing it:

```bash
pi -e ./packages/pi-read-guard/extensions/read-guard.ts
pi -e ./packages/pi-context-guard/extensions/context-guard.ts
pi -e ./packages/pi-subagent-lite/extensions/subagent-lite.ts
pi -e ./packages/pi-zcode-memory/extensions/zcode-memory.ts
```

And if you would rather verify before installing, the checks run locally and need no network:

```bash
npm install
npm run check   # typecheck + tests
```

## How they fit together

Three touch points, all soft:

- **`pi-subagent-lite` → `pi-read-guard`.** Each subagent session loads the guard by default, so delegated writes go through the same gate. If the package cannot be resolved, the subagent still runs, with a warning and the gate off.
- **`pi-zcode-memory` → `pi-read-guard`.** A file read through `memory_read` publishes read state on pi's event bus, so the guard accepts it as "read" instead of demanding another read.
- **`pi-context-guard` ← the other two.** The memory index injection is a custom message and the `subagent` / `memory_read` results are off the prune list by default, so the context layer does not erase what the other two just put in front of the model.

## Requirements

- pi 1.3.0 or newer. The packages are built and tested against its extension type contract.
- Node.js 22.19 or newer.

This is a personally maintained project: pull requests and external issues are not accepted, though forking is fine. MIT licensed, see [LICENSE](LICENSE).
