# @momenttttt/pi-read-guard

[中文文档](https://github.com/Momenttttt/pi-extension-suite/blob/main/packages/pi-read-guard/README.zh-CN.md) · [pi extension suite](https://github.com/Momenttttt/pi-extension-suite)

Read-before-write as a hard rule for pi's built-in `edit` / `write` tools: before writing to a file that already exists, it must have been read **in this session**, and it must not have changed since that read.

pi's `write` is a full overwrite with no checks in front of it, and `edit` insists on an exact match but has no notion of "the file changed after you read it". This package adds that layer.

## Install

```bash
pi install npm:@momenttttt/pi-read-guard
```

Or load a working copy from a checkout, without installing it:

```bash
pi -e ./packages/pi-read-guard/extensions/read-guard.ts
```

## What it blocks

| Case | Result |
| --- | --- |
| Target file does not exist (a new file) | allowed |
| File not read in this session | **blocked**, reason asks for a read first |
| The read was truncated (`read` reported truncation) | **blocked**, reason points to chunked reads or a targeted `edit` |
| Read earlier, file changed since (mtime moved forward, content differs) | **blocked**, reason asks for a re-read |
| Read earlier, file was only touched (mtime changed, content identical) | allowed |
| Only a ranged read (`offset`/`limit`), file unchanged since | allowed |
| Only a ranged read, file changed since | **blocked** (re-read) |

The **last line** of a blocking reason is a fixed-format code line, so other extensions and scripts can match on it:

```
(read-guard: not_read)
```

Three codes: `not_read`, `truncated_read`, `modified_since_read`. pi's `tool_call` result carries only `{ block, reason, terminate }` and no structured `details`, so the code has to live in the `reason` text; that is the only place a downstream reader can find it.

## Configuration

Two locations, deep-merged, project over global:

- Global: `<agent-dir>/extensions/read-guard.json` (default `~/.pi/agent/extensions/read-guard.json`)
- Project: `<cwd>/.pi/read-guard.json`

```json
{
  "enabled": true,
  "mode": "block",
  "exempt": ["**/generated/**"]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | when off, the extension does not interfere at all |
| `mode` | `"block"` | `"block"` rejects the call; `"warn"` only notifies and lets it through (for migrations) |
| `exempt` | `[]` | path exemptions. Empty by default, so everything is guarded, **memory files included** |

A config that fails to parse (corrupt file, invalid JSON) does not crash the extension; it falls back to the defaults.

## Design tradeoffs

**Why does `write` accept a ranged read as good enough?**
This release **deliberately** takes the looser rule: a ranged read counts as a valid watermark as long as the file's mtime has not moved, and `edit` and `write` follow the same rule. The stricter alternative ("you must have read the whole file before you may overwrite it") would block the everyday workflow of reading the relevant part and then rewriting the file, which costs more than it buys. The genuinely dangerous case, overwriting without having read the whole thing, is already caught by **truncated reads**, and pi's `details.truncation` exists precisely to signal it. What is left is a ranged read the model chose on purpose.

**Why fold path case on win32?**
On NTFS, `C:\Foo\a.ts` and `c:\foo\A.ts` are the same file, and not folding them produces false positives ("but I did read it" followed by "read it again"). The cost is that on a case-sensitive volume (rare) two different files may be treated as one.

**Memory files are guarded too.** No exemption is preset for the memory directory: when memory files go through the built-in `edit`/`write`, they have to be read first as well.

## Boundaries and known limits

- **This is not a lock.** It checks once, before the tool call; a window of milliseconds remains between passing the gate and the write landing on disk, and an external process can still change the file in that window.
- **Only the built-in `edit` / `write` tool names are covered.** MCP file tools, file tools from other extensions, `bash` redirection and `apply_patch`-style tools are not. A change made through `bash` does not invalidate read state; the mtime check on the next `edit`/`write` is the backstop.
- **mtime precision.** On Windows, FAT and network drives the granularity can be as coarse as two seconds, so a fast read-change-write can land on "mtimes equal, allow". That is inherent to this approach.
- **A resumed session starts from an estimated watermark.** pi's session file has no "mtime at read time", so when read state is rebuilt after a resume or a compaction, the timestamp of the tool result message is used as the watermark. A file changed while the session was suspended, with a change time earlier than that message, counts as fresh. The odds are low, and the outcome is no worse than not checking at all.
- **Read records summarized away by `/compact` lapse**, and the model has to read again. That is intentional and conservative.
- **What a false positive costs**: after an external formatter rewrites a file, the model is asked to read it once more. That is the design, not a bug.

## Verify before installing

```bash
npm install
npm run check        # typecheck + tests
```

The checks run offline: they exercise a real pi session in-process and assert both the gate's allow/block decisions and the requests the model receives.

## License

MIT
