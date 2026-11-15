## [0.5.23] - 2026-11-15

- **Correction to 0.5.22's wording, not to its behaviour.** The release note said a restore no longer unarchives;
  the code still does, and it should — a person who restores a log expects its row back, and the archive flag is
  what the sidebar reads. [ADR 0023](docs/adr/0023-detach-never-archive.md) now records the amendment: the plugin
  touches the flag in exactly one direction and in exactly one place, a restore, and never on a deletion.
- Verified live on the same session as the previous release: a deletion reports
  `workspace {"detached":[id],"orphans":[]}` and `still_listed: []` with **`archived_ids` unchanged at 4**, and the
  restore answers `verified: true, projection: true` with both files back.

## [0.5.22] - 2026-11-15
## [0.5.22] - 2026-11-15

- **A deletion detaches the session and never archives it — the row now leaves instead of turning into a dimmed
  "archived" row.** The sidebar draws a row only while the id is a **member** of a workspace and not archived
  (`sessionVisible`), and a blank session's placeholder tests the same membership. Archiving was both unnecessary
  and harmful: under the product's "show archived" filter the row is still drawn, dimmed, and the registry refuses to
  archive a session whose log is already gone — the case that needed it most. `detachSessions` replaces
  `hideSessions`, the window's own `archiveSession` call is gone, the answer no longer speaks of an archive, and a
  restore no longer unarchives. [ADR 0023](docs/adr/0023-detach-never-archive.md) supersedes ADR 0012's mechanism.
- **The notice matrix is a test.** Every outcome a person can reach — the log moved, there was nothing to delete,
  the Host held it back, the route is absent, the command matched nothing, no session to name — is asserted in one
  case each. Writing it found a real gap: a command that matched nothing was reported as *delete requested*, which
  reads as success while nothing happened; it now says *删除失败：宿主没有匹配到 /clean 命令*.

## [0.5.21] - 2026-11-15
## [0.5.21] - 2026-11-15

- **A deletion now works when the trash is on another volume — which it is on this machine.** The trash lives in the
  workspace (`<workspace>/.agents/cleaner`) while the session store lives under the user profile, so `rename` answers
  `EXDEV: cross-device link not permitted` and **every session that had a log failed to move**. Log-less ids still
  "worked", which is what the live checks had been using, so the regression went unseen since the data directory
  moved into the workspace. `dsh-team`'s trash had already documented the repair; it is now implemented:
  `moveAcrossDevices` tries the rename, and on `EXDEV` stages a copy, **compares every file's size with its source**,
  and removes the source only after the whole copy is verified. The same helper carries a projection file and the
  reverse transfers a restore performs.
- An index entry records `copied: true` when a transfer crossed a device, so a rename and a verified copy are
  distinguishable in the receipt rather than assumed to be the same thing.
- [ADR 0022](docs/adr/0022-deletion-crosses-volumes.md) records it, including the shape of the mistake: a live check
  that only removed log-less sessions could not see a failure that only affects sessions with logs.

## [0.5.20] - 2026-11-15
## [0.5.20] - 2026-11-15

- **A deletion now takes the session's derived record with its log.** The projection cache
  (`storages/session_projcache/sessions/<id>.json`) carries a session's title, its `cwd` and whether it is **blank**,
  and the sidebar's placeholder path draws a row from exactly that — so moving the log alone left the record that
  puts the row on screen. The move now renames the projection into the trashed folder, a restore puts it back (and
  answers `projection: true`), and a purge frees it through the same file walk that owns everything inside the
  folder, so the reclaimed bytes are honest.
- The cache package sanctions this itself: *"pruning stored checkpoints is out-of-band maintenance, same stance as
  session persistence itself"* — the same stance and the same missing API as session logs.
- A projection that is missing or held is reported on the entry and never fails the deletion: the log is the
  authority and the cache rebuilds from it.
- [ADR 0021](docs/adr/0021-derived-records-travel-with-the-log.md) records it, including the one case left alone on
  purpose: ids **with no log** keep their projection, because their row is the one the window's archive call removes
  and the projection is the only record of the title a person chose.

## [0.5.19] - 2026-11-15
## [0.5.19] - 2026-11-15

- **A survey of how four neighbours delete a session, recorded as
  [ADR 0020](docs/adr/0020-what-the-neighbours-do.md)** — no behaviour change, because the survey mainly confirms
  what this plugin already does and names which write actually removes the row:
  - `dsh-team`, installed beside this plugin and solving the same problem, says it in one line: *"the move also
    drops the artifact out of the session-query index, which is what makes the member disappear from the host's own
    lists"* — and it archives nothing. **The move is the mechanism**; this plugin's `archiveSession` /
    `detachSession` writes are belt-and-braces, and are the reason an archived row is still drawn dimmed under the
    product's "show archived" filter.
  - Claude Code separates "disappears from the list" from "the transcript is gone", and enforces retention with a
    lazy sweep on session start (default 30 days) rather than a timer — the same split and the same laziness as
    here.
  - Codex CLI deletes artifacts first and the state rows afterwards under one lifecycle lock, and refuses while a
    child thread exists. This plugin asks the registry **before** the move instead, because *this* product's
    registry refuses to archive a session whose log is already gone.
  - OpenCode publishes `SessionEvent.Deleted` so clients react instead of polling; the equivalent here is asking
    the session-query backend what it still lists (`still_listed`), which the deletion answer already reports.
- Numeric settings stay in the profile patch (`retentionDays`, `trashLimit`, `dataDir`), matching the family's
  `trashLimit`/`trashByteLimit` — no settings editor for them is expected of this plugin.

## [0.5.18] - 2026-11-15
## [0.5.18] - 2026-11-15

