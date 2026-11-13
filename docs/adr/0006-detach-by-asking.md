# 0006 — A deleted session is detached by asking the registry, never by editing its store

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

Deleting a session's log leaves a row behind in the sidebar. `@deepseek-ai/dsh-workspace` records each
project's session list in `storages/workspace.json` (`tables.workspaces.<id>.sessionIds`), and it keeps a
session's place there when the directory is missing — deliberately, because a missing directory cannot be
told apart from a temporarily unavailable one ("Already-accounted sessions keep their project and order
when their fully qualified recorded path is missing"). The package also says what that costs: external
changes are "seen late — if another process deletes or damages a directory, the project reflects it only
at the next refresh or restart".

So the row is a ghost: the log is gone, the session can never be opened again, and the visible half of the
deletion is still on screen. The first live deletion this plugin performed produced exactly that, and the
person asked why the sessions they had just deleted were still listed.

## Options

1. **Edit `storages/workspace.json` directly.** The file belongs to another subsystem that holds it in
   memory and writes it on its own chain; an external rewrite can be overwritten by the next archive or
   pin, and the running app would not notice until it reloads. It also puts the plugin in the position of
   owning a record it only reads.
2. **Delete the projection cache entry.** Derived, self-healing, and already read by this plugin — but the
   cache is not the list. The row would remain, and the plugin would start deleting in another
   subsystem's directory to fix a problem it did not cause.
3. **Ask the owner.** `ctx.workspaceRegistry.list()` returns the projects, each with its `sessionIds`, and
   the entity exposes `detachSession(id)`: the registry runs it on its own mutation chain, stamps
   `updatedAt`, and the workspace controller's `follow()` stream carries durable changes to the client —
   which is what makes a row disappear *now* rather than at the next refresh.
4. **Do nothing and document the restart.** Safe, honest, and still a ghost row on screen.

## Decision

Option 3, as a best-effort step after a deletion:

- the registry is asked for the ids the deletion removed, **and** for the ids the caller named whose log is
  already gone — naming a ghost row is the person saying it should not be there, and every such id is
  archived by construction, so nothing is detached that was not asked about;
- the call happens after the files are gone and can never fail the deletion;
- the answer says which of the three happened: detached, no registry mounted, or a detach that failed, and
  how many of the ids had no log left to remove;
- the archive set is not touched. It is the person's own record of what they hid, and the listing already
  explains an archived id with no directory as `already_gone`.

> **Amended the same day, before release.** The first version asked only for the ids a call had just
> removed, which left the rows orphaned by earlier deletions exactly where they were — the gap a person
> hits the moment they upgrade: nothing left to delete, and the row still on screen. The second paragraph
> above is that correction.
>
> **Amended again after the first live run of the feature.** The detach worked and the client applied it at
> once — the rows left their project and reappeared under *ungrouped*. They did not disappear, and this
> decision cannot make them: the sidebar's rows come from the session list the window fetched
> (`sessionQuery.listSessions`), and nothing in the harness publishes "this log is gone" — there is no
> deletion API to publish it in the first place ([ADR 0001](0001-out-of-band-deletion.md)). So what the
> detach buys is real but bounded: the project's records no longer name a session that cannot be opened,
> and the row leaves when the window next fetches its list — a page reload, *not* a restart. *(Superseded:
> a reload proved not to be enough — see the fifth note below.)* The answer says that instead of implying the
> row vanishes on screen.
>
> **Amended a third time, after the second live run: the detach alone is not enough.** A page reload kept
> the rows under *ungrouped*, which rules the session list out — the store no longer lists them. What still
> names them is the **archive set**: the client's workspace model holds archived Session identities, and an
> archived session that belongs to no project has no visible list left to be hidden from, so it renders as
> ungrouped. The registry supports the missing direction explicitly — "a restore only drops an id from the
> archive set, so an entry whose session is gone still unarchives" — so the plugin now asks for both: detach
> the membership, then unarchive the id. Both calls are made only for ids whose files this call removed or
> whose log the caller named as already gone, so neither can be made for a session that still has files.
>
> **Amended a fourth time, after the third live run: the last holder is the window, and it is out of reach.**
> With the store, the project membership, the archive set and the host's session list all proved clean (the
> host answers `session/not-found` when such a row is clicked), the rows still rendered after a reload. They
> live in the renderer's own persisted sidebar view — `localStorage["dsh.workspace.view.v5"]`, a
> `sessionOrderByAccount` map of account to ordered Session ids, written by the client and re-read on every
> start. It lists the deleted ids in three buckets (the project, the ungrouped account, and the flat order).
> No host plugin can reach a browser storage key, and nothing in the harness publishes "this log is gone" for
> the client to prune it with — the same absence that makes this plugin necessary. What the deletion can
> promise therefore stops here: logs, project records and archive entries are gone at once, and the row is
> the window's own copy until that copy is rebuilt.
>
> **Confirmed by a fifth live run, which settles what "rebuilt" costs.** A page reload did not clear the rows
> even with every host-side record clean; a full restart of the app did, immediately. So the accurate advice
> is a restart, not a reload, and the answer now says so: `a window that is already open keeps its own copy
> of that list until the app restarts`.
>
> **Amended a sixth time: a restart is not required after all.** The client rewrites that view whenever it
> re-orders a bucket from the members it actually has — `setOrderBy(mode, activeSessionOrders)` on a sort
> change and `setSessionOrder(accountKey, order, activeSessionOrders)` on a drag both write the *reconciled*
> order wholesale, while a page reload only rehydrates the saved one. Switching the sidebar's ordering away
> from *manual* and back, or dragging a single session, is therefore enough, and it was measured: the
> persisted view went from 11 stale ids to 0, with the buckets shrinking by exactly the deleted count
> (11 → 7 in the project, 25 → 23 ungrouped). So the honest advice is the sort switch or the drag — no
> restart, no page reload, no plugin reaching into browser storage.

## Consequences

- The sidebar drops the row when the deletion returns, instead of after a restart.
- A profile without the registry, a registry whose read throws, or one entity that refuses to detach all
  leave the row to clear at the next refresh, and the answer says so rather than implying success.
- The plugin depends on one entity-level method name for this. That coupling is decoration-level: it can
  cost the immediate row removal, never a file, a candidate or a byte count.
- The plugin still writes no workspace record itself: `mutate` belongs to the registry.

## Revisit when

`WorkspaceRegistry` grows a first-class method for "this session is gone" (or the controller exposes
detach through its Remote surface). Then call that, and delete the entity-level reach.
