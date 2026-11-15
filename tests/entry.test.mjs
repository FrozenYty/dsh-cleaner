/**
 * The bundle entry's tool surface, with a fake Host context.
 *
 * The engine is covered directly by engine.test.mjs, so a mistake that lives only here — a missing
 * `exec`, a guard that reads the caller but does not apply it, a tool that deletes on the listing
 * call — would otherwise reach the model and nothing else. The plugin resolves its paths from
 * DSH_HOME, so the whole file points DSH_HOME at a fixture and never reads the real one.
 */

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { chmod, mkdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'

import { apply } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const TMP = join(here, '.tmp-entry')
const ROOT = join(TMP, 'sessions')
const WORKSPACE = join(TMP, 'storages', 'workspace.json')
const CALLER = 'session-caller'
const PREVIOUS_HOME = process.env.DSH_HOME
const PREVIOUS_DATA_DIR = process.env.DSH_CLEANER_DATA_DIR

const ARCHIVED = [
  { id: 'session-archived-1', project: '--D-ALPHA--', bytes: 100 },
  { id: 'session-archived-2', project: '--D-ALPHA--', bytes: 200 },
]
const LIVE = { id: 'session-live-1', project: '--D-ALPHA--', bytes: 50 }

async function writeSession({ id, project, bytes }) {
  const dir = join(ROOT, project, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 1))
}

async function writeWorkspace(ids) {
  await mkdir(dirname(WORKSPACE), { recursive: true })
  await writeFile(WORKSPACE, JSON.stringify({ global: { archivedSessionIds: ids }, tables: {} }))
}

/** The projection cache the runtime keeps beside the store, with only the row this plugin reads. */
async function writeProjection(id, title) {
  const dir = join(TMP, 'storages', 'session_projcache', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 2, val: title } } } }),
  )
}

/** A context with only what this plugin reaches for: the registry, `agents`, the seam, the query and the workspaces. */
function harness({ agents = [], persistence, workspaces, query, sessions, workingDirectory, commands = true, webServer = true } = {}) {
  const tools = new Map()
  const registered = new Map()
  const routes = new Map()
  const disposed = []
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect: (callback) => {
      const disposer = callback()
      disposed.push(disposer)
      return () => disposer?.()
    },
    get: (name) => {
      if (name === 'sessions') return sessions
      if (name === 'workingDirectory') return workingDirectory
      if (name === 'agents') return { list: () => agents }
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') return query
      if (name === 'workspaceRegistry') return workspaces
      if (name === 'webServer') {
        if (!webServer) return undefined
        return {
          register: (route) => {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        }
      }
      if (name === 'commands') {
        if (!commands) return undefined
        return {
          register: (definition) => {
            registered.set(definition.name, definition)
            return () => registered.delete(definition.name)
          },
        }
      }
      return undefined
    },
  }
  return { ctx, tools, commands: registered, routes, disposed }
}

const install = (options) => {
  const { ctx, tools, commands, routes, disposed } = harness(options)
  // The loader passes the patch row's config as the second argument; a test that supplies one is exercising the
  // documented way a profile configures this plugin.
  apply(ctx, options?.config)
  return Object.assign(tools, { commands, routes, disposed })
}

const caller = { session: { id: CALLER } }
const run = (tool, args, exec = { agent: caller }) => tool.execute(args, exec)
const text = (tool, value) => tool.output.render({}, value)
  .map((block) => block.text)
  .join('\n')
/** Run the human command the way the command registry does, and answer with its result. */
const command = (tools, rawInput) => tools.commands.get('clean').handler({
  commandId: 'command-1',
  agent: caller,
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

/** The store this suite reads: three archived sessions and one that was never archived, plus the caller. */
async function buildFixture() {
  await rm(TMP, { recursive: true, force: true })
  for (const session of ARCHIVED) await writeSession(session)
  await writeSession(LIVE)
  await writeSession({ id: CALLER, project: '--D-ALPHA--', bytes: 999 })
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER])
}

before(async () => {
  process.env.DSH_HOME = TMP
  // This plugin's own data goes under the fixture too. Without it the suite would write a trash into the
  // real `~/.dsh/cleaner` (or worse, into a workspace), and a test that touches real data is not a test.
  process.env.DSH_CLEANER_DATA_DIR = join(TMP, 'cleaner')
})

beforeEach(buildFixture)

after(async () => {
  await rm(TMP, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.DSH_CLEANER_DATA_DIR
  else process.env.DSH_CLEANER_DATA_DIR = PREVIOUS_DATA_DIR
})

test('the entry registers exactly the listing and the deleting tool', () => {
  const tools = install()
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs', 'trash_session_logs'])
  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
  }
  assert.deepEqual(tools.get('list_session_logs').parameters.properties, {})
  assert.deepEqual(tools.get('delete_session_logs').parameters.required, ['session_ids'])
})

