# dsh-cleaner

English | [中文](README-zh.md)

[![ci](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)
![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-blue)

> Deletes archived logs, never a live session.

A DeepSeek Harness profile bundle for the one thing the product does not do: remove an archived
session's log. It lists what is still on disk, waits while a person decides, deletes exactly the ids
they approve, and reports the bytes reclaimed. No schedule, no age threshold, no background sweep.

[github.com/FrozenYty/dsh-cleaner](https://github.com/FrozenYty/dsh-cleaner)

## Status

- Current version: v0.1.0.
- **Exercised in a real profile on this machine** (2026-11-13): installed from this directory, both
  tools appeared, `list_archived_sessions` reported the six archived logs, and `delete_archived_sessions`
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
| list | `list_archived_sessions` | Lists the archived sessions whose logs are still on disk, with each one's bytes. No argument, no side effect — calling it can never be a mistake. |
| confirm | — | The person reads the list and approves ids. Nothing happens during this step. |
| delete | `delete_archived_sessions` | Takes the approved ids by name, removes those session directories, and reports the bytes reclaimed. |

`delete_archived_sessions` requires the ids, so nothing is ever deleted by default and a subset can be
approved. It refuses, and reports instead of failing:

- a session that is not archived, and one archived but no longer on disk;
- the session running the command, and any session a live agent holds;
- a session restored between the listing and the deletion — the archive list is re-read at deletion
  time, not trusted from the listing.

## Install

Installing is the person's decision, not the bundle's:

```sh
dsh plugin --profile <profile> add /path/to/dsh-cleaner
```

There is no build step, no dependency and no install script: `index.js` and `engine.js` use only
`node:` builtins and each other. Installing links this working tree into the profile; what runs is this
directory.

## First use

There is no interface to open: you ask in ordinary language and the model calls the tools. One real
exchange, from the rehearsal above:

```
> Which archived sessions are still taking space?

list_archived_sessions {}
← Archived session logs on disk: 6 of 6 archived ids, 4169349 bytes (3.98 MiB).
  The session store holds 36 directories, 91902898 bytes (87.65 MiB) in all.
    session-36560858-…  182051 bytes (177.8 KiB)  3 file(s)  last write 2026-11-02T07:39:15.053Z
    session-177a4f1f-…  2475067 bytes (2.36 MiB)  1 file(s)  last write 2026-11-03T02:14:07.060Z
    …
  Nothing was deleted. Show this list to the person and call delete_archived_sessions with the ids
  they approve.

> Delete the six you listed. Keep nothing.

delete_archived_sessions { session_ids: ["session-36560858-…", "session-177a4f1f-…", …] }
← Deleted 6 session directory(ies): 4169349 bytes (3.98 MiB) reclaimed.
  The session persistence backend no longer lists any of them.
```

## What it never does

- Never touches an unarchived session. The only ids it can delete come from
  `global.archivedSessionIds` in the workspace storage file, and the engine looks up only those ids —
  an unarchived session is not filtered out, it is never a candidate by construction.
- Never touches the session executing the command, or one a live agent is using.
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
- `<DSH_HOME>/storages/workspace.json` — read only, for `global.archivedSessionIds`.

The workspace file is never written. A deleted id stays in the archive list; it is simply an id with
no directory, which the listing reports as already gone.

## What it does not do

- **No unarchive, no re-archive, no pinning.** It removes logs and nothing else; the archive list and
  the workspace records belong to the harness.
- **No projection cache eviction.** The harness keeps per-session projections under
  `storages/session_projcache/`, and this plugin does not touch them: a deleted session may keep a
  stale row and its cache file until the runtime rewrites or drops it. Derived data, self-healing, and
  owned by another subsystem — and deliberately not a third path for the engine to be wrong about.
- **No attachment cleanup.** Images and files a session carried live in a content-addressed store
  (`attachments/v1/objects`), not in the session directory: one object can belong to several sessions,
  and finding a session's references would mean parsing its log, which this plugin refuses to do. That
  store is 54 MiB on the machine this was written on, and it is left alone.
- **No schedule, no retention policy, no size cap.** Deleting is a decision, not a rule.
- **No proof that a person approved the list.** The ids make the approved set explicit in the
  conversation and the refusals bound the damage, but a model could still name an id nobody looked at.
  See [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md).
- **No log repair.** A corrupt or unreadable log is still deleted when its session is archived: this
  plugin is the cleanup path of last resort, so it must not depend on the log being parseable.

## Where this fits

Three ways to make a session's log go away, and what each one actually refuses to do. The middle column
was read from `dsh-session-cleaner` v1.0.2's published code, not from its summary.

| | this plugin | `dsh-session-cleaner` | doing it by hand |
|---|---|---|---|
| surface | two model-facing tools | a web UI menu item and an HTTP route | a shell |
| what it will delete | archived ids only, named by a person | any session with no attached agent | whatever the glob matches |
| the running session | refused by id, always | refused while its agent is running | not refused — the glob does not know |
| what it reports | candidates, bytes, last write, store total, per-id result | detach / workspace / file counts | nothing |
| writes the workspace records | never | yes, it detaches the session | no |
| survives a wrong id | refuses it and says why | n/a — it takes one id from a menu | deletes the wrong session |

Neither tool is a superset of the other: `dsh-session-cleaner` deletes *any* session and cleans up the
workspace records, which is what a person clicking a menu item wants. This plugin deletes only what is
already hidden, and its whole design is about being unable to delete anything else.

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
No. The candidate set is the archive list, looked up by id: an unarchived session is never looked up,
not merely filtered out.

**Why does the listing show a last-write time?**
It is the newest file's write time in that session directory — the last time the session appended
anything. That is the fact that turns "delete all six" into a decision: of the six listed here, the
oldest last wrote on 2026-11-02 and the newest on 2026-11-12, and nothing else in the output separates
them.

**How does it know how big the store is?**
It walks every project directory under `sessions/` once per listing. That walk is also what makes an
archived id with no directory visible as `already_gone`, which is the state a second run finds.

## Compatibility

- **DSH**: verified against the installed `0.2.2-rc.1` desktop build. The storage layout and the id
  escaping in `engine.js` were read from that build's `app.asar`
  (`@deepseek-ai/dsh-session-persistence` and its JSONL backend), not from memory. A later build that
  renames either is the one change this plugin cannot absorb by itself — and it fails safely: zero
  candidates, every archived id reported as already gone (`docs/design.md` §8).
- **Session format**: one directory per session with `session.vN.jsonl.zstd` generations inside. No
  format is parsed, so every released generation, and any later one, is covered by construction.
- **Node**: `^22.19.0 || >=24.0.0`. CI runs the suite on both majors and both platforms; the
  isolation flag differs between them (`--test-isolation=none` on 24, which is what the local runner
  uses, and `--experimental-test-isolation=none` on 22).

## Security

What the plugin trusts, what it can be made to delete, and what it cannot touch:
[SECURITY.md](SECURITY.md).

## Verify

```sh
node scripts/check.mjs                              # manifest, dependency surface, schemas, locales, patch, documents
node --check index.js                               # the bundle entry parses as ESM
node --check engine.js
node --test --test-isolation=none tests/*.test.mjs  # the fixture tests, one process on purpose
```

`--test-isolation=none` is required on this machine: the default runner spawns one process per file and
the sandbox refuses that spawn. It is also the Node 24 spelling; Node 22 names it
`--experimental-test-isolation`. CI runs the suite on both majors and both platforms, so the flag
spelling and the platform are each covered by a green run rather than by a claim.

No test touches a real `DSH_HOME`. The engine takes the session storage root and the workspace storage
file as arguments, every engine test passes fixture paths, and the entry tests point `DSH_HOME` at a
fixture. A dry run against the real store is a separate, deliberate act:

```sh
node -e "import('./engine.js').then(async (m) => console.log(JSON.stringify(await m.planCleanup({
  sessionsRoot: process.env.DSH_HOME + '/sessions',
  workspaceFile: process.env.DSH_HOME + '/storages/workspace.json',
}), null, 2)))"
```

`planCleanup` only reads: it is safe to run at any time, and it is the same call `list_archived_sessions`
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
| What did each release contain? | [CHANGELOG.md](CHANGELOG.md) |
| What can it be made to delete, and what does it trust? | [SECURITY.md](SECURITY.md) |
| How do we branch, commit and merge? | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What are an assistant's rules here? | [AGENTS.md](AGENTS.md) |
