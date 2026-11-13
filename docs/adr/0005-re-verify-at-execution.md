# 0005 — A plan is re-verified when it is executed

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

`planCleanup` produces a description of a moment: these ids were archived, these directories held these
files and these byte counts. `applyCleanup` acts on it later, and several things can happen in between:

- a person unarchives a session (`workspaceRegistry.unarchiveSession` exists), so an id in the plan is no
  longer a candidate at all;
- another deletion run, or a person with a shell, removes a directory the plan still names;
- a directory is replaced, moved, or replaced by a file;
- the plan itself is handed back by a caller — `applyCleanup` is exported and takes plain data, and the
  test suite deliberately tampers with plans.

The last case found a real hole. Two separate guards existed: archive membership, which validates the
**id**, and containment, which validates the **path**. A plan that swapped two archived sessions' paths
passed both — the deletion followed the path while the report named the id, so the engine deleted one
session and reported another. Nothing had asserted that the two fields described the same session.

## Decision

Every guard the listing performed is repeated against the live filesystem at execution time, and one is
added:

1. re-read `global.archivedSessionIds`; a candidate no longer listed is refused, not deleted;
2. the candidate directory's name must equal `encodeSegment(id)` — the binding that makes the report true;
3. `lstat` must see a real directory (a link is refused) whose `realpath` stays inside the resolved
   session storage root;
4. every entry directly inside must be a regular file, and each file's size is measured immediately
   before its `unlink`, so `removed_bytes` is what actually left the disk.

Refusals are reported per candidate and never abort the sweep. No candidate is deleted on the strength of
the plan alone.

## Rationale

- The report is part of the promise: "these ids were deleted, this many bytes" has to be true, and it is
  only true if the id and the path were the same object at the moment of deletion.
- A plan is data. It arrives as an argument, it can be stale, and it can be wrong; a function that
  deletes files should not trust an argument it can cheaply check.
- The checks cost a handful of syscalls per candidate, against an operation that is already walking a
  directory tree.

## Consequences

- A stale plan produces refusals with reasons rather than an error, which is also what makes a second run
  of the same call a no-op instead of a failure.
- `applyCleanup` cannot be used to delete an arbitrary path, even deliberately: the path must be the
  directory the id names, inside the configured store. Handing it a foreign path is refused by design.
- Each of these guards has a test that tampers with a plan to prove it fires — the swap, the path outside
  the root, the directory replaced by a file, the directory that vanished, and the id restored in
  between.

## Revisit when

The persistence seam grows a deletion operation with its own transactional semantics. At that point the
re-verification belongs to whoever owns the store, and this list should shrink to the checks that API
cannot make (the archive list, the protection rule) rather than being kept as a second opinion.