- **Every contribution is now inside `ctx.effect`, so closing the plugin takes all of it with it.** The dictionary
  and the session menu row were registered with a bare `register()` whose disposer nobody held: disabling the
  plugin evicts its client module
  ([the kernel's own words](docs/adr/0019-contributions-follow-the-plugin-lifetime.md): *"disabling it removes the
  entry and waits for its asynchronous effects before evicting unused modules and styles"*), and a contribution
  outside an effect is exactly the one that would survive that eviction. Both are wrapped now, like the page, its
  icon, the notice and the shortcut already were.
- **The fixture models the same lifetime**: a shortcut's disposer removes it, and a slot injection owns what its
  scope registers, so "closing the plugin leaves nothing behind" is a test and not a claim.
- **A test that says it in one line**: the row, the three seats and the key are there while the plugin is open, and
  all four are gone after every effect is disposed — which is what the kernel does on disable.

## [0.5.17] - 2026-11-15
## [0.5.17] - 2026-11-15

- **The trash page has no subtitle.** 删除只是搬走，可恢复。 explained what the heading, the empty state and the
  restore button already say, so it is gone — and with it the dictionary entry, so there is no unused string left
  behind. The page is now: 回收站 / 回收站是空的。/ the directory it reads.

## [0.5.16] - 2026-11-15
## [0.5.16] - 2026-11-15

- **The deletion answer has no `unlogged` field — that one belongs to the listing.** Asking the running Host for the
  answer verbatim settled it, after two rounds of guessing from reason strings:

  ```json
  "refused":   [ { "id": "01940c04-…", "reason": "no session directory is stored under that id" } ],
  "workspace": { "detached": ["01940c04-…"], "archived": [], "orphans": ["01940c04-…"] },
  "query":     { "still_listed": [] }
  ```

  `workspace.orphans` is the structural signal for "there was nothing to delete and the registry was asked to drop
  the row", so that is what decides the branch now, with `unlogged` kept as a second shape for the listing's answer.
  A log-less click therefore prints **无日志，已移出列表** instead of 未删除, and leaves the row to the registry it
  already asked.
- The test carries that answer verbatim, so the next person does not have to guess which field a deletion reports.

## [0.5.15] - 2026-11-15
## [0.5.15] - 2026-11-15

- **The engine reports an id with no directory under `unlogged`, and the window was looking in `refused`.** The
  window's own record of the click said it plainly — `lastClick=nothing moved` with no reason at all, `lastHide=none`,
  `archived_ids` unchanged — so the answer had been understood as "nothing happened" while it actually said
  "there was nothing to delete". Reading the answer's **own fields** fixes it: `unlogged` means done (there is
  nothing to delete, and the row goes), `protected` means held back (the log stays, the row stays, and the reason
  is shown verbatim). A reason string is not an interface; guessing which field carries it cost two rounds.
- Both branches are asserted with the shapes the engine really produces: `unlogged` takes the row with it and says
  *无日志，已移出列表*; `protected` keeps the row and prints its reason.

## [0.5.14] - 2026-11-15
## [0.5.14] - 2026-11-15

- **The trash page says it in one breath.** *删除只是搬走，可恢复。* replaces a sentence that explained the session
  backend, and *宿主半边未加载，重启后可用。* replaces the version naming the Harness. The page's other strings were
  already short.

## [0.5.13] - 2026-11-15
## [0.5.13] - 2026-11-15

- **The data directory is the workspace's `.agents/cleaner`, not the profile's.** `workingDirectory.defaultDirectory`
  is documented as "an absolute fallback for Sessions without an original directory", and in a desktop profile it
  is the profile's own directory — so resolving from it put the trash under
  `~/.dsh/profiles/desktop/.agents/cleaner`. The workspace registry's records carry `path` (the same field the
  sidebar compares a Session's `cwd` against), so that is what is asked now, and the answer is resolved when it is
  first needed rather than frozen at load, because the registry may not be mounted yet when `apply` runs.
- **The notices are short.** Every receipt now reads as one phrase — 已删除 / 未删除 / 无日志，已移出列表 /
  已请求删除，回执见本会话 — instead of the paragraph the previous versions printed.
- **The last click's outcome survives a reload**, in the window's own storage. Today's live fault became
  unreadable exactly because a reload wiped it: the page came back with `lastClick=none`, and the only witness to
  what the click did was gone. `lastClick` and `lastHide` are remembered across loads now.

## [0.5.12] - 2026-11-15
## [0.5.12] - 2026-11-15

- **A restore now reports what the store holds, not what the index remembered.** `restored` carried the entry's
  recorded `files` and `bytes`, which describe where the directory **was**: a restore could therefore report
  success with nothing at the destination. It now measures the directory after the move and answers `verified`
  from that measurement, so the one shape a lost log takes — "success" with an empty store — cannot happen
  silently again.
- **An incident, recorded rather than smoothed over.** While verifying the route I deleted a real session
  (`session-8529fc54-…`, a second "Greeting", 50 308 bytes) by mistake, then restored it through the trash route.
  The restore reported success; by the next listing the directory was gone from the store, the trash index was
  empty, and only the projection cache remained. The log is not recoverable. The engine's restore renamed
  successfully and the trash forgot the entry correctly, so what removed it afterwards was not observed — this
  release does not claim to know; it makes the case visible the next time, and the reason it is written here is
  that the previous version could not have told anyone.

## [0.5.11] - 2026-11-15
## [0.5.11] - 2026-11-15

- **"Nothing to delete" and "the Host refused" are now two different receipts.** A click on a session that never
  wrote a log was answered with the engine's internal sentence — `no session directory is stored under that id` —
  which reads like a fault report for what is actually finished work: there was nothing to delete, the row leaves,
  and that is the outcome the person asked for. It now says so. A genuine refusal still prints the refusal's own
  reason, and still leaves the row where it is.
- The two cases had been one branch since hiding was introduced; separating the wording is what made the
  difference visible, and both are asserted: the log-less case hides the row, the refusal case must not.

## [0.5.10] - 2026-11-15
## [0.5.10] - 2026-11-15

- **The row can now delete the session you are looking at.** The window's own report from the live profile made
  the fault plain: `lastClick=nothing moved: the session running this command`. The guard that protects an Agent's
  own session was written for the `/clean` **command** carrier and had been copied onto the route, which fabricated
  an Agent out of the session on screen — so clicking ⋯ → 删除会话 on an open session was refused, which is the
  ordinary case for a cleanup tool. What is protected now follows the carrier
  ([ADR 0018](docs/adr/0018-protection-follows-the-carrier.md)): an Agent call protects the session it runs in; a
  window call names itself in the record and protects nothing; a call with neither is still refused. The busy-Agent
  guard is unchanged and is what actually protects a session being written to.
- **The row is hidden only when it should go.** A refusal — a busy Agent, a directory the filesystem would not let
  go — now leaves the row alone, because hiding it would contradict the receipt printed beside it. A real deletion,
  or a session that never had a log, still hides it: those are the two cases where the row must leave.

## [0.5.9] - 2026-11-15
## [0.5.9] - 2026-11-15

- **`order` was not the whole placement, and 0.5.8's conclusion was wrong.** The menu overlay splits resolved
  actions into its item list and its footer by `afterContent`, and the product returns the archive action with
  `afterContent: true` — so *归档会话* is not in the item list at all and **no `order` value can seat another row
  below it**. This row now carries `afterContent: true` as well and keeps `order: 700`, which orders it after
  archive (600) **inside the footer**: it is the last row of the menu, which is where it was asked to be.
- `separatorBefore` is dropped: the archive row already carries one, so the destructive block is divided once and
  two adjacent dividers no longer stack.
- **The lesson is recorded where it will be read**: `afterContent` is a field of the resolved *action*, not of the
  registration call — which is exactly why the previous version could look right in the code and be wrong on
  screen. [ADR 0017](docs/adr/0017-row-belongs-in-the-footer.md) supersedes ADR 0016's mechanism, and the test now
  asserts the resolved action rather than the registration.

## [0.5.8] - 2026-11-15
## [0.5.8] - 2026-11-15

- **The row can sit below 归档会话, and now does.** `contextMenus` documents its ordering as "Contributions sort
  by `order`, then ID" — ascending and numeric, with no relative placement. The session family's own rows, read
  from `dsh-client-ui-workspace` in the installed asar, are pin 100, rename 200, fork 300, copy-id 450 and
  **archive 600**, so `order: 350` had always sorted the row *above* 归档会话 rather than under 分叉会话 as ADR
  0011 recorded. It now registers `order: 700` with `separatorBefore: true`, which is the shape the product's own
  destructive row uses in a workspace menu (*删除工作区*). The number is still not a contract, and
  [ADR 0016](docs/adr/0016-row-below-archive.md) says so.
- The product's five numbers are recorded in the ADR, the README pair and `docs/seams.md`, so the next reader can
  re-check them in one command instead of trusting this text.

## [0.5.7] - 2026-11-15
## [0.5.7] - 2026-11-15

- **Every 405 in this plugin's history had one cause: a `resource` route is read-only.** The carrier serves
  `resource` routes for GET and HEAD only and refuses any other method **before matching**, with an empty 405
  that is indistinguishable from "this route does not exist" — while every listing printed `route registered`.
  The window has to POST, so the carrier now registers **`handler`** routes (`(request, response) => …`) and
  writes the JSON answer itself.
- **No process restart is needed for this, or for any later Host-half change.** The base bundle enables HMR in
  this profile (`include:hmr`, active), and a profile-recomposition replaces plugins whose loaded files changed
  on disk — including the targets of `link:`ed packages, which is what this bundle is. Writing one comment into
  the profile's patch triggers it. Verified live, twice: first the listing grew the `Window transport:` line that
  only this version prints, then `POST /dsh-cleaner/list` answered with the full JSON listing while the process
  that started hours earlier kept running.
- The exact-path, handler-shaped registration is asserted in the entry tests, including that a GET still answers
  this plugin's own 405 rather than the carrier's.

## [0.5.6] - 2026-11-15
## [0.5.6] - 2026-11-15

- **A click now hides the row even when there is no log to remove.** A window draws its rows from the workspace
  records and the sidebar never draws an archived session, so `archiveSession` is the **only** call that makes a
  row leave an open window at once. The workspace registry refuses to archive a session that is "neither live nor
  in session persistence" — a session that never wrote a log is exactly that — so the host deletion skips the
  archive for such an id and the row stood there after the click. That is the whole answer to *"为什么 Greeting
  不能点完就消失"*: not a slow host, not a missing refresh, but a permission the registry does not grant.
- The browser half now hides the row itself, with the same action the sidebar's own ⋯ → 归档会话 uses, **after**
  the deletion request: for a session with a log the host has already archived it and the registry resolves a
  second archive as a no-op; for one without, this is the only thing that can write the flag. A session that was
  never open becomes live in the same call, which is what makes the registry accept it.
- The self-report gained `lastHide=archived <id> | refused: … | no uiWorkspace service`, so a row that does not
  go says which of the three happened.
- A workspace service that refuses the archive is recorded and never thrown: the deletion has already happened
  by then, and a hide that fails must not fail it.

## [0.5.5] - 2026-11-15
## [0.5.5] - 2026-11-15

- **The command carrier no longer claims a deletion it cannot see.** It answers with "did a command match", not
  with what it removed, so the notice now says *已发出删除请求——宿主的回执就在这个会话里* and the Host's own
  answer in the conversation carries the outcome. A blank session genuinely has no log, and a notice that said
  "deleted" there would have been one more quiet lie.
- **The state report rides the command once per page load**, not after every click: the running Host parses a
  command line and prints its answer in the conversation, so a report per click added a line to somebody's
  transcript each time and taught them to ignore it.
- The report records `handed to /clean (matched=…)` rather than `deleted over /clean`, for the same reason.

## [0.5.4] - 2026-11-15
## [0.5.4] - 2026-11-15

- **The keycap was missing because the registration was refused, and this is why.** The product's own validation
  (its `protocol.js`, read from the installed asar) admits a shortcut only when **every declared profile** admits
  it. `web:linux` accepts three fixed combinations and nothing else, so declaring it with `Control+Shift+D` made
  `register()` throw `Unsupported Web shortcut` — and **the whole registration was refused**: no catalogue entry,
  hence no key beside the menu row, and a key that never fired. Reproduced outside the browser with the
  product's own pure functions before changing anything:

  ```
  web:macos    issue=none webAllowed=true   → accepted
  web:windows  issue=none webAllowed=true   → accepted
  web:linux    issue=unsupported-browser    → REGISTRATION THROWS
  ```

- `web:linux` is now **left unbound** — an omitted profile is simply unbound, which is the honest state on a
  platform whose rules do not admit the combination. The other five keep `Ctrl+Shift+D` / `⌘⇧D`.
- If a declared profile is ever refused again, the half **retries with the desktop profiles only**, so a refused
  platform costs one platform instead of every key, and the report says which attempt won.
- The three bug reports that started this — *「标签旁边不会印 Ctrl+Shift+D」*, *「点击没有效果」* — were two
  different faults with one shape: a contribution that fails silently. Both now name their own failure.

## [0.5.3] - 2026-11-15
## [0.5.3] - 2026-11-15

- **A click now says what it did, at the frame level** (`shell.overlay`, self-dismissing after 12 seconds):
  *已删除。目录在回收站里，可以恢复。* / *没有删除：<原因>* / *删除失败：<原因>* / and, when the click cannot run
  at all, *当前没有打开的会话，没有可以作为调用者的会话*. "点击没有效果" was never a wrong symptom — it was the
  absence of one, and a row that deletes nothing and says nothing cannot be told apart from a row that is not
  wired up. That ambiguity is what cost the most rounds here.
- The notice reads the same sentence the report carries, so what a person sees in the window and what the next
  listing prints cannot disagree.
- The half's self-report gained `notice=contributed | refused: …`.

## [0.5.2] - 2026-11-15
## [0.5.2] - 2026-11-15

- **The row no longer needs a restarted Host.** It tried one carrier — the HTTP route — which exists only from
  0.3.0, so on the Host this was being debugged on every click ended in `405` and nothing else. It now tries the
  route first and then **the `/clean` command the running Host already serves** (registered since 0.2.18),
  carried by the session in front of the person through `ctx.sessions.retain(id)` → `binding.session.command`.
  The evidence for that carrier, read from the live Client contract rather than assumed: `retain` "starts its
  shared initial history opening", `reference.ready` settles that attempt, and the binding hands back an
  `AgentContext` — an agent scope, which is what a command needs.
- **The carrier is the session in front of the person, and only the target is closed.** That distinction is what
  the previous attempts got wrong: a closed session cannot carry a command, but it does not have to — the one
  the person is looking at can, and the target travels as the argument.
- **The self-report now rides the command too** when there is no route, and it says which carrier delivered it
  (`report=route` / `report=command (route unavailable: …)` / `report=nowhere: …`). Before this, every report was
  lost on any Host older than 0.3.0 — which is exactly the Host being debugged.
- The click's outcome says which carrier did the work (`deleted over the route` / `deleted over /clean`), so a
  fallback is never mistaken for the primary path.

## [0.5.1] - 2026-11-15
# Changelog

What each released version of this bundle contained, newest first, in the shape
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) describes: one dated section per version, ISO
dates, and a later release adds a section above an older one instead of rewriting it.

