# 0026 — Plugin data lives under the user's home directory

- **Status:** accepted
- **Date:** 2026-11-16
- **Supersedes:** the **location** of [ADR 0015](0015-our-own-data-directory.md) (which put the data directory inside
  a workspace's `.agents` folder). Its other rule — the plugin owns its own data directory and no other record
  system's store — stands.

## Context

The data directory was resolved as "the config field, then the environment, then **the workspace the registry
names**, then `~/.dsh/cleaner`". It was also **bound once, at load**, which is where the trouble started: at load
the workspace registry is often not mounted yet, so the fallback was used — and that fallback was
`workingDirectory.defaultDirectory`, the profile's default directory. That is not a workspace: it follows whatever
the person last opened.

On 2026-11-16 the repositories moved into a folder of their own and the profile's default directory became that new
folder. The plugin followed it, so the trash began living in `<new folder's parent>/.agents/cleaner` while the
real one still held the earlier deletions:

```
live trash.root = <new folder>/.agents/cleaner/trash     ← wrong, and empty
the real one    = <workspace>/.agents/cleaner/trash      ← what the person expected
```

Nothing was lost (the trash was empty), but the class of failure is the unrecoverable one: a data directory that
moves makes earlier deletions look like they never happened. A workspace moves; a profile default moves; a checkout
moves. Only the user's home directory does not.

## Decision

The data directory is:

1. the `dataDir` config field, when a profile sets one;
2. `DSH_CLEANER_DATA_DIR`, when the environment sets one;
3. otherwise **`~/.agents/cleaner`** — the same answer on every machine, in every workspace, under every profile.

`.agents/<plugin>` is the machine-wide home for plugin data: one place a person can open, back up and reason about,
shared by every bundle that writes state. Nothing else is consulted: no workspace, no profile default, no checkout,
no `import.meta.url`. The resolution runs **per use**, so there is no early binding to be wrong later, and a
`cwd`-shaped argument is accepted and deliberately **ignored**.

## Consequences

- The failure class disappears structurally rather than being patched: there is no moving input left.
- The trash now sits on the same volume as the session store (`C:`), so the cross-device move of
  [ADR 0022](0022-deletion-crosses-volumes.md) becomes the rare case rather than the normal one. The machinery
  stays: a configured `dataDir` can still be on another volume.
- Per-workspace separation is gone, on purpose. These plugins are per-person tools, not per-project state; one
  global directory is the honest model, and a profile that genuinely wants isolation sets `dataDir`.
- **An existing trash is not picked up automatically.** A person who had deletions held under
  `<workspace>/.agents/cleaner` moves that folder to `~/.agents/cleaner`, or sets `dataDir` back to it. This
  repository's own trash was empty when the change landed, so nothing was migrated here.
- The siblings (`dsh-memory`, `dsh-search`, `dsh-team`) still write under their workspaces; aligning them is their
  own change, recorded nowhere but in each repository's log.
