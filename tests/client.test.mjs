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
  assert.deepEqual([...built.inject], ['remote.session'], 'it waits for the session list it prunes against')
  return built
}

/** Mount the half against a fake page and return what it did. */
function mount({ views, list, answer }) {
  const store = storage(views)
  const listeners = new Map()
  const page = {
    localStorage: store,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  }
  const calls = []
  const cleanup = []
  const ctx = {
    remote: {
      session: {
        list: async (request) => {
          calls.push(request)
          if (list !== undefined) return list()
          return answer
        },
      },
    },
    effect: (run) => {
      const dispose = run()
      cleanup.push(dispose)
      return dispose
    },
  }
  plugin(register(page)).apply(ctx)
  return { store, calls, listeners, cleanup }
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