A release adds its section in the same pull request that writes the change, so the version in
`package.json` always has a section here.

## [0.5.1] - 2026-11-15

- **The page is called 回收站 / Trash.** "Deleted sessions" described the contents and read like a log title;
  "Trash" is the word every desktop already uses for the place a deleted thing can be recovered from.
- **The page carries its own icon** — a drawn trash can in the product's line style, contributed to
  `settings.section.icon` under the same id as the page, which is what pairs them. The seat's default gear said
  nothing about what the page was.
- The page no longer prints the transport's status code at a person. The technical detail stays in the report
  the host half prints (`Window half: … route=…`), and what a person reads is *"The plugin's Host half is not
  loaded yet. Restart the Harness and it comes to life."*

## [0.5.0] - 2026-11-15

- **The trash has a page.** The browser half contributes one settings page — *已删除的会话 / Deleted
  sessions* — listing what the trash holds: title and id, bytes, when it was deleted, and a **恢复 /
  Restore** and **彻底删除 / Delete for good** button per entry. It is the seat the product documents
  (`slots.inject` → `slots.register` on `settings.section`), registered only when a slot service exists, so a
  profile without one keeps the menu row, the key and the dictionary.
- **The page acts through the same route the menu row uses**, so the two cannot drift: one `POST
  /dsh-cleaner/trash` with `op: list | restore | purge`, and every failure is shown in place instead of leaving
  a stale list.
