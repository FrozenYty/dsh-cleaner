/**
 * The browser half, mounted against a fake page.
 *
 * What these tests are for: the half contributes one menu row, one shortcut and one dictionary, and every act
 * it performs goes through the host half's route — `POST /dsh-cleaner/<action>` — because a session-menu row
 * acts on a session that may have no agent at all. A service that refuses this plugin's definition must cost
 * exactly that one thing, and the half must survive a route that is not there.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** Evaluate `client.js` the way the page does — registering, not importing. */
function register(page = {}) {
  const loaded = []
  page.__ModuleLoader__ = { load: (definition) => loaded.push(definition) }
  const context = {
    window: page,
    // The page has timers, so the sandbox has them too.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the file registers exactly one client plugin')
  return loaded[0]
}

/** The plugin object the loader's factory returns, with a `require` that knows only the page's module table. */
function plugin(definition) {
  const asked = []
  const value = definition.factory((name) => {
    asked.push(name)
    if (name === 'react') return fakeReact()
    throw new Error(`the bundle half must not require anything but the page's own table (asked for ${name})`)
  })
  value.asked = asked
  return value
}

/**
 * A React just real enough to call a component function once.
 *
 * `useState` answers the initial value and drops every update, and `useEffect` runs the effect immediately:
 * enough to see the first render tree (the labels and the structure) without a renderer. The list itself is
 * covered by the host-side tests, which exercise the same route answer.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [initial, () => {}],
    useEffect: (effect) => { effect() },
  }
}

/** Everything the rendered tree says, as one string, so an assertion reads like a person's report. */
function rendered(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(rendered)
  return [
    typeof node.type === 'string' ? '' : '',
    ...rendered(node.children),
  ]
}

/**
 * Mount the half against a fake page and return what it did.
 * @param options - the optional client services, the route's answer, and the page's own state.
 */
function mount({ menus, locale, shortcuts, slots, sessions, current, injectThrows, answer, transport } = {}) {
  const page = {
    localStorage: {
      getItem: (name) => (name === 'dsh.sessions.current' && current !== undefined
        ? JSON.stringify({ sessionId: current })
        : null),
    },
  }
  const registered = []
  const registeredShortcuts = []
  const registrations = new Map()
  const requests = []
  const dictionaries = new Map()
  /** The settings page this half contributes, and the slots it asked for. */
  const panels = new Map()
  const slotRequests = []
  const injections = []
  let pendingInject

  page.fetch = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}')
    requests.push({ url, options, body })
    if (transport === 'refuse') throw new Error('the network is gone')
    if (transport === 'not-json') return { ok: true, status: 200, text: async () => '<html>' }
    const value = typeof answer === 'function' ? answer(url, body) : (answer ?? {})
    return {
      ok: value?.__status === undefined || value.__status < 400,
      status: value?.__status ?? 200,
      text: async () => JSON.stringify(value),
    }
  }

  const ctx = {
    get: (name) => {
      if (name === 'contextMenus') {
        if (!menus) return undefined
        if (menus === 'refuse') {
          return {
            register: () => {
              throw new Error('the menu service refused this contribution')
            },
          }
        }
        return {
          register: (definition) => {
            registered.push(definition)
            registrations.set(definition.id, definition)
            return () => registrations.delete(definition.id)
          },
        }
      }
      if (name === 'shortcuts') {
        if (!shortcuts) return undefined
        if (shortcuts === 'refuse') {
          return {
            register: () => {
              throw new Error('the shortcut registry refused this definition')
            },
          }
        }
        return {
          register: (definition) => {
            registeredShortcuts.push(definition)
            return () => {}
          },
          // The overlay reads the catalogue to print keys beside a label; the bundle reads the same store to
          // decide whether it may name it at all.
          catalog: {
            getSnapshot: () => {
              if (shortcuts === 'loading') throw new Error('the catalogue is not readable yet')
              if (shortcuts === 'empty') return []
              return registeredShortcuts.map((definition) => ({ id: definition.id, label: definition.label() }))
            },
          },
        }
      }
      if (name === 'slots') {
        if (!slots) return undefined
        if (slots === 'refuse') {
          return {
            inject: () => {
              throw new Error('the slot service refused this contribution')
            },
          }
        }
        return {
          // The documented shape: wait for the slot, then register into it.
          inject: (key, callback) => {
            slotRequests.push(key)
            callback()
            return () => {}
          },
          register: (options, component) => {
            // Keyed by seat *and* id: the page and its icon share the id on purpose, so a map keyed by the id
            // alone would let the icon overwrite the page.
            const seat = `${options.name}|${options.id}`
            panels.set(seat, { options, component })
            return () => panels.delete(seat)
          },
        }
      }
      if (name === 'locale') {        // The product's dictionary service: `register(ns, {en, zh})` contributes, `bind(ns)` reads back with
        // the product's own fallback (an untranslated language lands on `en`).
        return {
          register: (ns, dicts) => {
            dictionaries.set(ns, dicts)
            return () => dictionaries.delete(ns)
          },
          bind: (ns) => (key) => {
            const chain = [String(locale ?? 'en').slice(0, 2).toLowerCase(), 'en']
            for (const language of chain) {
              const value = dictionaries.get(ns)?.[language]?.[key]
              if (typeof value === 'string') return value
            }
            return key
          },
        }
      }
      return undefined
    },
    effect: (run) => {
      const dispose = run()
      cleanup.push(dispose)
      return dispose
    },
    ...injectThrows
      ? {
          inject: () => {
            throw new Error('this Context refuses to inject')
          },
        }
      : shortcuts === 'late'
        ? {
            inject: (deps, callback) => {
              injections.push({ deps, callback })
              pendingInject = { deps, callback }
            },
          }
        : {
            // The ordinary case: each registration waits for its own service and is answered in turn.
            inject: (deps, callback) => {
              injections.push({ deps, callback })
              if (deps.includes('shortcuts') && shortcuts !== undefined) {
                callback({ shortcuts: ctx.get('shortcuts'), effect: ctx.effect })
              }
              if (deps.includes('slots') && slots !== undefined) {
                callback({ slots: ctx.get('slots'), effect: ctx.effect })
              }
            },
          },
  }
  const cleanup = []
  plugin(register(page)).apply(ctx)
  return {
    requests,
    registered,
    registrations,
    shortcuts: registeredShortcuts,
    panels,
    slotRequests,
    injections,
    cleanup,
    pendingInject: () => pendingInject,
  }
}

