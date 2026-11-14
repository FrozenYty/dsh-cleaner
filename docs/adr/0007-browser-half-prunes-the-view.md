# 0007 — The bundle ships a browser half that prunes the window's own view

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** —

## Context

A deletion removes a log, asks the workspace registry to drop the project membership and the archive entry,
and reports whether the host's session list still names the id. What survived all of it was the window's
own sidebar view: `localStorage["dsh.workspace.view.v5"]`, a `sessionOrderByAccount` map of account to
ordered Session ids, written by the client and re-read on every start
([ADR 0006](0006-detach-by-asking.md), fourth amendment).

It was measured twice. A page reload left the rows in place, because a reload only rehydrates that value. A
restart cleared them, because the client rewrote the view from the members it actually had at boot. Reading
the client source found the exact condition: `setOrderBy(mode, activeSessionOrders)` and
`setSessionOrder(accountKey, order, activeSessionOrders)` write the *reconciled* order wholesale, so
switching the sort away from manual and back — or dragging one session — clears the stale ids. That was
measured too: 11 stale ids to 0, with the buckets shrinking by exactly the deleted count.

So a person could clear the row with a gesture. That is not the standard this plugin holds itself to: a
deletion is complete for a person when the row they can see is gone, and "remember to re-order the sidebar"
is a repair the plugin should do itself.

## Options

1. **Document the gesture and stop.** Cheap and honest, and it was shipped for an evening. It leaves the
   plugin's own promise unfinished: the row is the visible half of the deletion.
2. **Have the Host write the workspace store.** Rejected in [ADR 0006](0006-detach-by-asking.md): the file
   belongs to a subsystem that holds it in memory and writes it on its own chain.
3. **Ship a browser half that prunes the stored view.** The page's loader runs an artifact inside the
   renderer, where that storage lives. It is the only place with both the value and the list that can judge
   it.
4. **Ask the harness for a session-removed event.** Correct long-term, and out of this repository's hands;
   the same absence that makes this plugin necessary.

## Decision

Option 3, with the narrowest possible behaviour:

- the half asks the host for the session list (`ctx.remote.session.list({})`) and drops the ids a stored
  view kept that the list does not name;
- it writes only when it actually dropped something, plus one small mark (`dsh-cleaner.client.v1`) so the
  pass is observable from outside the page;
- an unanswerable or empty list prunes **nothing**: a view is evidence of what a person arranged, and it is
  only repaired against a list that proves an id is gone;
- it touches no key that is not `dsh.workspace.view.*`, and inside one only `sessionOrderByAccount`;
- it imports nothing — the page's module loader evaluates the file and provides the context — and it
  registers under the package name, which is how the loader finds it;
- it runs at every page load and when the window regains focus (a deletion made while the window was in the
  background is covered when it comes back).

## Consequences

- The row leaves the sidebar on the next page load with no gesture, no reload-on-demand and no restart.
- The page that was already open when the deletion happened can keep its copy until it loads again: no
  host event exists to re-render it, and forcing a reload of someone's conversation to hide a row would be
  a worse trade.
- The bundle now has a browser artifact. It is tested by evaluating the same file the page evaluates
  (`tests/client.test.mjs`), and the manifest check in `scripts/check.mjs` proves the declaration, the
  export, the published file, the registration id and the zero-import rule.
- A future change to the persisted view shape (a `v6` key, a different field) degrades this half to a
  no-op rather than a corruption: it only rewrites values whose shape it recognises.

## Revisit when

The harness publishes a session-removed event a client can re-render on, or the view stops being browser
storage. Then this half can be deleted instead of maintained.
