# 0004 — Links and irregular directories are refused, not followed

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

The deletion unit is a directory tree, and the tree is not entirely this plugin's to trust. Three
situations were possible, and each has a plausible "obvious" implementation that goes wrong:

- **A link where a project or session directory should be.** `readdir` with `withFileTypes` reports a
  link as neither a file nor a directory on both platforms; an implementation that calls `stat`
  instead, or that follows the entry, would walk into the target and delete files outside the storage
  root.
- **A session directory holding something other than the regular files the backend writes.** A nested
  directory may belong to a future version of the backend, or to a person. `rm -r` would decide for us.
- **A session directory whose path, once resolved, is outside the root.** Symlinks are not the only way
  there: a path can be replaced between the listing and the deletion.

## Decision

The walk is two levels deep and `lstat`-based: a project or session entry that is not a real directory
is reported as skipped and never entered. A candidate directory is removed only when every entry
directly inside it is a regular file; anything else refuses the candidate with a reason. Before a file
is unlinked, the candidate's `realpath` must be inside the resolved storage root. Files are unlinked one
at a time with their size measured first, and the directory is removed with `rmdir` once empty.

## Rationale

- The refusals are fail-closed: the worst case is a session that cannot be cleaned until a human looks
  at it, never a file removed from the wrong place.
- Measuring each file at unlink time makes `removed_bytes` what actually left the disk, not what the
  listing predicted. Those are different numbers when something changed in between, and the honest one
  is the second.
- Unlinking one at a time keeps the decision local. The alternative — a recursive delete — is shorter,
  but its behaviour with a reparse point that appeared after the check is a platform detail this plugin
  should not be betting on.

## Consequences

- A session directory that gains a subdirectory cannot be cleaned by this plugin. It is listed as
  skipped, with the path and the reason, so the human sees it instead of a silent no-op.
- A partially removed candidate is reported as `failed` with the bytes that were freed; the remaining
  files are found by the next run. Nothing pretends the candidate was removed.
- On Windows a directory junction is removed with `rmdir` (which removes the link, not the target); a
  recursive delete over a tree that contains one can fail with `ENOTEMPTY`, which is why the tests
  remove their links in a `finally` block.
- Tests cover both levels of link and the irregular directory, because a rule with no failing test is
  not a rule here (CONTRIBUTING §1).

## Revisit when

The backend starts writing something other than regular files into a session directory — a nested
artifact directory, for instance. Then "everything inside must be a regular file" becomes the wrong
predicate, and the replacement has to name what it will and will not remove, with a test per case.
