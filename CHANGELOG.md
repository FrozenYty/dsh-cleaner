# Changelog

What each released version of this bundle contained, newest first, in the shape
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) describes: one dated section per version, ISO
dates, and a later release adds a section above an older one instead of rewriting it.

A release adds its section in the same pull request that writes the change, so the version in
`package.json` always has a section here.

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
