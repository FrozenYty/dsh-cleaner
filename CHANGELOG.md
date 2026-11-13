# Changelog

What each released version of this bundle contained, newest first, in the shape
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) describes: one dated section per version, ISO
dates, and a later release adds a section above an older one instead of rewriting it.

A release adds its section in the same pull request that writes the change, so the version in
`package.json` always has a section here.

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
- Repository checks (`scripts/check.mjs`) and 32 fixture tests, both run by CI with Node 22 and Node 24
  on all three platforms.
- `SECURITY.md` states what the plugin trusts and the blast radius, because a plugin whose job is
  deletion owes that answer.
- One line carries the plugin wherever a person meets it — the card in the plugin list, both READMEs,
  the package description — and it says the two things the code enforces: the candidate must be
  archived, and nothing in use is touched.
- First live run, recorded because it is this release's evidence: installed into a desktop profile, both
  tools appeared, and the six archived logs on this machine were listed and then deleted through the
  tools — 4,169,349 bytes reclaimed, the mounted persistence backend confirming the removal, and an
  independent directory count agreeing (36 session directories before, 30 after).