const attempted = (requests) => requests.filter((call) => !call.url.endsWith('/state'))
const states = (requests) => requests.filter((call) => call.url.endsWith('/state')).map((call) => call.body.state)
const lastState = (requests) => {
  const all = states(requests)
  assert.ok(all.length > 0, 'the half spoke')
  return all[all.length - 1]
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the registered id is the package the Host installed', () => {
  const definition = register()
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(definition.id, manifest.name)
})

test('the bundle half requires nothing', () => {
  const definition = register()
  assert.doesNotThrow(() => plugin(definition))
})

test('a session menu item deletes through the host route, naming the target and the caller', async () => {
  // The caller is the session the window is showing: the host protects that one, and it is the only thing a
  // route has instead of an agent. The target travels in the same body — one request, one act.
  const { registrations, requests } = mount({ menus: true, current: 'session-open-1' })

  const entry = registrations.get('dsh-cleaner.delete-log')
  assert.equal(entry.target, 'session')
  assert.equal(entry.order, 350, 'after fork (300), before the id copy (450)')
  assert.equal(typeof entry.run, 'undefined', 'the click belongs to the item it resolves, not the entry')

  const [item] = entry.resolve({ sessionId: 'session-other-1' })
  assert.equal(item.label, 'Delete session')
  assert.equal(item.danger, true, 'the colour 删除工作区 has')
  assert.equal(item.icon.key, 'workspace.delete')
  assert.equal(typeof item.run, 'function')

  item.run()
  await settle()
  assert.equal(attempted(requests).length, 1)
  assert.equal(attempted(requests)[0].url, '/dsh-cleaner/delete')
  assert.deepEqual(attempted(requests)[0].body, { caller: 'session-open-1', ids: ['session-other-1'] })

  // No target, no item: the menu must not offer a deletion it cannot name.
  assert.equal(entry.resolve(undefined).length, 0)
  assert.equal(entry.resolve({}).length, 0)
})

test('the row is offered without asking the host anything', () => {
  const { registered } = mount({ menus: true })
  const entry = registered[0]
  const item = entry.resolve({ sessionId: 'session-1' })[0]
  assert.equal(Array.isArray(item), false, 'resolve is synchronous and returns the item itself')
  assert.equal(entry.resolve({ sessionId: 'session-1' }).length, 1)
})

test('the menu label is Chinese when the window is', () => {
  const { registered } = mount({ menus: true, locale: 'zh-CN' })
  assert.equal(registered[0].resolve({ sessionId: 'session-1' })[0].label, '删除会话')
})

test('the keys print beside the label only when the catalogue holds the id', () => {
  // 0.2.4 named a static `commandId` and took every session menu down with it; a dangling association is now
  // impossible by construction.
  const hinted = mount({ menus: true, shortcuts: true })
  assert.equal(hinted.registered[0].resolve({ sessionId: 'session-1' })[0].commandId, 'session.delete-log')

  const unhinted = mount({ menus: true, shortcuts: 'empty' })
  assert.equal(unhinted.registered[0].resolve({ sessionId: 'session-1' })[0].commandId, undefined)

  const broken = mount({ menus: true, shortcuts: 'loading' })
  assert.equal(broken.registered[0].resolve({ sessionId: 'session-1' })[0].commandId, undefined)
})