test('the listing tool deletes nothing and names the bytes it found', async () => {
  const tools = install()
  const value = await run(tools.get('list_session_logs'), {})

  assert.deepEqual(
    value.candidates.map((entry) => entry.id).sort(),
    ['session-archived-1', 'session-archived-2', LIVE.id],
    'every stored session is offered, archived or not',
  )
  assert.equal(value.total_bytes, 350)
  assert.equal(value.stored_bytes, 350 + 999)
  const rendered = text(tools.get('list_session_logs'), value)
  assert.ok(rendered.includes('Nothing was deleted.'))
  assert.match(rendered, /The session store holds 4 directories/)
  assert.match(rendered, /last write \d{4}-\d{2}-\d{2}T/)
  assert.match(rendered, /\b1 file\b/, 'a count of one reads as a person writes it')
  assert.doesNotMatch(rendered, /file\(s\)/)
  assert.match(
    rendered,
    /Kept, protected: session-caller — the session running this command/,
    'the listing names what it kept, not only what it would delete',
  )
  for (const candidate of value.candidates) assert.ok(existsSync(candidate.path))
})

test('a listing with nothing left to delete does not invite a deletion call', async () => {
  const tools = install()
  await run(tools.get('delete_session_logs'), {
    session_ids: ['session-archived-1', 'session-archived-2', LIVE.id],
  })
  const value = await run(tools.get('list_session_logs'), {})
  assert.deepEqual(value.candidates, [])

  const rendered = text(tools.get('list_session_logs'), value)
  assert.match(rendered, /there is nothing to delete/)
  assert.match(rendered, /Already gone/)
  assert.doesNotMatch(rendered, /call delete_session_logs/)
})

test('a directory the walk refused is named in the listing, with the reason', async () => {
  const tools = install()
  const link = join(ROOT, '--D-LINKED--')
  await symlink(join(ROOT, '--D-ALPHA--'), link, process.platform === 'win32' ? 'junction' : 'dir')

  try {
    const value = await run(tools.get('list_session_logs'), {})
    assert.equal(value.skipped.length, 1)

    const rendered = text(tools.get('list_session_logs'), value)
    assert.match(rendered, /Not a candidate: .*--D-LINKED-- — not a directory; a link at this level is not followed/)
  } finally {
    // A junction is a directory entry, a symlink is not: `rmdir` removes the first and fails with ENOTDIR
    // on the second, which is the same split the engine has to live with. Neither call descends the link.
    if (process.platform === 'win32') await rmdir(link)
    else await unlink(link)
  }
})

test('a long list of already-deleted ids is counted and marked, not printed whole', async () => {
  const tools = install()
  const gone = Array.from({ length: 14 }, (_, index) => `session-gone-${index + 1}`)
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), ...gone])

  const value = await run(tools.get('list_session_logs'), {})
  assert.equal(value.already_gone.length, 14)
  assert.equal(value.candidates.length, 3)

  const rendered = text(tools.get('list_session_logs'), value)
  assert.match(rendered, /Already gone \(archived, but no directory is stored\): 14 — session-gone-1\b/)
  assert.match(rendered, /and 4 more/)
  assert.doesNotMatch(rendered, /session-gone-14/, 'the tail is marked, not printed')
})

test('a megabyte-sized number is reported in MiB, not only in bytes', () => {
  const tools = install()
  const value = {
    sessions_root: '/store',
    workspace_file: '/store/workspace.json',
    archived_ids: 0,
    stored_sessions: 0,
    stored_bytes: 1572864,
    candidates: [],
    total_bytes: 0,
    already_gone: [],
    protected: [],
    skipped: [],
    requested: [],
  }

  assert.match(text(tools.get('list_session_logs'), value), /1572864 bytes \(1\.50 MiB\) in all/)
})

test('the deletion answer names a partial removal and a backend it could not re-read', () => {
  const tools = install()
  const value = {
    sessions_root: '/store',
    removed: [{ id: 'session-archived-1', path: '/store/a', files: 1, bytes: 100 }],
    removed_count: 1,
    removed_bytes: 100,
    failed: [{ id: 'session-archived-2', path: '/store/b', error: 'cannot be removed (x): EACCES', bytes_freed: 40 }],
    refused: [{ id: 'session-live-1', reason: 'not an archived session' }],
    verify: { backend: 'sessionPersistence', error: 'the backend went away' },
  }

  const rendered = text(tools.get('delete_session_logs'), value)
  assert.match(rendered, /Partially removed: session-archived-2 — cannot be removed \(x\): EACCES \(40 bytes freed\)/)
  assert.match(rendered, /Kept: session-live-1 — not an archived session/)
  assert.match(rendered, /could not be re-read \(the backend went away\); the deletion above stands/)
})

test('a listing names the sessions the way a person does, and so does the receipt', async () => {
  const tools = install()
  await writeProjection('session-archived-1', '询问模型身份')
  await writeProjection('session-archived-2', '  say   "hi"  ')

  const value = await run(tools.get('list_session_logs'), {})
  const rendered = text(tools.get('list_session_logs'), value)
  assert.match(rendered, /"询问模型身份"  session-archived-1/)
  // Whitespace collapses, and a quote in a title cannot break the line's quoting.
  assert.match(rendered, /"say 'hi'"  session-archived-2/)

  const report = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(report.removed[0].title, '询问模型身份')
  assert.match(text(tools.get('delete_session_logs'), report), /"询问模型身份"  session-archived-1/)
  assert.equal(report.removed_bytes, 100)
})

