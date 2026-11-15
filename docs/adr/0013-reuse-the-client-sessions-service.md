# 0013 — The window half acts through the Client's `sessions` service, and no longer repairs the sidebar view

**Status:** accepted, supersedes [ADR 0007](0007-browser-half-prunes-the-view.md).
**Date:** 2026-11-15.

## Context

Two things came out of a long debugging session, and one of them invalidates an earlier decision.

**The client root of this build has no `remote` service.** The Client inspect directory lists exactly these
services: `layout`, `locale`, `sessions`, `slots`, `theme`, `timer`, `uiWorkspace`, `workspaces`. The
`ctx.remote.*` object the shipped session *controller* uses internally is bound to an agent-scoped Context
(`AgentContext`), not exposed on the root a dynamic plugin receives. So every `ctx.remote.*` call the browser
half made — `remote.session.list` and `remote.commands.execute` — threw, and each one was caught and
swallowed by a `try`/`catch` written to make failures non-fatal. The failure mode was perfectly camouflaged:
the row appeared, the click did nothing, and the self-report never arrived, all while the half looked
healthy.

**The official client-side way to act on a session is `ctx.sessions`:**

```js
const reference = ctx.sessions.retain(sessionId, { source: 'gateway' })
const binding = await reference.ready          // SessionBinding
await binding.session.command('/clean <id>')   // ISession.command → { ok, value: { matched } }
reference.release()
```

`retain` starts the initial history open, so a session nobody had open still gets a live binding — that is
what makes a row action work for a closed session. And `binding.session.command(line)` is the same admission
the composer runs, so the deletion keeps one implementation behind every caller.

## Decision

1. **The window half's transport is `ctx.sessions.retain(...)`.** The menu row and Ctrl+Shift+D call
   `binding.session.command('/clean <target>')` in the session the window is showing, with the target named
   as the argument: a command needs an agent, that session always has one, and the receipt therefore lands in
   front of the person instead of in a session they cannot see.
2. **The sidebar-view repair is removed.** It was the browser half's entire original job
   ([ADR 0007](0007-browser-half-prunes-the-view.md)): at every page load it asked the host which sessions
   still existed and dropped the ids the stored view still named. That repair never ran, because the call it
   depended on does not exist here. What actually hides a deleted session's row is the **archive write** the
   host half performs: an archived session is never drawn by the sidebar, and that is a product rule reached
   through a product interface ([ADR 0006](0006-detach-by-asking.md), [ADR 0012](0012-archive-never-unarchive.md)).
3. **Every service stays optional.** The half declares no `inject`: each service is read lazily and a missing
   one costs its own contribution, never the others. The one registration that must wait — the shortcut, whose
   registry mounts after this plugin — uses `ctx.inject(['shortcuts'], …)`.

## Consequences

- One row, one keystroke, one dictionary, one report. The browser half shrank by about a third.
- A row whose session is gone for a reason *other* than this plugin's own deletion (a hand-removed directory,
  a deleted workspace) is no longer pruned from the view. The sidebar re-reads that view on start and drops
  ids the Host no longer catalogs — the product's own behaviour — and this plugin no longer duplicates it.
- The report rides the same `sessions.retain` channel and is sent first, before anything that can throw, and
  again from the guard that catches a setup failure: the diagnostic now survives the failure it exists to
  report.
- The rule this episode reinforces is the one from ADR 0011's amendments and `docs/seams.md`: **use the
  product's own interface, and check that it exists before writing a hundred lines against it.** The Client
  service directory is a read-only query away, and it was never consulted.
