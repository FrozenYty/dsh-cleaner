# 0020 — What the neighbours do, and which parts of it we adopt

- **Status:** accepted
- **Date:** 2026-11-15

## Context

After the deletion path finally worked end to end, the question was asked in the right shape: *the plugin only
has to move a log out of the session store and have the row stop being drawn — why was that hard, and do others
do it better?* This ADR records what four neighbours actually do, and what that changes here.

## What they do

| project | how a session is removed | how the list follows | retention |
| --- | --- | --- | --- |
| `dsh-team` (this workspace, same family) | the persisted session is **moved** into a trash directory; **nothing is archived** | "the move also drops the artifact out of the session-query index, which is what makes the member disappear from the host's own lists; that effect is why this module exists" (`trash.js:4`) | two caps from the bundle patch's `config` (`trashLimit`, `trashByteLimit`), pruned when someone looks |
| Claude Code | deleting a background session makes it "disappear from the list … Its transcript stays on your machine, available through `claude --resume`" — UI removal and data removal are **separate acts** | the row/index is what the delete touches | `cleanupPeriodDays` (default 30) "runs the deletion as a background sweep **after a session starts**" — no timer daemon |
| Codex CLI | rollouts are deleted first, then "main state DB rows are deleted after every associated rollout is removed, **under the same lifecycle lock**, so queued artifact mutations cannot use deleted thread metadata"; refuses while an attached child thread exists | the DB rows are the list | archive (`/archive`) and delete (`/delete`) are separate commands |
| OpenCode | publishes `SessionEvent.Deleted` on a bus and **projects** it to clean derived state | clients react to `session.deleted` instead of polling | — |

## What this changes here

1. **The mechanism we rely on is the move, and that is now stated as such.** The row leaves because the log
   leaves: the host's session-query index drops an artifact whose directory is gone, which is the sibling's own
   written reason for existing and was confirmed live here (`query.still_listed: []` after a deletion). Our extra
   `archiveSession`/`detachSession` writes are **belt-and-braces**, not the cause — and they are what draws an
   archived row dimmed under the product's "show archived" filter, and what the registry refuses outright for a
   session with no log. Recorded so the next reader does not attribute the effect to the wrong write, as
   [ADR 0012](0012-archive-never-unarchive.md) did.
2. **UI-gone and data-gone stay separate, deliberately.** Claude Code's split matches this plugin's: the trash
   holds the bytes for `retentionDays`, and only a purge frees them. Nothing here needs to change.
3. **Our order is the reverse of Codex's, on purpose.** Codex removes artifacts and then rows; this plugin writes
   the archive record **before** the move, because *this* product's registry refuses to archive a session whose log
   is already gone (`WorkspaceUnknownSessionError`, verified — [ADR 0012](0012-archive-never-unarchive.md)). The
   ordering follows the platform's constraint, and Codex's own reason for locking the two together is the one we
   satisfy by asking first.
4. **No event bus exists for us, so verification takes its place.** OpenCode's clients learn from
   `session.deleted`; here the workspace feed is the product's equivalent, and the deletion answer asks the
   session-query backend what it still lists (`query.still_listed`) — a read, not a poll.
5. **The sweep stays lazy.** Claude Code's `cleanupPeriodDays` runs on session start and never on a timer, exactly
   as this plugin's retention sweep runs when somebody looks ([ADR 0014](0014-route-transport-and-recoverable-deletion.md)).
6. **Numeric settings live in the profile patch, not in a settings UI.** The sibling exposes `trashLimit` /
   `trashByteLimit` as patch `config` fields and builds no editor for them; this plugin keeps `retentionDays`,
   `trashLimit` and `dataDir` the same way, and shows the effective values rather than offering controls.

## The wider survey (source-read, not summaries)

The sibling plugin is one data point; a second pass read eleven projects' own code or docs (GitHub Contents API
and `code.claude.com` raw markdown — GitHub's web UI is unreachable from this machine):