test('a projection that cannot be read costs a title, not the listing', async () => {
  const tools = install()
  const dir = join(TMP, 'storages', 'session_projcache', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session-archived-1.json'), '{ this is not json')
  // session-archived-2 has no projection file at all.

  const value = await run(tools.get('list_session_logs'), {})
  assert.equal(value.candidates.length, 3)
  for (const candidate of value.candidates) assert.equal('title' in candidate, false)
  assert.match(text(tools.get('list_session_logs'), value), /  session-archived-1  \d+ bytes/)

  const report = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-2'] })
  assert.equal('title' in report.removed[0], false)
  assert.equal(report.removed_bytes, 200)
})

test('the deleting tool removes only the ids it was given, and reports the bytes', async () => {
  const tools = install()
  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })

  assert.deepEqual(value.removed.map((entry) => entry.id), ['session-archived-1'])
  assert.equal(value.removed_count, 1)
  assert.equal(value.removed_bytes, 100)
  assert.deepEqual(value.failed, [])
  assert.deepEqual(value.refused, [])
  assert.match(
    text(tools.get('delete_session_logs'), value),
    /Deleted 1 session directory: 100 bytes/,
    'the singular is spelled out, not templated',
  )
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')), 'an id not given stays')
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))
})

test('a profile without a workspace registry still answers', async () => {
  const tools = install()
  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })

  assert.equal(value.removed_count, 1)
  assert.equal(value.workspace.registry, 'absent')
  assert.match(text(tools.get('delete_session_logs'), value), /No workspace registry is mounted/)
})

test('a registry that refuses a detach cannot fail a deletion that already happened', async () => {
  const workspaces = {
    list: () => [{ sessionIds: ['session-archived-1'], detachSession: async () => { throw new Error('the registry refused') } }],
  }
  const tools = install({ workspaces })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(value.removed_count, 1)
  assert.equal(value.removed_bytes, 100)
  assert.deepEqual(value.workspace.failed, [{ id: 'session-archived-1', error: 'the registry refused' }])
  assert.match(text(tools.get('delete_session_logs'), value), /The workspace list kept session-archived-1/)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
})

test('naming an id whose log is already gone drops its ghost row too', async () => {
  const calls = []
  const workspace = {
    sessionIds: ['session-archived-1'],
    async detachSession(id) {
      calls.push(id)
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id)
    },
  }
  const registry = {
    archivedSessionIds: ['session-archived-1'],
    list: () => [workspace],
  }
  const tools = install({ workspaces: registry })

  // First call removes the log; the row goes with it.
  const first = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(first.removed_count, 1)
  assert.deepEqual(first.workspace.orphans, [])
  assert.deepEqual(workspace.sessionIds, [])

  // Second call has nothing to remove — that is the state a person is left in after a cleanup, and the
  // id they still see in the sidebar is exactly what they can name to be rid of the row.
  workspace.sessionIds = ['session-archived-1']
  const second = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(second.removed_count, 0)
  assert.equal(second.removed_bytes, 0)
  assert.deepEqual(second.workspace.orphans, ['session-archived-1'])
  assert.deepEqual(workspace.sessionIds, [])
  assert.deepEqual(calls, ['session-archived-1', 'session-archived-1'])
  assert.match(text(tools.get('delete_session_logs'), second), /1 of the ids had no log left to remove/)
  assert.doesNotMatch(text(tools.get('delete_session_logs'), second), /persistence backend/)
})

test('a session list that still names a deleted id is reported, because a row can outlive the log', async () => {
  const tools = install({ query: { listSessions: async () => [{ sessionId: 'session-archived-2' }, { sessionId: 'session-archived-1' }] } })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.deepEqual(value.query.still_listed, ['session-archived-1'])
  assert.match(text(tools.get('delete_session_logs'), value), /The session list still names session-archived-1/)
})

test('a session list that no longer names them adds no noise', async () => {
  const tools = install({ query: { listSessions: async () => [{ sessionId: 'some-other-session' }] } })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.deepEqual(value.query.still_listed, [])
  assert.doesNotMatch(text(tools.get('delete_session_logs'), value), /session list/)
})

test('the running session is refused by name, not deleted', async () => {
  const tools = install()
  const value = await run(tools.get('delete_session_logs'), { session_ids: [CALLER] })

  assert.deepEqual(value.removed, [])
  assert.equal(value.removed_bytes, 0)
  assert.deepEqual(value.refused, [{ id: CALLER, reason: 'the session running this command' }])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', CALLER, 'session.v4.jsonl.zstd')))
})

test('a live agent’s session is refused too', async () => {
  const tools = install({ agents: [{ id: 'session-archived-2' }] })
  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-2'] })

  assert.deepEqual(value.removed, [])
  assert.deepEqual(value.refused, [{ id: 'session-archived-2', reason: 'a live agent holds this session' }])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
})

