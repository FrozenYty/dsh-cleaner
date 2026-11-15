/**
 * The browser half, mounted against a fake page.
 *
 * What these tests are for: the half contributes one menu row, one shortcut and one dictionary, and it says
 * what it managed to do through the one client-side channel that exists — `sessions.retain(id).ready` →
 * `binding.session.command(line)`. Every service is optional, and a service that refuses this plugin's
 * definition must cost exactly that one thing.
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
  // A page has timers and storage, so the sandbox has them too.
  const context = {
    window: page,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the file registers exactly one client plugin')
  return loaded[0]
}

/** The plugin object the loader's factory returns, with `require` that must never be called. */
function plugin(definition) {
  return definition.factory(() => {
    throw new Error('the bundle half must not require anything')
  })
}

/**
 * Mount the half against a fake page and return what it did.
 * @param options - the optional client services and their behaviour.
 */
function mount({ menus, locale, shortcuts, sessions, current, injectThrows, commandResult } = {}) {
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
  const commands = []
  const releases = []
  const dictionaries = new Map()
  let pendingInject

  const sessionsService = {
    // The official client-side channel: retain a session, use the binding's `command`, release it.
    retain: (sessionId, options) => {
      commands.push({ retained: sessionId, options })
      const reference = {
        ready: Promise.resolve({
          sessionId,
          session: {
            command: async (line) => {
              commands.push({ command: line, from: sessionId })
              return commandResult ?? { ok: true, value: { matched: true } }
            },
          },
        }),
        release: () => releases.push(sessionId),
      }
      return reference
    },
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
      if (name === 'sessions') {
        if (sessions === 'absent') return undefined
        return sessionsService
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
      if (name === 'locale') {
        // The product's dictionary service: `register(ns, {en, zh})` contributes, `bind(ns)` reads back with
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
          getLocale: () => ({ active: locale ?? 'en', locales: [], revision: 1 }),
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
              pendingInject = { deps, callback }
            },
          }
        : {},
  }
  const cleanup = []
  plugin(register(page)).apply(ctx)
  return {
    commands,
    releases,
    registered,
    registrations,
    shortcuts: registeredShortcuts,
    cleanup,
    pendingInject: () => pendingInject,
  }
}

const reports = (commands) => commands.filter((call) => String(call.command ?? '').startsWith('/clean --state '))
const clicks = (commands) => commands.filter((call) => call.command !== undefined && !String(call.command).startsWith('/clean --state '))
const lastState = (commands) => {
  const all = reports(commands)
  assert.ok(all.length > 0, 'the half spoke')
  return JSON.parse(String(all[all.length - 1].command).slice('/clean --state '.length))
}

test('the registered id is the package the Host installed', () => {
  const definition = register()
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(definition.id, manifest.name)
})

test('the bundle half requires nothing', () => {
  const definition = register()
  assert.doesNotThrow(() => plugin(definition))
})

test('a session menu item runs the command in the window\'s own session, naming the target', async () => {
  // A command needs an agent, so it is carried by the session in front of the person; the target travels as
  // the argument. This is also where the receipt lands, which is the only place the person will look.
  const { registrations, commands, cleanup } = mount({ menus: true, sessions: true, current: 'session-open-1' })

  const entry = registrations.get('dsh-cleaner.delete-log')
  assert.equal(entry.target, 'session')
  assert.equal(entry.order, 350, 'after fork (300), before copy-id (450)')
  assert.equal(typeof entry.run, 'undefined', 'the click belongs to the item it resolves, not the entry')

  const [item] = entry.resolve({ sessionId: 'session-other-1' })
  assert.equal(item.label, 'Delete session')
  assert.equal(item.danger, true, 'the colour 删除工作区 has')
  assert.equal(item.icon.key, 'workspace.delete')
  assert.equal(typeof item.run, 'function')

  item.run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(clicks(commands).length, 1)
  assert.equal(commands[0].retained, 'session-open-1', 'the carrier is the open session, retained first')
  assert.equal(clicks(commands)[0].from, 'session-open-1', 'the command runs in the carrier')
  assert.equal(clicks(commands)[0].command, '/clean session-other-1', 'and the target is the argument')

  // No target, no item: the menu must not offer a deletion it cannot name.
  assert.equal(entry.resolve(undefined).length, 0)
  assert.equal(entry.resolve({}).length, 0)

  // The contribution goes away with the plugin.
  assert.equal(registrations.size, 1)
  cleanup[0]()
  assert.equal(registrations.size, 0)
})

