# @momenttttt/pi-subagent-lite

[中文文档](https://github.com/Momenttttt/pi-extension-suite/blob/main/packages/pi-subagent-lite/README.zh-CN.md) · [pi extension suite](https://github.com/Momenttttt/pi-extension-suite)

Lightweight subagents that run in-process and are isolated by default.

- Two built-in agents: `Explore` (read-only broad search) and `general-purpose`
- Agents are defined by markdown profiles in three predictable directories; a profile with the same name **replaces the built-in one whole**
- A subagent's conversation is never written to disk, it does not inherit the parent's history, and it **cannot spawn subagents of its own** (recursion is impossible by construction)
- The model-facing tool name is `subagent`

## Install

```bash
pi install npm:@momenttttt/pi-subagent-lite
```

To try this package without installing it:

```bash
pi -e ./packages/pi-subagent-lite/extensions/subagent-lite.ts
```

## Usage

The model calls:

```
subagent(description, prompt, subagent_type?, model?)
```

`description` and `prompt` are required; leaving `subagent_type` out uses `general-purpose`. A subagent cannot see the current conversation, so everything it needs has to be written into `prompt`. The tool result is the subagent's final text plus a one-line summary (`agent` / `status` / `turns` / `tool_calls` / `duration` / `tokens`), with the same items in structured form under `details`.

`/agents` lists the agents that are actually in effect (source, resolved model, tool count, prompt mode, whether it reads `AGENTS.md`, `maxTurns`), along with any files that were skipped and why, override warnings, and conflicts with similar extensions.

## Agent profiles

```markdown
---
name: reviewer            # falls back to the file name when omitted
description: when this agent should be used
tools: read, grep, find   # string or array; "*" or omitted = the SDK's full default set
disallowedTools: write    # subtracted from the result of tools
model: inherit            # inherit (default, follows the session model) or provider/model
thinking: inherit         # inherit, or off/minimal/low/medium/high/xhigh/max
maxTurns: 12              # optional; no limit when absent
promptMode: append        # append (default, after pi's standard prompt) | replace
injectAgentsMd: true      # whether the subagent reads the project AGENTS.md
enabled: true
---

The body is appended to the subagent's system prompt (or replaces it entirely under `promptMode: replace`).
```

**Load order** (low to high; the same name replaces the whole file, with a warning):

| Layer | Location |
| --- | --- |
| Built-in | `Explore` and `general-purpose`, from the code |
| User level | `<agent-dir>/agents/*.md` (default `~/.pi/agent/agents`) |
| Project (compatibility) | `<repo>/.agents/agents/*.md` |
| Project (authoritative) | `<repo>/.pi/agents/*.md` |

The project directory is found by walking up from the current working directory: the first directory that contains `.pi/` or `.agents/` wins, and the walk stops at the git root, so the nearest layer wins. Directories are not searched recursively (only that one level). A file that fails to parse only shows up in `/agents` as "skipped, with a reason"; it never blocks startup.

Older field names still work, with a warning rather than silently: `display_name` → `name`, `prompt_mode` → `promptMode`, `disallowed_tools` → `disallowedTools`, `max_turns` → `maxTurns`.

## Configuration

Two locations, deep-merged, project over global:

- Global: `<agent-dir>/extensions/subagent-lite.json`
- Project: `<cwd>/.pi/subagent-lite.json`

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | when off, the `subagent` tool stays registered (a tool cannot be unregistered) but every call returns "disabled in configuration" without running a sub-session; conflict detection and guard-injection warnings are off too |
| `guardExtensionPaths` | unset = automatic | extension paths loaded into sub-sessions in addition. Unset resolves `@momenttttt/pi-read-guard` automatically and injects it into sub-sessions; `[]` turns that off explicitly; a list of paths uses only those |

## Design tradeoffs

**Explore's read-only is an agreement at the prompt level, not a sandbox.** `Explore` keeps the full `bash` tool; `edit` / `write` are simply absent from its tool pool. The read-only semantics are carried by two paragraphs of its system prompt (which classes of read-only commands are allowed, which are explicitly forbidden, and "if you are unsure, report first"). Hardening it with a command policy would be a fake sandbox that a creative command line can slip past, and it would make "what Explore can do" mean something unique to this project. Neither this README nor the prompt implies enforcement: a model that ignores the prompt can still write files.

**Both built-in agents follow the session model (`model: inherit`) rather than pinning one.** Capability and cost stay on the same footing, and switching models switches the subagents with it. The cost is that a broad search like Explore is billed at the session model's rate, which can be more expensive than pinning a cheap model. To save money, put `model: provider/id` in a profile; `/agents` shows the model actually resolved for each agent, so you are never wrong about what you are paying for.

**A same-name profile replaces the whole file; fields are never merged.** To change only the built-in Explore's model, you copy its definition and edit that. That is an acceptable cost for a property worth having: a profile is always self-consistent, never half old and half new. pi's own resource overrides are whole-file too.

**Subagent sessions are never written to disk.** Persisting usually exists to support resume, and this plugin has no resume, so nothing is written: no disk usage, and nothing a subagent read lands on disk. A future resume feature will have to revisit this decision.

**Usage is reported back to the parent.** pi's session totals depend on the `usage` in tool results, so it is always passed through. The numbers have to be right.

**`details.truncated` covers body truncation only; stopping at `maxTurns` is expressed as `status: "max_turns"`.** The design document folded "the result was truncated" and "it did not finish" into one boolean, and they are split apart here: one boolean cannot say two things, and `status` already distinguishes them.

**`turns` is an approximation.** It counts assistant messages (measured: one `message_end` per message, the same count as `turn_end`), which is not a strict "model turns" measure; when a run is interrupted pi adds an empty assistant message, so an interrupted run counts one extra. `maxTurns` only exists to stop at a limit: stopping early beats running away.

**`maxTurns` is unset by default.** Cost is not capped, and a run simply goes until it stops. When one runs away, an interrupt from the parent is the backstop (Esc → `ctx.signal` → the sub-session's `abort()`).

**Subagents are subject to read-before-write by default, starting from an empty read-state table.** A sub-session has `pi-read-guard` injected by default (resolved by package name; `guardExtensionPaths` can name paths or turn it off), so a subagent has to read a file itself before changing it. Read state is not inherited from the parent, at the cost of a few extra tokens. When the guard cannot be resolved the subagent is **not** cut off: injection is turned off with a clear warning, and `/agents` says "not injected".

**Resolving the guard path deviates from the design document, based on measurement.** The design said `import.meta.resolve("@momenttttt/pi-read-guard")`, but pi loads extensions with jiti (modules become `data:` URLs), where `import.meta.resolve` throws `Invalid relative URL or base scheme is not hierarchical`; and the package has no `main`/`exports` anyway, so that would not resolve to the extension file. The implementation tries `import.meta.resolve` first and falls back to `createRequire(import.meta.url).resolve` when it throws, resolving `<package>/package.json` and then building the extension file path from its `pi.extensions` list. Both paths were measured.

**Sub-sessions reuse the parent session's model runtime.** Without that, `model: inherit` fails inside a sub-session: a provider registered by an extension in the parent session (a proxy provider, say) exists only in the parent's runtime, and the one a sub-session builds itself does not know it. pi exposes no public way to get it, so it is reused after a structural check; when that is not possible, it falls back to a self-built sub-session runtime and says so in the tool result rather than assuming silently.

## Boundaries and known limits

- **Does not coexist with other subagent extensions.** pi's tool registration is last-writer-wins and silent, so this plugin scans `pi.getAllTools()` at `session_start` and, when someone else's `Agent` / `Task` / `subagent` is registered, warns clearly and suggests uninstalling the other one (`/agents` lists them as well).
- **Sub-session isolation rests on `noExtensions: true`.** The same flag makes it structurally impossible for a subagent to spawn another. The side effect is that subagents get no extension tools, with one exception: the guard still applies, because `additionalExtensionPaths` takes effect under `noExtensions: true` too (measured).
- **A subagent gets only `prompt` plus its own system prompt.** It does not inherit the parent's history (no forking, no context-inheritance switch; v1 also skips background execution and completion notifications).
- **Several `general-purpose` subagents running in parallel within one assistant message can step on the same files** (they can all write). Explore is read-only and safe to parallelize. v1 does not force serialization; the prompt and the profiles merely advise it.
- **Result size is capped at 100k bytes** (UTF-8, `truncateHead`, noted in the body when it happens).
- **Background execution, skill preloading, worktree isolation and per-agent persistent memory are out of scope** (background execution is on the v2 list).

## Verify before installing

```bash
npm install
npm run check        # typecheck + tests
```

The checks run offline: they cover profile parsing and layer order, delegating over a real session, usage reported back to the parent, and interrupts.

## License

MIT
