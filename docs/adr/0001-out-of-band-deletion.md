# 0001 — Removal is out-of-band, and the seam is a witness

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

An archive in DeepSeek Harness hides a session: `workspaceRegistry.archiveSession` appends the id to
`global.archivedSessionIds` in the workspace storage file, and the log stays where it was. The product
offers no way to remove it, and the official persistence seam explicitly does not:

```
No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.
  — @deepseek-ai/dsh-session-persistence, Known Limitations
Nothing deletes session files — logs accumulate under root until removed externally;
the seam has no deletion API.
  — @deepseek-ai/dsh-session-persistence-jsonl, Known Limitations
```

Four ways to remove a log were considered:

1. **Extend the seam** with a delete operation. It is a shipped package inside the Electron asar; a
   profile bundle cannot patch it, and a third-party backend cannot be assumed.
2. **Truncate or rewrite the log.** The seam's own contract is append-only, contiguous `seq`; a
   truncated log is refused by the next writer as corruption, and a rewritten one destroys the history
   the archive was preserving.
3. **Ask the runtime to delete.** `workspaceController` exposes archive, unarchive, pin and unpin, and
   no delete. `dsh-session-cleaner` (a sibling plugin) opened a custom HTTP route for it; that route
   still removes files itself.
4. **Remove the session's own directory, from outside.** The backend owns exactly one directory per
   session and documents that directory as the session's own; removing it whole is the smallest action
   that leaves nothing behind and reads no format.

## Decision

Delete the session's own directory, as out-of-band filesystem maintenance. The engine takes the session
storage root and the workspace storage file as arguments, never opens a persistence handle, never parses
a session event and never writes a line. The mounted seam is consulted only **after** a deletion, to ask
whether it still lists the ids that were removed, and that answer is reported.

## Rationale

- It is the only mechanism the product actually leaves open, and the seam's own documentation names it
  as the intended one.
- Removing a directory needs no format knowledge, so no future session format can be misread or
  half-migrated by this plugin.
- Because there is no API to enforce anything, every safety rule has to live in this repository and be
  tested here: archive membership, protection, links, irregular directories. The tests exist for that
  reason (design §4, §5).
- Verification after the fact uses the seam where it is strong: `list()` is a disk-backed read, so it
  can confirm that the harness's own view no longer contains the session.

## Consequences

- The projection cache (`storages/session_projcache/`) is not touched; a deleted session may keep a
  stale derived row until the runtime drops it.
- `archivedSessionIds` keeps the deleted ids. They become ids with no directory, reported as
  `already_gone` — which is also what makes a second run answer "0 candidates" instead of failing.
- The filesystem layout is now a compatibility surface: if a future backend renames the project key or
  the id escape, the listing reports zero candidates until `engine.js` is updated (design §8).
- A non-empty project directory survives a deletion; an empty one does too. Only session directories
  are removed.

## Revisit when

The Harness ships a first-party deletion operation, or the persistence seam gains one. At that point
this plugin should become the confirmation and reporting surface over that API, and the directory
walk should be deleted rather than kept as a fallback — two mechanisms would eventually disagree.
