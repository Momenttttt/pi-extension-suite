# @momenttttt/pi-context-guard

[中文文档](https://github.com/Momenttttt/pi-extension-suite/blob/main/packages/pi-context-guard/README.zh-CN.md) · [pi extension suite](https://github.com/Momenttttt/pi-extension-suite)

Adds the two client-side context capabilities pi does not have: **microcompact** (older tool results swapped for placeholders) and **snip** (the model points at a stretch of history it no longer needs; undoable).

pi's native **compaction** is left as it is. This package does not rewrite it: the summary prompt, the thresholds and the overflow recovery are all untouched.

> The three words mean different things here and are not interchangeable: **compaction** = summarize older history with one model call; **microcompact** = mechanical cleanup that replaces the bodies of older tool results with placeholders; **snip** = a stretch of history the model points at, which disappears from the model's context (lossless, undoable).

## Install

```bash
pi install npm:@momenttttt/pi-context-guard
```

To try this package without installing it:

```bash
pi -e ./packages/pi-context-guard/extensions/context-guard.ts
```

## Microcompact: two triggers

| Trigger | Condition | Default |
| --- | --- | --- |
| Idle | at least `gapThresholdMinutes` (60) since the last assistant message, and more than `keepRecent` prunable results | **automatic** |
| Volume | prunable bodies (UTF-8 bytes) over `maxClearableBytes` (256 KiB), and more than `keepRecent` results | **manual**: `/ctx prune`; set `autoVolumeTrigger: true` to make it automatic |

The 60-minute idle threshold is exactly the server-side prompt cache TTL. Once a session has been idle that long the cache is cold anyway, so that is the cheapest moment to rewrite the history prefix.

Cleanup touches **this request only**: the `context` event swaps the `content` of the selected tool results for one placeholder sentence. `isError` and `details` stay as they are, nothing is written to disk, and the session file keeps the original text.

### Which tool results get pruned

The criterion is "the output can be re-run or rebuilt". `read`, `bash`, `powershell`, `grep`, `find`, `ls`, `edit` and `write` qualify. MCP tools, `codemode` and `tool_search` do not (non-idempotent, or too expensive to re-run).

Two tools from this suite are **not** pruned by default, and both can be turned on:

- `subagent` (from `@momenttttt/pi-subagent-lite`): a subagent's report is a conclusion, not raw output. Pruning it makes the model forget what it already learned and delegate the same work again → `clearSubagentResults: true`
- `memory_read` (from `@momenttttt/pi-zcode-memory`): a memory body can be read again by name, but it is a long-term fact → `clearMemoryResults: true`

### A stable decision

The prune set depends only on **the message sequence plus a frozen prune watermark** (persisted with `pi.appendEntry`). Two consecutive requests get the same set, so the rewritten prefix is byte-identical and the cache prefix is not shredded on every turn.

## Snip

The model can call `snip({ from, to, reason? })` to point at an earlier stretch of history by short id. Short ids are `\n[id:xxxxxx]` suffixes appended to user messages **in the request only** (derived from the first 6 base36 characters of `sha256(role + ":" + timestamp)`); the stored copy is untouched.

- The snip is committed at `turn_end` (preferred) or `agent_before_settle` (fallback) as pi's native `context_edit{replacement: null}`, a read-time projection; the original entries stay in the session file.
- `context_edit` goes into pi's own projection, so pi sees the snipped history when it recomputes `tokensBefore`. That is pi's mechanism (its `docs/compaction.md` says the count is based on the rebuilt, context-edited projection), not something added here. **This project has no test asserting how far a snip pushes automatic compaction out**: that would take a real model running both paths, which is acceptance work outside the test seams. Do not treat it as tested behavior.
- Snipping the turn in progress is refused, both endpoints must exist, and the error lists the ids that are available.
- `/ctx undo-snip` commits a restoring `context_edit` (content taken from the original entries) and renders "已恢复 N 条历史" ("restored N entries").
- A `custom` audit entry lands in the session, rendered as "已裁剪 N 条历史（可撤销）" ("snipped N entries, undoable"), so the user does not think messages went missing. TUI text like this is Chinese by design; model-facing text is English.

## Configuration

Two locations, deep-merged, project over global:

- Global: `<agent-dir>/extensions/context-guard.json` (default `~/.pi/agent/extensions/context-guard.json`)
- Project: `<cwd>/.pi/context-guard.json`

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

A config that fails to parse (corrupt file, invalid JSON) does not crash the extension; it falls back to the defaults.

## `/ctx`

One command shows the state of things: context usage (tokens / window / percentage), this session's cleanup counters (results pruned and bytes saved), how many entries were snipped, compaction failures, and how the usage compares against the automatic compaction threshold.

> **`/ctx prune` and pi's built-in `/compact` are not the same thing.**
> `/compact` (from pi) **calls a model** to summarize older history: lossy, not undoable, and it is the one that actually decides when automatic compaction fires.
> `/ctx prune` only replaces the **bodies of older tool results** with placeholders: no model call, nothing written to disk, undoable, and it does not move the compaction trigger.
> "Compaction" and "microcompact" are different words in this project, and the command names follow: the first belongs to pi, the second to this package.

- `/ctx prune`: prune once **right now** using the volume trigger's selection, without waiting for idle. **The threshold still applies**: if the prunable bodies outside the kept tail do not exceed `maxClearableBytes` it does nothing (the volume trigger is defined that way) and only tells you how much is missing.
- `/ctx undo-snip`: undo the most recent snip.

## Design tradeoffs

**Why can't the default save a long session that is still running?**
The idle trigger only acts after 60 minutes without activity, because the server-side prompt cache TTL is one hour: by then the cache is cold anyway, and that is the cheapest moment to rewrite the history prefix. **The cost has to be stated plainly: an active session whose images keep piling up is not rescued automatically.** It takes one manual `/ctx prune`, or turning on `autoVolumeTrigger`. Installing this package is not the same as never hitting the request-size ceiling again.

**Why is the `snip` tool always visible to the model instead of being activated on demand?**
Activating it on demand (registering it as `deferred` and switching it on with `pi.setActiveTools()` past a context threshold) **changes the tool list**. pi appends a record to the transcript when the tool set changes, and a provider that cannot express that increment receives a full checkpoint, which can **invalidate the cache prefix**. The saved prompt cost would be less than the loss from a cold cache. The price is a few dozen tokens of tool description per turn, which is acceptable.

**Why does a cleanup not clear pi-read-guard's read state?**
Cleanup is an optimization of what the model is shown in this request; the world on disk has not changed. So the read-state table is **not** invalidated by it: even when a tool result has been replaced by a placeholder, the model still counts as having read that file. Should it edit the file on that basis, the mtime check is still the last line of defense.

**Why reduce pressure after a failed compaction instead of skipping it?**
Measured on this machine (`test/compaction-fuse.test.ts`): in a `reason: "threshold"` scenario, returning `{ cancel: true }` from `session_before_compact` makes pi throw `Compaction cancelled`, swallow it immediately, and emit a `session_compact_failed` (`aborted: true`, `errorMessage: undefined`). It does not compact and does not retry; as long as the context stays over the threshold the next turn cancels again, so the context keeps growing until it overflows. Cancelling is worse on the overflow path, where the compact-and-retry is the only recovery chance there is. So this plugin **never returns cancel**: a failure is counted and shown in `/ctx`, the next request force-prunes once under the volume trigger (which really does reduce pressure), and after three failures in a row the UI says so outright.

**Why not rewrite pi's compaction?**
pi already covers three layers (threshold trigger, overflow recovery, summary structure with iterative updates) and does it well. What is actually missing is microcompact, snip and a cross-tool result budget. Rewriting those three layers would double the maintenance cost for close to no gain.

## Boundaries and known limits

- **Microcompact does not affect pi's automatic compaction threshold.** It only changes a single request and never enters pi's projection, so it makes requests smaller (good against the byte ceiling) without pushing compaction out. Use `snip` for that: `context_edit` does enter the projection.
- **No server-side cache edits.** `cache_edits` / `cache_reference` are an Anthropic-specific beta that a client cannot reproduce. What is possible is rewriting the local request, at the price of an invalidated cache prefix, and the trigger timing keeps that price below the payoff.
- **Placeholders change how the model reads its own history.** The placeholder says the output can be re-run when needed, but the model may still change its plan because of it.
- **The model can misuse `snip`.** Three backstops: range validation, no snipping of the turn in progress, and `/ctx undo-snip`. There is no automatic snipping (which would just be microcompact).
- **A snip only affects the projection the model sees.** The messages are still in the session file and in the TUI.
- **The result budget layer (truncating oversized tool results) is not implemented.** pi's built-in tools truncate already, and the case that really needs it is MCP and custom tools.

## Verify before installing

```bash
npm install
npm run check        # typecheck + tests
```

The checks run offline: they assert the prune selection sets and triggers, and the requests a real session's model receives (smaller payloads, placeholders in place of pruned results, byte-identical consecutive prefixes).

## License

MIT
