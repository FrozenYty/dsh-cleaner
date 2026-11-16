# PROGRESS — the development log

Append-only. One dated entry per day of work, newest last. Each entry records **why** a change was made and
**how it was checked** — not which files moved, which `git log` already answers. A release that a user can see
gets its own note in `CHANGELOG.md`; this file is for the reasoning and the evidence that would otherwise be
lost.

Dates are the commit dates, in the order the work happened.

## 2026-11-13

- **The repository exists, and a deletion is out-of-band maintenance rather than a product feature.**
  The official persistence seam has no delete API, and the plugin does not pretend otherwise: it lists, takes
  explicit ids, removes the named directories and reports the bytes (`7add4fd`, `7a4961e`, ADR
  [0001](docs/adr/0001-out-of-band-deletion.md), [0003](docs/adr/0003-two-tools-with-explicit-ids.md)).
  Consent is a mechanism, not a description — two tools, ids required, nothing defaulted. Verified with the
  fixture engine tests; the first live run is recorded in `d7edb74`.
- **Every guard is repeated against the live filesystem when a plan executes, and an id is bound to the path
  it names.** A plan is data that has been sitting on disk since the listing, so the execution re-checks the
  encoded name, the `lstat`, the `realpath` and the fact that every entry is a regular file (`2d6378c`,
  `b5be136`, `ab9e726`, ADR [0005](docs/adr/0005-re-verify-at-execution.md)). Links and irregular directories
  are refused rather than followed (ADR [0004](docs/adr/0004-refuse-links.md)). Verified by fixtures that
  replace a directory between the listing and the deletion, and by one that renames an id to someone else's
  path.
- **CI became the proof of the `engines` claim: three systems, two Node majors** (`d774652`, `754feb4`,
  `cc27f3e`, and `de31476` for the isolation flag that Node 22 and 24 spell differently). The matrix is the
  claim, not decoration. Verified twice over: the six legs ran green, and a deliberate probe (`f9d3814`)
  confirmed that a red check really blocks the merge — then it was reverted (`67973cb`).
- **A deleted log still had a row, and the first answer was archiving.** The registry was asked to detach the
  id from its project and to archive it (`52bad41`, `c45d1b6`, `11c00c3`, ADR
  [0006](docs/adr/0006-detach-by-asking.md)), and the answer started reporting the host's own session list
  when it still named a deleted id (`c47fbb5`, `712c789`, ADR [0009](docs/adr/0009-two-records-two-cases.md)).
  **This mechanism was wrong and was replaced twice** — see the entries for 2026-11-15; it is recorded here
  unedited because a log that only remembers successes is not a log.
