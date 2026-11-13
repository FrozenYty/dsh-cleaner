# PLAN — the deletion flow, end to end

What "perfect" means for this plugin, stated as checks rather than intentions. Each item names the
acceptance that proves it, and the ones already done are marked. The goal is one sentence from the person —
*"delete this session"* — that ends with the row gone and the bytes reported, with no archive dance, no
layout gesture and no restart.

Written after a night of live failures, which are the reason each item exists.

## Already done, and verified live

- [x] A deletion removes a session's own directory and reports the exact bytes that left the disk.
- [x] The running session and any session whose agent is **busy** are protected; an idle resident agent is
      not ([ADR 0008](docs/adr/0008-busy-not-resident.md)).
- [x] The records a deletion leaves are decided per id by asking the host's own session list, so a deleted
      session stops hopping between *archived* and *ungrouped* ([ADR 0009](docs/adr/0009-two-records-two-cases.md)).
- [x] The bundle carries a browser half that prunes the window's own sidebar view
      ([ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md)).

## P0 — one step, no archive dance

1. **A session no longer has to be archived to be deletable.**
   The candidate rule becomes: *the store holds a log for this id, no agent is busy with it, and the caller
   named it.* Archiving stays what it is in the product — a way to hide a session — instead of a
   precondition this plugin invented.
   - Acceptance: a session that is **not** archived, named by id, with no busy agent, is deleted in one
     call; the answer reports it and the bytes. The refusal `not an archived session; archive it first`
     no longer exists.
   - Files: `engine.js` (the plan's candidate rule and every reason that mentions archiving), `index.js`
     (tool descriptions, the listing, the answer), both READMEs, `docs/design.md` §4, a new ADR 0010.
   - Test that fails without it: a fixture session with a log and **no** archive entry must be a candidate
     and must be deletable by name.

2. **A human command surface, so the model is optional.**
   The harness documents the shape: implement the operation once as a host service method, expose it as a
   session command the client can run through `ctx.remote.commands.execute(...)`, and expose the same
   operation as an agent tool ([`references/user-actions.md`] in the plugin-development skill).
   - Acceptance: typing the command lists candidates; typing it with ids deletes them; the wording equals
     the tool's answer for the same call, because both call one implementation.
   - Files: a new module for the operation plus `ctx.commands.register`; `index.js`'s tools call the same
     module.
   - Test that fails without it: the command's result for a given id equals the tool's result for it.

3. **The row always goes.** Finish what ADR 0009 started and prove it live:
   - a session the host has let go: delete → the host list drops it → the browser half prunes the view at
     the next page load → no row;
   - a session archived in the same run: delete → both records stay → the row is the archived one, hidden
     in its project;
   - Acceptance: after each deletion, one page load leaves no row for the deleted session, with nothing
     clicked and nothing restarted.

4. **The browser half must be seen running.** It is tested against a fake page and has never been observed
   in the real window.
   - Acceptance: after a page load, `dsh-cleaner.client.v1` in the profile's localStorage carries a fresh
     timestamp and the ids it pruned.

## P1 — no surprises in the answer

5. **The listing shows everything a decision needs, and every refusal is predictable from it.**
   Each row already carries title, bytes, file count, last write, and the store total. Add the two facts
   that decide a deletion: whether the session is archived, and whether an agent currently holds it (and
   its status).
   - Acceptance: every refusal the deleting tool can produce has its cause visible in the listing that
     preceded it.

6. **A UI affordance for the same operation**, if the slot system allows it cheaply: the browser half
   registers an item on a session's context menu that runs the command of item 2 through
   `ctx.remote.commands.execute(...)`, so a person can delete a session without typing and without the
   agent.
   - Acceptance: the row's menu offers it; clicking it deletes and the row goes, with no model turn.

## Stated boundary, not fixed

- A session the host still holds in memory is drawn from the host's list, and `ctx.sessions` exposes no way
  for a plugin to release it (`create`/`prepare`/`enter`/`announce`/`flush`/`get`/`list`/`fork`, no `close`).
  Item 3 is what keeps that row out of sight; a restart is what ends it. This is why the plugin reports the
  state instead of promising a screen.

## Order

1 (the rule) → 3 (the row, proven live) → 5 (the listing) → 2 (the command) → 6 (the menu) → 4 (the browser
half's live proof, which can happen at any point). Every item lands with its test, its document and its
entry in `CHANGELOG.md`, on a branch, with the six CI legs green — the same way everything tonight landed.
