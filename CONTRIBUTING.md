# Contributing

How work happens in this repository. Style beyond what CI enforces is between the author and the
reviewer.

## 1. What this repository is careful about

This is a plugin whose whole job is to delete files. Two rules come before every other rule here:

- **A deletion is an act somebody asked for.** Nothing in this repository may add a schedule, an age
  threshold, a retention policy or a background sweep — not behind a config key, not "off by default".
- **A promise about what is not deleted needs a test that would fail if the promise broke.** Every
  sentence in the README's "What it never does" names a fixture whose deletion would expose it.

## 2. Branching

`main` is protected. Work happens on short-lived branches, lowercase, hyphen-separated, prefixed by
type:

```
feat/engine-refuse-reflinks    fix/listing-byte-count    docs/design-pair
```

Merge through a pull request, then delete the branch.

## 3. Commits

Conventional Commits, with the module as scope:

```
feat(engine): refuse a session directory that holds a nested directory
fix(plugin): protect a live agent's session, not only the caller's
docs(design): record the storage layout read from the asar
chore(ci): run the fixture tests on both platforms
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.
Modules: `plugin`, `engine`, `bundle`, `docs`, `ci`.

One commit does one thing. If the message needs "and", split the commit.

**Never add a footer that credits a tool.** No `Co-authored-by:` naming an AI assistant or a code
generator. A squash merge copies the single commit message onto `main` verbatim, and GitHub counts that
trailer as another contributor.

## 4. Pull requests

- Keep a PR under **400 changed lines**. Larger work is split.
- Fill in the template: what changed, how it was verified, what else is affected.
- **CI is the only gate.** When `check` is green on both platforms the PR may merge.
- Merge with **squash** — one change, one commit on `main`.

## 5. What CI checks

| Job | Command | What a failure means |
|---|---|---|
| Every module parses | `node --check index.js` (also `engine.js`, `scripts/check.mjs`) | a syntax error |
| Fixture tests | `node --test --test-isolation=none tests/*.test.mjs` | a behavioural promise broke — fix the behaviour, not the assertion |
| Repository checks | `node scripts/check.mjs` | the manifest, the schema subset, the locale pair, the patch, a document reference or a machine path is wrong |

`scripts/check.mjs` verifies, without loading the Harness:

- `package.json` parses, `dsh.bundle.patch` points at the patch, every `files` entry exists, and every
  root module is published;
- a Host module imports only `node:` builtins and relative files, and the entry exports `apply(ctx)`;
- every `execute(` in the entry declares `(args, exec)` — the wrapper the fixture tests call directly,
  and the host calls with an execution context;
- no tool schema uses a keyword outside the Host's accepted subset, which fails the whole plugin at
  load rather than one tool;
- `locale/en.json` and `locale/zh.json` carry the same keys, and the Chinese title is the two-character
  name of the family convention;
- the patch is a top-level array whose insert names this package;
- every document citation resolves: a `docs/…md` that is named exists, and a `§N` points at a heading;
- no shared document carries an absolute machine path.

**It cannot prove that the plugin activates, that either tool behaves in a live profile, or that a
deletion was correct.** Only an install and a live call can, so the report says which of the three was
observed and which was not.

## 6. A check or a test nobody has seen fail is not trusted

Before a new rule is believed, break the thing it describes, watch the failure name the right file and
the right reason, then restore it. This is recorded in the pull request's "How it was verified", not
implied by a green run.

## 7. Language

Everything written to disk is English: code, comments, commit messages, documents, PR descriptions.
The one exception is `README-zh.md`, which is the Chinese half of the README pair and is written as
Chinese prose rather than translated word for word. `locale/zh.json` is the other: a product string,
Chinese by requirement.

Chinese prose uses full-width punctuation — “”、，。；：（） — never ASCII quotes or commas wedged into
a Chinese sentence.
