# 0015 — The plugin's own data: `.agents/cleaner`, configurable, and bounded

**Status:** accepted. Narrows one consequence of
[ADR 0014](0014-route-transport-and-recoverable-deletion.md) — the trash exists, but it no longer lives under
the Harness data directory.

**Date:** 2026-11-15.

## Context

ADR 0014 put the trash at `<DSH_HOME>/dsh-cleaner-trash/`. That is the wrong home for it, for a reason that has
nothing to do with tidiness: `DSH_HOME` belongs to the **Harness** — `sessions/`, `storages/`, `profiles/`,
credentials — and this plugin's trash is not Harness data. Nothing in the product reads it, nothing cleans it
up, and a person who moves or backs up `DSH_HOME` would carry a trash they never asked for.

The sibling bundle `dsh-team` already settled the same question for its own artifacts: a workspace-relative
`.agents/team` directory, an environment override, a frozen fallback outside every workspace, a validated
config field (`trashLimit`) read from the bundle patch row, and a cap whose reasoning is written down. That is
the house shape, and this plugin follows it.

## Decision

1. **Default location: `<workspace>/.agents/cleaner/`.** One folder holds everything this plugin writes — the
   trash and its `index.json`. It sits beside the memory notebook and the team roster, so all of an agent's own
   data is in one directory a person can open. `trash/` is one level inside it, so a later addition has
   somewhere to go that is not the trash.
2. **It is configurable, through the documented seat.** The bundle patch row `cleaner` takes
   `dataDir`, `retentionDays` and `trashLimit`. A profile that wants the bytes elsewhere writes:
   ```yaml
   - id: cleaner
     config: { dataDir: '.cleaner' }   # absolute, or relative to the workspace
   ```
   The row id is frozen for that reason.
3. **Resolution order, and a refusal.** `dataDir` from the config, else `DSH_CLEANER_DATA_DIR`, else
   `<workspace>/.agents/cleaner`, else `~/.dsh/cleaner`. The **Host's own installation is never a workspace**:
   a base inside `app.asar`, or the directory holding the executable, is skipped rather than written into —
   one would fail inside a sealed archive, the other would litter an installation.
4. **Resolution happens once, at load.** A session's working directory can change while it runs, and
   re-resolving would move the trash out from under a deletion in flight. Every listing prints the path in
   effect, so where the bytes are is never a question a person has to ask.
5. **A wrong config fails the load.** A present field that cannot be honoured throws with the field, the value
   it saw and the minimum — never the first deletion, hours later, in front of somebody who just clicked.
6. **The trash is bounded by two rules, both applied by acts, never by a timer and never by a listing:** an age
   window (30 days by default) and an entry cap (200 by default). The oldest go first, because the newest entry
   is the mistake somebody is most likely to be undoing, and every entry freed is reported with its id and its
   bytes.

## Consequences

- `DSH_HOME` goes back to holding only Harness data. The trash follows the workspace, so two projects keep two
  trashes and a person can see which is which.
- The cap is irreversible in the same way the age window is: a pruned entry has no bytes left. The default is
  deliberately generous for that reason — the cost is a rounding error next to an un-undoable mistake.
- A deletion made from one workspace is restored from that workspace. The listing names the trash it is reading,
  so this is visible rather than surprising; a person who moves between workspaces can set `dataDir` to one
  shared directory if they prefer a single trash.
- A listing is still pure: it reports what the two rules would do and frees nothing, which is what makes it safe
  to call at any time.