- React comes from the page's own module table (`require('react')`, the documented shape for a Client module),
  so the panel needs no build step and no duplicate installation.
- The client manifest now declares the packages whose seats it uses (`dsh-client-ui-settings`,
  `-layout`, `-locale`) instead of the stale session-controller id from the era when this half talked to
  `ctx.sessions`.
- The half's self-report gained `panel=contributed | refused: …`, so "the page is missing" is a sentence in the
  listing rather than a question.

## [0.4.0] - 2026-11-15

- **The trash moved out of `DSH_HOME`, and became configurable.** `DSH_HOME` holds Harness data — sessions,
  workspace records, profiles — and the trash is not that. Its default is now
  `<workspace>/.agents/cleaner/trash/`, beside the memory notebook and the team roster, so everything this
  plugin owns is in one directory a person can open ([ADR 0015](docs/adr/0015-our-own-data-directory.md)).
- **A profile can move it or bound it**, through the bundle patch row `cleaner` — the same seat the sibling
  bundle uses:
  ```yaml
  - id: cleaner
    config: { dataDir: '.cleaner', retentionDays: 30, trashLimit: 200 }
  ```
  Resolution order is the config, then `DSH_CLEANER_DATA_DIR`, then the workspace, then `~/.dsh/cleaner`. The
  Host's own installation is never used as a workspace: a base inside `app.asar`, or beside the executable, is
  skipped rather than written into.
- **A present value that cannot be honoured fails the load**, naming the field, the value it saw and the
  minimum — not the first deletion, hours later, in front of somebody who just clicked.
- **The trash is bounded by two rules instead of one**: the 30-day window, and a cap of 200 entries. Both are
  applied by acts — a deletion, a restore, a purge — never by a timer, and never by a listing, which only
  reports what they would do. The oldest entries go first, and each one freed is reported with its id and its
  bytes.
- The data directory is resolved once at load and printed by every listing, so where the bytes are is never a
  question a person has to ask.

## [0.3.0] - 2026-11-15

- **The sidebar row works, because the window now has a transport that does not need an agent.** The host half
  registers one route on the product's own web carrier — `prefix /dsh-cleaner/` — and answers
  `POST /dsh-cleaner/{delete,list,trash,state}`. Every earlier attempt failed for the same reason: a command
  needs a **live** agent, and the session behind a sidebar row is usually closed. The window sends the session
  it is showing as `caller`, which is what keeps the running session protected on this path too. The
  community plugin that does this same job reaches its host the same way
  ([ADR 0014](docs/adr/0014-route-transport-and-recoverable-deletion.md)).
