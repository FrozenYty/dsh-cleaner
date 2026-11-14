# Design

How the plugin keeps the promises in the README, and where the promises stop. This is the document to
read before changing the candidate rule, the deletion path or the storage layout.

## 1. What the plugin is

An archive in DeepSeek Harness only hides a session: its log stays on disk. Nothing in the product
removes that log, and the official persistence seam cannot — `@deepseek-ai/dsh-session-persistence`
lists "No deletion or retention API — pruning stored sessions is out-of-band backend maintenance" among
its known limitations, and its JSONL backend says "Nothing deletes session files". This bundle is that
out-of-band maintenance, and it is deliberately small: a listing that cannot delete, and a deletion that
can only delete ids it is given by name.

## 2. The two layers

| Layer | Files | Knows about |
|---|---|---|
| Bundle entry | `index.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg` | the Harness services (`ctx.tools`, `ctx.get`), `DSH_HOME`, and the two tool definitions |
| Deletion engine | `engine.js` | two filesystem paths and nothing else — no Harness import, no environment |
| Browser half | `client.js` | one storage key family in the page (`dsh.workspace.view.*`) and the session list the host serves — no import, no build step |

The engine takes the session storage root and the workspace storage file as arguments. That is what
makes every test a fixture test: the bundle entry is the only place that resolves a path from the
environment, and the tests for it point `DSH_HOME` at their own tree.

The browser half is the plugin's second consumer and its only artifact inside the window. It exists for one
reason: after a deletion the sidebar can keep a row whose session is gone, because that row lives in the
window's own persisted view and no host event rewrites it. The half prunes the stored view against the
session list the host serves, at every page load and when the window regains focus, so the row is gone the
next time the page loads without anyone touching the sidebar — [ADR 0007](adr/0007-browser-half-prunes-the-view.md).
Its rules are deliberately dull: prune only ids the host no longer lists, write only when something was
dropped (plus one small mark under `dsh-cleaner.client.v1`), and treat an unanswerable list as "nothing to
do". It imports nothing, so the page's loader can evaluate the file as it stands, and
`tests/client.test.mjs` drives exactly that file.

The bundle entry imports no `@deepseek-ai` package. A profile-linked bundle resolves bare specifiers
from its own directory, where none is installed, so the import would fail the load — see
[ADR 0002](adr/0002-zero-import-bundle-half.md). Tool definitions are therefore plain canonical JSON
Schema objects, and every service is reached through `ctx`.

## 3. The storage layout it works on

Read from the installed asar, not from memory. The JSONL backend stores one session per directory:

```
<DSH_HOME>/sessions/<project-key>/<encoded-id>/session.vN.jsonl.zstd
```

