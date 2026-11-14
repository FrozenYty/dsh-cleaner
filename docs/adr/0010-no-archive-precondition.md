# 0010 — No archive precondition

Date: 2026-11-14
Status: accepted
Supersedes: nothing. Amends ADR 0003's candidate set and ADR 0005's re-verification.

## Context

Until v0.1.0 the candidate set was `global.archivedSessionIds` and nothing else. The argument was that an
archive is the person's own signal — they hid the session, so they are done with it — and that a plugin
which can only delete what someone already hid cannot delete anything by surprise. ADR 0003 built the
consent mechanism on top of that: two tools, ids by name, and a candidate set the listing printed.

A night of live use showed what the rule costs, in three separate ways:

1. **Two surfaces for one act.** Deleting meant hiding the session in the sidebar first, then naming it.
   A person who wanted the log gone had to perform an action about *visibility* to unlock an action about
   *deletion* — and the sidebar's archive action reads as "hide", not as "I am finished with this".
2. **Refusals nobody can act on.** "Not an archived session; archive it first to make it a candidate" is
   a sentence the plugin should never have had to say. The work it described was the person's, not the
   session's.
3. **Record churn with no owner.** Because the archive set doubled as the candidate index, every deletion
   had to decide what to do with two workspace records (project membership and archive entry), and each
   choice produced a new visible state: an id whose log was gone still unarchived into a visible
   ungrouped row ([ADR 0009](0009-two-records-two-cases.md) is what settled that).

None of that is required by the harness. It has the facts a deletion needs, and this plugin already reads
them: `ctx.sessionQuery.listSessions()` says what is live, and the store itself says what is on disk.

## Decision

**The store is the index.** A session is a candidate when its directory is under the session storage root,
well formed, and not protected. Archiving is what the product does to hide a session; it is not this
plugin's permission to delete one, and it is no longer part of any decision.

- The workspace file is still read, but only to *report*: whether a listed session is archived, and which
  archived ids have no directory left (`already_gone`). A missing or empty archive file no longer means
  "nothing to list" — it means every session on disk is listed, none of them marked archived.
- The listing prints the archive state of each row, because it tells the person whether that row is
  already hidden in their sidebar — a fact about what they will see, not about what they may delete.
- Protection is unchanged in kind and narrower in scope: the session running the command, and any session
  whose agent is **busy** ([ADR 0008](0008-busy-not-resident.md)). Nothing else vetoes.
- Nothing is deleted without being named. The deleting tool still takes ids only, and the listing is still
  the only place those ids come from ([ADR 0003](0003-two-tools-with-explicit-ids.md)).
- The deletion-time re-verification stays exactly as ADR 0005 requires — id/path binding, containment,
  link refusal, regular-files-only — except that the archive list is no longer re-read, because no
  candidate depends on it any more.

The tools are renamed with the rule: `list_session_logs` and `delete_session_logs`. A name that says
"archived" would now be a lie in the one place a model reads before deciding what to call.

## Consequences

- One surface. "Delete this session" is one sentence, and the same sentence works whether or not the
  session was ever hidden.
- The plugin can now delete a session a person is still using — if they name it. That is the same exposure
  ADR 0003 already accepted (a model can name an id nobody looked at), and the protections that bound it
  did not change. What changed is that hiding a session is no longer mistaken for a permission check.
- `decodeSegment` had to exist: with no archive list to iterate, the store enumerates itself, and a
  directory name is a complete record of its id because the escape is injective. A name that is not a
  valid escape cannot come from this backend and is kept as it stands.
- The workspace records are now purely a *reporting* concern for this plugin, which makes ADR 0009's
  two-case rule the only thing that touches them.
