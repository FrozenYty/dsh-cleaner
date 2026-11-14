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

1. **A session no longer has to be archived to be deletable.** — **done** (v0.2.0,
   [ADR 0010](docs/adr/0010-no-archive-precondition.md)).
   The store is the index: the engine enumerates session directories and decodes each name back to its id,
   the archive file is read only to report, and the tools are renamed `list_session_logs` /
   `delete_session_logs` because the old names had become a lie.
   - Met: a session with no archive entry is a candidate and is deleted by name (engine test
     *"archiving is not a gate"*, entry test *"an id that is already deleted is refused…"*).
   - Met: `not an archived session; archive it first to make it a candidate` no longer exists anywhere.

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

5. **The listing shows everything a decision needs, and every refusal is predictable from it.** — **done**
   for the two facts that decide a deletion: each row carries its archive state, and every session the
   plugin will keep is printed with the reason it is kept (`Kept, protected: <id> — <reason>`), including a
   busy agent's status.
   - Met: every refusal the deleting tool can produce has its cause visible in the listing that preceded
     it — protected (with reason), refused directory (with reason), or not on disk at all.

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

Items 1 and 5 landed in v0.2.0. Item 4 needs one page load in the real window; item 3 needs one deletion of
a session the host has let go.