- **A deletion is recoverable for 30 days.** Each session directory is moved out of the store in **one atomic
  rename** into `<DSH_HOME>/dsh-cleaner-trash/`, with an `index.json` beside it. The store stops holding the
  session at once — which is what the row needs — and the bytes are freed only by a purge. This also removes
  the "half-removed session" failure mode: a rename either happens or does not.
- **New surface: `trash_session_logs`** (`action: list | restore | purge`) and `/clean trash | restore | purge`.
  A restore puts the directory back where the backend looks for it and unarchives it — the one place this
  plugin calls `unarchiveSession`, and the reason a deletion still never unarchives.
- **Retention is not a timer.** Entries past 30 days are freed by the next deletion, restore or purge; a
  listing only *reports* what that sweep would do, because a listing must never be able to destroy anything.
- The listing now carries two more facts a person needs: what the trash holds (`Trash: …`), and which transport
  the window has (`Window transport: …`) — a row that is drawn and cannot act looks exactly like one that works.
- `applyCleanup` and the per-candidate unlink path are gone; `moveToTrash` is the deletion and `purgeTrash` is
  the only thing that removes files.

## [0.2.19] - 2026-11-15

- **The real cause, at last: this build's client root has no `remote` service.** Every `ctx.remote.*` call the
  browser half made — `remote.session.list` for the view repair, `remote.commands.execute` for the click and
  the self-report — threw, and each was swallowed by a `try`/`catch` written to keep failures non-fatal. That
  is why the row appeared, the click did nothing and `Window half: nothing heard` stayed true, all at once.
  The Client inspect directory lists `layout`, `locale`, `sessions`, `slots`, `theme`, `timer`, `uiWorkspace`
  and `workspaces` — and no `remote`.
- **The half now acts through the official `ctx.sessions` service**: `retain(id, { source: 'gateway' })` →
  `await reference.ready` → `binding.session.command(line)` → `release()`. `retain` starts the initial history
  open, so a session nobody had open still gets a live binding, and `command` is the admission the composer
  runs — the deletion keeps one implementation behind every caller. The click carries the command in the
  session the window shows and names the target as its argument, so the receipt lands where the person is
  looking.
- **The sidebar-view repair is removed** ([ADR 0013](docs/adr/0013-reuse-the-client-sessions-service.md)
  supersedes [ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md)): it was built on a remote that does
  not exist here, so it never ran. What hides a deleted session's row is the archive write, a product rule
  reached through a product interface.
- The browser half shrank by a third, and its report now records `transport`, `current` and `lastClick`, so
  the next fault of this kind names itself.

## [0.2.18] - 2026-11-15

- **The command is carried by the session the window is showing.** commands.execute resolves against a live
  agent, and a sidebar row may belong to a session nobody holds any more — which is why the click did nothing
  and why the window half's own report never arrived: both ran the command *in the target session*. The row now
  names the target as an argument and runs the command in the open session, exactly as the composer does:
  the carrier always has an agent, /clean already accepts ids, and the receipt appears in front of the person
  instead of in a session they cannot see.
- With no session open there is nothing to carry the command, and the row says so rather than failing silently.

## [0.2.17] - 2026-11-15

- **The window half now speaks before it can fail.** Its report is sent first, before anything that can throw,
  and once more from inside the guard that catches a setup failure — so a half that dies while setting up still
  says which error killed it (atal=…) instead of leaving Window half: nothing heard from a window yet as the
  only evidence. The report also fetches its own session id, because leaning on the repair meant silence in exactly
  the case that mattered.
- The report now carries ow=contributed|refused: … and dictionary=…, and the listing prints all of it.
- Diagnostics on the live machine: Human command: /clean — registered (the host registration fix works) with
  Window half: nothing heard from a window yet — that pair is what pointed at the browser half being dead on
  arrival rather than the row being refused.

## [0.2.16] - 2026-11-14

- **The label comes from the product's dictionary service.** The window half now contributes
  `ctx.locale.register('dsh-cleaner', { en, zh })` and reads it back with `ctx.locale.bind`, instead of
  guessing the language from `getLocale().active` and hard-coding two literals. Any language we do not
  translate now lands on `en` through the product's own fallback chain, and the guess is gone.
- **[docs/seams.md](docs/seams.md)**: every seam this plugin uses, everything it owns because no seam exists,
  and the risks it accepts with the reason — written so the next change starts from the map instead of from
  memory. The audit found no other bespoke path: the tools, the command, the menu row, the shortcut, the
  archive/detach, the busy check and the window half's report all run through product interfaces.

## [0.2.15] - 2026-11-14

- **The window half now says what it managed to do, and a listing prints it.** A browser half that loads but
  cannot contribute anything is invisible from the host side, and "the row is there but the key is missing"
  has now cost several rounds of guessing. It has exactly one channel to the host — the command registry — so
  it borrows it: two seconds after a page load it runs `/clean --state {…}` with its own account
  (`inject=… service=… register=… catalog=… menu=…`), the host records it, answers **silently** so nothing
  lands in a transcript, and the next listing carries it as `client_half` plus one line: `Window half: …`.
  A `--state` that is not a JSON object is not a report, so the flag can never make the command quiet on a
  person.
- The state is kept even when a registration is refused: `register=refused: <reason>`. "Refused" without a
  reason is the same silence one layer down — the failure mode this plugin has already paid for three times.

## [0.2.14] - 2026-11-14

- **The shortcut waits for its service, which is why the keycap was missing.** Registering it read
  `ctx.get('shortcuts')` once while the browser half loaded; a client service that mounts after this plugin
  is simply not there yet, so the registration was skipped **silently** — the row and the pruning kept
  working, the catalogue never held the id, and the hint therefore had nothing to print. The registration
  now goes through `ctx.inject(['shortcuts'], …)` (the Core API the host half already uses for the command
  registry), so it lands whenever the service arrives, and it is disposed with the plugin. A Context without
  `inject` falls back to the one-shot lookup and says so on the console instead of staying quiet.
- The fake page in the tests grew the two states that matter: a service that mounts late (the binding is
  delivered when it does) and a catalogue that is unreadable (the hint is withheld, nothing throws).

## [0.2.13] - 2026-11-14

