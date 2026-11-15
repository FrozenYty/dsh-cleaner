# 0017 — The row belongs in the menu footer

- **Status:** accepted
- **Date:** 2026-11-15
- **Supersedes:** the mechanism in [ADR 0016](0016-row-below-archive.md) — the placement decision stands, the
  sentence that a number alone reaches it does not

## Context

[ADR 0016](0016-row-below-archive.md) concluded that `order: 700` puts the deletion row below 归档会话 (600), on
the documented statement that "contributions sort by `order`, then ID". The row still rendered **above** it.

Reading the installed renderer (`@deepseek-ai/dsh-client-ui-context-menu/lib/client.js`) shows why: the overlay
splits the resolved actions into two buckets before it draws them.

```jsx
items:  menuEntries(items.filter((item) => !item.afterContent), catalog, renderSlot),
footer: menuEntries(items.filter((item) =>  item.afterContent), catalog, renderSlot),
```

And `@deepseek-ai/dsh-client-ui-workspace` returns the archive action with **`afterContent: true`**:

```js
register("archive", 600, ["workspace/archiveSession", "workspace/unarchiveSession"], (target) => [{
  id: "archive",
  label: t(restoring ? "menu.unarchiveSession" : "menu.archiveSession"),
  icon: { key: … },
  separatorBefore: true,
  afterContent: true,
  commandId: "session.archive",
  run: () => …,
}])
```

Every action without the flag is drawn in the item list; every action with it is drawn in the footer, after the
list. So 归档会话 is **not** in the item list at all, and no `order` value can place another item below it — the
order only decides position **within** a bucket.

## Decision

The action carries `afterContent: true` beside `danger: true` and the trash icon, and keeps `order: 700` so it
sorts after the archive row (600) inside the footer. `separatorBefore` is **dropped**: the archive action already
carries one, and a second divider between two adjacent rows reads as a mistake.

## Consequences

- The menu now ends with 归档会话 and then 删除会话, both below a single divider — the same shape as *删除工作区*
  at the end of a workspace menu.
- `order` still decides the footer's internal order, so a product row added to the footer with an order above 700
  moves ours up; the number remains not a contract.
- An action's `afterContent` is a **field of the returned action**, not of the registration, which is why this
  could not be seen from the registration signature alone. Anything drawn from this menu has to be read from the
  renderer's split, not from the registration call.
