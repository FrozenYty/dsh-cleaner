# 0016 — The session menu row sits below 归档会话

- **Status:** accepted
- **Date:** 2026-11-15
- **Supersedes:** the placement sentence of [ADR 0011](0011-one-operation-two-callers.md) (`order: 350`,
  "put it under 分叉会话")

## Context

The sidebar row's menu position was chosen as `order: 350`, on the reading that the product's session actions
were fork (300) and copy-id (450), so 350 sat directly under 分叉会话. The person who uses it asked for the row
to be **below 归档会话** instead: a destructive action belongs at the bottom of the list, where
*删除工作区* also sits in the workspace menu.

Reading the installed packages rather than this repository settles what the numbers are. `contextMenus`
documents its ordering as "Contributions sort by `order`, then ID" — ascending, numeric, with no relative
placement (`after`/`before`) and no group. `dsh-client-ui-workspace` declares the session family's own rows, one
contribution each:

| row | order |
| --- | --- |
| `session.pin` | 100 |
| `session.rename` | 200 |
| `session.fork` | 300 |
| `session.id` (copy session id) | 450 |
| `session.archive` (归档会话) | 600 |

So the row was never "under 分叉会话" in the sense the request meant: at 350 it sorted above 归档会话 (600).
Placement below it is reachable inside the documented mechanism — any order greater than 600.

## Decision

The contribution registers `order: 700`, with `separatorBefore: true` beside the `danger: true` and the icon key
already there. 700 is above every row the product declares today and below anything it may add later only by
accident, which is the honest limit of a plain number: the menu is a list sorted by that number, and no
contribution declares a "last" position.

## Consequences

- The row reads as the last, separated, red action in a session's menu, the same shape as *删除工作区* in a
  workspace's menu.
- The number is **not a contract**: a product build that inserts a row above 700 moves this one up again, and
  nothing breaks. `docs/seams.md` keeps that caveat.
- A build that renumbers the product's rows silently changes where this one appears. The test asserts our own
  700, not the product's numbers — those were read from the installed asar and are recorded here so a later
  reader can re-check them in one command.
