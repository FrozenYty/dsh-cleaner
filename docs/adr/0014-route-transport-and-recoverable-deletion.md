# 0014 — The window reaches the host over an HTTP route, and a deletion becomes recoverable

**Status:** accepted. Extends [ADR 0013](0013-reuse-the-client-sessions-service.md) (the Client's `sessions`
service is still the official way to *act on* a session, but it cannot run an operation that has no agent),
and reverses one promise of [ADR 0001](0001-out-of-band-deletion.md): the deletion is no longer immediate
physical removal, it is a move into a trash this plugin owns.

**Date:** 2026-11-15.

## Context

Three transports were tried for one sidebar row, and each failed for a reason worth recording:

| Transport | Why it failed |
|---|---|
| `ctx.remote.commands.execute` | there is no `remote` service on this build's client root |
| a command carried by `ctx.sessions.retain(sessionId)` | a command needs a **live agent**, and the session behind a sidebar row is usually **closed**: its log is on disk and nothing holds it |
| `/clean` typed by the person | works, but a row that has to be typed is not a row |

The second row is the important one. It is not a bug in the transport; it is the wrong shape of caller. A
person deletes the sessions they are **not** using, and every carrier that runs a command has to borrow an
agent from somewhere to do it.

Meanwhile the same feature in the wild settles the question. `TOBYCAI/dsh-sessions-manager` — a shipped plugin
that adds *delete / move / archive* rows to the session menu — posts to its **own host routes**
(`/archived-sessions/delete`, `/archived-sessions/trash/purge`, …) and lists as one of its constraints that
the menu is a data contribution whose session id comes from the host. Two independent implementations, one
conclusion: **client → host goes over the web carrier**.

The host confirms the seam exists: `webServer.register(route: WebRoute | WebResourceRoute)` with
`WebResourceRoute = { kind: 'exact' | 'prefix', path, resource: (request: Request, peer?) => Promise<Response> }`,
and `kind: 'prefix'` routes are matched before the fallback, so a plugin's own prefix cannot be shadowed.

## Decision

1. **One route, four actions.** The host half registers `prefix /dsh-cleaner/` and answers
   `POST /dsh-cleaner/{delete,list,trash,state}`. Every action calls the same function the tool and the
   command call, so there is still one implementation per operation.
2. **The window names its own caller.** A route has no agent, so the body carries `caller`, the session the
   window is showing — the id the sidebar already persists in `dsh.sessions.current`. That is what keeps the
   running session protected on this path too: without it, a deletion is refused with the same words the tool
   uses.
3. **A deletion is a rename into the trash.** Each session directory is moved, in one atomic rename, to
   `<DSH_HOME>/dsh-cleaner-trash/<stamp>-<escaped-id>/`, and recorded in `index.json` beside it. The store stops
   holding the session at once — which is the whole point of the rename — and the bytes are freed only when an
   entry is purged.
4. **Recovery is part of the surface.** `trash_session_logs` (and `/clean trash|restore|purge`) lists, restores
   and purges. A restore puts the directory back where the backend looks for it and unarchives it; that is the
   one place this plugin calls `unarchiveSession`, and it is why [ADR 0012](0012-archive-never-unarchive.md)'s
   rule stays true — a *deletion* never unarchives.
5. **Retention is not a timer.** Entries older than 30 days are freed by the next deletion, restore or purge.
   A listing only *reports* what that sweep would do, because a listing is the one call that must never be able
   to destroy anything.

## Consequences

- The sidebar row works on a closed session, which no command-based carrier could. The dependency that used to
  make it fail — a live agent — is gone from the path entirely.
- A deletion is no longer irreversible. That is a product decision, not an implementation detail: a mistake used
  to be recoverable only from a backup, and now it is recoverable for 30 days, by name.
- The rename makes the "half-removed session" failure mode impossible: a rename either happens or does not,
  where unlinking a directory file by file could stop in the middle with a live writer holding it.
- The trash is a directory this plugin owns; the session store never contains it, so the backend never lists a
  trashed session.
- A route is a wider interface than a command: it is reachable by anything that can POST to the carrier.
  Mitigated by what the operations already do — every id is re-verified against the filesystem, links are
  refused, and the caller is protected — which is why the route is nothing but a caller and a body.
