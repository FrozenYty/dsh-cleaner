/**
 * The browser half against a fake window.
 *
 * `client.js` is not a module: the page's module loader evaluates it and it registers a factory. So this
 * test evaluates the same source the page evaluates, in a `vm` context with a stub `window`, and then
 * drives the plugin the way the page does — through `apply(ctx)` with a fake `remote.session.list`.
 *
 * What it proves: the ids a view kept that the host no longer lists are dropped, the ids that still exist
 * are kept in their order, nothing else in storage is touched, and every unanswerable case leaves the view
 * exactly as the person arranged it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** A localStorage face with the two methods the half uses plus the iteration the platform defines. */
function storage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    get length() {
      return entries.size
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (name) => (entries.has(name) ? entries.get(name) : null),
    setItem: (name, value) => entries.set(name, String(value)),
    entries,
  }
}

/** Evaluate `client.js` the way the page does — registering, not importing. */
function register(page = { __ModuleLoader__: { load: () => {} } }) {
  const loaded = []
  page.__ModuleLoader__ = { load: (definition) => loaded.push(definition) }
  const context = { window: page }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the file registers exactly one client plugin')
  return loaded[0]
}

/** The plugin object the loader's factory returns, with `require` that must never be called. */
function plugin(definition) {
  const built = definition.factory(() => {
    throw new Error('the browser half imports nothing')
  })
  // The plugin object comes from the page's realm, so its array is compared by content, not identity.
  assert.deepEqual(
    [...built.inject],
    ['remote.session', 'remote.commands'],
    'it waits for the session list it prunes against, and for the command its menu item runs',
  )
  return built
}

/**
 * Mount the half against a fake page and return what it did.
 * @param options - the views to plant, the host's answer, and the optional client services.
 */
function mount({ views, list, answer, menus, locale, commands, shortcuts, current, silent } = {}) {
  const store = storage(views)
  const listeners = new Map()
  const page = {
    localStorage: store,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  }
  if (current !== undefined) store.setItem('dsh.sessions.current', JSON.stringify({ sessionId: current }))
  const calls = []
  const cleanup = []
  const executed = []
  const listed = []
  const registered = []
  const registeredShortcuts = []
  const registrations = new Map()
  const ctx = {
    remote: {
      session: {
        list: async (request) => {
          calls.push(request)
          if (list !== undefined) return list()
          return answer
        },
      },
      commands: {
        list: async (sessionId) => {
          listed.push(sessionId)
          if (commands === undefined) return [{ name: 'clean', description: 'stub' }]
          if (typeof commands === 'function') return commands(sessionId)
          return commands
        },
        execute: async (sessionId, line, attachments) => {
          executed.push({ sessionId, line, attachments })
          // A host that does not know the command answers `undefined`, exactly as the registry does.
          return silent ? undefined : { commandId: 'command-1', result: { kind: 'success' } }
        },
      },
    },
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
        return {
          register: (definition) => {
            registeredShortcuts.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'locale') {
        return { getLocale: () => ({ active: locale ?? 'en', locales: [], revision: 1 }) }
      }
      return undefined
    },
    effect: (run) => {
      const dispose = run()
      cleanup.push(dispose)
      return dispose
    },
  }
  plugin(register(page)).apply(ctx)
  return {
    store,
    calls,
    listeners,
    cleanup,
    executed,
    registered,
    registrations,
    listed,
    shortcuts: registeredShortcuts,
  }
}

const VIEW = (buckets) => JSON.stringify({ groupBy: 'workspace-tree', orderBy: 'manual', sessionOrderByAccount: buckets })

test('the registered id is the package the Host installed', () => {
  const definition = register()
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(definition.id, manifest.name)
})

