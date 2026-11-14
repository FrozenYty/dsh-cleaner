# 0011 — One operation, two callers

Date: 2026-11-14
Status: accepted
Amends: nothing. Adds a surface to ADR 0003's consent mechanism.

## Context

ADR 0003 made the consent mechanism two model-facing tools: a listing that cannot delete, and a deleting
tool whose ids must have been printed. That is a mechanism, not a promise that a person can only delete by
talking to a model. A night of live use showed the cost of the gap: to remove a log, the person had to ask
an agent to call a tool, which spent a turn, a request and a context window on a decision they had already
made. "Delete this session" is not a question that needs a model.

The harness documents the shape this should take — *"One operation, two callers"*, in the
plugin-development skill's `references/user-actions.md`: implement the operation once as a host method,
call it from the UI through a client-callable entry point (it names `ctx.remote.commands.execute` as the
example), and expose the same operation as an agent tool. Two callers, one implementation, and the
failure the UI shows is the failure the tool returns.

## Decision

**A session command is a second caller of the same implementation, not a second mechanism.**

- `listLogs(ctx, exec)` and `deleteLogs(ctx, exec, ids)` are the operation. The two tools and the command
  all end in them, so the wording, the protections and the refusals cannot drift between a person typing
  and a model calling. A test compares the command's answer with the tool's answer for the same ids.
- The command is registered through `ctx.get('commands')` and disposed as an effect, so a profile without
  that service still registers its tools, and an unloaded plugin leaves no command behind.
- Its shape is the registry's own contract, read from the installed harness rather than guessed:
  `{ name, description, input: { hint }, handler({ agent, rawInput }) }`, and the handler returns
  `{ kind: 'success' | 'error', text }`. Execution resolves the definition and runs the handler *without
  sending anything to the model* — that is the whole point.
- `/clean` lists; `/clean <id> <id>` deletes. The input is split on whitespace and commas, so ids copied
  out of a listing can be pasted as they are. An id that is refused is answered, not thrown: a command
  that fails loudly on "already deleted" would be worse than the tool it mirrors.
- The command keeps the caller protection: `invocation.agent` is the Session it was run from, so
  `/clean <the session I am typing in>` is refused exactly as the tool refuses it.

## Consequences

- A deletion no longer needs a model turn. The listing and the receipt are text in the transcript, which
  means the same `renderList`/`renderDelete` wording a person would have read in a tool result.
- The tool surface stays, because a model that is already in a conversation is the right caller when the
  person is describing what they want rather than naming ids: "delete the old ones under MYPROJS" is a
  request for the listing-then-approve flow, not for a command line.
- The command cannot be invoked by an agent: it is the human's entry point in the composer. That is the
  line `references/user-actions.md` draws, and the plugin keeps to it — an authority-granting action stays
  user-only, and this one grants nothing: it is the same explicit-id consent, typed instead of spoken.

## Amendment — the row in the session menu (same day)

A third caller appeared once the command existed: a session's ⋯ menu carries *Delete log*, and its click
runs the same command for the row it was opened on. It adds no operation, which is the point — the surface
a person reaches for is a row that says what it does, and what it does is `/clean <that id>`.

It is a **data contribution** (`contextMenus.register({ id, target: 'session', order, resolve })` returning
`{ id, label, run }`), not a React component in the token slot the sidebar also offers. Two reasons: a
renderer would have to reproduce the menu's markup and styles to look native, and a data contribution is
the shape the harness documents ("data contributions need no renderer"). The label follows the window's
active locale — the two literals are in the half rather than in a dictionary it would have to register,
because two words do not justify a locale namespace, and a missing dictionary key would render as a key.

### Amendment — where the row sits, and how it looks (same day, after the first sight of it)

The row read *Delete log* and rendered between the ordinary actions, with no icon. Three corrections, all
from the product's own vocabulary rather than from taste:

- **The label is the act**: 删除会话 / *Delete session*. "日志" is what the plugin removes; "会话" is what
  the person is looking at, and the menu is theirs.
- **`afterContent: true`**, which renders the action in the menu's footer group — after 在文件夹显示 and
  归档会话 — instead of before them. A destructive row adjacent to the action people use most is a
  mis-click waiting to happen, and `order` cannot express this: it only sorts contributions against each
  other.
- **`danger: true`, and the icon key it pairs with.** This is the trio the workspace plugin uses for its own
  delete row — `danger` plus `icon: { key: 'workspace.delete' }` plus a separator the session menu does not
  need — so *删除会话* reads exactly like *删除工作区*. 0.2.6 dropped the colour for one release, on a reading
  of the same note that preferred a neutral row; 0.2.7 put it back to match the workspace delete. The icon
  key is borrowed deliberately: re-drawing the glyph here would be a guess at the neighbours' stroke, size
  and colour, and this bundle cannot resolve `@deepseek-ai/dsh-client-ui-primitives` to import the real one.
  If that plugin is ever absent the key resolves to nothing and the row loses its icon rather than failing.

Two facts are only true in a running window, and the half treats both as optional: whether the menus
service is reachable from a dynamic client half, and what the click may call. If either is absent the row
is simply not contributed — the view pruning, which is the half's first job, keeps working either way.

### Amendment — a row that runs a command the host does not have (same day, after the first click)

The first click on that row failed, and the reason is worth writing down because it is a shape this plugin
will always have: **the browser half reloads with the page and the host half only reloads with the
process.** Right after an update the window therefore offers the new row while the running host still has
the old bundle — and `ctx.remote.commands.execute` answers `undefined` for a name it does not know, which
the composer treats as ordinary text. The session's own agent answered instead of the plugin, and the
person read a failure for a deletion that never happened.

