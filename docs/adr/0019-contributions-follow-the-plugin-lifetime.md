# 0019 — Every contribution lives inside the plugin's lifetime

- **Status:** accepted
- **Date:** 2026-11-15

## Context

The person using this plugin asked for one property, in one sentence: *while the plugin is closed, the Harness
interface is the Harness's own — 删除会话, 回收站 and the shortcut are gone, and nothing about the window is left
changed.*

The client kernel already promises the mechanism. `@deepseek-ai/dsh-client-modules/README.md`:

> An open Web page follows the Host's complete module graph through the HMR transport. Enabling an ordinary plugin
> adds its Loader entry; **disabling it removes the entry and waits for its asynchronous effects before evicting
> unused modules and styles.** Re-enabling loads one instance with its styles.

Eviction removes the module; it does not walk through services undoing arbitrary calls. So a contribution survives
its plugin exactly when it was registered **outside** a scope the kernel disposes. Auditing this plugin found two:
the dictionary (`locale.register`) and the session menu row (`contextMenus.register`) were called bare, with a
disposer nobody held — while the settings page, its icon, the notice and the shortcut went through `ctx.effect`
([ADR 0017](0017-row-belongs-in-the-footer.md) and the slots' documented `inject`).

## Decision

Every contribution to the product's interface is registered inside `ctx.effect(...)`, following the pattern the
product's own packages document — `ctx.effect(() => ctx.contextMenus.register({ … }))`. A contribution that cannot
be expressed that way is a contribution the plugin should not make.

## Consequences

- Disabling the plugin takes the row, the settings page, its icon, the notice, the shortcut and the dictionary with
  it; re-enabling contributes exactly one of each. Asserted end to end in the browser half's suite: the four
  contributions are present while the plugin is open and all four are gone after every effect is disposed.
- The fixture models the same lifetime — a shortcut's disposer removes it, an injection owns what its scope
  registers — because a fixture that cannot lose a contribution cannot witness this promise.
- The Host half needs no further rule: its tools, route, command and directory tracking already go through
  `ctx.inject`/`ctx.effect`, and the toggle test in `plugin_manager` shows the route disappearing with the row.