test('a click with no session open to name as the caller says so instead of failing silently', async () => {
  const { registered, requests } = mount({ menus: true })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.deepEqual(attempted(requests), [], 'nothing was executed')
  assert.equal(lastState(requests).lastClick, 'no session is open to name as the caller')
})

test('an answer naming what moved is recorded as a deletion, and what was kept as a refusal', async () => {
  const moved = mount({
    menus: true,
    current: 'session-open-1',
    answer: { removed: [{ id: 'session-1' }], trash: { root: 'D:\\home\\dsh-cleaner-trash' } },
  })
  moved.registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.match(lastState(moved.requests).lastClick, /^deleted \(recoverable under D:\\home\\dsh-cleaner-trash\)/)

  const kept = mount({
    menus: true,
    current: 'session-open-1',
    answer: { removed: [], refused: [{ id: 'session-1', reason: 'the session is running' }] },
  })
  kept.registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.match(lastState(kept.requests).lastClick, /nothing moved: the session is running/)
})

test('a route that is not there, or not JSON, costs the click and nothing else', async () => {
  // The whole reason this half reports `route=…`: a row that draws and does nothing must say which half of the
  // conversation broke.
  const gone = mount({ menus: true, current: 'session-open-1', transport: 'refuse' })
  gone.registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  // The report itself could not be carried either, so the state is only visible on the retry that did not happen;
  // what must hold is that nothing threw and the page is still alive.
  assert.equal(gone.registrations.size, 1, 'the row is still registered')

  const html = mount({ menus: true, current: 'session-open-1', transport: 'not-json' })
  html.registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.equal(html.registrations.size, 1)
})

test('a refused deletion is recorded rather than thrown', async () => {
  const { registered, requests } = mount({
    menus: true,
    current: 'session-open-1',
    answer: { __status: 500, error: 'a deletion needs a calling Agent' },
  })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.match(lastState(requests).lastClick, /refused: a deletion needs a calling Agent/)
})

test('the shortcut is Ctrl+Shift+D on every platform and deletes the session the window shows', async () => {
  const { shortcuts, requests } = mount({ shortcuts: true, current: 'session-live-1' })

  assert.equal(shortcuts.length, 1)
  const [shortcut] = shortcuts
  assert.equal(shortcut.id, 'session.delete-log')
  assert.equal(typeof shortcut.label, 'function')
  assert.equal(shortcut.label(), 'Delete session')
  for (const platform of ['desktop:windows', 'desktop:macos', 'desktop:linux', 'web:windows', 'web:macos', 'web:linux']) {
    // Serialised, because the definition was built in the page's realm: its objects are not this realm's.
    assert.equal(
      JSON.stringify(shortcut.defaults[platform]),
      JSON.stringify({ code: 'KeyD', modifiers: ['primary', 'shift'] }),
      platform,
    )
  }

  const resolved = shortcut.resolve()
  assert.equal(resolved.status, 'handled')
  resolved.run()
  await settle()
  assert.deepEqual(attempted(requests)[0].body, { caller: 'session-live-1', ids: ['session-live-1'] })
})

test('the shortcut says why it cannot act instead of guessing a session', () => {
  const { shortcuts } = mount({ shortcuts: true })
  const resolved = shortcuts[0].resolve()
  assert.equal(resolved.status, 'blocked')
  assert.equal(resolved.reason, 'no session is open')
})

test('a shortcuts registry that refuses the definition costs the key, not the row', async () => {
  const { registered, requests } = mount({ menus: true, shortcuts: 'refuse', current: 'session-1' })
  assert.equal(registered.length, 1, 'the row is still contributed')
  await settle()
  assert.match(lastState(requests).register, /refused: the shortcut registry refused this definition/)
})

test('a shortcut service that mounts after the page still gets the binding', () => {
  const mounted = mount({ shortcuts: 'late' })
  // Both services are waited for, and each registration is answered with its own: the key and the panel are
  // independent, so a profile that mounts only one of them still gets that one. Serialised, because the
  // dependency arrays were built in the page's realm.
  assert.equal(
    JSON.stringify(mounted.injections.map((entry) => entry.deps)),
    JSON.stringify([['shortcuts'], ['slots']]),
  )
  const pending = mounted.injections[0]

  const definitions = []
  pending.callback({
    shortcuts: { register: (definition) => { definitions.push(definition); return () => {} } },
    effect: (callback) => callback(),
  })
  assert.deepEqual(definitions.map((definition) => definition.id), ['session.delete-log'])
})

