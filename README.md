# dsh-cleaner

English | [中文](README-zh.md)

[![ci](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)
![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-blue)

> Deletes stored logs, never a live session.

A DeepSeek Harness profile bundle for the one thing the product does not do: remove a session's log. It
lists what is still on disk, waits while a person decides, deletes exactly the ids they approve, and
reports the bytes reclaimed. No schedule, no age threshold, no background sweep, and **no need to archive
first** — archiving is how the sidebar hides a session, not a permission to delete one.

[github.com/FrozenYty/dsh-cleaner](https://github.com/FrozenYty/dsh-cleaner)

## Status

- Current version: v0.2.4.
- **Exercised in a real profile on this machine** (2026-11-13): installed from this directory, both
  tools appeared, `list_session_logs` reported the six logs, and `delete_session_logs`
  removed exactly those six directories — 4,169,349 bytes reclaimed, 0 failed, 0 refused. The mounted
  `sessionPersistence` backend confirmed it no longer lists them, a second listing reported zero
  candidates with all six explained as already gone, and an independent directory count agreed: 36
  session directories before, 30 after, with the running session untouched.
- **Checked with the Host's own schema validator**, taken out of the installed `0.2.2-rc.1` asar: both
  output schemas pass `assertSupportedJsonSchema`, the check `tools.register()` runs before a tool exists
  at all; both parameter schemas pass the stricter object-root assertion and accept exactly the argument
  shapes the tools document (an invented argument, a string where an array belongs, or a missing required
  field is rejected); and both real results pass `validateJsonSchemaValue` against the output schema they
  declare. The schema check alone is not activation — the live run above is what proves that.
- **Not covered yet**: a deletion that fails partway, a link inside a real session directory, and a
  Harness build whose storage layout differs from `0.2.2-rc.1`. The first two are fixture-tested; the
  third fails safely (zero candidates) and is described in [docs/design.md](docs/design.md) §8.
- `scripts/check.mjs` never loads the Harness, and it is not meant to: activation is what a profile
  shows, not what a repository can prove.
- Release list: [CHANGELOG.md](CHANGELOG.md). Mechanism and state matrix:
  [docs/design.md](docs/design.md). Decisions: [the ADRs](docs/adr/).

## The contract

Archiving a session in DeepSeek Harness only hides it: the log stays on disk forever. Nothing in the
product removes it, and the official persistence seam cannot — `@deepseek-ai/dsh-session-persistence`
documents "No deletion or retention API — pruning stored sessions is out-of-band backend maintenance"
as a known limitation, and its JSONL backend states it plainly: "Nothing deletes session files — logs
accumulate under root until removed externally." This bundle is that external removal, and it obeys one
rule:

**Deletion is an act somebody asked for, never a schedule.** There is no timer, no interval, no age
threshold and no background sweep in this plugin, and a profile cannot configure one into it. Removal
happens only inside a tool call, after a person has seen the list.

The two tools are the three steps:

| Step | Tool | What it does |
|---|---|---|
| list | `list_session_logs` | Lists the sessions whose logs are on disk, with each one's bytes, file count, last write and whether it is archived. No argument, no side effect — calling it can never be a mistake. |
| confirm | — | The person reads the list and approves ids. Nothing happens during this step. |
| delete | `delete_session_logs` | Takes the approved ids by name, removes those session directories, and reports the bytes reclaimed. |

`delete_session_logs` requires the ids, so nothing is ever deleted by default and a subset can be
approved. Archived and unarchived sessions are both deletable; what it refuses, and reports instead of
failing, is:

- the session running the command, and any session whose agent is **busy** (the refusal names the status);
- an id that is no longer on disk;
- a session directory the plugin will not touch: a link, or one holding anything but regular files.

The same operation is a **human command**, so a deletion does not need a model turn. Its name is `clean`,
and it is typed with a leading slash:

```
/clean                     → the listing, as text in the transcript
/clean <id> <id> …         → deletes exactly those, and reports the bytes
```

It runs through the host's command registry (`ctx.remote.commands.execute`), which resolves the command
and runs it *without* sending anything to the model: no turn, no request, no context window spent on a
decision you have already made. Both callers end in one implementation, so a person typing and a model
calling cannot disagree ([ADR 0011](docs/adr/0011-one-operation-two-callers.md)).

A session's own **⋯ menu** carries the same thing as one row — *删除会话* / *Delete session*, in the window's
language, drawn in red with the product's own trash glyph, sorted last of every session action, with
**Ctrl+Shift+D** (⌘⇧D) printed beside it. That key deletes the session the window is looking at, and it is a
real binding in the product's shortcut table: it shows up in the shortcut settings and can be remapped
there. It is a data contribution to the menu, not a renderer: the bundle supplies the label, the icon key,
the key and the click, and the sidebar draws it like its own actions. The row appears only when the host
really has the `clean` command — the window half reloads with the page and the host half only with the
process, and a row whose command the host has never heard of turns a click into ordinary text, which reads
as a failure that never happened.

## Install

The profile links to a directory, so the clone is what runs — put it somewhere it can stay:

```sh
git clone https://github.com/FrozenYty/dsh-cleaner.git ~/code/dsh-cleaner
```

Then install that absolute path into the profile you use. In the desktop app, ask for it: the model calls
`plugin_manager` with `install_bundle` and the path — the route this repository was verified with. A
profile the CLI owns (`web`, `headless`, `sdk`) takes the same path through `dsh plugin`, which forwards
to pnpm:

```sh
dsh plugin --profile web add ~/code/dsh-cleaner
```

There is no build step, no dependency and no install script: `index.js` and `engine.js` use only `node:`
builtins and each other.

**Updating** is `git pull` in that clone and a restart of the app: the host reads the bundle when it
starts, so a running window keeps the code it loaded. **Removing** is `plugin_manager` with
`remove_bundle`, or `dsh plugin --profile <name> remove dsh-cleaner` on a CLI profile; the clone, the
store, and every deletion already made are untouched.

After installing, the card in the plugin list reads **Cleaner** — `Deletes stored logs, never a live
session.` If the card is there with its switch on, the bundle loaded.

## First use

There is no interface to open: you ask in ordinary language and the model calls the tools. One real
exchange, from the live run recorded in [Status](#status):

```
> Which sessions are still taking space?

list_session_logs {}
← Session logs on disk: 6, 4169349 bytes (3.98 MiB) (6 of them archived).
  The session store holds 36 directories, 94607680 bytes (90.22 MiB) in all.
    "导入 Claude Code 聊天记录"  session-36560858-…  182051 bytes (177.8 KiB)  3 files  archived  last write 2026-11-02T07:39:15.053Z
    "询问模型身份"  session-177a4f1f-…  2475067 bytes (2.36 MiB)  1 file  archived  last write 2026-11-03T02:14:07.060Z    …
  Nothing was deleted. Show this list to the person and call delete_session_logs with the ids
  they approve — archived or not.

> Delete the six you listed. Keep nothing.

delete_session_logs { session_ids: ["session-36560858-…", "session-177a4f1f-…", …] }
← Deleted 6 session directories: 4169349 bytes (3.98 MiB) reclaimed.
    "导入 Claude Code 聊天记录"  session-36560858-…  182051 bytes (177.8 KiB)  3 files    …
  The workspace records dropped them (6 detached): an archived session is hidden by the sidebar, so
  the rows are gone from every open window without a reload.
  The session persistence backend no longer lists any of them.
```

## What it never does

- Never touches a session that is running the command, or one whose agent is **busy** — the refusal names
  the status, so "wait for its work" is distinguishable from "the plugin refused for a reason you cannot
  see". An agent the host merely keeps in memory does not block a deletion
  ([ADR 0008](docs/adr/0008-busy-not-resident.md)).
- Never deletes anything nobody named. The store is the index — every session whose log is on disk is a
  candidate, archived or not — and the deleting tool only ever receives ids the listing printed.
- Never follows a link. Symlinked project and session directories are skipped rather than entered, a
  session directory holding anything but regular files is refused and reported rather than removed,
  every candidate is resolved under the session storage root before a byte is unlinked, and files are
  unlinked one at a time instead of handing a recursive delete a whole tree.
- Never opens a session log, reads an event or rewrites a line. The unit of removal is the session's
  own directory, whole — no session format is parsed, so no future format can be misread.

## Where it works

`DSH_HOME` (default `~/.dsh`), and under it the two paths the engine takes as arguments:

- `<DSH_HOME>/sessions/<project-key>/<session-id>/` — the session's own directory, as
  `dsh-session-persistence-jsonl` lays it out (`session.vN.jsonl.zstd` generations inside it). The
  directory name is the backend's own escaping of the id, reproduced in `engine.js`; every generation
  in the directory is part of the same session and goes with it.
- `<DSH_HOME>/storages/workspace.json` — read only, for `global.archivedSessionIds`: the archive flag a
  listing shows, and the ids an earlier deletion may have left behind. It is not a gate — a session
  without an archive entry is a candidate like any other.
- `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` — read only, for one row: the session's
  title, shown beside the id so a list of ids can be matched against the sessions someone remembers by
  name. A missing, older or unreadable file costs the title and changes nothing else.

The workspace file is never written, and neither is the project's session list: the plugin **asks** the
registry to detach the deleted ids from their project and to archive them, which is what makes the row go
away ([ADR 0006](docs/adr/0006-detach-by-asking.md)). Archiving is the lever, not a tidiness step: the
sidebar draws no archived session, and the registry publishes the change to every open window, so **the row
disappears at once — no reload, no restart, no sort switch**
([ADR 0012](docs/adr/0012-archive-never-unarchive.md)). Never unarchiving is the point: that call belongs
to a restore, and it is what used to put a deleted session's row back on screen. The one copy no host event
reaches is the window's own persisted sidebar view, and the bundle's browser half prunes it at every page
load ([ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md)).

## What it does not do

- **No unarchive, no re-archive, no pinning.** It removes logs and nothing else, then asks for the two
  record changes that make the row disappear: detach it from its project, archive it. The second one is
  why a deletion needs no reload — an archived session is never drawn
  ([ADR 0012](docs/adr/0012-archive-never-unarchive.md)). The plugin writes no workspace record itself
  ([ADR 0006](docs/adr/0006-detach-by-asking.md)).
- **Never a session whose work is running.** The session executing the command is always kept, and so is
  any session whose agent is busy; the refusal names the status (`a live agent holds this session (status:
  running)`) so the reason is something to act on. An agent that is merely resident — archived work has
  stopped, the harness still keeps the object in memory — does not block the deletion
  ([ADR 0008](docs/adr/0008-busy-not-resident.md)).
- **No projection cache eviction.** The harness keeps per-session projections under
  `storages/session_projcache/`, and this plugin reads one row from them — the title it shows beside an
  id — and writes nothing: a deleted session may keep a stale row and its cache file until the runtime
  rewrites or drops it. Derived data, self-healing, and cheaper than parsing a log to find a name.
- **No attachment cleanup.** Images and files a session carried live in a content-addressed store
  (`attachments/v1/objects`), not in the session directory: one object can belong to several sessions,
  and finding a session's references would mean parsing its log, which this plugin refuses to do. That
  store is 54 MiB on the machine this was written on, and it is left alone.
- **No schedule, no retention policy, no size cap.** Deleting is a decision, not a rule.
- **No proof that a person approved the list.** The ids make the approved set explicit in the
  conversation and the refusals bound the damage, but a model could still name an id nobody looked at.
  See [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md).
- **No log repair.** A corrupt or unreadable log is still deleted when its session is named: this
  plugin is the cleanup path of last resort, so it must not depend on the log being parseable.

## Where this fits

Three ways to make a session's log go away, and what each one actually refuses to do. The middle column
was read from `dsh-session-cleaner` v1.0.2's published code, not from its summary.

| | this plugin | `dsh-session-cleaner` | doing it by hand |
|---|---|---|---|
| surface | two model-facing tools | a web UI menu item and an HTTP route | a shell |
| what it will delete | any session log on disk, named by a person | any session with no attached agent | whatever the glob matches |
| the running session | refused by id, always | refused while its agent is running | not refused — the glob does not know |
| what it reports | candidates, bytes, last write, store total, per-id result | detach / workspace / file counts | nothing |
| writes the workspace records | asks the registry to detach the deleted session; never edits the store | yes, it detaches the session | no |
| survives a wrong id | refuses it and says why | n/a — it takes one id from a menu | deletes the wrong session |

Neither tool is a superset of the other: `dsh-session-cleaner` reaches its deletion through a menu item
and an HTTP route, so a person clicks instead of naming ids. This plugin's whole design is about being
unable to delete anything nobody printed in a listing — and since v0.2.0 it does delete unarchived
sessions too, so the "already hidden" restriction is gone from the list of differences.

## Questions

**I archived a session by mistake — is it gone?**
Not until something is deleted. This plugin never writes the archive list, so unarchiving still works
while the files are there, and a session restored between the listing and the deletion is refused by
name.

**Does it work while the harness is running?**
Yes: it reads the workspace file and unlinks session directories, and holds no handle to the session
store. The session running the command is always refused, and so is any session a live agent holds. A
deleted session's row may linger in the UI until the runtime refreshes — see the projection cache note
above.

**Will it delete sessions that are not archived?**
Yes. Archiving is the product's way to hide a session, not this plugin's permission to delete one: the
store is the index, so an unarchived session is a candidate and can be deleted by id like any other. The
listing shows each session's archive state because it tells you whether the row is already hidden.

**Can a deletion be undone?**
No. Each session's directory is unlinked file by file, and there is no trash to restore from: the
workspace record stays, but the log behind it does not. That is the whole reason the surface is "list,
then name ids" — the listing is the only preview there is.

**Why does the listing show a last-write time?**
It is the newest file's write time in that session directory — the last time the session appended
anything. That is the fact that turns "delete all six" into a decision: of the six in the exchange
above, the oldest last wrote on 2026-11-02 and the newest on 2026-11-12, and nothing else in the output
separates them.

**Where does the title in the listing come from?**
The projection cache the harness keeps beside the store — the same name the sidebar shows. It is read
from that file and never written, no log is opened to find it, and a session without one is listed by id
alone.

**How does it know how big the store is?**
It walks every project directory under `sessions/` once per listing. That walk is also what makes an
archived id with no directory visible as `already_gone`, which is the state a second run finds.

## Troubleshooting

**The model does not offer the tool.**
The bundle is not loaded in this profile. The plugins page should show the **Cleaner** card and the
profile's `package.json` should list `dsh-cleaner`; if both are true and the tools are still missing,
restart the app — a window keeps the plugin list it booted with.

**It lists nothing, and the disk is still full.**
The listing reports the size of the whole store next to what it found: nothing listed against a 90 MiB
store means the sessions are gone and the space is held by something this plugin does not remove — the
projection cache and the attachment store.

**A refusal names a reason I do not understand.**
The reasons are: `a live agent holds this session (status: …)` — its work is still running, so wait for
it; `no session directory is stored under that id` — a second call with the same ids, or a session
deleted from another window; and `its directory is not a candidate: …`, where the reason after the colon
names the shape this plugin refuses to touch (a link, or a directory holding something that is not a
file).

**A deletion says `Partially removed`.**
A file could not be unlinked — usually a lock held by an indexer or an antivirus. The answer names the file
and the bytes freed so far, the directory stays, and the id is still a candidate, so the same call can
simply be run again.

**The card still shows an older description after an update.**
The host reads the bundle when it starts: `git pull` updates the files, but a running window keeps the code
and the locale it loaded. Restart.

**A deleted session is still in the sidebar.**
It should not be: the plugin archives the session as part of the deletion, and the sidebar never draws an
archived session, so the row goes the moment the registry change reaches the window — that is a live
stream, not a reload. What is left is a record, not a row: the archive set names an id with no directory,
which the listing reports as `already_gone`, and which appears only if you switch the archived filter to
*show* or *only*. If a row really is still drawn, the window kept a copy from before the change: a page
load also prunes the window's own persisted view, and a restart rebuilds the client's session list. One
case is stated rather than fixed: a session the host still holds in memory keeps its *name* in that list
until the host releases it (a restart does; no plugin API can), and the answer says so when it happens
(`the host holds that session in memory`).

## Compatibility

- **DSH**: verified against the installed `0.2.2-rc.1` desktop build. The storage layout and the id
  escaping in `engine.js` were read from that build's `app.asar`
  (`@deepseek-ai/dsh-session-persistence` and its JSONL backend), not from memory. A later build that
  renames either is the one change this plugin cannot absorb by itself — and it fails safely: zero
  candidates, every archived id reported as already gone (`docs/design.md` §8).
- **Session format**: one directory per session with `session.vN.jsonl.zstd` generations inside. No
  format is parsed, so every released generation, and any later one, is covered by construction.
- **Node**: `^22.19.0 || >=24.0.0`. CI runs `npm test` on both majors and all three platforms (Linux,
  macOS, Windows); the flag that puts the suites in one process is spelled per major, and
  `scripts/test.mjs` chooses it from the running version, so the same command works on each.

## Security

What the plugin trusts, what it can be made to delete, and what it cannot touch:
[SECURITY.md](SECURITY.md).

## Verify

```sh
node scripts/check.mjs     # manifest, dependency surface, schemas, locales, patch, documents
node --check index.js      # the bundle entry parses as ESM
node --check engine.js
npm test                   # the fixture tests, one process on purpose
```

The suites share one process deliberately: the default runner spawns one process per test file, and a
confined sandbox refuses that spawn. Node 24 spells the flag `--test-isolation`, Node 22
`--experimental-test-isolation`, so `scripts/test.mjs` picks the spelling for the running major rather
than repeating it in package.json, CI and here. CI runs that same `npm test` on both majors and all
three platforms, which is what makes the spelling and the platform green rather than claimed.

No test touches a real `DSH_HOME`. The engine takes the session storage root and the workspace storage
file as arguments, every engine test passes fixture paths, and the entry tests point `DSH_HOME` at a
fixture. A dry run against the real store is a separate, deliberate act:

```sh
node -e "import('./engine.js').then(async (m) => console.log(JSON.stringify(await m.planCleanup({
  sessionsRoot: process.env.DSH_HOME + '/sessions',
  workspaceFile: process.env.DSH_HOME + '/storages/workspace.json',
}), null, 2)))"
```

`planCleanup` only reads: it is safe to run at any time, and it is the same call `list_session_logs`
makes. It never deletes; `applyCleanup` is the only function that does.

## Documents

| Question | Document |
|---|---|
| What does the plugin promise, and how do I install it? | this README |
| How does it keep those promises, and what is a candidate? | [docs/design.md](docs/design.md) |
| Why is removal out-of-band, and what does the seam provide? | [ADR 0001](docs/adr/0001-out-of-band-deletion.md) |
| Why does the bundle half import nothing? | [ADR 0002](docs/adr/0002-zero-import-bundle-half.md) |
| Why two tools, and why explicit ids? | [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md) |
| Why are links and irregular directories refused? | [ADR 0004](docs/adr/0004-refuse-links.md) |
| Why is a plan checked again when it is executed? | [ADR 0005](docs/adr/0005-re-verify-at-execution.md) |
| Why does it detach a deleted session instead of editing the workspace file? | [ADR 0006](docs/adr/0006-detach-by-asking.md) |
| Why does the bundle carry a browser half? | [ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md) |
| Why does a busy agent block a deletion, and a resident one not? | [ADR 0008](docs/adr/0008-busy-not-resident.md) |
| Which workspace records does a deletion touch? | [ADR 0009](docs/adr/0009-two-records-two-cases.md) (superseded) |
| Why does a deleted row disappear at once? | [ADR 0012](docs/adr/0012-archive-never-unarchive.md) |
| Why is archiving not a precondition? | [ADR 0010](docs/adr/0010-no-archive-precondition.md) |
| Why is there a command as well as a tool? | [ADR 0011](docs/adr/0011-one-operation-two-callers.md) |
| What did each release contain? | [CHANGELOG.md](CHANGELOG.md) |
| What can it be made to delete, and what does it trust? | [SECURITY.md](SECURITY.md) |
| How do we branch, commit and merge? | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What are an assistant's rules here? | [AGENTS.md](AGENTS.md) |
