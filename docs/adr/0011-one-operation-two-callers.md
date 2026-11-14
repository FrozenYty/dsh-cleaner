# 0011 — One operation, two callers

Date: 2026-11-14
Status: accepted
Amends: nothing. Adds a surface to ADR 0003's consent mechanism.

## Context

ADR 0003 made the consent mechanism two model-facing tools: a listing that cannot delete, and a deleting
tool whose ids must have been printed. That is a mechanism, not a promise that a person can only delete by
talking to a model. A night of live use showed the cost of the gap: to remove a log, the person had to ask
an agent to call a tool, which spent a turn, a request and a context window on a decision they had already
made. "Delete this session" is not a question that needs a model.

The harness documents the shape this should take — *"One operation, two callers"*, in the
plugin-development skill's `references/user-actions.md`: implement the operation once as a host method,
call it from the UI through a client-callable entry point (it names `ctx.remote.commands.execute` as the
example), and expose the same operation as an agent tool. Two callers, one implementation, and the
failure the UI shows is the failure the tool returns.

## Decision

**A session command is a second caller of the same implementation, not a second mechanism.**

- `listLogs(ctx, exec)` and `deleteLogs(ctx, exec, ids)` are the operation. The two tools and the command
  all end in them, so the wording, the protections and the refusals cannot drift between a person typing
  and a model calling. A test compares the command's answer with the tool's answer for the same ids.
- The command is registered through `ctx.get('commands')` and disposed as an effect, so a profile without
  that service still registers its tools, and an unloaded plugin leaves no command behind.
- Its shape is the registry's own contract, read from the installed harness rather than guessed:
  `{ name, description, input: { hint }, handler({ agent, rawInput }) }`, and the handler returns
  `{ kind: 'success' | 'error', text }`. Execution resolves the definition and runs the handler *without
  sending anything to the model* — that is the whole point.
- `/clean` lists; `/clean <id> <id>` deletes. The input is split on whitespace and commas, so ids copied
  out of a listing can be pasted as they are. An id that is refused is answered, not thrown: a command
  that fails loudly on "already deleted" would be worse than the tool it mirrors.
- The command keeps the caller protection: `invocation.agent` is the Session it was run from, so
  `/clean <the session I am typing in>` is refused exactly as the tool refuses it.

## Consequences

- A deletion no longer needs a model turn. The listing and the receipt are text in the transcript, which
  means the same `renderList`/`renderDelete` wording a person would have read in a tool result.
- The tool surface stays, because a model that is already in a conversation is the right caller when the
  person is describing what they want rather than naming ids: "delete the old ones under MYPROJS" is a
  request for the listing-then-approve flow, not for a command line.
- The command cannot be invoked by an agent: it is the human's entry point in the composer. That is the
  line `references/user-actions.md` draws, and the plugin keeps to it — an authority-granting action stays
  user-only, and this one grants nothing: it is the same explicit-id consent, typed instead of spoken.
