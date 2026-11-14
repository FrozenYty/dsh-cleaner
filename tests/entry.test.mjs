/**
 * The bundle entry's tool surface, with a fake Host context.
 *
 * The engine is covered directly by engine.test.mjs, so a mistake that lives only here — a missing
 * `exec`, a guard that reads the caller but does not apply it, a tool that deletes on the listing
 * call — would otherwise reach the model and nothing else. The plugin resolves its paths from
 * DSH_HOME, so the whole file points DSH_HOME at a fixture and never reads the real one.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
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
function harness({ agents = [], persistence, workspaces, query, commands = true } = {}) {
  const tools = new Map()
  const registered = new Map()
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
      if (name === 'agents') return { list: () => agents }
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') return query
      if (name === 'workspaceRegistry') return workspaces
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
  return { ctx, tools, commands: registered, disposed }
}

const install = (options) => {
  const { ctx, tools, commands, disposed } = harness(options)
  apply(ctx)
  return Object.assign(tools, { commands, disposed })
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
})

beforeEach(buildFixture)

after(async () => {
  await rm(TMP, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

test('the entry registers exactly the listing and the deleting tool', () => {
  const tools = install()
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs'])
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

test('a deletion asks the workspace registry to forget the session it orphaned', async () => {
  const detachment = []
  const unarchived = []
  const workspace = {
    sessionIds: ['session-archived-1', 'session-archived-2'],
    async detachSession(id) {
      detachment.push(id)
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id)
    },
  }
  const registry = {
    archivedSessionIds: ['session-archived-1', 'session-archived-2'],
    list: () => [workspace],
    async unarchiveSession(id) {
      unarchived.push(id)
      this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
    },
  }
  const tools = install({ workspaces: registry })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(value.removed_count, 1)
  assert.deepEqual(detachment, ['session-archived-1'], 'the registry is asked, so the row can go now')
  assert.deepEqual(value.workspace.detached, ['session-archived-1'])
  // The archive set is what still names a session with no log, and the client renders that identity.
  assert.deepEqual(unarchived, ['session-archived-1'])
  assert.deepEqual(value.workspace.unarchived, ['session-archived-1'])
  assert.deepEqual(registry.archivedSessionIds, ['session-archived-2'])
  assert.deepEqual(workspace.sessionIds, ['session-archived-2'])
  assert.match(text(tools.get('delete_session_logs'), value), /The workspace records dropped them \(1 detached, 1 unarchived\)/)
  // A page reload proved not to be enough; the window rewrites its own copy on a sort switch or a drag,
  // and a restart is the heavier way to the same end.
  assert.match(text(tools.get('delete_session_logs'), value), /until it rewrites it \(a sort switch or a drag\) or restarts/)
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
    async unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
    },
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

test('an unarchived id with no log is still dropped, and the session list is still asked about it', async () => {
  const calls = []
  const registry = {
    archivedSessionIds: ['session-archived-1'],
    list: () => [{
      sessionIds: ['session-archived-1'],
      async detachSession(id) {
        calls.push(id)
        this.sessionIds = this.sessionIds.filter((entry) => entry !== id)
      },
    }],
    async unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
    },
  }
  const tools = install({
    workspaces: registry,
    query: { listSessions: async () => [{ sessionId: 'session-archived-1' }] },
  })

  const first = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(first.removed_count, 1)
  // The state a person is in after an earlier cleanup: no log left, no archive entry, and a row still
  // drawn. Detaching is all that is left to ask for, and the session list is the answer that says where
  // the row still lives.
  registry.list()[0].sessionIds = ['session-archived-1']
  const again = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(again.removed_count, 0)
  assert.deepEqual(again.workspace.unarchived, [])
  assert.deepEqual(again.query.still_listed, ['session-archived-1'])
  assert.match(text(tools.get('delete_session_logs'), again), /The session list still names session-archived-1/)
})

test('an id the host still lists keeps both records, because a window still draws a row for it', async () => {
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
    async unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
    },
  }
  const tools = install({
    workspaces: registry,
    // The host still holds the session in memory, so its list still names it: the sidebar draws a row for
    // it, and an archived row of a project is the one it hides. Dropping either record is what turns a
    // hidden row into a visible one, so neither is dropped.
    query: { listSessions: async () => [{ sessionId: 'session-archived-1' }] },
  })

  const value = await run(tools.get('delete_session_logs'), { session_ids: ['session-archived-1'] })
  assert.equal(value.removed_count, 1, 'the log still goes')
  assert.deepEqual(value.workspace.detached, [])
  assert.deepEqual(value.workspace.unarchived, [])
  assert.deepEqual(value.workspace.kept_archived, ['session-archived-1'])
  assert.deepEqual(calls, [], 'nothing asked the registry to detach it')
  assert.deepEqual(workspace.sessionIds, ['session-archived-1'])
  assert.deepEqual(registry.archivedSessionIds, ['session-archived-1'])
  const rendered = text(tools.get('delete_session_logs'), value)
  assert.match(rendered, /1 of the ids stayed where they were/)
  assert.match(rendered, /the host still holds that session in memory/)
  assert.doesNotMatch(rendered, /The workspace records dropped them/)
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
  // The registry owns the definition's lifetime; the plugin registers it as an effect.
  assert.equal(tools.disposed.length, 1)
  tools.disposed[0]()
  assert.deepEqual([...tools.commands.keys()], [])
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
  assert.deepEqual([...tools.keys()].sort(), ['delete_session_logs', 'list_session_logs'])
  assert.equal(tools.commands.size, 0)
  assert.deepEqual(tools.disposed, [], 'nothing was registered, so nothing needs disposing')
})
