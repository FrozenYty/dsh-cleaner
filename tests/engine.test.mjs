/**
 * The deletion engine against a fixture.
 *
 * Every case here builds its own storage root and workspace file under `tests/.tmp`, and passes those
 * two paths to the engine — no test in this file can reach a real ~/.dsh even if it wanted to. The
 * fixture is the one the acceptance describes: three archived sessions, one live session, one empty
 * project directory, and (in the later cases) the two shapes the engine must refuse to touch.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'

import { applyCleanup, encodeSegment, planCleanup, readArchivedIds, scanStoredSessions } from '../engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const TMP = join(here, '.tmp')
const ROOT = join(TMP, 'sessions')
const WORKSPACE = join(TMP, 'storages', 'workspace.json')
const OUTSIDE = join(TMP, 'outside')

const ARCHIVED = [
  { id: 'session-archived-1', project: '--D-ALPHA--', files: { 'session.v3.jsonl.zstd': 1000, 'session.v4.jsonl.zstd': 2000 } },
  { id: 'session-archived-2', project: '--D-ALPHA--', files: { 'session.v4.jsonl.zstd': 500 } },
  { id: 'session-archived-3', project: '--D-BETA--', files: { 'session.v4.jsonl.zstd': 12345 } },
]
const ARCHIVED_BYTES = 1000 + 2000 + 500 + 12345
const LIVE = { id: 'session-live-1', project: '--D-ALPHA--', files: { 'session.v4.jsonl.zstd': 777 } }

/** Write one session directory exactly as the JSONL backend lays it out. */
async function writeSession({ id, project, files }, root = ROOT) {
  const dir = join(root, project, encodeSegment(id))
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), Buffer.alloc(bytes, 7))
  return dir
}

/** The workspace storage file, with only the field this engine reads filled in. */
async function writeWorkspace(ids) {
  await mkdir(dirname(WORKSPACE), { recursive: true })
  await writeFile(
    WORKSPACE,
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: ids, pinnedSessionIds: [] },
      tables: { workspaces: {} },
    }, null, 2),
  )
}

async function buildFixture({ archived = ARCHIVED.map((entry) => entry.id) } = {}) {
  await rm(TMP, { recursive: true, force: true })
  for (const session of ARCHIVED) await writeSession(session)
  await writeSession(LIVE)
  // An empty project directory, and an empty session directory whose id is not archived.
  await mkdir(join(ROOT, '--D-EMPTY--'), { recursive: true })
  await mkdir(join(ROOT, '--D-ALPHA--', 'session-empty-1'), { recursive: true })
  await writeWorkspace(archived)
}

const plan = (options = {}) => planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, ...options })

before(async () => {
  await rm(TMP, { recursive: true, force: true })
})

beforeEach(async () => {
  await buildFixture()
})

after(async () => {
  await rm(TMP, { recursive: true, force: true })
})

test('a dry run lists exactly the archived sessions on disk, counts their bytes, and deletes nothing', async () => {
  const listing = await plan()

  assert.deepEqual(listing.candidates.map((candidate) => candidate.id).sort(), [
    'session-archived-1',
    'session-archived-2',
    'session-archived-3',
  ])
  assert.equal(listing.total_bytes, ARCHIVED_BYTES)
  assert.equal(listing.archived_ids, 3)
  assert.equal(listing.stored_sessions, 5)
  assert.deepEqual(listing.already_gone, [])
  assert.deepEqual(listing.protected, [])
  // The listing describes 3 files in the first directory and 1 in each of the others.
  assert.deepEqual(
    listing.candidates.map((candidate) => candidate.files.length).sort(),
    [1, 1, 2],
  )

  for (const candidate of listing.candidates) assert.ok(existsSync(candidate.path), `${candidate.path} must survive a dry run`)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id, 'session.v4.jsonl.zstd')))
})