test('an idle agent does not block a deletion, a busy one does, and the answer says which', async () => {
  // The busy case runs first: the idle case is the one that actually removes the directory.
  const busy = install({ agents: [{ id: 'session-archived-2', status: 'running' }] })
  const kept = await run(busy.get('delete_session_logs'), { session_ids: ['session-archived-2'] })
  assert.deepEqual(kept.removed, [])
  assert.deepEqual(kept.refused, [{ id: 'session-archived-2', reason: 'a live agent holds this session (status: running)' }])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))

  const idle = install({ agents: [{ id: 'session-archived-2', status: 'idle' }] })
  const removed = await run(idle.get('delete_session_logs'), { session_ids: ['session-archived-2'] })
  assert.equal(removed.removed_count, 1, 'a resident agent is not a writer')
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')), false)
})

test('an id that is already deleted is refused in the answer, not thrown', async () => {
  const tools = install()
  const value = await run(tools.get('delete_session_logs'), {
    session_ids: [LIVE.id, 'session-archived-2', 'session-archived-2'],
  })

  // An unarchived id is deleted like any other; a repeated id is de-duplicated, not an error.
  assert.deepEqual(value.removed.map((entry) => entry.id).sort(), [LIVE.id, 'session-archived-2'].sort())
  assert.deepEqual(value.refused, [])
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), false)

  const again = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-2'] })
  assert.deepEqual(again.removed, [])
  assert.deepEqual(again.refused, [
    { id: 'session-archived-2', reason: 'no session directory is stored under that id; already deleted' },
  ])
  // Nothing was removed, so the persistence backend is not asked to confirm a removal that did not
  // happen — and the answer says nothing about it.
  assert.deepEqual(again.verify, { backend: 'not-asked' })
  assert.doesNotMatch(text(tools.get('delete_session_logs'), again), /persistence backend/)
})

test('a removal that fails leaves the record where it was, because the files go first', {
  // POSIX refuses to take an entry out of a directory it may not write to; Windows has no portable way to hold
  // a move open, so this runs where it can (CI covers Linux and macOS). Since the deletion is one atomic
  // rename (ADR 0014), the permission that has to be denied is the *parent's*, not the directory's.
  skip: process.platform === 'win32' ? 'no portable way to deny a rename on Windows' : false,
}, async () => {
  const project = join(ROOT, '--D-ALPHA--')
  await chmod(project, 0o500)
  const detachment = []
  const registry = {
    archivedSessionIds: [],
    list: () => [{
      sessionIds: ['session-archived-1'],
      async detachSession(id) { detachment.push(id) },
    }],
  }
  try {
    const tools = install({ workspaces: registry })
    const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })

    // The log is still there, so the row has to be too: the record is written after the files, never before.
    assert.equal(value.removed_count, 0)
    assert.equal(value.failed.length, 1)
    assert.deepEqual(detachment, [], 'nothing was dropped from the workspace record')
    assert.deepEqual(value.workspace.detached, [])
    assert.match(text(tools.get('delete_session_logs'), value), /cannot be moved into the trash/)
  } finally {
    await chmod(project, 0o755)
  }
})

test('a call without a calling Agent, or with no ids, is rejected before anything is touched', async () => {
  const tools = install()
  const tool = tools.get('delete_session_logs')

  await assert.rejects(() => run(tool, { session_ids: [LIVE.id] }, {}), /needs a calling Agent/)
  await assert.rejects(() => run(tool, { session_ids: [] }), /at least one session/)
  await assert.rejects(() => run(tool, { session_ids: [''] }), /non-empty session ids/)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')))
})

test('the answer says what the mounted persistence backend sees after the deletion', async () => {
  const tools = install({ persistence: { list: async () => [{ header: { id: 'session-archived-1' } }] } })
  const stillThere = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })

  assert.deepEqual(stillThere.verify, { backend: 'sessionPersistence', still_listed: ['session-archived-1'] })
  assert.match(text(tools.get('delete_session_logs'), stillThere), /still lists session-archived-1/)

  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER])
  const clean = install({ persistence: { list: async () => [] } })
  const leftover = await run(clean.get('delete_session_logs'), { session_ids: ['session-archived-2'] })
  assert.deepEqual(leftover.verify, { backend: 'sessionPersistence', still_listed: [] })
  assert.match(text(clean.get('delete_session_logs'), leftover), /no longer lists any of them/)

  // No backend mounted at all: a real deletion still reports, and says the disk was the only witness.
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER, 'session-archived-3'])
  await writeSession({ id: 'session-archived-3', project: '--D-ALPHA--', bytes: 33 })
  const absent = install()
  const noBackend = await run(absent.get('delete_session_logs'), { session_ids: ['session-archived-3'] })
  assert.equal(noBackend.removed_count, 1)
  assert.deepEqual(noBackend.verify, { backend: 'absent' })
  assert.match(text(absent.get('delete_session_logs'), noBackend), /no session persistence backend is mounted/)
})

