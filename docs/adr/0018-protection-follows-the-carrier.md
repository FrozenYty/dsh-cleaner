# 0018 — Who a deletion protects depends on who asked

- **Status:** accepted
- **Date:** 2026-11-15
- **Supersedes:** the carrier sentence of
  [ADR 0014](0014-route-transport-and-recoverable-deletion.md) ("the caller is named by the window, because a
  route has no Agent of its own")

## Context

The guard that keeps a session safe was written for the **command** carrier: `/clean` runs *inside* an Agent's
session, so deleting that session would pull the log out from under the writer, and it is protected by name.

The route carrier copied that idea and fabricated an Agent out of the session the window was showing. The result
was a row that could not delete the session in front of the person: clicking ⋯ → 删除会话 on an open session was
refused with *"the session running this command"*, even though a route runs nothing. That is the ordinary case for
a cleanup tool, and the window's own report said so:

```
lastClick=nothing moved: the session running this command
```

## Decision

What is protected follows the carrier:

- an **Agent** call (the tool, or `/clean`) protects the session that Agent runs in — unchanged;
- a **window** call names the session it is showing for the record only, and protects nothing, because a route
  has no Agent and the session on screen is not being written to;
- a call with **neither** an Agent nor a window is still refused, so no anonymous caller can delete freely;
- the **busy-Agent** guard is unchanged and independent of the carrier: any session with a non-idle Agent is held
  back with its status named, which is what actually protects a session that is being written to right now.

## Consequences

- A person can delete the row they are looking at. The window keeps showing that session (its object is live), the
  row leaves the sidebar because the deletion also archives it, and the log is in the trash.
- A session whose log file is still open by a writer may be **refused** by the filesystem on Windows — the engine
  reports *"cannot be moved into the trash"* and nothing is hidden. A refusal by name beats a silent half-removal.
- The window's name is still recorded, so a receipt can say who asked, but it can never hold a row back.
