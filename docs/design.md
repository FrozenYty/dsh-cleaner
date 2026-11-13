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

The engine takes the session storage root and the workspace storage file as arguments. That is what
makes every test a fixture test: the bundle entry is the only place that resolves a path from the
environment, and the tests for it point `DSH_HOME` at their own tree.

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

The workspace storage file is read-only here: `global.archivedSessionIds` is the only field this plugin
reads, and the plugin never writes the file. A deleted id stays in that list and becomes an id with no
directory, which the listing reports as already gone.

## 4. The candidate state matrix

Selection is driven by the archive list, not by the disk: the engine walks the disk once to build a map
of session directories, then looks up **only the archived ids**. An unarchived session is not filtered
out — it is never a candidate by construction, because nothing looks it up.

| Archived | Directory state | Protected | What happens |
|---|---|---|---|
| no | any | any | never considered; not even listed |
| yes | absent | any | `already_gone`: reported with the id, nothing removed. This is the second-run state. |
| yes | a real directory of regular files | yes | `protected`: reported with the reason, kept |
| yes | a real directory of regular files | no | `candidate`: listed with its bytes; removed when named |
| yes | a link, or a directory holding anything but regular files | any | `skipped`: reported with the path and the reason; never entered, never removed |

Two consequences worth stating: an archived id with no directory is not an error, and a directory this
plugin refuses to touch is not a failure — both are ordinary answers, because a deletion run has to be
able to say "nothing to do" and "I will not touch that" without pretending either is a crash.

`protected` is filled by the bundle entry, not the engine: the Session running the command
(`exec.agent.session.id`) and every Session a live agent holds (`ctx.agents.list()`). The caller is
first, because that is the one the contract names.

## 5. The deletion path

1. Re-read `global.archivedSessionIds`. The plan is a description of the past; this is the deliberate
   act, and an id restored between the listing and now must survive it. A workspace file that cannot be
   read or parsed throws here, before anything is removed.
2. Resolve the session storage root once (`realpath`). A root that is itself a link is followed to its
   target on purpose; containment is then measured against that target, so nothing escapes it.
3. For each candidate, in order: still archived? does the directory name still encode this id (a plan
   naming someone else's path is refused, so the report cannot lie)? `lstat` a real directory (a link is
   refused)? its `realpath` inside the root? every entry directly inside a regular file? Only then:
   `lstat` each file for its size, `unlink` it, and `rmdir` the directory.
4. Report `removed` (id, path, file count, bytes), `removed_bytes` (measured at unlink time, so it is
   what actually left the disk), `failed` (with the bytes freed before the failure) and `refused` (with
   the reason). One candidate's failure does not abort the sweep. The listing carries two more facts a
   person needs to decide: `modified`, the newest file's write time in each candidate directory, and
   `stored_bytes`, what the whole store holds — a reclaimable number without the total behind it cannot
   be judged.
5. Ask the mounted persistence service whether it still lists the removed ids, and report the answer.

The last step is the only use this plugin makes of the seam. It is a report and not a gate: the seam
cannot delete, so it must not be able to veto a deletion either. A profile without the service, or a
backend read that throws, is described in the answer; neither fails a call whose files are already gone.

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

## 8. Failure modes

- **The backend changes its storage layout or its id escaping.** Archived ids stop matching directory
  names: the listing reports `0 candidates`, every archived id as `already_gone`, and `stored_sessions`
  greater than zero. Safe — nothing is deleted — and visible in the answer, but silent in the sense that
  no error is raised. This is the one coupling to another package in the repository.
- **A session directory gains a nested directory.** It is refused and reported rather than removed, and
  the listing says why. A human decides what it is.
- **Two deletions run at once.** The second finds the files gone or unlink fails; both are reported, and
  nothing outside the candidate set is touched.
- **The workspace file is corrupt.** Listing and deletion throw before removing anything.
- **A session id has two directories** — a moved cwd, a copied tree, a restored backup. The scan keeps
  one as the candidate and reports the other as skipped, so the store total is not silently short;
  deleting the reported one makes the other a candidate on the next run.
- **`DSH_HOME` names the wrong store.** The listing prints both paths it used, so the mistake is visible
  in the answer before anyone approves a deletion.
- **The projection cache keeps a stale row.** Per-session projections under
  `storages/session_projcache/` are derived data owned by another subsystem; this plugin does not touch
  them, and the runtime rewrites or drops them.