test('a page load drops the ids the view kept that the host no longer lists', async () => {
  const { store, calls } = mount({
    views: {
      'dsh.workspace.view.v5': VIEW({
        'project-a': ['session-live-1', 'session-gone-1', 'session-live-2'],
        '': ['session-gone-2', 'session-live-3'],
      }),
      'something-else': 'untouched',
    },
    answer: { items: [{ sessionId: 'session-live-1' }, { sessionId: 'session-live-2' }, { sessionId: 'session-live-3' }] },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1, 'it asks the host for the list, once')
  assert.deepEqual(Object.keys(calls[0]), [], 'and asks for everything, with no filter')
  assert.deepEqual(JSON.parse(store.getItem('dsh.workspace.view.v5')).sessionOrderByAccount, {
    'project-a': ['session-live-1', 'session-live-2'],
    '': ['session-live-3'],
  })
  // Order is the person's arrangement: what survives keeps its place, and what does not is gone.
  assert.equal(store.getItem('something-else'), 'untouched')
})

test('every version of the view key is repaired, and a second pass writes nothing', async () => {
  const views = {
    'dsh.workspace.view.v4': VIEW({ '': ['session-gone-1', 'session-live-1'] }),
    'dsh.workspace.view.v5': VIEW({ '': ['session-gone-1', 'session-live-1'] }),
  }
  const first = mount({ views, answer: [{ id: 'session-live-1' }] })
  await new Promise((resolve) => setImmediate(resolve))
  const repaired = first.store.getItem('dsh.workspace.view.v5')
  assert.equal(repaired.includes('session-gone-1'), false)
  assert.equal(first.store.getItem('dsh.workspace.view.v4').includes('session-gone-1'), false)

  // A load that finds nothing to repair must not rewrite the value: a write is a change of a person's view.
  const second = mount({ views: { 'dsh.workspace.view.v5': repaired }, answer: [{ id: 'session-live-1' }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(second.store.getItem('dsh.workspace.view.v5'), repaired)
})

test('a deletion made while the window was in the background is repaired when it returns', async () => {
  let listed = [{ sessionId: 'session-live-1' }, { sessionId: 'session-gone-1' }]
  const { store, listeners } = mount({
    views: { 'dsh.workspace.view.v5': VIEW({ '': ['session-gone-1', 'session-live-1'] }) },
    list: () => ({ items: listed }),
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getItem('dsh.workspace.view.v5').includes('session-gone-1'), true, 'nothing is dropped while the host still lists it')

  listed = [{ sessionId: 'session-live-1' }]
  assert.equal(typeof listeners.get('focus'), 'function', 'the page can call it back into work')
  listeners.get('focus')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getItem('dsh.workspace.view.v5').includes('session-gone-1'), false)
})

test('every unanswerable case leaves the view as the person arranged it', async () => {
  const view = VIEW({ '': ['session-gone-1', 'session-live-1'] })
  const cases = [
    ['a list call that throws', { list: () => { throw new Error('gateway down') } }],
    ['an empty list', { answer: { items: [] } }],
    ['a list with no usable ids', { answer: { items: [{ nothing: true }] } }],
    ['an answer that is not a list', { answer: undefined }],
  ]
  for (const [name, options] of cases) {
    const { store } = mount({ views: { 'dsh.workspace.view.v5': view }, ...options })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(store.getItem('dsh.workspace.view.v5'), view, name)
  }
})

test('a view that is not the shape this half repairs is left alone', async () => {
  const cases = {
    'dsh.workspace.view.v5': 'not json at all',
    'dsh.workspace.view.v6': JSON.stringify({ groupBy: 'flat' }),
    'dsh.workspace.view.v7': JSON.stringify({ sessionOrderByAccount: { '': 'not an array' } }),
  }
  const { store } = mount({ views: cases, answer: [{ sessionId: 'session-live-1' }] })
  await new Promise((resolve) => setImmediate(resolve))
  for (const [name, value] of Object.entries(cases)) assert.equal(store.getItem(name), value, name)
})

test('each pass leaves one mark, so the half can be seen from outside the page', async () => {
  const { store } = mount({
    views: { 'dsh.workspace.view.v5': VIEW({ '': ['session-gone-1', 'session-live-1'] }) },
    answer: [{ sessionId: 'session-live-1' }],
  })
  await new Promise((resolve) => setImmediate(resolve))

  const mark = JSON.parse(store.getItem('dsh-cleaner.client.v1'))
  assert.equal(mark.dropped, 1)
  assert.equal(mark.listed, 1)
  assert.match(mark.at, /^\d{4}-\d{2}-\d{2}T/)
})

test('the listener is registered as an effect, so an unloaded plugin leaves no handler behind', () => {
  const { listeners, cleanup } = mount({
    views: {},
    answer: [],
  })
  assert.equal(typeof listeners.get('focus'), 'function')
  assert.equal(typeof cleanup[0], 'function', 'apply returns the cleanup the page can run')
  cleanup[0]()
  assert.equal(listeners.has('focus'), false, 'the handler is gone with it')
})

test('a session menu item runs the command for that session, and nothing else', async () => {
  const { registered, registrations, executed, cleanup } = mount({
    views: {},
    answer: [{ sessionId: 'session-live-1' }],
    menus: true,
  })

  assert.equal(registered.length, 1, 'one data contribution, no renderer')
  const entry = registered[0]
  assert.equal(entry.target, 'session')
  assert.equal(typeof entry.resolve, 'function')
  assert.equal(typeof entry.run, 'undefined', 'the click belongs to the item it resolves, not the entry')

  const [item] = await entry.resolve({ sessionId: 'session-archived-1' })
  assert.equal(item.label, 'Delete session', 'the label follows the window language')
  assert.equal(typeof item.run, 'function')
  // Presentation: the same pair 删除工作区 uses — the product's destructive treatment and the trash glyph the
  // workspace plugin registered in the shared icon slot — sorted last, in the ordinary group.
  assert.equal(item.danger, true, 'the colour 删除工作区 has')
  assert.equal(entry.order, 9000, 'after every session action the build registers, Archive (600) included')
  assert.equal(item.afterContent, undefined, 'the footer group renders before the component rows')
  assert.equal(item.icon.key, 'workspace.delete')

  item.run()
  await new Promise((resolve) => setImmediate(resolve))
  // Compared field by field: the arguments come from the page's realm, so their arrays are not this
  // realm's arrays even when they hold the same values.
  assert.equal(executed.length, 1)
  assert.equal(executed[0].sessionId, 'session-archived-1')
  assert.equal(executed[0].line, '/clean session-archived-1')
  assert.equal(executed[0].attachments.length, 0)

  // No target, no item: the menu must not offer a deletion it cannot name.
  assert.equal((await entry.resolve(undefined)).length, 0)
  assert.equal((await entry.resolve({})).length, 0)

  // The contribution goes away with the plugin.
  assert.equal(registrations.size, 1)
  cleanup[0]()
  assert.equal(registrations.size, 0)
})

test('the menu label is Chinese when the window is', async () => {
  const { registered } = mount({ views: {}, answer: [], menus: true, locale: 'zh-CN' })
  const [item] = await registered[0].resolve({ sessionId: 'session-1' })
  assert.equal(item.label, '删除会话')
})

test('a host that has no clean command contributes no row at all', async () => {
  // The window half reloads with the page and the host half only reloads with the process, so this is the
  // normal state right after an update — and a row that runs an unknown command is worse than no row: the
  // click becomes ordinary text, the session's agent answers, and the person reads a failure that never
  // happened.
  const { registered, executed, listed } = mount({
    views: {},
    answer: [],
    menus: true,
    commands: [{ name: 'compact', description: 'some other command' }],
  })

  assert.equal((await registered[0].resolve({ sessionId: 'session-1' })).length, 0)
  assert.deepEqual(listed, ['session-1'], 'the host was asked which commands it has')
  assert.deepEqual(executed, [], 'and nothing was executed')
})

test('the command list is asked once per session, and an unreadable list hides the row', async () => {
  const asked = []
  const { registered } = mount({
    views: {},
    answer: [],
    menus: true,
    commands: (sessionId) => {
      asked.push(sessionId)
      return [{ name: 'clean', description: 'stub' }]
    },
  })

  const entry = registered[0]
  assert.equal((await entry.resolve({ sessionId: 'session-1' })).length, 1)
  assert.equal((await entry.resolve({ sessionId: 'session-1' })).length, 1)
  assert.deepEqual(asked, ['session-1'], 'the second open reuses the answer')

  // A second session is its own question: scoped commands shadow globals per agent.
  await entry.resolve({ sessionId: 'session-2' })
  assert.deepEqual(asked, ['session-1', 'session-2'])

  // A list call that throws is not evidence that the command exists, so no row is offered: a click that
  // fails reads worse than a row that is missing.
  const failing = mount({
    views: {},
    answer: [],
    menus: true,
    commands: () => { throw new Error('gateway down') },
  })
  assert.equal((await failing.registered[0].resolve({ sessionId: 'session-3' })).length, 0)
})

test('a click that reaches a host without the command stops offering the row', async () => {
  // The guard reads the command list, but the host can still answer `undefined` — a race, or a build whose
  // list endpoint lies. Then the row is withdrawn for that session rather than failing a second time.
  const { registered, executed } = mount({
    views: {},
    answer: [],
    menus: true,
    commands: [{ name: 'clean', description: 'stub' }],
    silent: true,
  })
  const entry = registered[0]
  const [item] = await entry.resolve({ sessionId: 'session-1' })
  assert.equal(typeof item.run, 'function', 'the list said the command exists, so the row is offered')

  item.run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(executed.length, 1)
  assert.equal((await entry.resolve({ sessionId: 'session-1' })).length, 0, 'the host answered nothing, so no second try')
})

test('a registration the host refuses costs the row and nothing else', async () => {
  // Learned the hard way: a contribution this bundle could not register once took the whole menu down with
  // it, so every registration is isolated and a failure is reported instead of thrown.
  const { store, registered } = mount({
    views: { 'dsh.workspace.view.v5': VIEW({ '': ['session-gone-1', 'session-live-1'] }) },
    answer: [{ sessionId: 'session-live-1' }],
    menus: 'refuse',
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(registered, [], 'the contribution was refused')
  assert.equal(store.getItem('dsh.workspace.view.v5').includes('session-gone-1'), false, 'the view is still pruned')
})

test('a page without the menus service still prunes the view', async () => {
  const { store, registered } = mount({
    views: { 'dsh.workspace.view.v5': VIEW({ '': ['session-gone-1', 'session-live-1'] }) },
    answer: [{ sessionId: 'session-live-1' }],
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(registered, [], 'no service, no contribution, and no throw')
  assert.equal(store.getItem('dsh.workspace.view.v5').includes('session-gone-1'), false)
})
