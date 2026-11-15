# 0024 — A deletion also drops the archive flag

- **Status:** accepted
- **Date:** 2026-11-15
- **Amends:** [ADR 0023](0023-detach-never-archive.md), which said a deletion never touches the archive flag

## Context

[ADR 0023](0023-detach-never-archive.md) reasoned from the sidebar's visibility rule to the conclusion that the
workspace membership is what draws a row, and that a deletion therefore only has to detach. That is true for a
session that still has a log. It is **not** true for an id that is *archived*: the sidebar draws archived sessions
as rows in their own right, log or no log.

The author's own machine showed it plainly: four ids sat in `archivedSessionIds` with **no log at all** and no
projection, drawn as dimmed rows in 「未分组」, and calling the deletion on them changed nothing, because detaching
an id that is already no member is a no-op and the archive flag remained:

```
session-9f1c46a4…  [no title]                    log=False
session-fcddaf79…  [Greeting]                    log=False
session-8529fc54…  [Greeting]                    log=False
session-6e2fe601…  [no title]                    log=False
```

Asked directly — *"can't these disappear through the plugin at once?"* — the answer was no, and the missing step
was the flag itself.

## Decision

A deletion drops the archive flag for every id it removed **and** every id it found already gone:

- `unarchiveSessions` — the helper a restore already used — runs on the same set the deletion detaches, after the
  files have moved;
- the deletion answer carries `workspace.unarchived` beside `detached` and `orphans`.

This is the only direction a deletion may move the flag, and it is the direction that makes a row leave. The order
is unchanged: files first, records after, so a move that fails leaves the row where it was.

## Consequences

- Every deleted id has nothing left that can draw it: no log, no projection, no membership, no archive entry.
- A session the person archived and then deleted does not come back archived after a restore — a restore asks for
  the archive flag only in the sense that it *drops* it, which is what ADR 0023 already recorded for that path.
- The rule from ADR 0023 that survives unchanged: a deletion never **adds** an archive entry. Hiding by archiving
  is still wrong; *un*hiding by unarchiving is not.