- **The keycap prints beside the label.** `commandId` is set — but only when the shortcut catalogue really
  holds this plugin's id, read synchronously from the same store the overlay reads
  (`ctx.shortcuts.catalog.getSnapshot()`). The overlay's lookup is a plain
  `catalog.find((entry) => entry.id === action.commandId)`, so a *dangling* association is the one shape this
  bundle will not ship: 0.2.4 named a static one and took every session menu down with it. Present → the keys
  print; absent, unreadable or malformed catalogue → no association, no hint, and the row still works.
- Three tests pin it: the hint is claimed when the catalogue has the id, withheld when it does not, and
  withheld — without throwing — when reading the catalogue fails.

## [0.2.12] - 2026-11-14

- **Seated after 分叉会话** (`order: 350`, between fork 300 and copy-id 450), on request: the row is where a
  person looks for it, not at the bottom of the menu.
- **Ctrl+Shift+D is back** — registered through `ctx.shortcuts.register` with the product's own platform
  table, so it shows up in the shortcut settings and is remappable there. It acts on the session the window
  shows, read from the sidebar's own persisted selection (`dsh.sessions.current`, `{ sessionId }`), reports
  `blocked` instead of guessing when that cannot be read, and runs the same command as the row.
- **No `commandId` on the row**, deliberately: printing the keys beside the label is the one piece that
  plausibly took *every* session's menu down in 0.2.4, and this row lives in all of them. The key works
  without it; the hint comes back only once the catalogue entry can be checked against a running catalogue.
- The shortcut registration is isolated like every other contribution: a registry that refuses the
  definition costs the key, never the row or the view pruning.

## [0.2.11] - 2026-11-14

- **The human command now registers even when the command registry mounts after this bundle.** The
  registration read `ctx.get('commands')` once while the plugin loaded; when the registry was not up yet the
  lookup returned nothing and the command was skipped **silently**, which is how the sidebar row ended up
  running a command the host had never heard of: the row appeared, the click did nothing, and nothing said
  why. The registration now waits for the service (`ctx.inject(['commands'], …)`) and its disposal still
  removes the command with the plugin.
- **Every listing reports whether the command is registered.** `human_command` in the value and one line in
  the rendered text (`Human command: /clean — registered`), because that fact lives in a registry rather than
  on disk and it is the difference between a row that deletes and a row that does nothing. This is the
  diagnostic that would have found the bug in one call.

## [0.2.10] - 2026-11-14

- **The guard is gone, and the row asks the host nothing.** Three releases tried to answer "does the host
  have this command?" before offering the row: awaiting it inside `resolve` hid the row on a freshly
  restarted host, asking in the background left a synchronous throw that took the whole menu down
  (`操作失败，请重试`), and the guard itself could not see the one fact it needed. The contribution is now
  **plain data**: a constant label in the window's language, an icon key, `danger`, `order` — and a single
  call when it is clicked, wrapped so that neither an unknown command nor a refusing transport can surface
  an error. The worst case is a click that does nothing, which is cheaper than every failure the guard
  produced.
- This also removes the plugin's only use of `commands.list` from the client half; `commands.execute` at
  click time is the one client-callable entry point the product itself uses for the same purpose.

## [0.2.9] - 2026-11-14

- **The row is back on a host that has the command.** The 0.2.8 guard awaited the command list *inside* the
  menu's `resolve`, so a call that did not settle hid the row exactly where it mattered — on a freshly
  restarted host, which is the state the guard was written for. The question is now asked in the
  background and `resolve` only reads the answer: a definite "no" hides the row, an unanswered question
  offers it, and a click that learns the truth (`execute` answered `undefined`) records it for the next
  menu. The page load also warms the question with the first session the host names, so a stale window
  usually hides the row before it is ever opened.
- The cost of being wrong is now one click that does nothing, and that click is remembered — not a row that
  silently never appears.

## [0.2.8] - 2026-11-14

- **A row that cannot be verified is not offered.** The command check used to fail *open* — an unreadable
  command list kept the row — which is exactly how a stale window ends up offering a click that fails. It
  fails **closed** now, and a click that reaches a host answering `undefined` remembers that for the session
  and withdraws the row instead of offering a second failing click. The rule: a missing row is a smaller
  surprise than a click that reports a failure for something that never happened.

## [0.2.7] - 2026-11-14

- **`danger` is back**, so the row reads exactly like *删除工作区*: the product's destructive colour with the
  trash glyph it registers. 0.2.6 removed the colour on an earlier reading of the same note; the decision
  now is to match the workspace delete rather than to stand out from it. The triple the workspace row uses
  is `danger` + `icon: { key: 'workspace.delete' }` (+ a separator the session menu does not need), and this
  row carries the first two.

## [0.2.6] - 2026-11-14

- **The row is neutral, not red.** `danger` is gone: the label and the trash glyph already say what the row
  does, and a red row among neutral ones pulls the eye towards the one action that cannot be undone. It also
  keeps the row visually identical to its neighbours, which is what was asked for in the first place. The
  product still colours *its own* destructive row red; this bundle simply does not ask for it.

## [0.2.5] - 2026-11-14

- **The Ctrl+Shift+D shortcut is withdrawn**, and the session menu works again. Declaring it in the shortcut
  catalogue (or the `commandId` that printed it beside the label) made every session's ⋯ menu answer
  `操作失败` in the window: the overlay renders our row inside every session menu, and a contribution it
  cannot render takes the whole popup with it. The row keeps its label, its red, its trash glyph and its
  last-place order; the key can come back once its catalogue entry can be verified against a running
  catalogue rather than assumed.
- **Every contribution is now registered in isolation.** A service that refuses this plugin's definition
  costs the row and nothing else — the view pruning and every other plugin's menu keep working — and the
  refusal is reported to the page's console instead of being thrown into the plugin's `apply`.
  ([ADR 0011](docs/adr/0011-one-operation-two-callers.md), amendment).

## [0.2.4] - 2026-11-14

- **The row is the last thing in the menu, and it has a key.** `order: 9000` sorts it after every session
  action this build registers (pin 100, rename 200, fork 300, copy-id 450, archive 600) instead of into the
  footer group, which renders before the built-in rows. **Ctrl+Shift+D** (⌘⇧D on macOS) now deletes the
  session the window is looking at: the binding is registered in the product's own default table, so it
  appears in the shortcut settings and is remappable there, and the row points at it with `commandId`, which
  is what prints the keys beside the label the way the product prints them for its own actions. The key uses
  the same guard as the row — a host without `clean` receives nothing rather than a line of text
  ([ADR 0011](docs/adr/0011-one-operation-two-callers.md), amendment).