test('a persistence backend that throws cannot fail a deletion that already happened', async () => {
  const tools = install({ persistence: { list: async () => { throw new Error('backend is gone') } } })
  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })

  assert.equal(value.removed_count, 1)
  assert.deepEqual(value.verify, { backend: 'sessionPersistence', error: 'backend is gone' })
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
})

test('the human command is registered with the shape the command registry requires', () => {
  const tools = install()
  const definition = tools.commands.get('clean')

  assert.ok(definition, 'a profile with the commands service gets one command')
  assert.equal(definition.name, 'clean', 'the name is given without a slash')
  assert.match(definition.description, /logs/)
  assert.equal(definition.input.hint.length > 0, true)
  assert.equal(typeof definition.handler, 'function')
  // The registry owns the definition's lifetime; the plugin registers it as an effect. Five effects are
  // registered in a profile with both carriers: the command and the four window routes.
  assert.equal(tools.disposed.length, 5)
  for (const dispose of tools.disposed) dispose()
  assert.deepEqual([...tools.commands.keys()], [])
  assert.deepEqual([...tools.routes.keys()], [], 'and the route goes with the plugin')
})

test('a command registry that mounts after the plugin still gets the command', () => {
  // The registry may appear after this bundle loads. Reading `ctx.get('commands')` once at load missed it
  // silently, which is how the sidebar row came to run a command the host had never heard of — the row was
  // there, the command was not, and nothing said so. `inject` holds the callback until the service exists.
  let pending = []
  const registered = new Map()
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect: (callback) => { const disposer = callback(); return () => disposer?.() },
    get: () => undefined,
    inject: (deps, callback) => { pending.push({ deps, callback }) },
  }

  apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs', 'trash_session_logs'], 'the tools are there')
  // Two registrations wait for their service, and both are named: the command a person types, and the route
  // the window's row uses. A row without that route draws and does nothing, which is the failure this
  // plugin spent the longest on.
  assert.deepEqual(pending.map((entry) => entry.deps), [['commands'], ['webServer']], 'both registrations wait for their service')
  assert.equal(registered.size, 0)
  assert.equal(routes.size, 0)

  // The registries mount, and the Context runs each callback in a scope that carries the service.
  pending[0].callback({
    commands: { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
    effect: ctx.effect,
  })
  assert.deepEqual([...registered.keys()], ['clean'], 'and then the command is registered')

  pending[1].callback({
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect: ctx.effect,
  })
  assert.equal(
    JSON.stringify([...routes.keys()].sort()),
    JSON.stringify(['/dsh-cleaner/delete', '/dsh-cleaner/list', '/dsh-cleaner/state', '/dsh-cleaner/trash']),
    'and the window has a transport',
  )
  for (const route of routes.values()) {
    // Exact paths: a prefix route at `/dsh-cleaner/` registered cleanly and then never matched a request, which
    // is exactly the failure this assertion exists to prevent from coming back.
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})

test('the command lists without deleting, and deletes only what it is given', async () => {
  const tools = install()

  const listed = await command(tools, '')
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /Session logs on disk: 3, 350 bytes \(2 of them archived\)/)
  assert.match(listed.text, /Name the ids to delete: \/clean <id>/)
  // A listing is not a deletion, whatever the command does next.
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')))
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', CALLER)))

  const deleted = await command(tools, 'session-archived-1, session-archived-2')
  assert.equal(deleted.kind, 'success')
  assert.match(deleted.text, /Deleted 2 session directories/)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')), false)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), 'an id the command did not name stays')

  // Unarchived sessions are a command away too, because the rule is the same one the tool follows.
  const unarchived = await command(tools, LIVE.id)
  assert.match(unarchived.text, /Deleted 1 session directory/)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), false)
})

test('the command and the tool answer the same thing for the same ids', async () => {
  const tools = install()
  const toolValue = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  const toolText = text(tools.get('delete_session_logs'), toolValue)

  // The same ids against the same store, from a fresh fixture: one implementation, two callers.
  await buildFixture()
  const tools2 = install()
  const commandValue = await command(tools2, 'session-archived-1')

  // One implementation, two callers: the wording cannot drift, because both render the same value.
  assert.equal(commandValue.text, toolText)
})

test('the command records what a window reports, and answers without a line', async () => {
  // The browser half has no channel to the host except this registry, so it borrows the command: `/clean
  // --state {…}` is recorded and the next listing says it. Silent on purpose — a diagnostic must not put a
  // line in anybody's transcript.
  const tools = install()
  const state = { inject: true, service: 'present', register: 'registered', catalog: 'holds the id', menu: 'menu service present' }
  const recorded = await tools.commands.get('clean').handler({
    commandId: 'command-1',
    agent: caller,
    rawInput: `--state ${JSON.stringify(state)}`,
    attachments: [],
  })
  assert.equal(recorded.kind, 'success')
  assert.equal(recorded.text, undefined, 'nothing is written into the transcript')

  const listing = await run(tools.get('list_session_logs'), {})
  assert.match(listing.client_half, /register=registered/)
  assert.match(listing.client_half, /catalog=holds the id/)
  assert.match(text(tools.get('list_session_logs'), listing), /Window half: inject=true/)

  // A `--state` that is not a JSON object is not a report: it is handed to the ordinary path, and what was
  // recorded stays as it was. The flag can therefore never make the command go quiet on a person.
  const before = (await run(tools.get('list_session_logs'), {})).client_half
  const listed = await command(tools, '--state nonsense')
  assert.equal(listed.kind, 'success')
  assert.equal((await run(tools.get('list_session_logs'), {})).client_half, before)
})

