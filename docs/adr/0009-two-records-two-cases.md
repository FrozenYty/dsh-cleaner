# 0009 — Two records, two cases: what a deletion leaves in the workspace

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** —

## Context

A deletion asks the workspace registry to drop two things: the project membership (`tables.workspaces.<id>.sessionIds`)
and the archive entry (`global.archivedSessionIds`). [ADR 0006](0006-detach-by-asking.md) decided both,
"detach and unarchive", on the reasoning that a session with no log should not be named anywhere.

The live system disagreed, twice, in opposite directions:

- the five rows that started this work were **not** in the host's session list; they survived in the
  window's own view, and only a restart cleared them ([ADR 0007](0007-browser-half-prunes-the-view.md));
- the row for a session deleted **in the same app run** behaved the other way: the host still held its
  agent (`status: idle`), so its list still named it, so a window still drew a row for it — and both
  "drop" calls made that worse. Detaching moved it out of its project, and the sidebar shows the row of an
  *ungrouped* session; unarchiving removed the one property that hides a row in the project's own bucket
  (`sessionVisible` hides an archived member). The person watched it hop from *archived under MYPROJS* to
  *visible under ungrouped*.

So "the log is gone" is one fact and "no record names it" is not the same fact: the records decide what a
window *draws*, and a window draws from the host's list, which is *persisted ∪ live*.

## Options

1. **Always detach and unarchive** (ADR 0006). Right for an id the host has let go, wrong for one it still
   holds: it turns a hidden row into a visible one.
2. **Never detach or unarchive.** Leaves the project records naming a session that can never be opened,
   which is what ADR 0006 set out to remove.
3. **Ask the host's own session list first, and decide per id.** The list is exactly what the window
   renders, so it is the right oracle: if it still names the id, the window still draws it, and the
   records must stay as they are; if it does not, nothing draws it and the records can be cleaned.

## Decision

Option 3, in this order: ask the host's list (`ctx.sessionQuery.listSessions`) for the ids this call
handled — the ones it removed and the named ones whose log was already gone — and then:

- **the host still names the id** → touch neither record. The sidebar hides an archived row of a project,
  so leaving both alone is what keeps the row out of the way. The answer says so, and says what ends it:
  the host releasing the session, which a restart does;
- **the host has let it go** → detach the membership, unarchive the id (so the archive set stops naming a
  session that no longer exists), and the browser half prunes the window's own view at the next page load.

The answer reports which case each id fell into, so a person can tell "done" from "done, and one row is
waiting for the host".

## Consequences

- The normal case — an old session the host has long released — is one step: the log goes, the records are
  cleaned, and the row leaves on the next page load with nothing to click.
- For a session archived in the current app run, the log and the bytes are gone at once, the records are
  left in place on purpose, and the row is the archived one: dimmed under *ungrouped* at worst, and gone
  when the host releases the agent. No host API can evict a session a plugin does not own — `ctx.sessions`
  exposes `create`/`prepare`/`enter`/`announce`/`flush`/`get`/`list`/`fork` and no `close` — so this is the
  boundary, stated rather than papered over.
- One intermediate state existed during this work: a session deleted by the earlier rule (detached *and*
  unarchived, then archived again by hand) cannot be repaired by the plugin, because attaching a session
  needs its header and the log is gone. Such a row clears when the host lets go.

## Revisit when

`ctx.sessions` gains a way to release a session a plugin does not own, or the sidebar stops drawing rows
for sessions whose log is missing. Then the second case can be cleaned like the first.
