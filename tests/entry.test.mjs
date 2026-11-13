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

/** A context with only what this plugin reaches for: the registry, `agents`, and the persistence seam. */
function harness({ agents = [], persistence } = {}) {
  const tools = new Map()
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get: (name) => {
      if (name === 'agents') return { list: () => agents }
      if (name === 'sessionPersistence') return persistence
      return undefined
    },
  }
  return { ctx, tools }
}

const install = (options) => {
  const { ctx, tools } = harness(options)
  apply(ctx)
  return tools
}

const caller = { session: { id: CALLER } }
const run = (tool, args, exec = { agent: caller }) => tool.execute(args, exec)
const text = (tool, value) => tool.output.render({}, value)
  .map((block) => block.text)
  .join('\n')

before(async () => {
  process.env.DSH_HOME = TMP
})

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  for (const session of ARCHIVED) await writeSession(session)
  await writeSession(LIVE)
  await writeSession({ id: CALLER, project: '--D-ALPHA--', bytes: 999 })
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER])
})

after(async () => {
  await rm(TMP, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

test('the entry registers exactly the listing and the deleting tool', () => {
  const tools = install()
  assert.deepEqual([...tools.keys()].sort(), ['delete_archived_sessions', 'list_archived_sessions'])
  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
  }
  assert.deepEqual(tools.get('list_archived_sessions').parameters.properties, {})
  assert.deepEqual(tools.get('delete_archived_sessions').parameters.required, ['session_ids'])
})

test('the listing tool deletes nothing and names the bytes it found', async () => {
  const tools = install()
  const value = await run(tools.get('list_archived_sessions'), {})

  assert.deepEqual(value.candidates.map((entry) => entry.id).sort(), ['session-archived-1', 'session-archived-2'])
  assert.equal(value.total_bytes, 300)
  assert.equal(value.stored_bytes, 300 + 999 + 50)
  const rendered = text(tools.get('list_archived_sessions'), value)
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
  await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-1', 'session-archived-2'] })
  const value = await run(tools.get('list_archived_sessions'), {})
  assert.deepEqual(value.candidates, [])

  const rendered = text(tools.get('list_archived_sessions'), value)
  assert.match(rendered, /there is nothing to delete/)
  assert.match(rendered, /Already gone/)
  assert.doesNotMatch(rendered, /call delete_archived_sessions/)
})

test('a directory the walk refused is named in the listing, with the reason', async () => {
  const tools = install()
  const link = join(ROOT, '--D-LINKED--')
  await symlink(join(ROOT, '--D-ALPHA--'), link, process.platform === 'win32' ? 'junction' : 'dir')

  try {
    const value = await run(tools.get('list_archived_sessions'), {})
    assert.equal(value.skipped.length, 1)

    const rendered = text(tools.get('list_archived_sessions'), value)
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

  const value = await run(tools.get('list_archived_sessions'), {})
  assert.equal(value.already_gone.length, 14)
  assert.equal(value.candidates.length, 2)

  const rendered = text(tools.get('list_archived_sessions'), value)
  assert.match(rendered, /Already gone \(archived, but no directory is stored\): 14 — session-gone-1\b/)
  assert.match(rendered, /and 4 more/)
  assert.doesNotMatch(rendered, /session-gone-14/, 'the tail is marked, not printed')
})

test('the deleting tool removes only the ids it was given, and reports the bytes', async () => {
  const tools = install()
  const value = await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-1'] })

  assert.deepEqual(value.removed.map((entry) => entry.id), ['session-archived-1'])
  assert.equal(value.removed_count, 1)
  assert.equal(value.removed_bytes, 100)
  assert.deepEqual(value.failed, [])
  assert.deepEqual(value.refused, [])
  assert.match(
    text(tools.get('delete_archived_sessions'), value),
    /Deleted 1 session directory: 100 bytes/,
    'the singular is spelled out, not templated',
  )
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')), 'an id not given stays')
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))
})

test('the running session is refused by name, not deleted', async () => {
  const tools = install()
  const value = await run(tools.get('delete_archived_sessions'), { session_ids: [CALLER] })

  assert.deepEqual(value.removed, [])
  assert.equal(value.removed_bytes, 0)
  assert.deepEqual(value.refused, [{ id: CALLER, reason: 'the session running this command' }])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', CALLER, 'session.v4.jsonl.zstd')))
})

test('a live agent’s session is refused too', async () => {
  const tools = install({ agents: [{ id: 'session-archived-2' }] })
  const value = await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-2'] })

  assert.deepEqual(value.removed, [])
  assert.deepEqual(value.refused, [{ id: 'session-archived-2', reason: 'a live agent holds this session' }])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
})

test('an unarchived or already-deleted id is refused in the answer, not thrown', async () => {
  const tools = install()
  const value = await run(tools.get('delete_archived_sessions'), {
    session_ids: [LIVE.id, 'session-archived-2', 'session-archived-2'],
  })

  assert.deepEqual(value.removed.map((entry) => entry.id), ['session-archived-2'])
  assert.deepEqual(value.refused, [
    { id: LIVE.id, reason: 'not an archived session; archive it first to make it a candidate' },
  ])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))

  const again = await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-2'] })
  assert.deepEqual(again.removed, [])
  assert.deepEqual(again.refused, [
    { id: 'session-archived-2', reason: 'archived, but no session directory is stored; already deleted' },
  ])
  // Nothing was removed, so the persistence backend is not asked to confirm a removal that did not
  // happen — and the answer says nothing about it.
  assert.deepEqual(again.verify, { backend: 'not-asked' })
  assert.doesNotMatch(text(tools.get('delete_archived_sessions'), again), /persistence backend/)
})