test('a deletion removes the three archived directories and leaves the live session and the empty directory', async () => {
  const listing = await plan()
  const report = await applyCleanup(listing)

  assert.deepEqual(report.removed.map((entry) => entry.id).sort(), [
    'session-archived-1',
    'session-archived-2',
    'session-archived-3',
  ])
  assert.equal(report.removed_bytes, ARCHIVED_BYTES)
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.refused, [])

  for (const candidate of listing.candidates) assert.equal(existsSync(candidate.path), false, `${candidate.path} must be gone`)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-1')), false)
  assert.equal(existsSync(join(ROOT, '--D-BETA--', 'session-archived-3')), false)
  // Untouched: the live session, the empty project directory, the empty session directory, and the
  // project directories themselves — a project directory is not a session.
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id, 'session.v4.jsonl.zstd')))
  assert.ok(existsSync(join(ROOT, '--D-EMPTY--')))
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-empty-1')))
  assert.deepEqual((await readdir(join(ROOT, '--D-ALPHA--'))).sort(), ['session-empty-1', LIVE.id])
})

test('a session that is on disk but not archived survives a deletion run', async () => {
  const before = new Set(await readdir(join(ROOT, '--D-ALPHA--')))
  assert.ok(before.has(LIVE.id))

  const listing = await plan()
  await applyCleanup(listing)

  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), 'an unarchived session must never be a candidate')
  assert.ok(await readArchivedIds(WORKSPACE).then((ids) => !ids.includes(LIVE.id)))

  // Asked for by name, an unarchived id is refused with a reason instead of failing the call.
  const asked = await plan({ only: [LIVE.id] })
  assert.deepEqual(asked.candidates, [])
  assert.deepEqual(asked.requested, [{ id: LIVE.id, reason: 'not an archived session; kept' }])
  const nothing = await applyCleanup(asked)
  assert.deepEqual(nothing.removed, [])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))
})

test('a second run reports no candidate rather than an error, and says why', async () => {
  const first = await plan()
  await applyCleanup(first)

  const second = await plan()
  assert.deepEqual(second.candidates, [])
  assert.equal(second.total_bytes, 0)
  assert.equal(second.archived_ids, 3)
  assert.deepEqual(second.already_gone.sort(), [
    'session-archived-1',
    'session-archived-2',
    'session-archived-3',
  ])

  const again = await applyCleanup(second)
  assert.deepEqual(again.removed, [])
  assert.deepEqual(again.failed, [])
  assert.equal(again.removed_bytes, 0)

  // The same ids asked for by name are refused, not treated as a failure.
  const asked = await plan({ only: ['session-archived-1'] })
  assert.deepEqual(asked.requested, [
    { id: 'session-archived-1', reason: 'archived, but no session directory is stored; already deleted' },
  ])
})

test('the protected ids are listed and kept — the session running the command cannot delete itself', async () => {
  const listing = await plan({ protect: [{ id: 'session-archived-2', reason: 'the session running this command' }] })

  assert.deepEqual(listing.candidates.map((entry) => entry.id).sort(), ['session-archived-1', 'session-archived-3'])
  assert.deepEqual(listing.protected, [{
    id: 'session-archived-2',
    path: join(ROOT, '--D-ALPHA--', 'session-archived-2'),
    bytes: 500,
    reason: 'the session running this command',
  }])

  const report = await applyCleanup(listing)
  assert.equal(report.removed.length, 2)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
})

test('the archive list is re-read at deletion time: a session restored in between is kept', async () => {
  const listing = await plan()
  // The person unarchives one of them after seeing the list, before approving it.
  await writeWorkspace(['session-archived-1', 'session-archived-2'])

  const report = await applyCleanup(listing)

  assert.deepEqual(report.removed.map((entry) => entry.id).sort(), ['session-archived-1', 'session-archived-2'])
  assert.deepEqual(report.refused, [{ id: 'session-archived-3', reason: 'no longer archived; kept' }])
  assert.ok(existsSync(join(ROOT, '--D-BETA--', 'session-archived-3', 'session.v4.jsonl.zstd')))
})

