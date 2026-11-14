# Which seams this plugin uses, and which it owns

The rule this document exists for: **use the product's own interface for an operation before building one
beside it.** A private path duplicates bookkeeping the product already keeps and drifts from it. When no seam
carries a fact the plugin needs, the fact goes **inside an official payload** — an extra argument, an extra
field in an answer a person already reads — before a new transport is invented.

Written after a day in which a bespoke path cost five releases and a self-report cost three rounds of
guessing (see [ADR 0011](adr/0011-one-operation-two-callers.md) and its amendments). Each row is a decision to
keep, a decision to change, or a risk we accept with the reason.

## Used, and official

| Operation | Seam | Notes |
|---|---|---|
| Listing and deleting for a model | `ctx.tools.register` | two tools, explicit ids ([ADR 0003](adr/0003-two-tools-with-explicit-ids.md)) |
| Listing and deleting for a person | `ctx.commands.register` `/clean` | same two implementations behind it ([ADR 0011](adr/0011-one-operation-two-callers.md)) |
| Clicking "delete this session" in the sidebar | `contextMenus.register` | a data contribution, `order: 350`, `danger`, the workspace plugin's own trash glyph |
| Ctrl+Shift+D | `ctx.shortcuts.register` | the product's platform table, so it is listed and remappable in Settings |
| The row's label in every language | `ctx.locale.register` / `ctx.locale.bind` | the product's dictionary service; an untranslated language lands on `en` |
| Hiding the row of a deleted session | `workspaceRegistry.archiveSession` (and `unarchiveSession` to give it back) | never by editing the store ([ADR 0006](adr/0006-detach-by-asking.md), [ADR 0012](adr/0012-archive-never-unarchive.md)) |
| Asking whether a session is busy | `ctx.agents.list()` → `agent.status` | anything that is not exactly `idle` blocks, so an unknown status refuses rather than deletes |
| The session's own log layout | `dsh-session-persistence-jsonl`, documented in its README | "logs accumulate under `root` until removed externally; the seam has no deletion API" — this plugin is that external step ([ADR 0001](adr/0001-out-of-band-deletion.md)) |
| A window telling the host what it did | `/clean --state <json>` on the official command | no new transport; the host prints it in a listing a person already reads |

## Ours, because no seam exists

| Thing | Why it is ours | How it fails safe |
|---|---|---|
| Decoding a session directory name back to a session id | the backend escapes ids "injectively … to one safe path segment" but publishes no id→path API, and a deletion needs a path | a name that does not decode to the id it was looked up as is **skipped**, never guessed ([ADR 0005](adr/0005-re-verify-at-execution.md)) |
| Removing the directory | the seam has no deletion API; that is the plugin's whole reason to exist | files are unlinked one at a time, the directory is removed last, and every guard is re-checked against the live filesystem first |
| Pruning `dsh.workspace.view.*` in the window | the sidebar re-reads that store on start and nothing removes a row whose session is gone; archiving covers rows *we* deleted, not rows that died another way | only ids the host did not list are dropped; an unrecognised shape is left alone |
| `dsh-cleaner.client.v1` in `localStorage` | it is this plugin's own fact ("this half ran, and what it repaired") | rewriting it is a courtesy, and losing it costs nothing |

## Accepted risks, with the reason

- **A session written by another process.** The backend takes a kernel lock per session (`flock(2)`, or a named
  semaphore on Windows with no filesystem footprint), and no API exposes it. A write-open is not a usable
  probe either: inside the owning backend instance the claim excludes a second writer, so every loaded session
  would look busy. So protection is the registry's activity answer plus `agent.status`, which is exactly what
  the product gives itself — the product archives under the same blind spot. The failure is bounded: a file
  that cannot be unlinked is reported, and the session stays a candidate for the next run.
- **The archive check and the archive write are not atomic.** The product documents the same tolerance: a turn
  that starts between the check and the write is hidden while it runs. This plugin adds nothing on top.
- **`order: 350` is a number, not a contract.** The menu sorts data contributions by it; a build that inserts
  another action between fork and copy-id would move this row, and nothing would break.
