# 0003 — Two tools, and the ids are the consent

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

The plugin exists to remove files, so the shape of its surface is the shape of its consent. Four
surfaces were considered:

1. **One tool with `apply: false`.** Shortest, and the safe path is the default. But `apply: true`
   means "delete everything currently archived", and the set can grow between the listing and the
   approval. The model cannot show a person a set and then name it, because it never names anything.
2. **One tool plus a plan token.** The listing returns a digest of the set; the deletion requires it,
   and a changed set refuses. Strong, and stateless. But the token is opaque to the person reading the
   transcript, and a subset approval needs a second mechanism anyway.
3. **An HTTP route with a client button**, like `dsh-session-cleaner`. It is the best surface for a
   human clicking, but it puts the decision in the browser and adds a client half this plugin does not
   need.
4. **Two tools, and the deletion takes ids.** The listing has no argument and no side effect; the
   deletion requires the exact ids, so nothing is deleted by default and a person can approve a subset.

## Decision

Two model-facing tools:

- `list_archived_sessions` — no parameters, read-only, returns candidates with their bytes. Calling it
  can never be a mistake.
- `delete_archived_sessions({ session_ids })` — required, non-empty array of session ids. It deletes
  exactly the ids it is given, reports every id it refuses and why, and never infers a set.

The confirmation is the conversational step between the two calls, and the tool descriptions say so,
because that is the only place the model reads it: *do not make this call before they have seen the
list*.

## Rationale

- The ids make the approved set explicit in the transcript. A person can approve three of six, and the
  call says which three.
- A stale id is not an error: an id that is no longer archived, or already deleted, is refused and
  reported. That keeps a retry honest and makes the second run of the same call a no-op.
- There is no state between the calls to keep in sync, expire or invalidate.

## Consequences

- **This cannot prove the person approved the list.** A model could pass ids that were never shown, and
  no mechanism on this side of the conversation can tell. The refusals bound the damage (only archived
  sessions, never the caller, never a live one) but they do not replace the confirmation. That limit is
  stated in the README rather than hidden.
- Every id in the argument costs tokens; six ids is a line, sixty would be a different problem. If the
  archive list ever grows that far, the plan-token design in the context above is the replacement.
- The listing tool's result is also its report: it has to explain an empty result (all already gone) and
  a refused directory without failing.

## Revisit when

The archive list routinely holds enough sessions that naming them is unreasonable, or the Host grows a
native confirmation channel a tool can require. Either would replace this design rather than extend it.
