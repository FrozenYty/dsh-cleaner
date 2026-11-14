# 0012 — Archive, never unarchive

Date: 2026-11-14
Status: accepted
Supersedes: [0009](0009-two-records-two-cases.md)

## Context

ADR 0009 decided that a deletion touches the workspace records only for a session the host has let go —
and that for such a session it drops **both** records: the project membership and the archive entry. The
reasoning was that a session's records should stop naming it once its log is gone. It was wrong in one
direction, and the mistake is the whole of "deleting a session leaves a row behind":

- `sessionVisible(session, current, archived, archivedFilter)` in the sidebar is
  `case 'default': return !archived.has(session.id)`. **An archived session is never drawn.** Archiving is
  what hides a row; unarchiving is what *shows* one.
- So dropping the archive entry of a session whose log is gone does not clean anything up — it takes a
  session that was hidden (archived) and makes it visible again, as an ungrouped row, immediately.
- And the window's workspace store is fed by the host's `domain/changed` stream
  (`WorkspaceFeed.changed`, one increment per domain change), so the client applies that unarchive at
  once. That is why the row appeared "by itself" and why only a page reload or a restart got rid of it.

The row lingering after a deletion was therefore not a client-cache problem to work around. It was this
plugin making a hidden row visible and then asking everybody to reload.

## Decision

**A deleted session is archived, and the archive entry is never removed.** The project membership is
dropped, because the id names nothing there any more; the archive entry is kept or created, because it is
exactly what makes the row invisible.

- The records are asked for **before** the files are removed, and that order is forced: `archiveSession`
  throws `WorkspaceUnknownSessionError` for a session that is "neither live nor in session persistence", so
  an archive attempted after the unlink is refused and the row would stay. `unarchiveSession` runs no such
  check (dropping an id cannot introduce an unknown one), which is what makes the repair below possible.
- `hideSessions` detaches each id from its project and archives it unless the archive set already names it
  (that case is a no-op in the registry). Nothing is called for an id whose log is already gone except the
  detach: the registry cannot archive a session it cannot find.
- If a removal does not happen — a file that cannot be unlinked, a directory that became a file — the
  archive entry this call added is dropped again (`restoreSessions`). A session whose log is still on disk
  must not be hidden, and a session the person had already archived keeps the state they chose.
- This is the same treatment for every session, host-held or not. ADR 0009's two cases collapse: what hides
  a row is the archive set, not whether the host still lists the session. The host's list is now only a
  *report* — "the name stays until the host releases it, and nothing a plugin can call does that".
- The window hides the row **at once**, because the archive change travels the workspace feed to every open
  window and the sidebar's filter is the thing that decides visibility. No reload, no restart, no sort
  switch, no drag.
- Archiving an id whose log is about to go is the same kind of act as detaching it: a request to the
  registry that owns the record, never an edit of the workspace file
  ([ADR 0006](0006-detach-by-asking.md)).
- The browser half keeps its two jobs and stops being load-bearing for this: it prunes the window's own
  persisted view at a page load (that copy is not fed by the stream), and its ⋯ menu row runs the same
  command.

## Consequences

- A deletion is visually complete the moment the tool (or the command, or the menu row) returns. The honest
  residue is a record, not a row: the archive set names an id with no directory, which our own listing
  reports as `already_gone`, and which the sidebar shows only if a person switches the archived filter to
  *show* or *only* — a deliberate act, and the ghost is then labelled by the state it is in.
- A session the person never archived gets an archive entry it did not have. That is a record change they
  did not make, and it is the price of hiding the row immediately; the alternative was a visible row whose
  log no longer exists. ADR 0010 already made the archive entry a reporting fact rather than a gate, so
  nothing else depends on it.
- The `verify` step that asks the host's session list stays, because "the host still names it" is a fact a
  person may want to know — it just no longer changes what the plugin does.
