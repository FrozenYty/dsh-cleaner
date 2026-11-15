# 0021 — A deletion takes the derived record with the log

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A survey of eleven projects ([ADR 0020](0020-what-the-neighbours-do.md)) found one thing this plugin had missed,
and every surveyed project handles it: **derived state is what keeps a deleted session visible**. LibreChat
decrements tag counts and refreshes project stats; OpenCode projects `SessionEvent.Deleted` so each subsystem
cleans itself; Open WebUI nulls the references it must not delete.

This plugin's derived record is the session projection cache: `storages/session_projcache/sessions/<id>.json`. It
carries a session's title, its `cwd` and whether it is **blank** — and the sidebar's placeholder path draws a row
from exactly that (`summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(id) &&
!archived.includes(id)`). A deletion moved the log and left the record that draws the row. On this machine, 111 ids
had a projection and no directory at all.

The cache package states its own position on pruning:

> **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is
> out-of-band maintenance, same stance as session persistence itself.

That is the same stance this plugin already takes for session logs, and the same absence of an API.

## Decision

The projection travels with the log: `moveToTrash` renames `<projections>/<id>.json` into the trashed folder as
`projection.json` and records where it came from, `restoreFromTrash` puts it back before moving the directory
(the folder carries it, so it has to leave first), and a purge frees it through the same file-by-file walk that
already owns everything inside the folder. A projection that is missing or held is reported on the entry and never
fails the deletion: the log is the authority and the cache rebuilds from it.

## Consequences

- A deleted session leaves **no** record behind that can draw its row: not the log, not the workspace membership,
  not the projection.
- Recovery is complete rather than partial: a restore brings back the log *and* the title, and the answer says
  `projection: true` when the record went back.
- The bytes a purge reclaims now include the checkpoint, which is the honest reading of "every byte reclaimed".
- **Ids with no log keep their projection.** They are not candidates, so nothing is moved for them; their row is
  the one the window's own archive call removes, and their projection is the only record of the title a person
  chose. Dropping it as well is the next step if a ghost row ever reappears, and it would need a delete rather
  than a move, because there is no trash folder to hold it.
