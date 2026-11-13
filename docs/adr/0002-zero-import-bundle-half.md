# 0002 — The bundle half imports nothing

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** —

## Context

The obvious way to write two tools is the one the package documentation shows:

```js
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
```

A bundle installed into a profile from a directory becomes a `link:` dependency. The profile uses
`nodeLinker: hoisted` with `autoInstallPeers: false`, so pnpm installs neither that package's
dependencies nor its peers into the linked directory; Node resolves bare specifiers from the bundle's
own real path, and neither the profile's `node_modules` nor the dsh installation is an ancestor of it.
The result is a package that installs successfully and then refuses to activate:

```
failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
imported from <repository>/index.js
```

Declaring the packages as dependencies does not help, because nothing installs them next to a linked
directory. This is recorded in dsh-team's ADR 0002, where the same failure was found the same way; the
constraint is a property of profile-linked bundles, not of that plugin.

## Decision

`index.js` and `engine.js` import only `node:` builtins and each other. Tool definitions are plain
canonical JSON Schema objects — the shape `ctx.tools.register` consumes — and every service is reached
through `ctx` (`ctx.tools`, `ctx.get`, `exec.agent`). No `Config` schema is declared, because one
requires `schemastery`; the two paths are resolved from `DSH_HOME` in the entry.

## Rationale

- It is the only arrangement that works for a profile-linked bundle today.
- Losing `defineTool` costs argument validation at call time; the deletion tool validates its own
  argument shape, and the Host still validates the JSON Schema before dispatch.
- Losing the `Config` schema is a feature here: the plugin has no tunable, and the contract says a
  deletion is never configured into existence.

## Consequences

- `scripts/check.mjs` enforces the rule on every root module: an `@deepseek-ai` import fails, and so
  does any bare specifier outside `node:` and relative paths. It also checks that every root `.js` file
  is published, so a new module cannot escape the scan by not being listed.
- Every Harness service call is dynamic, so a Harness rename fails at runtime rather than at build
  time. `docs/design.md` §2 lists the services actually used.
- The tool schema must stay inside the Host's accepted keyword subset. A keyword outside it does not
  fail one tool: it fails the plugin at load. `scripts/check.mjs` fails by name on the known offenders
  (`minItems`, `pattern`, `default` and the rest).

## Revisit when

The Harness gives a linked bundle a resolution map, or ships `@deepseek-ai/*` somewhere Node can reach
from a linked directory. Then `defineTool` and a `Config` schema become available again — though this
plugin has nothing to configure, so only the typing benefit would return.