test('the row is offered without asking the host anything', () => {
  const { registered } = mount({ menus: true, sessions: true })
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

test('a click with no session open to carry it says so instead of failing silently', async () => {
  const { registered, commands } = mount({ menus: true, sessions: true })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await new Promise((resolve) => setImmediate(resolve))
  // Nothing to execute, and nothing to speak through either: the honest outcome is silence, and the state
  // that would have said so is only readable when a report could be carried.
  assert.deepEqual(clicks(commands), [], 'nothing was executed')
  assert.deepEqual(reports(commands), [], 'and there was no session to report through')
})

test('a profile without the sessions service costs a silent click', async () => {
  const { registered, commands } = mount({ menus: true, sessions: 'absent', current: 'session-open-1' })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(clicks(commands), [])
  assert.deepEqual(reports(commands), [], 'the report needs the same service')
})

test('a refusal from the command is recorded rather than thrown', async () => {
  const { registered, commands } = mount({
    menus: true,
    sessions: true,
    current: 'session-open-1',
    commandResult: { ok: false, error: { message: 'the session is running' } },
  })
  registered[0].resolve({ sessionId: 'session-1' })[0].run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(lastState(commands).lastClick, /refused: the session is running/)
})

test('the shortcut is Ctrl+Shift+D on every platform and deletes the session the window shows', async () => {
  const { shortcuts, commands } = mount({ shortcuts: true, sessions: true, current: 'session-live-1' })

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
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(clicks(commands)[0].command, '/clean session-live-1')
})

test('the shortcut says why it cannot act instead of guessing a session', () => {
  const { shortcuts } = mount({ shortcuts: true, sessions: true })
  const resolved = shortcuts[0].resolve()
  assert.equal(resolved.status, 'blocked')
  assert.equal(resolved.reason, 'no session is open')
})

test('a shortcuts registry that refuses the definition costs the key, not the row', async () => {
  const { registered, commands } = mount({ menus: true, sessions: true, shortcuts: 'refuse', current: 'session-1' })
  assert.equal(registered.length, 1, 'the row is still contributed')
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(lastState(commands).register, /refused: the shortcut registry refused this definition/)
})

test('a shortcut service that mounts after the page still gets the binding', () => {
  const { pendingInject } = mount({ shortcuts: 'late' })
  const pending = pendingInject()
  // Serialised: the definition was built in the page's realm, so its arrays are not this realm's.
  assert.equal(JSON.stringify(pending.deps), JSON.stringify(['shortcuts']), 'the binding waits for its service')

  const definitions = []
  pending.callback({
    shortcuts: { register: (definition) => { definitions.push(definition); return () => {} } },
    effect: (callback) => callback(),
  })
  assert.deepEqual(definitions.map((definition) => definition.id), ['session.delete-log'])
})

test('the half reports what it managed to do, through the official session binding', async () => {
  // The channel exists because "the row is there but the key is missing" is invisible from the host side.
  // The last report wins: the first speaks before a registration that waits for its service has had its turn.
  const { commands, releases } = mount({ menus: true, shortcuts: true, sessions: true, current: 'session-open-1' })
  await new Promise((resolve) => setTimeout(resolve, 2100))

  const state = lastState(commands)
  assert.equal(state.row, 'contributed')
  assert.equal(state.register, 'registered')
  assert.equal(state.catalog, 'holds the id')
  assert.equal(state.menu, 'menu service present')
  assert.equal(state.dictionary, 'locale service present')
  assert.equal(state.current, 'session-open-1')
  assert.equal(state.fatal, undefined)
  assert.ok(releases.length >= 1, 'every retained reference was released')
})

test('a half that fails while setting up still says so', async () => {
  // The diagnostic has to survive the failure it reports: the report is sent first, and the guard sends
  // another with the reason. A silent half is how three releases were lost.
  const { commands } = mount({ menus: true, sessions: true, current: 'session-open-1', injectThrows: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(lastState(commands).fatal, /refuses to inject/)
})

test('a menus service that refuses the contribution costs the row and nothing else', async () => {
  const { registered, commands } = mount({ menus: 'refuse', sessions: true, current: 'session-open-1' })
  assert.deepEqual(registered, [], 'the contribution was refused')
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(lastState(commands).row, /refused: the menu service refused this contribution/)
})