test('a link is refused at both levels and never followed out of the storage root', async (t) => {
  await mkdir(OUTSIDE, { recursive: true })
  await writeFile(join(OUTSIDE, 'keep.bin'), Buffer.alloc(64, 3))
  const linkedSession = join(ROOT, '--D-GAMMA--', 'session-archived-4')
  const linkedProject = join(ROOT, '--D-DELTA--')
  try {
    await mkdir(join(ROOT, '--D-GAMMA--'), { recursive: true })
    await symlink(OUTSIDE, linkedSession, 'junction')
    await symlink(OUTSIDE, linkedProject, 'junction')
  } catch (error) {
    t.skip(`this platform refused to create a directory link: ${error.message}`)
    return
  }
  // A junction is removed with rmdir, never with a recursive delete: the target is not this test's
  // to remove, and the next fixture reset must not have to guess.
  try {
    await writeWorkspace([...ARCHIVED.map((entry) => entry.id), 'session-archived-4'])

    const listing = await plan()
    // The linked session directory is not a candidate; the linked project directory is reported.
    assert.deepEqual(listing.candidates.map((entry) => entry.id).sort(), [
      'session-archived-1',
      'session-archived-2',
      'session-archived-3',
    ])
    const skipped = listing.skipped.map((entry) => entry.path)
    assert.ok(skipped.includes(linkedSession), 'the linked session directory must be reported, not entered')
    assert.ok(skipped.includes(linkedProject), 'the linked project directory must be reported, not entered')

    const report = await applyCleanup(listing)
    assert.deepEqual(report.refused, [])
    assert.ok(existsSync(join(OUTSIDE, 'keep.bin')), 'the link target must be untouched')
    assert.ok(existsSync(linkedSession), 'the link itself is not removed')
    assert.ok(existsSync(linkedProject))
  } finally {
    await rmdir(linkedSession).catch(() => {})
    await rmdir(linkedProject).catch(() => {})
  }
})

test('a session directory holding a nested directory is refused rather than removed', async () => {
  const nested = join(ROOT, '--D-BETA--', 'session-archived-5')
  await mkdir(join(nested, 'artifacts'), { recursive: true })
  await writeFile(join(nested, 'artifacts', 'part.bin'), Buffer.alloc(11, 1))
  await writeFile(join(nested, 'session.v4.jsonl.zstd'), Buffer.alloc(12, 1))
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), 'session-archived-5'])

  const listing = await plan()
  assert.equal(listing.candidates.some((entry) => entry.id === 'session-archived-5'), false)
  assert.ok(listing.skipped.some((entry) => entry.path === nested && /non-file entry/.test(entry.reason)))

  const report = await applyCleanup(listing)
  assert.ok(existsSync(join(nested, 'artifacts', 'part.bin')), 'nothing inside the refused directory was removed')
  assert.equal(report.removed.length, 3)
})

test('the directory name is the backend escape, so an id that needs one is still found', async () => {
  const id = 'session-\u00fcn\u00efcode'
  assert.equal(encodeSegment(id), 'session-~00FCn~00EFcode')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('session-plain.A-1'), 'session-plain.A-1')

  const dir = join(ROOT, '--D-ALPHA--', 'session-~00FCn~00EFcode')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(321, 5))
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), id])

  const listing = await plan()
  assert.ok(listing.candidates.some((entry) => entry.id === id && entry.bytes === 321))

  const report = await applyCleanup(listing)
  assert.ok(report.removed.some((entry) => entry.id === id))
  assert.equal(existsSync(dir), false)
})

test('an unreadable archive list is an error, and a missing one is simply an empty archive', async () => {
  await writeFile(WORKSPACE, '{ this is not json')
  await assert.rejects(() => plan(), /is not valid JSON/)

  await writeFile(WORKSPACE, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: 'nope' } }))
  await assert.rejects(() => plan(), /not an array/)

  await rm(WORKSPACE)
  const listing = await plan()
  assert.equal(listing.archived_ids, 0)
  assert.deepEqual(listing.candidates, [])

  const report = await applyCleanup(listing)
  assert.deepEqual(report.removed, [])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), 'nothing was deleted')
})

test('the scanner reports what it found without deciding anything', async () => {
  const { stored, skipped } = await scanStoredSessions(ROOT)
  assert.deepEqual([...stored.keys()].sort(), [
    'session-archived-1',
    'session-archived-2',
    'session-archived-3',
    'session-empty-1',
    LIVE.id,
  ])
  assert.equal(stored.get('session-archived-1').bytes, 3000)
  assert.deepEqual(skipped, [])

  const absent = await scanStoredSessions(join(TMP, 'no-such-root'))
  assert.equal(absent.stored.size, 0)
  assert.equal(absent.skipped.length, 1)
})