## [0.2.3] - 2026-11-14

- **The menu row appears only when the command it runs exists.** A window half reloads with the page and
  the host half only reloads with the process, so right after an update the menu could offer a row whose
  command the host had never heard of. Clicking it is admitted as ordinary text, the session's own agent
  answers instead, and the person reads a failure for a deletion that never happened — which is exactly
  what happened the first time this row was clicked. The half now asks the host for that session's command
  list, once per session, and contributes no row when `clean` is missing. A list that cannot be read
  fails open, because a row that works is better than a row that hides
  ([ADR 0011](docs/adr/0011-one-operation-two-callers.md), amendment).

## [0.2.2] - 2026-11-14

- The session menu row now reads how a person describes the act: **删除会话** / *Delete session* (it was
  *Delete log*). It is drawn with `danger: true` in the product's own red, carries the trash glyph the
  workspace plugin already registered in the shared `contextMenu.icon` slot — borrowed rather than
  re-drawn, so it looks like its neighbours without this bundle resolving a package it cannot — and is
  placed with `afterContent: true`, which puts it **after** 归档会话 (Archive) instead of between the
  ordinary actions ([ADR 0011](docs/adr/0011-one-operation-two-callers.md), amendment).

## [0.2.1] - 2026-11-14

- **A deleted session's row is gone at once.** The deletion now asks the workspace registry to *archive* the
  ids it removed, and never to unarchive them: the sidebar draws no archived session, and the registry
  publishes the change to every open window, so the row disappears the moment the call returns — no page
  reload, no restart, no sort switch. Unarchiving was the bug: it belongs to a restore, and it turned the
  hidden row of a deleted session into a visible ungrouped one
  ([ADR 0012](docs/adr/0012-archive-never-unarchive.md), superseding ADR 0009).
- The workspace records are the same for every session now, host-held or not. Whether the host still names
  the session is a fact the answer reports, not a decision it makes.

## [0.2.0] - 2026-11-14

- **Archiving is no longer a precondition.** The store is the index: every session whose log is on disk is
  a candidate, and the archive file is read only to *report* facts — whether a listed session is archived,
  and which archived ids no longer have a directory. Deleting used to take two surfaces (hide the session
  in the sidebar, then name it) and produced a class of refusals nobody could act on; a person can now
  name a session that was never archived and it is removed like any other
  ([ADR 0010](docs/adr/0010-no-archive-precondition.md)).
- The tools are renamed to match what they do: `list_session_logs` and `delete_session_logs`. A listing
  now prints each session's archive state beside its bytes, and the deleting tool's refusals are the three
  a person can act on: the running session, a session whose agent is busy (with the status), and an id
  with no directory left.
- The engine's candidate rule, its reasons, and the deletion-time checks were rewritten with it: the
  archive list is no longer re-read at deletion time, because nothing about a candidate depends on it any
  more. What still guards every candidate is unchanged — the id/path binding, the containment test, the
  refusal to follow a link, and the refusal to touch a directory holding anything but regular files.
- **A human command surface: `/clean`.** The same operation, reachable without the model: `/clean` lists,
  `/clean <id> <id>` deletes, and the wording is identical to the tool's because both end in one
  implementation ([ADR 0011](docs/adr/0011-one-operation-two-callers.md)). It runs through the host's
  command registry, so no turn is started and no tokens are spent deciding what to delete.
- **A row in a session's ⋯ menu: *Delete log*.** A data contribution, not a renderer: the browser half
  supplies the label (in the window's language) and a click, and the click runs that same command for the
  row it was opened on. A window without the menus service loses the row and keeps the view pruning.
- `decodeSegment` is the new inverse of the backend's id escape. It is what lets the store enumerate
  itself: a directory name records its session id completely, `~XXXX` and all.

## [0.1.0] - 2026-11-13

- The deletion engine, which works from two paths it is given — the session storage root and the
  workspace storage file — so every test runs against a fixture. A dry run lists candidates and their
  bytes; a deletion removes the session's own directory and reports what actually left the disk.
- Two model-facing tools: `list_archived_sessions`, which takes no argument and cannot delete, and
  `delete_archived_sessions`, which deletes only the ids it is given by name.
- The listing also reports each log's last write (the newest file's write time) and the size of the whole
  store, so a reclaimable total is judged against what it came from.
- The candidate rule is `global.archivedSessionIds` and nothing else, re-read at deletion time; the
  running session and every live agent's session are protected and reported; symlinked and junctioned
  directories are refused rather than followed; a session directory holding anything but regular files
  is refused rather than removed.
- Every check the listing makes is repeated against the live filesystem at deletion time, including the
  id/path binding and the containment test: a plan naming a path outside the storage root, or a path that
  belongs to another session, is refused — each covered by a test that tampers with a plan to prove it.
- Verification through the mounted `sessionPersistence` service after a deletion, reported and never
  able to veto one. The plugin parses no session format and rewrites no log line.
- A second directory carrying the same session id — a moved cwd, a copied tree — is reported as skipped
  rather than dropped from the count, and the traversal guard is covered by a property test over hostile
  ids: the escape always yields one inert path segment, and an archived id such as `../../outside` is
  reported as already gone without reaching anything outside the store.
- A listing that found nothing to delete no longer ends by inviting a deletion call: the "show this list
  and pass the ids they approve" line appears only when there is something to approve, because telling a
  model to call the deleting tool on an answer that listed none is how a wasted call gets made.
- Refusal reasons no longer restate the decision they are filed under: the answer already prefixes each
  one, so a kept id reads "not an archived session" instead of "not an archived session; kept".
- One test command for both majors: `npm test` runs `scripts/test.mjs`, which chooses the isolation flag
  spelling from the running Node version, so the package script no longer fails on Node 22 while the
  package claims it. CI runs that same command on every leg.
- A refusal for an id that is not archived now says which case it is: the session exists and only needs
  archiving, or nothing is stored under that id at all. Both stay refusals, but only one of them is the
  person's next step, and the answer names it.
