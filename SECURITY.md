# Security

This plugin deletes files. A report that it can be made to delete something it should not is the most
valuable bug you can file here, and the one the test suite is built around.

## Reporting

Open a private security advisory on GitHub — **Security → Report a vulnerability**. If that is
unavailable, open an issue titled `security: <one line>` without exploit details, and say how to reach
you. Please do not publish a working exploit before a fix is out.

Useful in a report: the listing the plugin printed (or a dry run from a shell, which deletes nothing),
what survived, and the `DSH_HOME` it used.

## What the plugin trusts

- **`DSH_HOME`** (default `~/.dsh`) decides which store is read. A wrong value points the deletion at
  the wrong store; the listing prints the session root and the workspace file it used, so the mistake is
  visible before anything is approved.
- **`global.archivedSessionIds` in `storages/workspace.json`** is the only source of candidates. Whoever
  can write that file can already hide sessions in the UI — marking an id archived is exactly what the
  harness does when a person archives — so the file is trusted by construction rather than by this
  plugin. The plugin never writes it.
- **The filesystem**, but only through checks: every candidate is a real directory (a link is refused),
  its resolved path must stay inside the resolved session storage root, and every entry inside it must
  be a regular file before anything is unlinked.

## What someone with those capabilities can cause

- A session's own directory under `<DSH_HOME>/sessions/<project-key>/` is removed, and its log is gone.
  That is the plugin's entire job, and it is irreversible — there is no trash.
- **Nothing outside that root.** A candidate whose resolved path leaves the root is refused (there is a
  test that tampers with a plan to prove it), and a link at either level is reported, never entered.
- **Nothing unarchived**, and never the session that is running the command or one a live agent holds.
  Those are refused by name in the answer, not silently skipped.

## What it cannot do

- It never executes anything from the store and never reads log content: it stats files and unlinks
  them. A corrupt, huge or hostile log is deleted exactly like a healthy one.
- It has no network access, no timer and no background work. Every deletion happens inside a tool call.
- It never writes the workspace file, the projection cache, or the attachment store.

## Blast radius

The worst case is one session directory: its log, and nothing else. The workspace file, the project
directories, the per-session projection cache and the content-addressed attachment store all survive.

Partial failure is reported, not hidden: a candidate whose files were partly removed appears as
`failed` with the bytes that were actually freed, and the next run finds the rest.