test('the command refuses in the answer instead of throwing, and keeps the caller', async () => {
  const tools = install()
  const gone = await command(tools, 'session-never-existed')
  assert.equal(gone.kind, 'success', 'a refusal is an answer, not a failed command')
  assert.match(gone.text, /Deleted nothing/)
  assert.match(gone.text, /Kept: session-never-existed — no session directory is stored under that id/)

  const itself = await command(tools, CALLER)
  assert.match(itself.text, /Kept: session-caller — the session running this command/)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', CALLER)))
})

test('a profile without the commands service still registers its tools', () => {
  const tools = install({ commands: false })
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs', 'trash_session_logs'])
  assert.equal(tools.commands.size, 0)
  assert.equal(tools.routes.size, 4, 'the window keeps its transport without a command registry')
})



/**
 * Call a route the way the carrier does: a **handler** with a Node request and response.
 *
 * The read-only `resource` shape is not what this plugin registers — that one is refused for any method but GET
 * and HEAD before matching — so the fixture hands over the raw request the way the carrier does, and reads the
 * answer off the response object.
 */
async function callRoute(tools, action, raw, method = 'POST') {
  const registered = tools.routes.get(`/dsh-cleaner/${action}`)
  assert.ok(registered, `the window has a transport for ${action}`)
  const text = raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
  const request = {
    method,
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
  const chunks = []
  const response = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(chunk)
    },
  }
  await registered.handler(request, response)
  const answer = chunks.join('')
  return { status: response.statusCode, text: answer, value: answer === '' ? undefined : JSON.parse(answer) }
}

/** One POST with a JSON body, which is what every route call the window makes looks like. */
async function route(tools, action, body, method = 'POST') {
  return callRoute(tools, action, method === 'POST' ? body ?? {} : undefined, method)
}

test('the row deletes through one route call, and the answer says what moved', async () => {
  // This is the path the sidebar row takes, and the reason it exists: no agent is involved anywhere in it.
  const tools = install()
  const { status, value } = await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-1'] })

  assert.equal(status, 200)
  assert.deepEqual(value.removed.map((entry) => entry.id), ['session-archived-1'])
  assert.equal(value.removed_bytes, 100)
  assert.deepEqual(value.trash.recoverable, ['session-archived-1'])
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false, 'out of the store at once')
})

test('a route call with no caller deletes: a window is not an agent', async () => {
  // The window names itself for the record, and that name is deliberately **not** treated as an Agent: a route
  // runs nothing, so there is no session that has to survive its own request. A caller-less call is still a
  // person's click, and it deletes.
  const tools = install()
  const { status, value } = await route(tools, 'delete', { ids: ['session-archived-1'] })
  assert.equal(status, 200)
  assert.equal(value.removed_count, 1)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false, 'and the log is gone')
})

test('the session the window is showing is deletable, because it is not running anything', async () => {
  // This is the case that made the row useless: a person opens a session, clicks its own ⋯ → 删除会话, and the
  // guard for the *command* carrier refused it as "the session running this command". A route runs nothing, so
  // the row in front of the person is exactly the row that must go.
  const tools = install()
  const { value } = await route(tools, 'delete', { caller: CALLER, ids: [CALLER] })
  assert.deepEqual(value.refused.map((entry) => entry.id), [])
  assert.equal(value.removed_count, 1)
  assert.equal(existsSync(join(ROOT, '--D-BETA--', CALLER)), false)
})

test('the command carrier still refuses its own session, and the tool still refuses its own', async () => {
  // The agent path is the one that must be protected: deleting the log of the session whose turn is running
  // would pull the file out from under the writer.
  const tools = install()
  const answer = await command(tools, `/clean ${CALLER}`)
  assert.match(answer.text, /Kept/)
})

test('the route lists without deleting, and names the trash in the same answer', async () => {
  const tools = install()
  // The window names the session it is showing, and that session is a **candidate**: a route runs nothing, so
  // there is no session that has to survive its own request, and the row in front of the person is the row this
  // whole plugin exists to remove.
  const { status, value } = await route(tools, 'list', { caller: CALLER })
  assert.equal(status, 200)
  assert.equal(value.candidates.length, 4)
  assert.deepEqual(value.protected.map((entry) => entry.id), [])
  assert.equal(value.window_transport, 'routes /dsh-cleaner/delete /dsh-cleaner/list /dsh-cleaner/trash /dsh-cleaner/state registered')
  assert.equal(value.trash.count, 0)

  await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-2'] })
  const after = (await route(tools, 'list', { caller: CALLER })).value
  assert.equal(after.candidates.length, 3)
  assert.equal(after.trash.count, 1)
  assert.equal(after.trash.bytes, 200)
})