- **Project key** — a readable transform of the session's `cwd`: `--` around the normalized path, `/`,
  `\` and `:` collapsed to `-`, every other unsafe unit escaped as `~XXXX`, bounded to 251 characters.
  `_no-cwd` when the session has no cwd. The engine never computes one; it scans every project
  directory and matches only the id segment.
- **Encoded id** — the backend's `encodeSegment`: `[A-Za-z0-9._-]` stays literal, every other unit
  (including `~`) becomes `~XXXX`, and `.`/`..` are special-cased. Real harness ids are already safe,
  so the directory name equals the id in practice; the escape only matters for an id that is not. The
  function is reproduced in `engine.js` because a bundle cannot import it.
- **One directory per session, several files inside** — a session may keep an old generation
  (`session.jsonl.zstd`, `session.v3.jsonl.zstd`) beside the current one, and the backend documents the
  directory as available for future session-local artifacts. The deletion unit is therefore the
  directory, not a file, and no session format is parsed to find it.
- **The log is not the whole session.** Images and files a session carried live in a separate
  content-addressed store (`attachments/v1/objects`), shared between sessions; nothing in a session
  directory points at them, and finding a session's references would mean reading its log. That store is
  therefore out of scope by design, not by omission.
- **The projection cache is read for one thing: a title.** `storages/session_projcache/sessions/<id>.json`
  is the runtime's own derived record, and `record.rows.title.val` is the name a person sees in the
  sidebar. The listing shows it beside the id so that "delete the six you listed" can be checked against
  the sessions someone remembers by name — and nothing else is read from it, nothing is written to it, and
  a missing or unreadable file costs the title and nothing more.

The workspace storage file is read-only here, and since [ADR 0010](adr/0010-no-archive-precondition.md) it
is read only to **report**: `global.archivedSessionIds` says whether a listed session is archived and which
archived ids no longer have a directory. It is not a gate. The plugin never writes the file, so a deleted
id stays in that list and becomes an id with no directory, which the listing reports as already gone.

## 4. The candidate state matrix

Selection is driven by the disk, not by the archive list: the engine walks the storage root once and every
session directory it finds is a candidate unless something protects it. `decodeSegment` turns the directory
name back into the session id, which is what makes the store its own index — the escape is injective, so
the name is a complete record of the id.

| Directory state | Protected | Archived | What happens |
|---|---|---|---|
| absent | any | no | not listed as a candidate; if an archived id names it, `already_gone` |
| absent | any | yes | `already_gone`: reported with the id, nothing removed. This is the second-run state. |
| a real directory of regular files | yes | any | `protected`: reported with the reason, kept |
| a real directory of regular files | no | any | `candidate`: listed with its bytes and its archive state; removed when named |
| a link, or a directory holding anything but regular files | any | any | `skipped`: reported with the path and the reason; never entered, never removed — and **not** `already_gone`, because the log is still there |

The archive column is a fact the listing prints, not a decision: an unarchived session is as deletable as
an archived one, and a person reads the flag to know whether that row is already hidden in their sidebar.

Two consequences worth stating: an archived id with no directory is not an error, and a directory this
plugin refuses to touch is not a failure — both are ordinary answers, because a deletion run has to be
able to say "nothing to do" and "I will not touch that" without pretending either is a crash.

The third state is the one that has to be kept apart from the second: "no directory at all" and "a
directory I would not touch" both produce no candidate, and only the first is evidence that the log is
gone. `already_gone` therefore means *the disk holds nothing under that id*, and a refused directory
still contributes the bytes that could be measured to the store total.

`protected` is filled by the bundle entry, not the engine: the Session running the command
(`exec.agent.session.id`) first, because that is the one the contract names, and then every Session whose
agent is **busy** — any status other than `idle`, including an agent that reports none. A resident-but-idle
agent is not a writer, and an archived session cannot start a model step anyway, so it does not block a
deletion ([ADR 0008](adr/0008-busy-not-resident.md)); the refusal carries the status it saw, so a person can
tell "wait for its work" apart from "the harness merely has it loaded".

## 5. The deletion path

1. Resolve the session storage root once (`realpath`). A root that is itself a link is followed to its
   target on purpose; containment is then measured against that target, so nothing escapes it. There is
   no archive read here any more: since [ADR 0010](adr/0010-no-archive-precondition.md) no candidate
   depends on the archive list, and re-reading it would only re-introduce the refusal that rule removed.
2. For each candidate, in order: does the directory name still encode this id (a plan naming someone
   else's path is refused, so the report cannot lie)? `lstat` a real directory (a link is refused)? its
   `realpath` inside the root? every entry directly inside a regular file? Only then: `lstat` each file
   for its size, `unlink` it, and `rmdir` the directory. Why every step is repeated rather than trusted:
   [ADR 0005](adr/0005-re-verify-at-execution.md).
3. Report `removed` (id, path, file count, bytes), `removed_bytes` (measured at unlink time, so it is
   what actually left the disk), `failed` (with the bytes freed before the failure) and `refused` (with
   the reason). One candidate's failure does not abort the sweep. The listing carries two more facts a
   person needs to decide: `modified`, the newest file's write time in each candidate directory, and
   `stored_bytes`, what the whole store holds — a reclaimable number without the total behind it cannot
   be judged.
4. Ask the mounted persistence service whether it still lists the removed ids, and report the answer.
5. Ask the workspace registry to detach the ids that were removed — and any id the caller named whose log
   is gone, archived or not, because a ghost row is exactly what a person is looking at when they name it
   and an earlier deletion may already have unarchived it. The plugin never edits the workspace store:
   `detachSession` runs on the registry's own mutation chain, and the workspace controller's `follow()`
   stream is what carries the durable change to the client. Why this is the one place the plugin touches
   another subsystem's records, and what the alternatives were: [ADR 0006](adr/0006-detach-by-asking.md).
   What this can and cannot do: it changes the project's records at once, so the session leaves its
   project — but a window that is already open keeps the session list it fetched, and the row leaves the
   sidebar only when that list is fetched again. The harness has no "this log is gone" event to publish,
   which is the same absence that makes this plugin necessary.

6. Ask the mounted session query whether it still *lists* those ids, and say so when it does. That list is
   what a window draws its session rows from, and it is a different service from the persistence seam: a
   session can be gone from the store and still be named there, which is why a row can outlive the log. The
   answer reports it instead of promising a screen it cannot see — and the *same* answer decides step 5: an
   id the list still names keeps both its project membership and its archive entry, because the sidebar
   hides an archived row of a project and shows the row of an ungrouped one
   ([ADR 0009](adr/0009-two-records-two-cases.md)).

The last three steps are reports about a deletion that already happened, and none of them can veto one.
The seam cannot delete, so it must not fail a call whose files are gone; a profile without the service, a
read that throws, a registry that is absent and a detach that fails are each described in the answer — and
`verify.backend: 'not-asked'` is what a call that removed nothing answers with, while the detach is still
asked for the ids it was given.

Where the promise stops: the sidebar also renders from a view the window persists for itself
(`localStorage["dsh.workspace.view.v5"]`, a `sessionOrderByAccount` map of account to ordered Session ids),
and it is re-read on every start. The browser half prunes that view against the host's list at every page
load, so a deleted session's row is gone the next time the page loads — no gesture, no restart. What the
plugin still cannot do is take the row off a page that is *already* open: the view lives in the renderer's
own memory once hydrated, nothing in the harness publishes "this log is gone" for it to re-render on, and
reloading somebody's conversation to hide a row would be the worse trade. The heavier manual repair, if a
page must be clean before it loads again, is a sort switch or a drag — measured: 11 stale ids to 0, because
the client then rewrites the view from the members it actually has.

## 6. Why files are unlinked one at a time

`rm -r` on the directory would be shorter. It would also decide, on the plugin's behalf, what to do with
a link that appeared between the listing and the unlink, and that decision differs by platform. Doing
it here means: a non-regular entry stops the removal and is reported, a link is never traversed, and the
bytes reported are the bytes measured on the files that were actually removed. A candidate whose files
are partly gone is reported as `failed` with the bytes freed, and the next run finds the rest. See
[ADR 0004](adr/0004-refuse-links.md).

## 7. What the checks and the tests can prove

| Layer | Proves | Cannot prove |
|---|---|---|
| `scripts/check.mjs` | the manifest, the published file set, the dependency surface, the schema keywords, the locale pair, the patch, every document citation | that the plugin activates |
| `tests/*.test.mjs` | the candidate matrix, the deletion path, the protections, the link and irregular-directory refusals, the idempotent second run, and the two tool wrappers | that the Host accepts the definitions, or that a live call reaches them |
| the installed Host validator (`dsh-tools`, run by hand against a fixture) | that both output schemas pass the assertion `tools.register()` runs, that both parameter schemas are object-rooted, and that both real results satisfy the schema they declare | that a profile registers, assembles a prompt and calls the tool |
| a live install | the tool list, a real listing, a real deletion | that the deletion was wise |

The fixture tests never touch a real `DSH_HOME`: the engine takes paths, and the entry tests point
`DSH_HOME` at their own tree. A dry run against the real store is a manual, deliberate act.

One asymmetry is worth knowing: `tools.register()` asserts the **output** schema before the tool exists,
and a call's arguments are validated against the **parameter** schema at dispatch, but the parameter
schema's keyword subset is not asserted at load — a raw parameter object is projected straight to the
model. `scripts/check.mjs` is what covers that half.

## 8. Failure modes

- **The backend changes its storage layout or its id escaping.** The store stops yielding candidates:
  the listing reports `0 candidates` with a non-zero store, and every archived id as `already_gone`. Safe
  — nothing is deleted — and visible in the answer, but silent in the sense that no error is raised. This
  is the one coupling to another package in the repository.
- **A session directory gains a nested directory.** It is refused and reported rather than removed, the
  listing says why, and the id is not called `already_gone`: the log is still on disk. A human decides
  what it is.
- **A session directory cannot be read.** Permissions, a broken ACL, a restored backup. Same answer as
  the previous case — `skipped` with the reason, never `already_gone`, never a candidate — except that
  nothing could be measured, so the store total does not include it. The skipped line is the only part of
  the answer that knows the directory exists, which is why it is printed rather than counted.
- **Two deletions run at once.** The second finds the files gone or unlink fails; both are reported, and
  nothing outside the candidate set is touched.
- **The workspace file is corrupt.** A listing or a deletion throws before removing anything: the archive
  flag and the `already_gone` list come from that file, and a file that exists but cannot be read is an
  error rather than "nothing is archived".
- **A session id has two directories** — a moved cwd, a copied tree, a restored backup. The scan keeps
  one as the candidate and reports the other as skipped, so the store total is not silently short;
  deleting the reported one makes the other a candidate on the next run.
- **The workspace registry is absent, or refuses a detach.** The files are already gone, so the answer
  reports which of the three happened and the sidebar row clears at the next refresh instead of at once.
  Nothing about the deletion itself depends on that call — [ADR 0006](adr/0006-detach-by-asking.md).
- **`DSH_HOME` names the wrong store.** The listing prints both paths it used, so the mistake is visible
  in the answer before anyone approves a deletion.
- **The projection cache keeps a stale row, or changes its shape.** Per-session projections under
  `storages/session_projcache/` are derived data owned by another subsystem; this plugin reads one row for
  a title and never writes anything. A deleted session may keep a stale row and its cache file until the
  runtime rewrites or drops it, and a record version that moves the title costs the listing its titles and
  nothing else — no candidate, byte count or refusal depends on that file.
