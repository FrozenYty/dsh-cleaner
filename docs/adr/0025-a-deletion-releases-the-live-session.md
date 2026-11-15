# 0025 — A deletion releases the live session object

- **Status:** accepted
- **Date:** 2026-11-15
- **Amends:** [ADR 0024](0024-a-deletion-drops-the-archive-flag.md) — the record writes were not the last thing
  that could keep a row on screen

## Context

With the log, the projection, the workspace membership and the archive flag all cleared, three rows still stood in
the sidebar. They had **no log at all**, and the query service named them anyway:

```
still_listed: ["session-fcddaf79…", "session-8529fc54…", "session-6e2fe601…"]
```

The source is the session service's own list. `dsh-session-query`'s documented surface is `listSessions`,
`readSession`, `filterSessions`, `filterEvents`, `readTitleSnapshots`, `listEvents`, `readSurface`, `readEvent`,
`traceSession`, `traceEvent`, `searchSessions`, `searchEvents` — **no delete and no forget** — and `listSessions()`
reports "every logical session … with `live` and `persisted` availability flags", preferring the live set. A live
session is created by `ctx.sessions.create()` and is "bound to the calling fiber", so a session created by the
window's **New session** button — a blank one that never wrote a log — stays listed in every window until that
fiber ends. A page reload does not end it; a Host restart does, which the author confirmed by restarting.

## Decision

The store's own removal is reachable and is what the product uses itself:

```js
/** Remove one exact entered session and emit its paired disposal when announced. */
detachEntered(entry) { … this.store.delete(entry.id); … this.emitDisposed(entry) }
```

`releaseLiveSessions` walks the ids a deletion dropped, takes each one's store entry when there is one, and calls
`detachEntered(entry)`. It is best-effort by construction: a service without the method, or without a `store`, is
answered with an empty result rather than an error, and a single failure is reported on the answer. The deletion
answer carries `workspace.released`.

The plugin therefore does not poll for the Host to change something it cannot change; it asks the object that owns
the row to let go, through the product's own method.

## Consequences

- A blank session's row leaves **without a restart**, which was the one case the earlier releases could not cover.
- This is the only place the plugin reaches into a service's internals (`sessions.store`), and it does so because
  the documented query surface offers no removal at all. If a later Host exposes a first-class removal, it should
  replace this call and this ADR should record the change.
- Ordering is unchanged — files first, records after — and the release runs last, because it is the least
  reversible of the writes in effect: a live session that is gone cannot be brought back by a later failure.
- What remains out of reach is a session another fiber owns and has not entered through this store; the answer
  still reports `still_listed` when that happens, and the receipt still says what it means.
