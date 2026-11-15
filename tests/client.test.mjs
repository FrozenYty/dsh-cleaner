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
function mount({ menus, locale, shortcuts, slots, sessions, current, injectThrows, answer, transport, commandsAnswer, archive } = {}) {
  const page = {
    localStorage: {
      getItem: (name) => (name === 'dsh.sessions.current' && current !== undefined
        ? JSON.stringify({ sessionId: current })
        : null),
    },
  }
  const registered = []
  const registeredShortcuts = []
  /** Registrations made while a slot injection is running, so the injection can dispose them. */
  let capture = null
  const registrations = new Map()
  const requests = []
  const dictionaries = new Map()
  /** The settings page this half contributes, and the slots it asked for. */
  const panels = new Map()
  const slotRequests = []
  const injections = []
  /** The command carrier: what it retained, what it ran, and what it released. */
  const retained = []
  const commands = []
  const released = []
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
            // A real registry drops the command with its disposer; the fixture has to model that, or no test can
            // tell a scoped contribution from one that outlives the plugin.
            return () => {
              const at = registeredShortcuts.indexOf(definition)
              if (at >= 0) registeredShortcuts.splice(at, 1)
            }
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
          // The documented shape: wait for the slot, then register into it. A real injection owns what its scope
          // registers, so disposing the injection disposes the seat — modelled here, because "closing the plugin
          // removes its page" is a promise this fixture is the only witness to.
          inject: (key, callback) => {
            slotRequests.push(key)
            const owned = []
            const previous = capture
            capture = owned
            try {
              callback()
            } finally {
              capture = previous
            }
            return () => {
              for (const dispose of owned) dispose?.()
            }
          },
          register: (options, component) => {
            // Keyed by seat *and* id: the page and its icon share the id on purpose, so a map keyed by the id
            // alone would let the icon overwrite the page.
            const seat = `${options.name}|${options.id}`
            panels.set(seat, { options, component })
            const dispose = () => panels.delete(seat)
            capture?.push(dispose)
            return dispose
          },
        }
      }
      if (name === 'sessions') {
        if (sessions === 'absent') return undefined
        // The documented shape: retain a session, await the binding, run a command in it, release it.
        return {
          retain: (sessionId, options) => {
            retained.push({ sessionId, options })
            return {
              ready: Promise.resolve({
                sessionId,
                session: {
                  command: async (line) => {
                    commands.push({ sessionId, line })
                    return commandsAnswer ?? { ok: true, value: { matched: true } }
                  },
                },
              }),
              release: () => released.push(sessionId),
            }
          },
        }
      }
      if (name === 'uiWorkspace') {
        if (archive === undefined) return undefined
        // The window's own workspace face: the call the sidebar's 归档会话 row makes.
        return {
          archiveSession: async (sessionId) => {
            archive(sessionId)
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
    retained,
    commands,
    released,
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
  // The overlay splits actions into items and footer by `afterContent`, and 归档会话 is a footer action, so
  // `order` alone cannot seat this row below it — 700 only decides where it lands *within* the footer.
  assert.equal(entry.order, 700, 'below archive (600) inside the footer')
  assert.equal(typeof entry.run, 'undefined', 'the click belongs to the item it resolves, not the entry')

  const [item] = entry.resolve({ sessionId: 'session-other-1' })
  // `afterContent` is a field of the resolved **action**, not of the registration — the reason ADR 0016 got the
  // mechanism wrong. This row belongs in the menu footer, under 归档会话, and nowhere else.
  assert.equal(item.afterContent, true, 'the row belongs in the menu footer, below 归档会话')
  // No separator of our own: the archive row carries one, and two adjacent dividers read as a mistake.
  assert.equal(item.separatorBefore, undefined, 'the archive row already divides the block')
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
  assert.match(lastState(moved.requests).lastClick, /^deleted over the route \(recoverable under D:\\home\\dsh-cleaner-trash\)/)

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
  // Both carriers refuse: the route says the caller is missing, and the command says the session is busy. What
  // a person must get is the reason, not a silent no-op and not a thrown page.
  const { registered, requests } = mount({
    menus: true,
    current: 'session-open-1',
    sessions: true,
    answer: { __status: 500, error: 'a deletion needs a calling Agent' },
    commandsAnswer: { ok: false, error: { message: 'the session is running' } },
  })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.match(lastState(requests).lastClick, /^refused: the session is running; route unavailable \(a deletion needs a calling Agent\)/)
})

test('a Host without the route still deletes, through the command it does serve', async () => {
  // This is the case that matters on a Host older than 0.3.0: `/clean` has been registered since 0.2.18, so the
  // row must not depend on a route that only newer Hosts have. The command is carried by the session in front
  // of the person, which is what keeps the running session protected.
  const { registered, requests, retained, commands, released } = mount({
    menus: true,
    current: 'session-open-1',
    sessions: true,
    transport: 'refuse',
  })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await settle()

  assert.equal(retained.length >= 1, true, 'the carrier session was retained')
  const deletion = commands.filter((call) => !call.line.startsWith('/clean --state '))
  assert.equal(deletion.length, 1)
  assert.equal(deletion[0].sessionId, 'session-open-1')
  assert.equal(deletion[0].line, '/clean session-1', 'the host\'s own command, with the target as the argument')
  assert.equal(released.includes('session-open-1'), true, 'and the reference was released')
  assert.match(lastState(requests).lastClick, /^handed to \/clean \(matched=true\); route unavailable/)
})

test('the report rides the command when the route is absent', async () => {
  // The half has to be visible on the Host it is being debugged on. A report that only exists on newer Hosts is
  // a report nobody reads at the moment it is needed.
  const { requests, commands } = mount({ menus: true, current: 'session-open-1', sessions: true, transport: 'refuse' })
  await settle()
  const stateLine = commands.filter((call) => call.line.startsWith('/clean --state '))
  assert.equal(stateLine.length >= 1, true, 'the state was carried by the command')
  assert.match(lastStateOf(requests), /^command \(route unavailable:/)

  function lastStateOf() {
    // The route never answered, so read the state the command carried instead of the request log.
    const carried = stateLine[stateLine.length - 1].line.slice('/clean --state '.length)
    return JSON.parse(carried).report
  }
})

test('the shortcut is Ctrl+Shift+D on every platform and deletes the session the window shows', async () => {
  const { shortcuts, requests } = mount({ shortcuts: true, current: 'session-live-1' })

  assert.equal(shortcuts.length, 1)
  const [shortcut] = shortcuts
  assert.equal(shortcut.id, 'session.delete-log')
  assert.equal(typeof shortcut.label, 'function')
  assert.equal(shortcut.label(), 'Delete session')
  for (const platform of ['desktop:windows', 'desktop:macos', 'desktop:linux', 'web:windows', 'web:macos']) {
    // Serialised, because the definition was built in the page's realm: its objects are not this realm's.
    assert.equal(
      JSON.stringify(shortcut.defaults[platform]),
      JSON.stringify({ code: 'KeyD', modifiers: ['primary', 'shift'] }),
      platform,
    )
  }
  // web:linux is deliberately unbound: the product admits only three fixed web combinations there, and a
  // profile its rules reject refuses the **whole** registration — no catalogue entry, no keycap, no key.
  assert.equal('web:linux' in shortcut.defaults, false, 'web:linux is left unbound rather than refusing everything')

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
    JSON.stringify(['settings.section', 'settings.section.icon', 'shell.overlay']),
    'the page, its icon and the notice each wait for their seat',
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
  // No subtitle: the page says what it is and what it is doing, and nothing else.
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

test('a click says what it did, at the frame level', () => {
  // "点击没有效果" was never a wrong symptom: it was the absence of one. The notice is the seat that makes a
  // silent no-op impossible — including the case where the click cannot run at all.
  const silent = mount({ menus: true, slots: true, current: 'session-open-1' })
  const notice = silent.panels.get('shell.overlay|dsh-cleaner.notice')
  assert.ok(notice, 'the notice is registered')
  assert.equal(notice.options.order, 900)
  // Nothing has happened yet, so it renders nothing rather than an empty bar.
  assert.equal(notice.component(), null)

  const clicked = mount({ menus: true, slots: true, current: 'session-open-1', transport: 'refuse' })
  clicked.registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-1' })[0].run()
  return settle().then(() => {
    // The sentence is recorded for the report; the notice reads the same value, so a person sees what the
    // listing will say.
    assert.match(lastState(clicked.requests).lastClick, /^handed to \/clean/)
  })
})

test('a click with no session to name says so in the notice and in the report', () => {
  const { registrations, requests, panels } = mount({ menus: true, slots: true })
  registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-1' })[0].run()
  // Synchronously visible: the click sets the sentence and the notice reads it, so the person sees the reason
  // without opening anything, and the report carries the same sentence.
  const shown = rendered(panels.get('shell.overlay|dsh-cleaner.notice').component()).join(' ')
  assert.match(shown, /No session is open/)
  return settle().then(() => {
    assert.equal(lastState(requests).lastClick, 'no session is open to name as the caller')
  })
})

test('a registry that refuses the full profile set still binds the desktop ones', () => {
  // The product refuses a registration whose *every* declared profile must admit the key, so one unsupported
  // profile used to cost the whole key. The fallback is what keeps a refused platform from costing all of them.
  const attempts = []
  const refuseFirst = (definition) => {
    attempts.push(Object.keys(definition.defaults).sort().join(','))
    if (attempts.length === 1) throw new Error('Unsupported Web shortcut: session.delete-log')
    return () => {}
  }
  const definitions = []
  const ctx = {
    get: (name) => (name === 'shortcuts'
      ? { register: refuseFirst, catalog: { getSnapshot: () => definitions.map((entry) => ({ id: entry.id })) } }
      : undefined),
    effect: (run) => { const dispose = run(); return () => dispose?.() },
    inject: (deps, callback) => callback({ shortcuts: ctx.get('shortcuts'), effect: ctx.effect }),
  }
  plugin(register()).apply(ctx)

  assert.equal(attempts.length, 2, 'it tried the declared set, then the desktop-only set')
  assert.match(attempts[0], /web:windows/)
  assert.equal(attempts[1].includes('web:'), false, 'the retry declares no web profile')
})

test('a click hides the row through the product\'s own archive action', async () => {
  // A window draws its rows from the workspace records, and the sidebar never draws an archived session — so
  // archiving is the only call that makes a row leave at once. The registry refuses to archive a session it
  // cannot find (a session that never wrote a log is exactly that), which is why this is the window's job and
  // why clicking delete on such a row used to leave it standing.
  const archived = []
  const fails = []
  const { registrations, requests } = mount({
    menus: true,
    current: 'session-open-1',
    slots: true,
    transport: 'refuse',
    archive: (sessionId) => { archived.push(sessionId) },
  })
  registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-blank-1' })[0].run()
  await settle()
  await settle()
  assert.deepEqual(archived, ['session-blank-1'], 'the row was hidden with the same action the sidebar uses')
  assert.equal(lastState(requests).lastHide, 'archived session-blank-1')
  assert.deepEqual(fails, [])
})

test('an archive that the workspace service refuses is recorded, never thrown', async () => {
  const { registrations, requests } = mount({
    menus: true,
    current: 'session-open-1',
    transport: 'refuse',
    archive: () => { throw new Error('WorkspaceUnknownSessionError: no such session') },
  })
  registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-blank-1' })[0].run()
  await settle()
  assert.match(lastState(requests).lastHide, /^refused: WorkspaceUnknownSessionError/)
})

test('a profile without the workspace service still deletes', async () => {
  const { registrations, requests } = mount({ menus: true, current: 'session-open-1', transport: 'refuse' })
  registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  assert.equal(lastState(requests).lastHide, 'no uiWorkspace service')
  assert.match(lastState(requests).lastClick, /^handed to \/clean/)
})

test('an id the engine reports as unlogged still takes its row with it', async () => {
  // The answer's own fields decide what happened. An id with no directory is reported under `unlogged` — not under
  // `refused` — so a client that looks for a reason string in the wrong field reports "nothing moved" and leaves
  // the row standing, which is exactly what a person saw on screen.
  const hidden = []
  const blank = mount({
    menus: true,
    slots: true,
    current: 'session-open-1',
    answer: { removed: [], refused: [], unlogged: [{ id: 'session-blank-1' }] },
    archive: (sessionId) => { hidden.push(sessionId) },
  })
  blank.registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-blank-1' })[0].run()
  await settle()
  await settle()
  assert.deepEqual(hidden, ['session-blank-1'], 'the row leaves, because there was nothing to delete')
  assert.match(JSON.stringify(blank.panels.get('shell.overlay|dsh-cleaner.notice').component()), /no log — row removed/i)
  assert.match(lastState(blank.requests).lastClick, /^nothing to delete: no log/)
})

test('a held-back id keeps its row and shows the reason the engine gave', async () => {
  const hidden = []
  const busy = mount({
    menus: true,
    slots: true,
    current: 'session-open-1',
    answer: { removed: [], refused: [], unlogged: [], protected: [{ id: 'session-1', reason: 'a live agent holds this session (status: running)' }] },
    archive: (sessionId) => { hidden.push(sessionId) },
  })
  busy.registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-1' })[0].run()
  await settle()
  await settle()
  assert.deepEqual(hidden, [], 'a held-back row stays exactly where it was')
  assert.match(lastState(busy.requests).lastClick, /status: running/)
  assert.match(JSON.stringify(busy.panels.get('shell.overlay|dsh-cleaner.notice').component()), /status: running/)
})

test('the deletion answer marks a log-less id under workspace.orphans, and that is done', async () => {
  // Captured verbatim from the running Host: the answer has no `unlogged` field at all; what it carries is
  // `workspace.orphans`, `workspace.detached` and `query.still_listed: []`. Reading the listing's field on a
  // deletion answer is why a finished click kept printing 未删除.
  const hidden = []
  const blank = mount({
    menus: true,
    slots: true,
    current: 'session-open-1',
    answer: {
      removed: [], removed_count: 0, removed_bytes: 0,
      trash: { root: 'D:\\MYPROJS\\.agents\\cleaner\\trash', retention_days: 30, recoverable: [] },
      failed: [],
      refused: [{ id: 'session-blank-1', reason: 'no session directory is stored under that id' }],
      workspace: { registry: 'workspaceRegistry', detached: ['session-blank-1'], archived: [], orphans: ['session-blank-1'], restored: [] },
      query: { backend: 'sessionQuery', still_listed: [] },
      verify: { backend: 'not-asked' },
    },
    archive: (sessionId) => { hidden.push(sessionId) },
  })
  blank.registrations.get('dsh-cleaner.delete-log').resolve({ sessionId: 'session-blank-1' })[0].run()
  await settle()
  await settle()
  assert.match(lastState(blank.requests).lastClick, /^nothing to delete: no log/)
  assert.match(JSON.stringify(blank.panels.get('shell.overlay|dsh-cleaner.notice').component()), /no log — row removed/i)
  assert.deepEqual(hidden, ['session-blank-1'], 'and the row is asked to leave')
})

test('closing the plugin takes every contribution with it', async () => {
  // The promise this plugin makes about the product's interface: while it is closed, none of its rows, seats or
  // keys are there and nothing about the window is left changed. The client kernel evicts the module and disposes
  // its effects; every contribution has to be inside one, or it outlives the plugin it belongs to.
  const mounted = mount({ menus: true, locale: true, slots: true, shortcuts: true, current: 'session-open-1' })
  assert.equal(mounted.registrations.size, 1, 'the session menu row is there while the plugin is open')
  assert.ok(mounted.panels.size >= 3, 'and the settings page, its icon and the notice')
  assert.equal(mounted.shortcuts.length, 1, 'and the key')

  for (const dispose of [...mounted.cleanup]) dispose?.()

  assert.equal(mounted.registrations.size, 0, 'no menu row survives the plugin')
  assert.equal(mounted.panels.size, 0, 'no settings page, icon or notice survives it')
  assert.equal(mounted.shortcuts.length, 0, 'no key survives it')
})