test('a deleted session can be put back, and only a purge frees its bytes', async () => {
  // The recovery path a person needs after a mistake, in three calls: delete, restore, purge — each of which
  // says what it did.
  const tools = install()
  await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-1', 'session-archived-2'] })

  const held = (await route(tools, 'trash', { op: 'list' })).value
  assert.equal(held.trash.count, 2)

  const back = (await route(tools, 'trash', { op: 'restore', ids: ['session-archived-1'] })).value
  assert.deepEqual(back.restored.map((entry) => entry.id), ['session-archived-1'])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), 'the backend finds it again')
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')), false)

  const purged = (await route(tools, 'trash', { op: 'purge', ids: ['session-archived-2'] })).value
  assert.deepEqual(purged.purged.map((entry) => entry.id), ['session-archived-2'])
  assert.equal(purged.purged[0].bytes, 200, 'the bytes are freed here and nowhere earlier')
  assert.equal((await route(tools, 'trash', { op: 'list' })).value.trash.count, 0)
})

test('the tool and the command reach the same trash as the route', async () => {
  const tools = install()
  await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-2'] })

  const held = await run(tools.get('trash_session_logs'), { action: 'list' })
  assert.equal(held.trash.count, 1)
  assert.match(text(tools.get('trash_session_logs'), held), /Trash: 1 session directory, 200 bytes/)

  const listed = await command(tools, 'trash')
  assert.match(listed.text, /Trash: 1 session directory/)
  const restored = await command(tools, 'restore session-archived-2')
  assert.match(restored.text, /Restored 1 session directory/)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
})

test('the window reports over the route, and the next listing prints it', async () => {
  // The self-report is the only way to see the browser half from the host side, and it is a fact a person
  // needs, so it belongs in the answer they already read.
  const tools = install()
  const { status, value } = await route(tools, 'state', { state: { row: 'contributed', register: 'registered', route: 'ok (state)' } })
  assert.equal(status, 200)
  assert.equal(value.ok, true)

  const listing = await run(tools.get('list_session_logs'), {})
  assert.match(text(tools.get('list_session_logs'), listing), /Window half: register=registered {2}row=contributed {2}route=ok \(state\)/)
})

test('a route answers a wrong method and a wrong body in words', async () => {
  const tools = install()
  // An unknown path never reaches this plugin at all: the carrier owns the match order, and an exact path that
  // is not registered is answered by the carrier's fallback. What this plugin must get right is the method and
  // the body, which it can see.
  assert.equal((await route(tools, 'delete', {}, 'GET')).status, 405)
  const broken = await callRoute(tools, 'delete', 'not json')
  assert.equal(broken.status, 400)
  assert.match(broken.value.error, /must be JSON/)
  // A handler answers an empty body as an empty object rather than an error: the window's listing call sends
  // no fields at all, and a body of "" is a body.
  assert.equal((await callRoute(tools, 'list', undefined)).status, 200)
})

test('a profile without a web server still registers its tools, and says so in the listing', async () => {
  const tools = install({ webServer: false })
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs', 'trash_session_logs'])
  const listing = await run(tools.get('list_session_logs'), {})
  assert.match(text(tools.get('list_session_logs'), listing), /Window transport: not registered \(no web server\)/)
})


test('a profile config moves the data directory, and a bad one fails the load', async () => {
  // The configurable part of ADR 0015, exercised through the entry rather than the resolver: what a profile
  // writes into its patch row has to reach the trash a deletion uses.
  const dataDir = join(TMP, 'configured-cleaner')
  const tools = install({ config: { dataDir, retentionDays: 7, trashLimit: 3 } })
  const { value } = await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-1'] })
  assert.equal(value.trash.root, join(dataDir, 'trash'), 'the deletion went where the config says')
  assert.equal(value.trash.retention_days, 7)
  assert.ok(existsSync(join(dataDir, 'trash', 'index.json')))

  // A value that cannot be honoured is refused while the plugin loads, with the field named — not later, in
  // front of a person who just clicked delete.
  assert.throws(() => install({ config: { retentionDays: 0 } }), /field "retentionDays" must be an integer >= 1/)
  assert.throws(() => install({ config: { trashLimit: 'lots' } }), /field "trashLimit"/)
})

test('the cap is applied by the next deletion, and the answer says what it cost', async () => {
  const tools = install({ config: { trashLimit: 1 } })
  await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-1'] })
  await route(tools, 'delete', { caller: CALLER, ids: ['session-archived-2'] })

  const held = (await route(tools, 'trash', { op: 'list' })).value
  assert.equal(held.trash.count, 1, 'the cap keeps the newest entry')
  assert.deepEqual(held.trash.entries.map((entry) => entry.id), ['session-archived-2'])
  assert.equal(held.swept.length, 1, 'and the one it pruned is reported')
  assert.equal(held.swept[0].id, 'session-archived-1')
})