test('a call without a calling Agent, or with no ids, is rejected before anything is touched', async () => {
  const tools = install()
  const tool = tools.get('delete_archived_sessions')

  await assert.rejects(() => run(tool, { session_ids: [LIVE.id] }, {}), /needs a calling Agent/)
  await assert.rejects(() => run(tool, { session_ids: [] }), /at least one session/)
  await assert.rejects(() => run(tool, { session_ids: [''] }), /non-empty session ids/)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')))
})

test('the answer says what the mounted persistence backend sees after the deletion', async () => {
  const tools = install({ persistence: { list: async () => [{ header: { id: 'session-archived-1' } }] } })
  const stillThere = await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-1'] })

  assert.deepEqual(stillThere.verify, { backend: 'sessionPersistence', still_listed: ['session-archived-1'] })
  assert.match(text(tools.get('delete_archived_sessions'), stillThere), /still lists session-archived-1/)

  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER])
  const clean = install({ persistence: { list: async () => [] } })
  const leftover = await run(clean.get('delete_archived_sessions'), { session_ids: ['session-archived-2'] })
  assert.deepEqual(leftover.verify, { backend: 'sessionPersistence', still_listed: [] })
  assert.match(text(clean.get('delete_archived_sessions'), leftover), /no longer lists any of them/)

  // No backend mounted at all: a real deletion still reports, and says the disk was the only witness.
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), CALLER, 'session-archived-3'])
  await writeSession({ id: 'session-archived-3', project: '--D-ALPHA--', bytes: 33 })
  const absent = install()
  const noBackend = await run(absent.get('delete_archived_sessions'), { session_ids: ['session-archived-3'] })
  assert.equal(noBackend.removed_count, 1)
  assert.deepEqual(noBackend.verify, { backend: 'absent' })
  assert.match(text(absent.get('delete_archived_sessions'), noBackend), /no session persistence backend is mounted/)
})

test('a persistence backend that throws cannot fail a deletion that already happened', async () => {
  const tools = install({ persistence: { list: async () => { throw new Error('backend is gone') } } })
  const value = await run(tools.get('delete_archived_sessions'), { session_ids: ['session-archived-1'] })

  assert.equal(value.removed_count, 1)
  assert.deepEqual(value.verify, { backend: 'sessionPersistence', error: 'backend is gone' })
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
})