- CI runs every leg on Linux, macOS and Windows: a friend may be on any of them, and the engine is
  filesystem code — directory walks, link detection and unlink are exactly where the families differ.
- The install section answers the questions a second person asks: where the clone lives (the profile links
  to it), which command installs it into a desktop profile versus a CLI-owned one, that updating is
  `git pull` plus a restart, and that removing it leaves the store alone.
- The listing stops printing every already-deleted id once there are more than ten: the count is the
  fact, the ids are the detail, and after a fifty-session cleanup the answer is a line instead of a page.
- The two tool descriptions say each fact once — the consent rule lives in the tool description, the
  value rule on the parameter, and the refusal list in the answer — which is 200 characters less text the
  model reads before it can act, measured on the definitions themselves.
- Counts read the way a person writes them: "1 file", "3 files", "1 session directory", "6 session
  directories" instead of the template's `file(s)` and `directory(ies)`.
- A session directory that exists but was refused — it holds a nested directory, or it cannot be read —
  is no longer reported as `already_gone`. The listing used to claim the log had been deleted while it sat
  there taking space, and the store total omitted it; now the id is accounted for by the skipped entry
  that names it, the refusal appears when someone asks for that id by name, and the bytes that could be
  measured are part of the total.
- The listing and the deletion receipt show each session's own title beside its id, read from the
  projection cache the harness already keeps: a list of opaque ids is hard to approve, and the name in
  the sidebar is the handle a person actually has. Read-only, fail-soft — a missing or older cache file
  costs the title and nothing else, and no log is opened to find a name.
- A deletion now asks the workspace registry to detach the ids it removed, so the row leaves the sidebar
  when the call returns instead of at the next restart — the registry keeps a session's place while its
  directory is missing, and only its owner can drop it. The plugin still writes no workspace record: the
  answer reports whether the detach happened, was impossible (no registry mounted) or failed per id, and
  none of that can fail a deletion whose files are already gone ([ADR 0006](docs/adr/0006-detach-by-asking.md)).
- The last holder of a deleted session's row is named, and so is the way out of it: the running window's own
  persisted sidebar view (`localStorage["dsh.workspace.view.v5"]`), which is rewritten from the members the
  window actually has when the sidebar re-orders — **a sort switch or a drag, no restart and no page
  reload**. Measured on this machine: the persisted view went from 11 stale ids to 0, with the buckets
  shrinking by exactly the deleted count ([ADR 0006](docs/adr/0006-detach-by-asking.md), sixth amendment).
- The deletion answer stops claiming more than the detach can do. A live run showed the rows leaving their
  project and reappearing under *ungrouped*: the project records change at once, but an open window keeps
  the session list it fetched and the row leaves only when that list is fetched again — a page reload, not
  a restart. [ADR 0006](docs/adr/0006-detach-by-asking.md) records the second amendment, and the answer,
  README and design say what actually happens.
- The deletion now also asks the registry to **unarchive** the ids it removed. Detaching the project
  membership alone left the rows on screen under *ungrouped*: the client's workspace model holds archived
  Session identities too, and an archived session belonging to no project has no visible list left to be
  hidden from. Restoring a session whose log is gone is the direction the registry documents as supported,
  and both calls are made only for ids whose files are gone ([ADR 0006](docs/adr/0006-detach-by-asking.md),
  third amendment).
- The deletion answer now also reports the host's **session list** (`ctx.sessionQuery`): when it still names
  a deleted id, the answer says so, because that list is what a window draws its rows from and a row can
  outlive the log. It is a report and not a gate, like the persistence check beside it.
- An id whose log is gone is now handled whatever its archive state: naming it in `delete_archived_sessions`
  detaches it from its project, unarchives it when it is still archived, and has the session list asked
  about it — because an earlier deletion can leave a row whose session is no longer archived at all.
- The bundle now carries a **browser half** (`client.js`) that prunes the window's own sidebar view. After
  a deletion, the last thing that could keep a row alive was `localStorage["dsh.workspace.view.v5"]`, which
  the client re-reads on every start and nothing rewrote for a host-side fact. At every page load — and when
  the window regains focus — the half asks the host for the session list and drops the ids a stored view
  kept that the list no longer names, so the row is gone the next time the page loads with nothing to
  click. It imports nothing, writes only when it actually dropped something, treats an unanswerable list
  as nothing to do, and leaves one small mark (`dsh-cleaner.client.v1`) so the pass can be seen from
  outside the page ([ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md)).
- A resident agent no longer blocks a deletion, and a refusal now says which state it saw. The protection
  used to be "any agent the registry lists for that session", which refused a session whose work had
  stopped but whose agent the harness still kept in memory — a refusal a person cannot act on. Now the
  caller is always kept, another session is kept only while its agent's status is something other than
  `idle` (an agent reporting none counts as busy), and the reason carries the status:
  `a live agent holds this session (status: running)` ([ADR 0008](docs/adr/0008-busy-not-resident.md)).
  Verified live: a session reported `status: idle` was deleted — 49,720 bytes, the store going from 30
  directories to 29 — and nothing recreated its log.
- Which workspace record a deletion touches is now decided per id, by asking the host's own session list
  first. A session the host still holds keeps **both** its project membership and its archive entry — the
  sidebar hides an archived row of a project and shows the row of an ungrouped one, so dropping either is
  what made a deleted session hop from *archived under its project* to *visible under ungrouped*. A session
  the host has let go loses both, as before ([ADR 0009](docs/adr/0009-two-records-two-cases.md)).
- Repository checks (`scripts/check.mjs`) and 58 fixture tests, both run by CI with Node 22 and Node 24
  on all three platforms. The browser half is tested by evaluating the same file the page evaluates, so a
  mistake in it fails a test instead of a person's sidebar.
- `SECURITY.md` states what the plugin trusts and the blast radius, because a plugin whose job is
  deletion owes that answer.
- One line carries the plugin wherever a person meets it — the card in the plugin list, both READMEs,
  the package description — and it says the two things the code enforces: the candidate must be
  archived, and nothing in use is touched.
- First live run, recorded because it is this release's evidence: installed into a desktop profile, both
  tools appeared, and the six archived logs on this machine were listed and then deleted through the
  tools — 4,169,349 bytes reclaimed, the mounted persistence backend confirming the removal, and an
  independent directory count agreeing (36 session directories before, 30 after).