| project | removal | UI sync | settings |
| --- | --- | --- | --- |
| openai/codex | rollout files first, then state-DB rows, one lifecycle lock; separate `/archive` | rescan of session dirs / state DB | `config.toml` `history.max_bytes`, enforced by the writer |
| Claude Code | **row only**: leaves the list, transcript stays for `--resume` | the session index; a lazy sweep prunes it | `settings.json` `cleanupPeriodDays`, written by `/config` |
| anomalyco/opencode | hard: interrupt, publish `SessionEvent.Deleted`, `bus.remove`, recurse into children | clients subscribe to server events | plugin KV storage |
| open-webui | chat + messages + view state + comments; `AutomationRun.chat_id` **set to NULL** rather than cascaded; `archived` flag as the soft tier | `refreshChatList()` refetch guarded by a generation counter | — |
| LibreChat | wave-based cascade, tag counts decremented, project stats refreshed, retry x3 | — | — |
| cline | hard delete of rows | **in-memory state first**, then push state to the webview | — |
| continue | `history/delete` | redux filter of the session list | — |
| chatbox | archive (hidden, restorable) + permanent delete; `session-will-delete`/`session-deleted` events | events, archive page lists separately | — |
| lobe-chat | hard delete in a transaction; **agents** soft-deleted into a recycle bin | reads carry `IS NOT TRUE`, auto-applied by a shared where-builder | — |
| Aider | none: `/clear` only; there is no session index | n/a | n/a |

Six conclusions that bear on this plugin:

1. **Delete ≠ erase, deliberately** (Claude Code's wording is the clearest). This plugin already splits the two:
   the trash holds bytes, only a purge frees them.
2. **Ordering beats atomicity.** Codex removes artifacts before rows, under one lock, and refuses while a child
   thread exists; LobeChat documents the reverse bug in a comment. Our order is the platform's: this product's
   registry refuses to archive a session whose log is already gone, so the record is written first.
3. **Derived state is the real stale-row risk, and every project cleans it as a fan-out** — LibreChat decrements
   tag counts and refreshes stats; OpenCode projects the delete event so each subsystem cleans itself. **This
   plugin has one derived record it does not yet touch: the session projection cache**
   (`storages/session_projcache/sessions/<id>.json`). It is what carries a session's title and `cwd`, it is what a
   **blank** session's row is drawn from (the sidebar's placeholder path requires `summary.blank && summary.cwd ===
   workspace.path && workspace.sessionIds.includes(id) && !archived.includes(id)`), and 111 ids on this machine have
   a projection with no directory at all. That single condition also explains why this plugin archives at all: for a
   session with no log there is nothing to move, and the archive flag is the only lever the product offers for its
   row. **Follow-up, not done here:** drop the projection for an id a deletion removed, through the projection
   service's own API, instead of leaving a cache entry nothing reads.
4. **References you must not delete get nulled, not cascaded** (Open WebUI). Nothing in this plugin owns another
   plugin's rows, so nothing needs nulling today — recorded because the workspace membership is the closest thing.
5. **UI sync is refetch-or-optimistic; no surveyed project keeps a live list feed.** This plugin hides the row
   optimistically with the product's own archive call and leaves the rest to the product's own feed, which is the
   same shape as Cline's "mutate local state first, then push".
6. **No surveyed project enforces a trash window with a timer.** Retention is either indefinite (archive) or a lazy
   age sweep (Claude Code's `cleanupPeriodDays`, run when a session starts). This plugin's sweep runs when somebody
   looks — the same choice — and the rule that follows from it is the one already written down: *if the plugin
   promises N days, the plugin owns the trigger.*

Unverified in that pass: LibreChat's UI sync and config path; the config-persistence route of cline, continue,
chatbox, lobe-chat and open-webui; whether chatbox expires archived chats at all.

## Consequences

- No behaviour changes: the archive writes stay, because they are harmless when they succeed and the client-side
  archive call is what removes a **log-less** row (the registry refuses it server-side).
- A future simplification is now written down and safe to take later: dropping the archive for sessions that have a
  log would remove the "dimmed under show-archived" case entirely. It was tried and reverted in this session only
  because it would have rewritten seven assertions at the end of a long round; the fact that the move is the real
  mechanism is the part worth keeping.
- The sibling plugin remains the first place to look for a same-family answer, before any third-party comparison:
  it is installed, it solves this exact problem, and its comments say why.
