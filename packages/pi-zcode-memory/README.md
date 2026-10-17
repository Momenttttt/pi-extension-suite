# @momenttttt/pi-zcode-memory

[中文文档](https://github.com/Momenttttt/pi-extension-suite/blob/main/packages/pi-zcode-memory/README.zh-CN.md) · [pi extension suite](https://github.com/Momenttttt/pi-extension-suite)

One project memory shared between pi and ZCode.

- Three tools: `memory_list`, `memory_read`, `memory_write`
- Only the `MEMORY.md` index is injected, once, at session start; bodies are never injected automatically and are read on demand
- The directory algorithm, the index format and the fact-file frontmatter all follow ZCode item by item, so both sides read and write the same files
- `/memory` shows the status and checks the index; `/memory reload` forces the next run to inject again

## Install

```bash
pi install npm:@momenttttt/pi-zcode-memory
```

Or load a working copy from a checkout, without installing it:

```bash
pi -e ./packages/pi-zcode-memory/extensions/zcode-memory.ts
```

## How the memory directory is located

Computed with the shared memory directory's path algorithm:

```
~/.zcode -> append cli (not appended when the basename already is cli)
<storageRoot>/memories/projects/<slug>-<hash16>/memory/
hash16 = sha256(win32 ? resolve(cwd).toLowerCase() : resolve(cwd)).slice(0, 16)
slug   = lowercase, non [a-z0-9._-] to -, trim leading/trailing -, cut to 48, "project" when empty
```

At runtime there are three tiers of fallback:

1. `dir` from the configuration (highest priority; for when the algorithm does not match, e.g. a workspace identity or a different spelling of the path)
2. The path the algorithm computes, when it exists
3. When it does not exist: exactly one `<slug>-*` directory under `memories/projects/` is used, with a warning; otherwise the project is treated as having no ZCode memory yet (no directory is created; `memory_write` creates it under the computed path when it is actually needed)

A directory carrying the `project-` prefix triggers a note: ZCode may have used a workspace identity (slug fixed to `project`, hash input not a path). Standalone CLI sessions and ordinary desktop projects do not look like that.

## Configuration

Two locations, deep-merged, project over global:

- Global: `<agent-dir>/extensions/zcode-memory.json` (default `~/.pi/agent/extensions/zcode-memory.json`)
- Project: `<cwd>/.pi/zcode-memory.json`

```json
{
  "enabled": true,
  "dir": "D:/zcode/cli/memories/projects/chat-ace14747b286680c/memory",
  "injectIndex": true
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | when off, the tools stay registered but the index is not injected (the tools themselves still work) |
| `dir` | none | explicit memory directory. The fallback for any case the algorithm cannot handle |
| `injectIndex` | `true` | whether to inject the index |

A config that fails to parse (corrupt file, invalid JSON) does not crash the extension; it falls back to the defaults.

## Tools

| Tool | Behavior |
| --- | --- |
| `memory_list` | walks the memory directory recursively (skipping `MEMORY.md`, not following directory symlinks) and returns file name / name / description / type / mtime. Broken frontmatter degrades to an entry with no description instead of throwing |
| `memory_read` | locates a memory by name or file name and returns the frontmatter summary plus the body. The body is truncated at ZCode's recall limit (first 200 lines / 4096 bytes) with a pointer to where the full text can be read |
| `memory_write` | takes `name` / `description` / `type` / `body` / `mode: create\|upsert`. Writes the fact file atomically and maintains its line in the `MEMORY.md` index |

A written frontmatter carries four keys and no more:

```yaml
---
name: <kebab-case-slug>
description: <one-line description>
metadata:
  node_type: memory
  type: user | feedback | project | reference
---
```

`originSessionId` is **not** written: that is a lazy field the reading side fills in itself when it is missing, and borrowing another tool's session id would be a fabrication. No custom keys are added to `metadata` either.

## Design tradeoffs

**Why is the index injected once instead of on every turn?**
Only `MEMORY.md` enters the context; bodies are read on demand. The injection is a `display: false` custom message returned from `before_agent_start` (not stuffed into the system prompt). A marker is then recorded with `pi.appendEntry("zcode-memory/injected", { indexHash })`, and `session_start` (new / resume / fork) rebuilds the marker from the current session projection. Re-injection happens in exactly three cases: the index content hash changed, the injected message was summarized away (no longer in the kept tail), or `/memory reload` was run. Runs with `messageType === "custom"` (started by `pi.sendMessage(..., { triggerTurn: true })`) are skipped outright.

**Why does `memory_write` use `withFileMutationQueue` plus a revision retry instead of a cross-process lock?**
ZCode's foreground writes have no cross-process lock either (only its background organizing process does); it detects concurrency through a revision (`mtime:<truncated ms>:size:<bytes>`). This package takes the same self-healing path: writes are serialized in-process through pi's queue, and before writing `MEMORY.md` the revision is compared; on a mismatch it re-reads and retries once, and on a second failure it returns an error for the model to retry. It **never** overwrites silently. The cost is that ZCode's next write hits a revision conflict, which it resolves by re-reading the index.

**Why does `memory_read` emit a read-state event?**
A memory read through `memory_read` and then modified with the built-in `edit` should not be rejected by [pi-read-guard](https://github.com/Momenttttt/pi-extension-suite/blob/main/packages/pi-read-guard/README.md) for not having been read. The two packages talk over `pi.events` (channel `read-guard/file-read`): the publisher only `emit`s, the subscriber only `on`s, and either side's absence degrades silently. There is no import dependency between them. Compared with a "configure your read-state provider" approach, this drops a layer of configuration shape and parsing rules for the same benefit. A truncated read publishes `kind: "truncated"` with no content hash: a truncated read cannot become a write watermark, the same rule the built-in `read` follows through `details.truncation`.

**Why cap what `memory_read` returns?**
What `memory_read` returns is what is actually available in the session: a recalled memory carries at most its first 200 lines / 4096 bytes, and the full text is always reachable with the built-in `read`. That way the model does not mistake the tool output for the whole file.

**Why does the directory algorithm skip `~` expansion and realpath?**
The hash input is the path string `resolve(cwd)` and nothing else. realpath would fold symlinks and short paths into a different string and compute the wrong directory. Folding case on win32 serves the same purpose: different spellings of one directory land on the same hash.

## Boundaries and known limits

- **Eventual consistency with ZCode, not live sync.** ZCode reads `MEMORY.md` **once for the entire run**; it refreshes only at first context initialization, cold resume and `/clear`. **Compaction is not a refresh point**, so a stale index survives it. After pi writes a memory, a ZCode session that is already running cannot see it until a new session or a cold resume; fact-file bodies are not cached and are fresher than the index.
- **ZCode's `Write` is a full overwrite.** When it writes `MEMORY.md` from a stale snapshot, outside changes are wiped wholesale (it does not merge). The only mitigations are reading before every write, and not batch-writing while ZCode is actively writing memory.
- **The index can be corrupted by the model.** `memory_list` falls back to the filesystem; `/memory` reports orphan index lines and files missing from the index, but does not repair the index automatically.
- **Frontmatter is only parsed within the first 30 lines.** A file whose closing `---` sits lower is treated as having no description by whichever side reads it, so a written frontmatter has to stay short.
- **Writes refuse to follow symlinks.** A symlink target is an error, and the real path has to be passed instead.
- **A truncated `memory_read` does not become a write watermark**: editing the same file with the built-in `edit` afterwards still triggers a re-read demand from pi-read-guard. That is the expected behavior of the read-before-write rule.
- **No delete tool, no automatic extraction.** In v1, forgetting something means the built-in `bash rm`; distilling memory is an explicit tool call, with no background model run.
- **The index is a `custom_message`**, outside pi-context-guard's prunable whitelist, so it is never pruned.

## Verify before installing

```bash
npm install
npm run check        # typecheck + tests
```

The checks run offline: they cover the directory algorithm, frontmatter parsing, index injection, and the hand-off with pi-read-guard.

## License

MIT