test('a deletion detaches the session and never archives it', async () => {
  // The rule that makes a row disappear: the sidebar draws a session only while it is a member of a workspace and
  // not archived, and a blank session's placeholder tests the same membership. So `detachSession` is the write that
  // matters — and an archive write is worse than useless, because an archived row is still drawn (dimmed) under the
  // product's "show archived" filter, and the registry refuses it outright for a session whose log is already gone.
  const detachment = []
  const archiveCalls = []
  const workspace = {
    sessionIds: ['session-archived-1', 'session-ghost-1'],
    async detachSession(id) {
      detachment.push(id)
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id)
    },
  }
  const tools = install({
    workspaces: {
      archivedSessionIds: [],
      list: () => [workspace],
      async archiveSession(id) { archiveCalls.push(id) },
    },
  })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1', 'session-ghost-1'] })
  assert.deepEqual(detachment.sort(), ['session-archived-1', 'session-ghost-1'], 'both the moved id and the log-less one are dropped from the record')
  assert.deepEqual(archiveCalls, [], 'and nothing is archived, on any path')
  assert.deepEqual(value.workspace.detached.sort(), ['session-archived-1', 'session-ghost-1'])
  assert.equal('archived' in value.workspace, false, 'the answer no longer speaks of an archive at all')
})

test('a deletion also drops the archive flag, because an archived id is drawn even with no log', async () => {
  // The four ids this plugin found on the author's machine were all archived with no log at all: the sidebar was
  // drawing them from the archive flag alone, and detaching them changed nothing. Dropping the flag is the only
  // thing that makes such a row leave, so a deletion does it — for an id it removed and for one already gone.
  const archived = new Set(['session-ghost-1', 'session-archived-1'])
  const unarchiveCalls = []
  const tools = install({
    workspaces: {
      archivedSessionIds: [...archived],
      list: () => [{ sessionIds: [], async detachSession() {} }],
      async unarchiveSession(id) {
        unarchiveCalls.push(id)
        archived.delete(id)
      },
    },
  })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1', 'session-ghost-1'] })
  assert.deepEqual(unarchiveCalls.sort(), ['session-archived-1', 'session-ghost-1'])
  assert.deepEqual([...archived], [], 'the archive list no longer names either of them')
  assert.deepEqual(value.workspace.unarchived.sort(), ['session-archived-1', 'session-ghost-1'])
})

test('a deletion releases the live session object, so the row goes without a restart', async () => {
  // A live session — one "New session" created, or one the window opened — is listed by the query service as `live`
  // until the store lets it go, and the query API has no delete. The store's own removal is `detachEntered`, which
  // emits `session/disposed`; that is what removes the row now, without touching the process.
  const entries = new Map([['session-ghost-1', { id: 'session-ghost-1' }], ['session-archived-1', { id: 'session-archived-1' }]])
  const disposed = []
  const tools = install({
    sessions: {
      store: entries,
      detachEntered(entry) {
        disposed.push(entry.id)
        entries.delete(entry.id)
      },
    },
  })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-ghost-1'] })
  assert.deepEqual(disposed, ['session-ghost-1'], 'the live object was removed through the store')
  assert.deepEqual(value.workspace.released, ['session-ghost-1'])
  assert.equal(entries.has('session-archived-1'), true, 'a session nobody deleted keeps its live object')
})

test('the data directory comes from the workspace record, never from the profile default', async () => {
  // The failure this guards: the plugin used to accept `workingDirectory.defaultDirectory` — the profile's default
  // directory, which is NOT a workspace — as the base for `.agents/cleaner`. When the repositories moved into a
  // folder of their own, that default became the new folder's parent, and the trash silently began living there.
  // Two cases, and the second is the one that fails without the fix: a decoy default directory must lose to the
  // frozen fallback when no workspace is named, and a named workspace must win outright.
  const saved = process.env.DSH_CLEANER_DATA_DIR
  delete process.env.DSH_CLEANER_DATA_DIR
  const decoy = join(TMP, 'the-profile-default')
  const workspace = join(TMP, 'a-workspace')
  try {
    const withoutRegistry = install({ workingDirectory: { defaultDirectory: decoy } })
    const fallback = await run(withoutRegistry.get('list_session_logs'), {})
    assert.equal(
      fallback.trash.root,
      join(homedir(), '.agents', 'cleaner', 'trash'),
      'no workspace means the frozen home directory, not the profile default',
    )

    const withRegistry = install({
      workspaces: { list: () => [{ path: workspace, sessionIds: [] }] },
      workingDirectory: { defaultDirectory: decoy },
    })
    const named = await run(withRegistry.get('list_session_logs'), {})
    assert.equal(named.trash.root, join(homedir(), '.agents', 'cleaner', 'trash'), 'a named workspace does not decide where the bytes go')
  } finally {
    process.env.DSH_CLEANER_DATA_DIR = saved
  }
})