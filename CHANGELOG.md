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
- Repository checks (`scripts/check.mjs`) and 28 fixture tests, both run by CI with Node 22 and Node 24
  on Linux and Windows.
- `SECURITY.md` states what the plugin trusts and the blast radius, because a plugin whose job is
  deletion owes that answer.
