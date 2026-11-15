# 0023 — A deletion detaches and never archives

- **Status:** accepted
- **Date:** 2026-11-15
- **Supersedes:** the mechanism of [ADR 0012](0012-archive-never-unarchive.md) ("archive is what makes the row
  disappear")

## Context

[ADR 0012](0012-archive-never-unarchive.md) hid a deleted row by archiving it, on the reading that the sidebar
draws no archived session. The reading is incomplete. The product's own visibility rule is:

```js
function sessionVisible(session, current, archived, archivedFilter) {
  case "default": return !archived.has(session.id);
  case "show":    …                                  // the sidebar's own filter
```

and a **blank** session has a separate placeholder path that tests the same membership:

```js
summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(id) && !archived.includes(id)
```

So the membership is what both paths test. Archiving was doing two harmful things: under the product's "show
archived" filter the row is still drawn, dimmed — which the person who uses this plugin described as *"it shows as
archived and stays there as an error"* — and the registry refuses to archive a session whose log is already gone,
so the case that needed it most (a session that never wrote a log) could not be archived by the Host at all.

## Decision

A deletion **detaches** the named ids from their workspace record and **never** archives:

- `detachSessions` replaces `hideSessions`, dropping the archive branch and the archive-state repair that existed
  only for it;
- the window's own `archiveSession` call (`hideRow`) is gone, because there is no archive state to write;
- the deletion answer no longer carries `workspace.archived` or `workspace.restored`; it carries `detached` and
  `orphans`;
- a restore no longer unarchives: nothing was archived by the plugin, and a session the person archived themselves
  keeps the state they chose.

## Consequences

- The row leaves for every case, including the one that never had a log, because the membership is what both
  drawing paths test — and nothing is left behind that a filter could draw.
- One write fewer per deletion, and no rollback path to keep correct.
- An id the Host still holds in memory (the session the window has open) keeps its row until the Host releases it;
  the answer already says so in words.
- The client's notice matrix is asserted as a single test: every outcome a person can reach — moved, log-less, held
  back, route absent, command unmatched, no session to name — has a notice. Writing it found a real gap: a command
  that matched nothing was reported as "delete requested", which read as success while nothing had happened.