test('the half reports what it managed to do, through the route the host registers', async () => {
  // The channel exists because "the row is there but the key is missing" is invisible from the host side.
  const { requests } = mount({ menus: true, shortcuts: true, current: 'session-open-1' })
  await settle()

  const state = lastState(requests)
  assert.equal(state.row, 'contributed')
  assert.equal(state.register, 'registered')
  assert.equal(state.catalog, 'holds the id')
  assert.equal(state.menu, 'menu service present')
  assert.equal(state.dictionary, 'locale service present')
  assert.equal(state.current, 'session-open-1')
  assert.equal(state.fatal, undefined)
  assert.equal(requests[0].url, '/dsh-cleaner/state', 'and it is the first thing the half does')
})

test('a half that fails while setting up still says so', async () => {
  // The diagnostic has to survive the failure it reports: the report is sent first, and the guard sends another
  // with the reason. A silent half is how three releases were lost.
  const { requests } = mount({ menus: true, current: 'session-open-1', injectThrows: true })
  await settle()
  assert.match(lastState(requests).fatal, /refuses to inject/)
})

test('a menus service that refuses the contribution costs the row and nothing else', async () => {
  const { registered, requests } = mount({ menus: 'refuse', current: 'session-open-1' })
  assert.deepEqual(registered, [], 'the contribution was refused')
  await settle()
  assert.match(lastState(requests).row, /refused: the menu service refused this contribution/)
})

test('the trash page is contributed to the settings seat, in the window\'s language', () => {
  // "A deletion is recoverable" is a fact a person should be able to see and click, not one they have to ask
  // a model to print. The seat is the documented settings page, registered the documented way.
  const { panels, slotRequests } = mount({ menus: true, slots: true, locale: 'zh-CN' })

  assert.equal(
    JSON.stringify(slotRequests),
    JSON.stringify(['settings.section', 'settings.section.icon']),
    'the page and its icon wait for their seats',
  )
  const panel = panels.get('settings.section|dsh-cleaner.trash')
  assert.ok(panel, 'the page is registered')
  assert.equal(panel.options.name, 'settings.section')
  assert.equal(panel.options.order, 500)
  // "Trash" is the word every desktop already uses; "deleted sessions" read like a log title.
  assert.equal(panel.options.label(), '回收站')

  const english = mount({ menus: true, slots: true })
  assert.equal(english.panels.get('settings.section|dsh-cleaner.trash').options.label(), 'Trash')
})

test('the page carries its own icon, paired to it by the same id', () => {
  // The seat's default gear says nothing about what the page is.
  const { panels, slotRequests } = mount({ menus: true, slots: true })
  assert.equal(slotRequests.includes('settings.section.icon'), true)
  const icon = panels.get('settings.section.icon|dsh-cleaner.trash')
  assert.ok(icon, 'the icon is registered')
  assert.equal(icon.options.id, 'dsh-cleaner.trash', 'the id is what pairs it with the page')
  assert.equal(typeof icon.component, 'function')

  const tree = icon.component()
  assert.equal(tree.type, 'svg')
  // A drawn trash can: a lid, a neck, a body and two slots — not a borrowed generic glyph.
  assert.equal(tree.children.filter((child) => child.type === 'path').length, 5)
})

test('the page\'s first render says what it is and that it is reading', () => {
  // The component is called once with a React stub: enough to hold the structure and the words, which is what
  // a person sees first. The list itself arrives from the same route the row uses, covered host-side.
  const { panels } = mount({ menus: true, slots: true })
  const tree = panels.get('settings.section|dsh-cleaner.trash').component()
  const words = rendered(tree).join(' ')
  assert.match(words, /Trash/)
  assert.match(words, /A deletion is a move/)
  assert.match(words, /Reading the trash/)
})

test('a profile with no slot service keeps the row, the key and the dictionary', () => {
  // The panel is the one contribution that depends on a slot service, and it must be the only thing that goes
  // without one: a hard `inject` would have taken the menu row down with it.
  const { registered, shortcuts, requests } = mount({ menus: true, shortcuts: true })
  assert.equal(registered.length, 1, 'the row is still contributed')
  assert.equal(shortcuts.length, 1, 'the key is still bound')
  return Promise.resolve().then(() => {
    const state = lastState(requests)
    assert.equal(state.row, 'contributed')
    assert.equal(state.panel, 'not contributed')
  })
})

test('a slot service that refuses the page costs the page, not the plugin', async () => {
  const { registered, requests } = mount({ menus: true, slots: 'refuse' })
  assert.equal(registered.length, 1, 'the row is still there')
  await settle()
  assert.match(lastState(requests).panel, /refused: the slot service refused this contribution/)
})

test('the half reports that the page is contributed', async () => {
  const { requests } = mount({ menus: true, slots: true, current: 'session-open-1' })
  await settle()
  assert.equal(lastState(requests).panel, 'contributed')
})
