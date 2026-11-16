# 0027 — A restore is files, membership and an agent, in that order

- **Status:** accepted
- **Date:** 2026-11-16
- **Amends:** [ADR 0023](0023-detach-never-archive.md) — its "membership is what makes the row leave" has a mirror
  direction that was never implemented, and [ADR 0006](0006-detach-by-asking.md) — the same "ask the registry, never
  edit its store" rule, applied to putting a session back instead of taking it away

## Context

A deletion is recoverable: the directory moves into `<dataDir>/trash` and a restore moves it back. Three releases
(0.5.36 → 0.5.39) put the directory back **byte for byte**, reported success, and left the sidebar empty anyway. The
row is drawn from the **workspace membership** (ADR 0023), and only the deletion half of attach/detach existed.

With the membership restored the row appeared, and the first prompt on it was refused as `session/agent-busy`. The
plugin had built the session itself — `sessions.prepare` plus `enter` — and a `Session` entered that way has **no
agent**: it is listed, and it rejects every prompt. The product's own operation is
`agents.resume({ resumeSessionId })`, "load a persisted session and rebuild the agent on it" — the option name read
from the loop factory's `resumeWith(ownerCtx, persistence, options)`, not guessed.

Two more facts decided the shape of the rest:

- The client `sessions` face is `retain`, `using`, `retainInfo`, `refreshProjections`, `search`, `fork`, `scope`,
  `binding` — **no `list` and no `refresh()`** (the live Client `Service` catalog). The list the sidebar draws is the
  Host's own, and the sidebar subscribes to it. Nothing this half can call makes the window re-read that list, so the
  plugin does not pretend to; what it can do is ask the product to **open** the session
  (`uiWorkspace.openSession`), which is a navigation the product already knows how to perform.
- A person measured which half of that matters: the restored session he **chatted with** survived switching the plugin
  off, while the one he never touched did not. The product holds what it opens.

The ledger replay was written before any of this was understood, and it resumed **every** remembered id on every load;
the live Host carried a dozen agents for sessions nobody had opened. A persisted session the process has not opened
needs nothing — the product loads it on demand. The one state that misbehaves is a `Session` object the process holds
**without** an agent, which is exactly the `agent-busy` case.

## Decision

A restore is three writes and one question, in this order:

1. **Files** — moving the directory back, verified byte for byte before anything else is written (ADR 0005).
2. **Membership** — `workspaceRegistry.attachSession(id)` on the workspace whose path holds the session, or whose
   record already names it. The registry is asked; its store is never edited (ADR 0006).
3. **Agent** — `agents.resume({ resumeSessionId: id })`, always on a restore click: the session was put back a moment
   ago and the product knows nothing about it. On a **load replay** the same call runs only for a session the process
   is holding without an agent; for every other id it is skipped.
4. **The window** — `uiWorkspace.openSession` for the first restored id, `sessions.retain` for the rest. Only one
   session can be on screen, and opening is what makes the product hold it.

The ledger under the data directory stays a **record** of what this plugin put back, not a queue it drains.

## Consequences

- A restored session is an ordinary persisted session. It appears because the Host lists it and a workspace claims it,
  not because the plugin did something special at draw time. Turning the plugin off leaves both records in place.
- A restore click is the only path that always pays for an agent; a load replay pays only for the one state that
  refuses a prompt, which is what took the count from a dozen to what is actually in use.
- What this cannot do: make an already-open window re-read its list. A page that has never been reloaded may still
  draw an older list, and that is the product's seam, not this plugin's. The observable markers are
  `workspace.reopened.resumed` on the answer and `live_agents` on the Host.
- The agent this plugin builds is owned by the fiber that resumed it, so switching the plugin off takes the agent and
  leaves the session, the log and the membership. That is the intended split: durable records outlive the plugin,
  memory does not.

## Evidence

- `tests/entry.test.mjs` — "a restore puts the session back into the workspace it came from", "a restore resumes an
  agent on the session, so its row and its prompt both work", "a load replay builds an agent only for a session the
  process holds without one".
- `tests/client.test.mjs` — "a restore asks the product to load what it put back, so the row can exist".
- Live Host: `workspace.json` → `tables.workspaces[<id>].sessionIds` holds the restored ids, `archivedSessionIds`
  holds neither, `sessions/<escaped-workspace>/<id>/session.v4.jsonl.zstd` is back in the store, and
  `sessionQuery.listSessions()` names them among 61 sessions.