- **The plugin says what it does not reclaim.** The threat model, the "no bytes are freed until a purge"
  boundary and the honest comparison with the other two ways to delete a log were written down (`551d54a`,
  `25eaac2`, `7242b79`) — the reason being that a cleanup tool which overstates itself is worse than none.
  A second person's first two questions were answered in the same pass (`44d05b8`) and their first failures
  fixed in PR [#1](https://github.com/FrozenYty/dsh-cleaner/pull/1) (`942427f`).

## 2026-11-14

- **The archive dance was removed (v0.2.0).** A session no longer has to be archived before its log can be
  deleted: the store is the index, and the archive file is read only to report (`8d94db7`, ADR
  [0010](docs/adr/0010-no-archive-precondition.md)). The reason was a person's own complaint — the plugin was
  refusing the very thing it existed to do. Verified on the three-system matrix, plus the test that a session
  with no archive entry is a candidate and is deleted by name (`cace5be`).
- **`/clean`, so the model is optional (v0.2.0).** The same operation behind the host's command registry,
  with one implementation for both callers so the two cannot report different things (`60448e9`, ADR
  [0011](docs/adr/0011-one-operation-two-callers.md)). Verified by a test that the command's answer for an id
  equals the tool's answer for it.
- **The menu row took two dozen commits before it could be trusted.** The row was contributed, then it
  depended on a command that was not registered yet, then on a service that was not mounted, then on a
  verification that could not run (`41508ff`, `451257a`, `73e64f1`, `b0ffd82`, `c684c9e`, `bef9b24`,
  `d776987`, `1b34557`). The lesson written into ADR [0013](docs/adr/0013-reuse-the-client-sessions-service.md)
  is that a contribution is data — it must not ask questions, hold a guard or have a failure path — and the
  fix that finally held was the plainest one (`bef9b24`).
- **Where the row sits is the product's call, and it is the footer.** Sorting inside one block could not put
  it below 归档会话, so it became an `afterContent` action with its own order (`074b59b`, PR
  [#52](https://github.com/FrozenYty/dsh-cleaner/pull/52); colour and icon in `3dd21b1`, `5cec8ee`,
  `ea264cd`; ADR [0016](docs/adr/0016-row-below-archive.md), [0017](docs/adr/0017-row-belongs-in-footer.md)).
  Verified in a real window, which is the only place that can confirm it.
- **The window half could not reach the host, so the host served a route (v0.3.0).** This build's client root
  has no `remote` service (`8688709`), and a message fired before the click's own turn never reached the
  session (`e72a3af`); the answer was a small route the host registers and the window calls
  (`d6b56dc`, ADR [0014](docs/adr/0014-route-transport-and-recoverable-deletion.md)). The transport itself was
  a discovery: a `resource` route refuses a POST before matching, so the four routes had to be `handler`
  routes (`d9969d9`), verified by a live POST that answered JSON and a page reload that kept working.

## 2026-11-15

- **One data directory, inside the workspace's `.agents` (v0.5.13).** The plugin's trash and index moved to
  `<workspace>/.agents/cleaner`, beside `dsh-team` and `dsh-memory`, instead of a directory of its own under
  the profile (`cc5af5a`, `0ab48d4`, PR [#56](https://github.com/FrozenYty/dsh-cleaner/pull/56), ADR
  [0015](docs/adr/0015-our-own-data-directory.md)). Verified by a live listing whose `trash.root` is the
  workspace path, and by a profile config that moves it.
- **The trash became a page (v0.5.14–0.5.16).** A deletion should be visibly recoverable, so the settings seat
  carries a trash that lists what is held, restores it and purges it (`f862fec`, PR
  [#43](https://github.com/FrozenYty/dsh-cleaner/pull/43); `f9e6c64`, `8129e0e`, `bd49066`, ADR
  [0014](docs/adr/0014-route-transport-and-recoverable-deletion.md) amendment).
- **Closing the plugin removes everything it contributed (v0.5.18).** Every contribution now lives inside the
  plugin's own lifetime, so disabling it takes the menu row, the page, the shortcut and the dictionary with it
  (`6a2ef7e`, PR [#61](https://github.com/FrozenYty/dsh-cleaner/pull/61), ADR
  [0019](docs/adr/0019-contributions-follow-the-plugin-lifetime.md)). Verified live: with `include:cleaner`
  disabled the route answered zero bytes, and re-enabling it restored the answer.
- **A survey of eleven neighbours, and the correction it forced (v0.5.19–0.5.21).** `dsh-team`'s own comment
  states the mechanism this plugin had attributed to archiving: the move drops the artifact out of the
  session-query index, which is what makes the row disappear (`5980cb5`, PR
  [#62](https://github.com/FrozenYty/dsh-cleaner/pull/62), ADR [0020](docs/adr/0020-what-the-neighbours-do.md)).
  The same survey found the derived record this plugin never touched — the projection cache — and it now
  travels with the log (`b946147`, PR [#63](https://github.com/FrozenYty/dsh-cleaner/pull/63), ADR
  [0021](docs/adr/0021-derived-records-travel-with-the-log.md)). Verified by a delete-and-restore on a real
  session, with the projection present in the trashed folder and back afterwards.
- **A deletion across volumes, which taught the difference between a rename and a copy (v0.5.21).** The trash
  is in the workspace and the store under the user profile, so `rename` answered `EXDEV` and **every deletion
  of a session that had a log failed** — while the log-less ids the live checks had been using still
  "worked" (`214aab8`, PR [#64](https://github.com/FrozenYty/dsh-cleaner/pull/64), ADR
  [0022](docs/adr/0022-deletion-crosses-volumes.md)). The repair is a staged copy whose every file is compared
  with its source before the source is removed; verified live, 453 946 bytes moved with `copied: true` in the
  index, and the reverse transfer on restore.
- **Five separate records could keep a row on screen, and each took its own release (v0.5.22–0.5.25).** The
  log (v0.2.0), the projection (v0.5.20), the workspace membership (`53e4d8f`, PR
  [#65](https://github.com/FrozenYty/dsh-cleaner/pull/65), ADR [0023](docs/adr/0023-detach-never-archive.md)),
  the archive flag (`63dedc4`, PR [#67](https://github.com/FrozenYty/dsh-cleaner/pull/67), ADR
  [0024](docs/adr/0024-a-deletion-drops-the-archive-flag.md)) and finally the live session object
  (`27dfca4`, PR [#68](https://github.com/FrozenYty/dsh-cleaner/pull/68), ADR
  [0025](docs/adr/0025-a-deletion-releases-the-live-session.md)). The fifth one is the reason the earlier
  "a restart clears it" answer was not the end: the store's own `detachEntered` emits `session/disposed`, and
  a deletion now calls it. Verified live after each step — `archived_ids` unchanged by a detach, then empty
  after the flag was dropped, then `still_listed` empty after the release — and by a window reload, which
  cleared none of them.
- **A notice matrix as a test, and a tidy that found a bug (v0.5.22, v0.5.26).** Every outcome a person can
  reach got its own case, and writing it showed that a `/clean` which matched nothing was reported as "delete
  requested" — reading as success while nothing had happened (`53e4d8f`, PR
  [#65](https://github.com/FrozenYty/dsh-cleaner/pull/65)). The tidy afterwards moved the stale prose onto the
  new mechanism — the delete receipt, `docs/design.md` §5, both READMEs and two fixtures (`e80ffdc`, PR
  [#69](https://github.com/FrozenYty/dsh-cleaner/pull/69)).

- **Three records were drifting into one another, so their jobs were written down (v0.5.27).** `PLAN.md` held
  task state and stale mechanism prose, `CHANGELOG.md` held release notes that some of that prose belonged to,
  and the *reason* behind a change — why the archive dance had to go, why a rename was not enough across
  volumes — lived only in commit messages and ADRs. The split is one rule in `AGENTS.md` §4 (what is owed / why
  it changed and how it was checked / what a user gets), and this file was reconstructed from the 89 commits,
  the merged pull requests and the 25 ADRs rather than from memory: every entry names its commits, its PR or its
  ADR, and nothing in it is a release note copied out of `CHANGELOG.md`. Verified by sampling three entries and
  matching each hash's date and subject with `git show -s`, and by the repository gate, which now covers this
  file: `ROOT_SINGLE_LANGUAGE` in `scripts/check.mjs` had been missing `PLAN.md` as well.

## 2026-11-16

- **The repository moved to `DSH_PLUGINS\dsh-cleaner`, and the migration was verified rather than assumed.**
  The workspace contract now separates a plugin's source from its output, so a repository whose code is linked
  into a profile and runs in every session lives in `DSH_PLUGINS\<short-name>`; the old path is gone and the
  profile's four `link:` rows point at the new one. No code, test or fixture was touched — the only edit is this
  entry. The failure this migration could have caused is the unrecoverable one, so it was checked first: **the
  data directory is not derived from where the repository lives.** `resolveDataDir` reads the configured override,
  then the workspace, then a frozen fallback under the user's home; it has no input that is the plugin's own file.
  Proven by running the same probe twice, from two different working directories (the drive root, and the checkout
  itself) with identical inputs: every leg answered identically — an override from the environment wins, the
  workspace gives `<workspace>/.agents/cleaner`, and with neither the frozen fallback gives `~/.dsh/cleaner` —
  which a path derived from `import.meta.url` or `process.cwd()` could not do. Confirmed live as well: the running
  host still answers `trash.root = <workspace>/.agents/cleaner/trash`, with 53 stored sessions and 49 candidates,
  because the location comes from the workspace the registry names and from the profile's configuration, never
  from the checkout. `npm test` (124 tests, 121 pass, 0 fail, 3 skipped) and `node scripts/check.mjs` both exit 0
  from the new path, and the bundle's `package.json` reads through the rebuilt junction. One stale reference was
  found **outside** this repository and is reported rather than fixed: the profile's `pnpm-lock.yaml` still records
  the old root for all four plugins while its `package.json` points at the new one; the junctions are what
  actually resolve, so nothing is broken today.

- **The data directory moved to the user's home directory, after the plugin was caught following the profile.**
  The trash began appearing under the new folder's parent — empty — while the real one still held earlier deletions,
  because the resolution order ended in "the workspace the registry names" and was bound once at load, when that
  registry is often not yet mounted; the profile's *default directory* filled the gap, and it follows whatever was
  opened last. Nothing was lost (that trash was empty), but a data directory that moves is the one failure this
  plugin cannot undo, so the class was removed rather than patched: the location is the `dataDir` field, then
  `DSH_CLEANER_DATA_DIR`, then `~/.agents/cleaner`, resolved per use, with a `cwd`-shaped argument accepted and
  deliberately ignored. Proven both ways — the guard test failed before the fix with exactly the wrong path
  (`.tmp-entry/the-profile-default/.agents/cleaner/trash' against `~/.agents/cleaner/trash`) and passes after it,
  and `npm test` reports 125 tests / 122 pass / 0 fail with `node scripts/check.mjs` green. ADR 0026 supersedes
  ADR 0015's location; its other rule (this plugin owns its own data directory) stands. The same trashes on this
  machine were empty, so there was nothing to migrate.

- **Deleting the session you are viewing now leaves the dead view.** Releasing a deleted session from the Host's
  store (ADR 0025) left the window on a conversation that no longer existed. The click now calls
  `uiWorkspace.startSession()` — the sidebar's own *新会话* call, which lands on the default page when no workspace
  can take a draft — and only after a deletion that really happened, and only for the session on screen: a refusal
  means the session is alive, so the page must stay. Proven both ways: the new client test failed before the change
  (`[]` against `['session-blank-1']`) and passes after it, with `npm test` at 125 tests / 122 pass.

- **Deleting the session on screen lands on a new session, and the alternatives were considered and declined.**
  With 0.5.29 shipped, the question was whether "leave the dead view" should have other destinations. Three were
  weighed and rejected: falling back to the sidebar's **neighbour row** would mean re-implementing the window's own
  ordering record (`localStorage["dsh.workspace.view.v5"]`), which is exactly what ADR 0013 refuses; staying put
  with a banner is the dead view 0.5.29 removed; asking every time adds a dialog to an action that is already a
  confirmation. The one implementable alternative — **`openSession()` to the most recently updated other session**,
  which the product already exposes — is **deliberately not built**: it would need a `onSelfDelete` config field
  whose default is the current behaviour, and nobody asked for it. If that use becomes real, it is a small field and
  two tests, and the guards stay: succeed + current session only.

- **A client-half change was left without an HMR trigger, and the 删除会话 row vanished until the plugin was
  toggled by hand.** Worth recording because it was diagnosed as a possible deletion bug and was not one: the host
  answered normally throughout (route up, the workspace's trash root, 47 stored sessions) and the earlier
  delete-and-restore cycle had passed. What happened is the documented seam: editing a file under the repository
  evicts the linked bundle's module, the window's contributions of that plugin are torn down with it, and the
  window rebuilds them only when the plugin is loaded again — a page reload or a plugin toggle does that, a file
  change alone does not. The host half *had* been triggered at 01:40 and `client.js` was edited at 01:49 with no
  trigger, which is exactly the asymmetry that hid it. The rule is now in `AGENTS.md` §5 for every future change,
  and the README pair tells a person what to do after `git pull` and what the symptom looks like if they do not.

- **The trash page shows the retention window and the cap, closing the last item on `PLAN.md`.** The two numbers a
  person needs to decide whether to purge something now come from the same config the sweep and the cap read
  (`retentionDays`, `trashLimit`), echoed in the trash answer and printed on one line under the path. The test drives
  the page to its second render, which needed the client fixture's `React` to keep hook state between renders instead
  of dropping every update — it still has no renderer, but it can now show what a page says after the Host answered.
  Confirmed red without the render change — the second render carried the path and **no** numbers — and green after
  it; `npm test` at 127 tests / 124 pass, `node scripts/check.mjs` passed.

- **The trash page's rows were rewritten for the person reading them, and the limits line moved into a tooltip.**
  Two faults, both reported from a screenshot of the running page: the release note's visible `保留 30 天 · 最多 200 条`
  competed with the list (it is the same for every row and a person asks once), and each row led with a raw
  `2026-11-16T02:16:36.066Z` beside a session id glued to the title. Now the title leads, the id is a tooltip, the time
  is spoken (`今天 10:16` / `昨天 22:41` / `11-14 09:03`, local, with the exact value in the tooltip), and the page
  counts what it holds. Both new tests were confirmed red without the change; the first attempt at the tooltip test
  passed vacuously — a `split('"title"')` cut a prefix that ended before the line, so the assertion was replaced with a
  walk to the node by `key`, which cannot pass while the line is there. `npm test` at 128 tests / 125 pass.

- **The trash page's safety and bulk actions, from the design conversation.** Three choices were put to him and he
  took all three: confirm in place, both bulk actions, and the workspace on the row. Purging is the only irreversible
  action on the page, so it now takes two clicks and the question is dropped by any other action; **全部恢复** sends
  every id in one call; **清空回收站** asks and names the count it would free; and each row leads with the workspace,
  read from the projection at deletion time (`workingDirectory`, the same row `title` comes from) and stored in the
  trash index. That read was one function per fact and is now one function with the row name as a parameter.
  Proven red without the change — the row's meta line rendered `2.0 KiB · today 11:04` with no workspace — and green
  after it; the suite is at 129 tests / 126 pass, `node scripts/check.mjs` passed.