The half now asks the host for that session's command list (once per session, remembered, because scoped
commands shadow globals per agent) and contributes **no row** unless `clean` is among them. A list that
cannot be read fails open: an unreadable answer is not evidence against the command, and a row that works
beats a row that hides.

The alternative — showing the row and disabling it — was rejected because a disabled row explains nothing
about *why*, and this plugin's whole surface is about saying what is true.

### Amendment — last in the menu, and a key of its own (same day, after the second look)

Two more requests, both answered from the product's tables rather than from taste:

- **Position.** The row now sorts with `order: 9000`, above every session action this build registers
  (pin 100, rename 200, fork 300, copy-id 450, archive 600). `afterContent` was the wrong tool: it moves a
  contribution into the menu's footer group, which the overlay renders *before* the component rows — that
  is why the row sat above 在文件夹显示 with a group separator over it. Plain ordering keeps it in the same
  group as the actions it belongs with, so there is no separator to explain.
- **Ctrl+Shift+D.** Registered through `ctx.shortcuts.register` with the product's own platform table
  (`desktop:windows|macos|linux`, `web:*`), so the binding appears in the shortcut settings, is remappable
  there, and cannot collide by accident. The menu row carries `commandId` = that shortcut's id, which is how
  the overlay prints the keys beside a label; the association never dispatches anything, so the row still
  runs its own captured callback for the session it was opened on. The key itself acts on the session the
  window is looking at, read from the sidebar's own persisted selection (`dsh.sessions.current`) because a
  global shortcut has no target — and when that cannot be read the shortcut reports `blocked` rather than
  guessing. It runs through the same command guard as the row: a host without `clean` receives nothing at
  all, instead of a line of text that reads as a failure.

### Amendment — the key is withdrawn, and why nothing may throw (same day, after it broke the menu)

Declaring that shortcut made **every** session's ⋯ menu answer `操作失败`. The likely mechanism, from the
packages' own documentation: the overlay renders this plugin's row inside every session menu, the shortcut
catalogue "rejects duplicate ids and overlapping default combinations" and its "errors while publishing an
accepted command catalog propagate to the caller", and a contribution the popup cannot render takes the
popup with it — our row is in every session's menu, so one bad entry is every menu.

Two things changed as a result:

- **The shortcut is withdrawn** until its catalogue entry can be checked against a running catalogue instead
  of assumed. The row keeps its label, its red, its trash glyph and its last-place order; what went away is
  the key and the `commandId` that printed it.
- **Every registration in the browser half is isolated**: `try`/`catch` around the contribution, a reported
  failure instead of a thrown one, and a disposer that cannot take the rest of the cleanup with it. The rule
  this plugin now follows is the one the failure taught: *a contribution this bundle cannot make must cost
  the row and nothing else.* A test mounts the half against a menus service that refuses the definition and
  asserts the view is still pruned and nothing throws.

### Amendment — the guard is gone, and the command was never registered (same day, at the third look)

The row kept disappearing and reappearing, and each fix chased the previous one. Two separate mistakes came
out of it, and both were mine:

- **The guard was answering the wrong question.** For three releases the row asked the host whether `clean`
  existed before offering itself: awaited inside `resolve` it hid the row on a freshly restarted host
  (0.2.8), asked in the background a synchronous throw escaped `resolve` and took the whole popup down
  (0.2.9). It is **removed**: `resolve` is synchronous, asks nothing, and the contribution's only call is the
  click, wrapped so that an unknown command or a refusing transport cannot surface (0.2.10). A click whose
  worst case is "nothing happens" beats every failure the guard produced.
- **The host had never registered the command at all.** `ctx.get('commands')` was read *once while the
  bundle loaded*; in a profile where the registry mounts later that lookup answers `undefined` and the
  registration was skipped **silently** — so the row was real, the command was not, and the guard had been
  telling the truth the whole time: the click did nothing because there was nothing to run. The registration
  now waits for the service (`ctx.inject(['commands'], …)`, the Core API that turns the callback into a child
  plugin with `inject`), and **every listing reports the outcome** as `human_command` plus one rendered line
  (0.2.11). That fact lives in a registry rather than on disk, and it is the difference between a row that
  deletes and a row that does nothing — it should have been in the listing from the start.

The lesson kept: a surface that silently does nothing is worse than one that visibly cannot, so a fact a
person needs (is the command registered?) belongs in the answer they already read, not in a log.

### Amendment — the key returns without the hint, and the row moves up (same day, on request)

- **`order: 350`**, between fork (300) and copy-id (450): "put it under 分叉会话". A plain number, and the
  whole of the position question — 归档会话 is a component row the product renders after every data
  contribution, so "last" was never a seat this plugin could take with an order.
- **Ctrl+Shift+D is registered again**, with the product's platform table, isolated in its own `try`/`catch`
  so a refusal costs the key and nothing else. It reads the session from the sidebar's own persisted
  selection — `dsh.sessions.current` holding `{ sessionId, subagentAddress? }`, read out of the workspace
  package's client half rather than guessed — and reports `blocked` when that cannot be read.
- **The hint is claimed only when the catalogue can render it** (0.2.13, replacing the blunt "no `commandId`"
  of 0.2.12). The overlay prints keys with
  `catalog.find((entry) => entry.id === action.commandId)`, and the bundle reads that same store
  (`ctx.shortcuts.catalog.getSnapshot()`) synchronously inside `resolve`: the id is named only when the
  catalogue actually holds it. Present → `Ctrl+Shift+D` prints beside the label; absent, unreadable or
  malformed → no association, no hint, and the row still works. A dangling `commandId` — the shape 0.2.4
  shipped, and the reason every session menu answered `操作失败` — is now impossible by construction, and
  three tests say so.
