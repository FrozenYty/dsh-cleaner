# 0008 — Busy, not resident: a loaded agent does not block a deletion

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** —

## Context

The plugin's headline promise is "never a live session", and `protections()` implemented it as *any agent the
registry lists for that session id*. That was fine while every session on disk was either running or gone.
It stopped being fine the first time a person archived a session, waited for its work to finish, and asked
for the deletion: the harness still had the agent resident, the plugin reported `a live agent holds this
session`, and the deletion was refused — with no way for the person to act on the refusal.

The tool then learned to say *which* state the agent is in, and the live answer was:

```
Kept, protected: session-31a6dbb8-… — a live agent holds this session (status: idle)
```

An idle agent is resident, not writing. The Host's own standard agrees: `archiveSession` refuses a session
with **running work** (`workspace/session-active`, listing the work by family), not one with a loaded agent;
and an archived session cannot start a model step at all — the Host's archive gate rejects the step
(`ArchivedSessionGate`), so its log is not going to be appended to under a deletion.

## Options

1. **Keep the broad rule and document it.** Safe, and it blocks a deletion a person may want for as long as
   the harness keeps the agent in memory — a refusal nobody can act on.
2. **Protect only the calling session.** Too loose: a session mid-turn would be deleted under the agent
   writing it.
3. **Protect the calling session, and any session whose agent is not idle.** Matches the Host's own notion
   of "work running", keeps the dangerous case out, and lets a resident-but-idle session go.

## Decision

Option 3:

- the session running the command is always protected, by name;
- another session is protected only while its agent's status is something other than `idle`, and the
  refusal carries that status (`a live agent holds this session (status: running)`) so the reason is
  something a person can act on;
- an agent that reports no status at all is treated as busy — unknown is not idle.

## Consequences

- A session can be deleted once it is archived and its work has stopped, even while the harness still keeps
  its agent in memory. That is the state a person is in when they archive something and come back to it.
- One row may outlive such a deletion: the Host's session list is *persisted ∪ live*, and a resident agent
  keeps its session listed. The plugin cannot evict it — `ctx.sessions` exposes no `close`/`remove`, and only
  the agent factory's own disposer removes a session — so the row leaves when the Host releases the agent,
  which a restart certainly does. The deletion answer names that state (`The session list still names …`)
  instead of pretending the row is gone.
- The deletion was verified not to be undone: after removing the directory of a resident-but-idle session,
  the store held 29 directories instead of 30, and nothing recreated it.

## Revisit when

`ctx.sessions` grows a way to release a session a plugin does not own, or the session list stops including
a live session whose log is gone.
