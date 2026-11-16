# PLAN — the deletion flow, end to end

What "perfect" means for this plugin, stated as checks rather than intentions. Each item names the
acceptance that proves it, and the ones already done are marked. The goal is one sentence from the person —
*"delete this session"* — that ends with the row gone and the bytes reported, with no archive dance, no
layout gesture and no restart.

This file holds **task state only**: what is still owed and how each item is proved. The reasoning behind a
change and the evidence it was checked belong in `PROGRESS.md`, and what a person who installs the bundle
gets belongs in `CHANGELOG.md`. Everything below was re-checked against the code and the ADRs on 2026-11-16;
items that had gone stale were corrected rather than kept for the comfort of a long list.

## Done, and verified live

- [x] **A deletion removes a session's own directory and reports the exact bytes that left the disk.** The
      store is the index, so a session needs no archive entry to be a candidate
      ([ADR 0010](docs/adr/0010-no-archive-precondition.md)); the move is one atomic rename, and across
      volumes a verified copy ([ADR 0014](docs/adr/0014-route-transport-and-recoverable-deletion.md),
      [ADR 0022](docs/adr/0022-deletion-crosses-volumes.md)).
      *Met:* live, 453 946 bytes moved with `copied: true`, then restored byte for byte.
- [x] **The running session and any session whose agent is busy are protected; an idle resident agent is
      not** ([ADR 0008](docs/adr/0008-busy-not-resident.md)). *Met:* the refusal names the status.
- [x] **The row always goes, and without a restart.** Every record that can draw it is cleared after the
      files move — the log, the projection, the workspace membership, the archive flag, and the live session
      object through the store's own `detachEntered` ([ADR 0021](docs/adr/0021-derived-records-travel-with-the-log.md),
      [ADR 0023](docs/adr/0023-detach-never-archive.md), [ADR 0024](docs/adr/0024-a-deletion-drops-the-archive-flag.md),
      [ADR 0025](docs/adr/0025-a-deletion-releases-the-live-session.md)).
      *Met:* live, `archived_ids` unchanged by a detach, `still_listed: []` after the release; and the
      notice matrix in `tests/client.test.mjs` pins one message per outcome.
- [x] **The browser half is seen running, not only faked.** It reports itself over the host's route and the
      listing prints the report ([ADR 0013](docs/adr/0013-reuse-the-client-sessions-service.md),
      [ADR 0014](docs/adr/0014-route-transport-and-recoverable-deletion.md)).
      *Met:* live, a click's `lastClick` reached the next listing with `report=route`.
- [x] **A human command surface and a UI affordance, so the model is optional.** `/clean` lists and
      `/clean <id>` deletes through the host's command registry, and a session's ⋯ menu carries
      *删除会话* below *归档会话* ([ADR 0011](docs/adr/0011-one-operation-two-callers.md),
      [ADR 0016](docs/adr/0016-row-below-archive.md), [ADR 0017](docs/adr/0017-row-belongs-in-the-footer.md)).
      *Met:* the command's answer equals the tool's for the same id; the row sorts into the menu's footer, and
      Ctrl+Shift+D does the same thing for the session the window shows.
- [x] **Closing the plugin leaves no trace of it in the interface.** Every contribution lives inside the
      plugin's lifetime ([ADR 0019](docs/adr/0019-contributions-follow-the-plugin-lifetime.md)).
      *Met:* live, with the profile row disabled the route answered zero bytes and the menu, page, shortcut
      and dictionary were gone; re-enabling restored them.
- [x] **The listing shows what a decision needs, and every refusal is predictable from it.** Each row carries
      its archive state and its title, and every session the plugin will keep is printed with its reason,
      including a busy agent's status.
- [x] **A deletion is recoverable, and only a purge frees bytes** ([ADR 0015](docs/adr/0015-our-own-data-directory.md)).
      *Met:* the trash lists, restores and purges what it holds; nothing is deleted on a timer, and the sweep
      runs only when somebody looks.

- [x] **The 回收站 page shows the limits it enforces** — the retention window and the cap, taken from the same
      config the sweep and the cap read, on one line under the path (v0.5.30).
      *Met:* a client test drives the page to its second render and asserts both numbers; a route test asserts the
      trash answer carries them; the page test fails without the render change.

## Still owed

- Nothing. The next thing this file holds is a new item, not an old one.

## Accepted, not work

- **The `CHANGELOG.md` carries duplicated `## [0.5.x]` headings** (0.5.25, 0.5.24, 0.5.23 … each appears twice),
  left by an earlier prepend. Published sections must not be rewritten, so it is recorded rather than fixed — a
  release note that says the same thing twice is untidy, not wrong.

## Outside this repository, reported not fixed

- The profile's `pnpm-lock.yaml` still records the old root for all four linked plugins, while its
  `package.json` points at `DSH_PLUGINS`. The junctions are what resolve, so nothing is broken; a lockfile is
  the profile's business.

## Known limit, with an honest answer

- A live session owned by a fiber that never entered this store cannot be released by the plugin
  ([ADR 0025](docs/adr/0025-a-deletion-releases-the-live-session.md)). The deletion reports those ids in
  `query.still_listed` instead of promising a screen it cannot see; in practice this has not been observed
  since the release landed.
