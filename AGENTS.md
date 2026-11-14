# AGENTS.md

Instructions for AI assistants working in this repository. Read this before your first task.

> This file holds only what is not written elsewhere. If a rule already lives in `CONTRIBUTING.md`,
> `docs/design.md` or `README.md`, delete the copy here instead of maintaining two versions.

## 1. Before you start

Read, in this order:

```
README.md  ->  docs/design.md  ->  the ADR that touches your change
```

`README.md` says what the plugin promises. `docs/design.md` says how it keeps those promises, including
the state matrix every candidate falls into. The ADRs hold the decisions that are expensive to
reverse.

- The files beat your memory. The Harness version changes under this repository; anything you remember
  about its services, its storage layout or its schema subset may already be wrong.
- When something is unclear, say what is unclear and what would make it clear. Do not guess at another
  lane's intent.
- The authoritative source for a Harness fact is the installed asar, never this repository. Extract it
  with the tooling under the workspace's `.agents/tools/` and read the package's own README.

## 2. The project

`dsh-cleaner` is a DeepSeek Harness profile bundle. An archive in the Harness only hides a session —
the log stays on disk — and the official persistence seam has no deletion API, so the plugin performs
that removal as deliberate, out-of-band maintenance: list, approve, delete the named ids, report the
bytes.

Two layers, and they must not be confused:

- **The bundle** (`package.json` and the files its `files` list publishes: `index.js`, `engine.js`,
  `client.js`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`) is what gets installed
  into a profile. It is linked from this repository, so there is no build step.
- **The engine** (`engine.js`) knows nothing about the Harness: it takes the session storage root and
  the workspace storage file as arguments, so every test runs against a fixture and the real `DSH_HOME`
  is never touched by a test.
- **The browser half** (`client.js`) runs inside the window, where the sidebar's own view lives. It is a
  script rather than a module: the page's loader evaluates it and it registers under the package name.
- **The Harness** is the host. Its APIs are read from the installed asar, never from this repository.

The load-bearing constraints, each with an ADR:

- the bundle entry imports no `@deepseek-ai` package, because a profile-linked bundle cannot resolve
  one ([ADR 0002](docs/adr/0002-zero-import-bundle-half.md));
- the seam cannot delete, and a deletion is never a schedule
  ([ADR 0001](docs/adr/0001-out-of-band-deletion.md));
- the surface is two tools with explicit ids, so consent is a mechanism and not a description
  ([ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md));
- links and irregular directories are refused, not followed
  ([ADR 0004](docs/adr/0004-refuse-links.md));
- every guard is repeated against the live filesystem when a plan is executed, and the id is bound to the
  path it names ([ADR 0005](docs/adr/0005-re-verify-at-execution.md));
- a deleted session is detached by asking the workspace registry, never by editing its store
  ([ADR 0006](docs/adr/0006-detach-by-asking.md));
- the bundle ships a browser half whose only job is to prune the window's own sidebar view, because that
  view is the one record no host-side step can reach ([ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md));
- a loaded agent does not block a deletion — a **busy** one does, and the refusal names the status
  ([ADR 0008](docs/adr/0008-busy-not-resident.md));
- what a deletion leaves in the workspace is decided per id by asking the host's own session list: a session
  it still holds keeps both records, one it has let go loses both
  ([ADR 0009](docs/adr/0009-two-records-two-cases.md));
- archiving is not a precondition: the store is the index, and a session is a candidate when its directory
  is under the storage root, well formed and unprotected
  ([ADR 0010](docs/adr/0010-no-archive-precondition.md));
- the listing and the deletion each have one implementation behind two callers — the tool and the `/clean`
  command — so their wording cannot drift ([ADR 0011](docs/adr/0011-one-operation-two-callers.md)).

## 3. Working principles

**1. Look before you move.** Read the file, run the checks, check the branch. Never edit from memory.

**2. Smallest change that works.** If you write 200 lines and it could be 50, rewrite it.

**3. Simple beats clever.** No abstraction for single-use code, no configurability nobody asked for,
no error handling for situations that cannot happen.

**4. Define done before coding.** The acceptance is a command that can fail, not a feeling. A new
deletion rule needs a fixture that would be deleted if the rule stopped working.

**5. Change one thing, search the whole repository.** A renamed tool, result field or document appears
in `index.js`, `engine.js`, the README pair, `docs/`, and the tests. `scripts/check.mjs` catches most
of it; grep for the rest.

**6. Read the error.** A non-zero exit is information. `ERR_MODULE_NOT_FOUND` from a bundle entry is
the known trap in ADR 0002, not a mystery — the repair is never "add a dependency".

**7. A blocked operation is a request for permission.** Say what was refused and ask. Profile installs,
`plugin_manager` calls, a deletion against a real store, and any write outside this repository are the
person's decision.

**8. A test that touches the real store is not a test.** The engine takes paths for that reason; use
them. A dry run against the real store is a deliberate act with a person's consent, and it still deletes
nothing.

## 4. Repository rules

- Branch names, commit format and PR rules live in `CONTRIBUTING.md`. Follow them; they are not
  repeated here.
- **Never force-push.** Never rewrite `main`'s history; it is what people clone.
- **Never delete anything on disk outside `tests/` while running a command in this repository**, except
  in a tool call the person asked for, against ids they approved.
- **An accepted ADR is closed.** To change a decision, write a new ADR that supersedes it.
- **`CHANGELOG.md` is append-only in effect**: a released section is never rewritten; a new release adds
  a section above it.
- **A problem outside your lane: report it, do not fix it.** One sentence in the PR description.

## 5. Verify and report

```sh
node scripts/check.mjs     # manifest, dependency surface, schemas, locales, patch, document references
node --check index.js      # the bundle entry parses as ESM
node --check engine.js
npm test                   # the fixture tests, one process on purpose
```

The suites share one process deliberately: the default runner spawns one process per test file, and this
machine's sandbox refuses that spawn. Node 22 and Node 24 spell the flag differently, so `scripts/test.mjs`
chooses it from the running version — one command, both majors, and CI runs exactly that command on 22 and
24, on Linux, macOS and Windows. Do not drop a leg to make CI faster: the engines field is a claim, and the
matrix is what makes it true.

`scripts/check.mjs` cannot prove the plugin works: it never loads the Harness. Installing the bundle
into a profile and calling the tools is the only real check, and it is the person's decision every time.
Never claim a tool works because the install printed `applied`.

Report in three parts:

1. **What changed** — files and behaviour, not intentions.
2. **How it was verified** — commands run and their result. Say whether a real store was involved, and
   whether it was a copy or the live one.
3. **What is left undone** — be explicit; "it works" is not a report.

## 6. Language

Talk to your user in Chinese. Write everything to disk in English: code, comments, commit messages,
documents, PR descriptions. The exceptions are the two files `CONTRIBUTING.md` §7 names:
`README-zh.md`, the Chinese half of the README pair, and `locale/zh.json`, a product string.

Chinese prose uses full-width punctuation — “”、，。；：（） — never ASCII quotes or commas wedged into
a Chinese sentence.
