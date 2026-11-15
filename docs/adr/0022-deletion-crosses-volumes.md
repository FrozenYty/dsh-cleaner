# 0022 — A deletion crosses volumes by copying, verifying, and removing last

- **Status:** accepted
- **Date:** 2026-11-15

## Context

The trash lives in the workspace (`<workspace>/.agents/cleaner/trash`) while the session store lives under the user
profile (`~/.dsh/sessions`). On this machine those are **two volumes**, and a `rename` between volumes fails with
`EXDEV`:

```
cannot be moved into the trash: EXDEV: cross-device link not permitted,
  rename '~/.dsh/sessions/<project>/<id>'
      -> '<workspace>/.agents/cleaner/trash/<stamp>-<id>'
```

The move was assumed to be a rename, and `rename` is what makes this plugin's deletion atomic. When the data
directory moved into the workspace ([ADR 0015](0015-our-own-data-directory.md)) that assumption silently became
false for every session that had a log: deletions of **log-less** ids still worked, which is exactly what the live
checks happened to use, so the regression went unseen for several releases.

`dsh-team`'s trash had already written the answer down, and it was read and not acted on: *"the cross-device move
fallback removes the source it has already copied"*.

## Decision

One helper, `moveAcrossDevices`, used by every transfer this plugin performs (a session directory, a projection
file, and the same transfers in reverse on restore):

1. try `rename` — the atomic path, and still the only path when both ends share a volume;
2. on `EXDEV` only, stage a copy at `<target>.copying`, file by file, **comparing each file's size with its
   source** as it arrives;
3. only after every file is verified, remove the source files and the source directory, then rename the staged copy
   into place.

Only regular files are copied. That is not a special case: a candidate containing anything else is refused long
before this point ([ADR 0004](docs/adr/0004-refuse-links.md)), which is what makes a plain copy faithful.

## Consequences

- A deletion works wherever the trash is. A failure at any step leaves the source untouched, so the worst outcome of
  the fallback is a duplicate, never a loss — the ordering is the whole safety argument.
- An index entry carries `copied: true` when the transfer crossed a device, so a reader can tell a rename from a
  verified copy instead of assuming the fast path was taken.
- The tests exercise the fallback explicitly (`{ copy: true }`), because a fixture that lives on one filesystem
  cannot produce `EXDEV` on its own.
- The lesson is recorded for the *shape* of the mistake rather than the bug: a live check that only ever removed
  log-less sessions could not see a failure that only affects sessions with logs. A verification has to exercise
  the branch the change touches, not the one that is convenient to reach.
