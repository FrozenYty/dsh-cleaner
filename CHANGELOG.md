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
- The candidate rule is `global.archivedSessionIds` and nothing else, re-read at deletion time; the
  running session and every live agent's session are protected and reported; symlinked and junctioned
  directories are refused rather than followed; a session directory holding anything but regular files
  is refused rather than removed.
- Verification through the mounted `sessionPersistence` service after a deletion, reported and never
  able to veto one. The plugin parses no session format and rewrites no log line.
- Repository checks (`scripts/check.mjs`) and 20 fixture tests, both run by CI on Linux and Windows with
  Node 24.
