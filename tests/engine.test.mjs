/**
 * The deletion engine against a fixture.
 *
 * Every case here builds its own storage root and workspace file under `tests/.tmp`, and passes those
 * two paths to the engine — no test in this file can reach a real ~/.dsh even if it wanted to. The
 * fixture is the one the acceptance describes: three archived sessions, one session that is **not**
 * archived, one empty session directory, one empty project directory, and (in the later cases) the two
 * shapes the engine must refuse to touch.
 *
 * The contract under test: the store is the index. A session whose log is on disk is a candidate whether
 * or not it is archived — archiving is the product's way to hide a session, not this plugin's gate — and
 * the archive list is only read to *report* facts (how many ids are archived, which archived ids no longer
 * have a directory). What still protects a session is its protection entry: the caller, or a busy agent.
 */

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, readdir, rm, rmdir, symlink, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test, { before, beforeEach, after } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyCleanup,
  decodeSegment,
  encodeSegment,
  planCleanup,
  readArchivedIds,
  scanStoredSessions,
} from '../engine.js'

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
const ARCHIVED_IDS = ARCHIVED.map((entry) => entry.id)
const LIVE = { id: 'session-live-1', project: '--D-ALPHA--', files: { 'session.v4.jsonl.zstd': 777 } }
/** Every session directory the fixture stores, in the order a person would not care about. */
const STORED_IDS = [...ARCHIVED_IDS, LIVE.id, 'session-empty-1']
const STORED_BYTES = ARCHIVED_BYTES + 777

/** Write one session directory exactly as the JSONL backend lays it out. */
async function writeSession({ id, project, files }, root = ROOT) {
  const dir = join(root, project, encodeSegment(id))
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), Buffer.alloc(bytes, 7))
  return dir
}

/** The workspace storage file, with only the fields this engine reads filled in. */
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

async function buildFixture({ archived = ARCHIVED_IDS } = {}) {
  await rm(TMP, { recursive: true, force: true })
  for (const session of ARCHIVED) await writeSession(session)
  await writeSession(LIVE)
  // An empty project directory, and an empty session directory that nobody archived.
  await mkdir(join(ROOT, '--D-EMPTY--'), { recursive: true })
  await mkdir(join(ROOT, '--D-ALPHA--', 'session-empty-1'), { recursive: true })
  await writeWorkspace(archived)
}

const plan = (options = {}) => planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, ...options })
const ids = (entries) => entries.map((entry) => entry.id).sort()

before(async () => {
  await rm(TMP, { recursive: true, force: true })
})

beforeEach(async () => {
  await buildFixture()
})

after(async () => {
  await rm(TMP, { recursive: true, force: true })
})

test('a dry run lists every session on disk, says which are archived, counts their bytes, and deletes nothing', async () => {
  const listing = await plan()

  assert.deepEqual(ids(listing.candidates), STORED_IDS.sort())
  assert.equal(listing.total_bytes, STORED_BYTES)
  assert.equal(listing.archived_ids, 3)
  assert.equal(listing.stored_sessions, 5)
  assert.equal(listing.stored_bytes, STORED_BYTES)
  assert.deepEqual(listing.already_gone, [])
  assert.deepEqual(listing.protected, [])
  // The archive flag is a fact about the product, not a gate: a person reads it to know whether the row
  // is already hidden, and the answer still offers the session for deletion.
  assert.deepEqual(
    listing.candidates.filter((candidate) => candidate.archived).map((candidate) => candidate.id).sort(),
    ARCHIVED_IDS.slice().sort(),
  )
  assert.deepEqual(
    listing.candidates.filter((candidate) => !candidate.archived).map((candidate) => candidate.id).sort(),
    [LIVE.id, 'session-empty-1'].sort(),
  )
  // The listing describes 3 files in the first directory and 1 in each of the others.
  assert.deepEqual(listing.candidates.map((candidate) => candidate.files.length).sort(), [0, 1, 1, 1, 2])
  // The last write is a real timestamp where one exists, because it is what a person uses to judge age.
  for (const candidate of listing.candidates) {
    if (candidate.files.length === 0) assert.equal(candidate.modified, null)
    else assert.match(candidate.modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  }
  // A tool result has to be lossless JSON: an `undefined` field would silently vanish here.
  assert.deepEqual(JSON.parse(JSON.stringify(listing)), listing)

  for (const candidate of listing.candidates) assert.ok(existsSync(candidate.path), `${candidate.path} must survive a dry run`)
})

test('a deletion removes exactly the ids it was given, archived or not', async () => {
  const named = ['session-archived-1', 'session-archived-3', LIVE.id]
  const listing = await plan({ only: named })
  const report = await applyCleanup(listing)

  assert.deepEqual(ids(report.removed), named.slice().sort())
  assert.equal(report.removed_bytes, 1000 + 2000 + 12345 + 777)
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.refused, [])
  for (const candidate of listing.candidates) assert.equal(existsSync(candidate.path), false, `${candidate.path} must be gone`)
  // Untouched: what was not named, the empty project directory, and the project directories themselves —
  // a project directory is not a session.
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-empty-1')))
  assert.ok(existsSync(join(ROOT, '--D-EMPTY--')))
  assert.deepEqual((await readdir(join(ROOT, '--D-ALPHA--'))).sort(), ['session-archived-2', 'session-empty-1'])
})

test('archiving is not a gate: a session without an archive entry is a candidate and is deleted by name', async () => {
  const listing = await plan({ only: [LIVE.id, 'session-empty-1'] })
  assert.deepEqual(ids(listing.candidates), [LIVE.id, 'session-empty-1'].sort())

  const report = await applyCleanup(listing)
  assert.deepEqual(ids(report.removed), [LIVE.id, 'session-empty-1'].sort())
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), false)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-empty-1')), false)
})

test('the archive entry of a candidate does not decide anything at deletion time', async () => {
  const listing = await plan({ only: ['session-archived-3'] })
  // The person unarchives it after seeing the list, before approving the deletion.
  await writeWorkspace(['session-archived-1', 'session-archived-2'])

  const report = await applyCleanup(listing)
  assert.deepEqual(ids(report.removed), ['session-archived-3'])
  assert.deepEqual(report.refused, [])
  assert.equal(existsSync(join(ROOT, '--D-BETA--', 'session-archived-3')), false)
})

test('a refusal says the id is protected, its directory is refused, or nothing is stored under it', async () => {
  const asked = await plan({ only: ['session-never-existed', 'session-archived-2'] })

  assert.deepEqual(ids(asked.candidates), ['session-archived-2'])
  assert.deepEqual(asked.requested, [
    { id: 'session-never-existed', reason: 'no session directory is stored under that id' },
  ])
  const report = await applyCleanup(asked)
  assert.deepEqual(report.refused, [])
  assert.deepEqual(ids(report.removed), ['session-archived-2'])
})

test('a named id with no log is reported as unlogged whether or not it is still archived', async () => {
  // Take the log away behind the plan's back, which is exactly the state a deletion leaves: the archive
  // entry stays and the directory is gone.
  rmSync(join(ROOT, '--D-ALPHA--', ARCHIVED[0].id), { recursive: true, force: true })

  const asked = await plan({ only: ['session-never-existed', ARCHIVED[0].id] })
  assert.deepEqual(asked.unlogged.sort(), ['session-never-existed', ARCHIVED[0].id].sort())
  assert.deepEqual(asked.already_gone, [ARCHIVED[0].id])
  assert.deepEqual(asked.requested, [
    { id: 'session-never-existed', reason: 'no session directory is stored under that id' },
    { id: ARCHIVED[0].id, reason: 'no session directory is stored under that id; already deleted' },
  ])
  const report = await applyCleanup(asked)
  assert.deepEqual(report.removed, [])
})

test('a second run reports what is left rather than an error, and says why the old ids are gone', async () => {
  const first = await plan({ only: ARCHIVED_IDS })
  await applyCleanup(first)

  const second = await plan()
  assert.deepEqual(ids(second.candidates), [LIVE.id, 'session-empty-1'].sort())
  assert.equal(second.total_bytes, 777)
  assert.equal(second.archived_ids, 3)
  assert.deepEqual(second.already_gone.sort(), ARCHIVED_IDS.slice().sort())

  const again = await applyCleanup({ ...second, candidates: [] })
  assert.deepEqual(again.removed, [])
  assert.deepEqual(again.failed, [])
  assert.equal(again.removed_bytes, 0)

  // The same ids asked for by name are refused, not treated as a failure.
  const asked = await plan({ only: ['session-archived-1'] })
  assert.deepEqual(asked.requested, [
    { id: 'session-archived-1', reason: 'no session directory is stored under that id; already deleted' },
  ])
})

test('the protected ids are listed and kept — the session running the command cannot delete itself', async () => {
  const listing = await plan({ protect: [{ id: 'session-archived-2', reason: 'the session running this command' }] })

  assert.deepEqual(ids(listing.candidates), ['session-archived-1', 'session-archived-3', LIVE.id, 'session-empty-1'].sort())
  assert.deepEqual(listing.protected, [{
    id: 'session-archived-2',
    path: join(ROOT, '--D-ALPHA--', 'session-archived-2'),
    bytes: 500,
    reason: 'the session running this command',
  }])

  const report = await applyCleanup(listing)
  assert.equal(report.removed.length, 4)
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', 'session-archived-2')))
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
    const listing = await plan()
    // The linked session directory is not a candidate; the linked project directory is reported.
    assert.deepEqual(ids(listing.candidates), STORED_IDS.sort())
    const skipped = listing.skipped.map((entry) => entry.path)
    assert.ok(skipped.includes(linkedSession), 'the linked session directory must be reported, not entered')
    assert.ok(skipped.includes(linkedProject), 'the linked project directory must be reported, not entered')

    await applyCleanup(listing)
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

  const listing = await plan()
  assert.equal(listing.candidates.some((entry) => entry.id === 'session-archived-5'), false)
  assert.ok(listing.skipped.some((entry) => entry.path === nested && /non-file entry/.test(entry.reason)))
  // The directory exists, so the log is not gone: reporting it as already deleted would be a lie about
  // the disk. Its measurable bytes still belong to the store, so the total does not omit them.
  assert.deepEqual(listing.already_gone, [])
  assert.equal(listing.stored_bytes, STORED_BYTES + 12)

  const asked = await plan({ only: ['session-archived-5'] })
  assert.equal(asked.requested.length, 1)
  assert.match(
    asked.requested[0].reason,
    /^its directory is not a candidate: holds a non-file entry \(artifacts\)/,
  )

  const report = await applyCleanup({ ...listing, candidates: listing.candidates.filter((entry) => entry.id === 'session-archived-1') })
  assert.deepEqual(ids(report.removed), ['session-archived-1'])
  assert.ok(existsSync(join(nested, 'artifacts', 'part.bin')), 'nothing inside the refused directory was removed')
})

test('a session directory that cannot be read is reported, and its id is not called already gone', {
  // POSIX denies a directory listing with the mode bits; Windows has no equivalent that does not need
  // an ACL, so the case runs where it can.
  skip: process.platform === 'win32' ? 'chmod cannot deny a directory read on Windows' : false,
}, async () => {
  const dir = join(ROOT, '--D-ALPHA--', 'session-archived-2')
  await chmod(dir, 0o000)

  try {
    const listing = await plan({ only: ['session-archived-2'] })
    assert.deepEqual(listing.candidates, [])
    assert.deepEqual(listing.already_gone, [])
    assert.ok(listing.skipped.some((entry) => entry.path === dir && /cannot be listed/.test(entry.reason)))

    assert.equal(listing.requested.length, 1)
    assert.match(listing.requested[0].reason, /^its directory is not a candidate: cannot be listed/)

    const report = await applyCleanup(listing)
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.refused, [])
    assert.ok(existsSync(dir), 'the unreadable directory is still there')
  } finally {
    await chmod(dir, 0o755)
  }
})

test('the directory name is the backend escape, and it decodes back to the id', async () => {
  const id = 'session-\u00fcn\u00efcode'
  assert.equal(encodeSegment(id), 'session-~00FCn~00EFcode')
  assert.equal(decodeSegment('session-~00FCn~00EFcode'), id)
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(decodeSegment('~002E'), '.')
  assert.equal(decodeSegment('~002E~002E'), '..')
  assert.equal(encodeSegment('session-plain.A-1'), 'session-plain.A-1')
  assert.equal(decodeSegment('session-plain.A-1'), 'session-plain.A-1')
  // Every id this backend can store survives a round trip, which is what lets the store be its own index.
  for (const raw of ['session-1', 'a b', 'x\u0000y', '~', 'c:d', '../../outside', 'session-\u00fcn\u00efcode']) {
    assert.equal(decodeSegment(encodeSegment(raw)), raw)
  }

  const dir = join(ROOT, '--D-ALPHA--', 'session-~00FCn~00EFcode')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(321, 5))

  const listing = await plan()
  const candidate = listing.candidates.find((entry) => entry.id === id)
  assert.ok(candidate, 'an id that needs escaping is found from its directory name alone')
  assert.equal(candidate.bytes, 321)
  assert.equal(candidate.archived, false)

  const report = await applyCleanup({ ...listing, candidates: [candidate] })
  assert.deepEqual(ids(report.removed), [id])
  assert.equal(existsSync(dir), false)
})

test('an unreadable archive list is an error, and a missing one leaves the store as the only index', async () => {
  await writeFile(WORKSPACE, '{ this is not json')
  await assert.rejects(() => plan(), /is not valid JSON/)

  await writeFile(WORKSPACE, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: 'nope' } }))
  await assert.rejects(() => plan(), /not an array/)

  await rm(WORKSPACE)
  const listing = await plan()
  assert.equal(listing.archived_ids, 0)
  // No archive file is a fresh installation, not an empty store: every session on disk is still offered.
  assert.deepEqual(ids(listing.candidates), STORED_IDS.sort())
  assert.deepEqual(listing.candidates.filter((candidate) => candidate.archived), [])

  const report = await applyCleanup({ ...listing, candidates: [] })
  assert.deepEqual(report.removed, [])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)), 'nothing was deleted')
})

test('an empty session directory is a candidate with zero bytes and no write time', async () => {
  const listing = await plan({ only: ['session-empty-1'] })

  assert.deepEqual(listing.candidates, [{
    id: 'session-empty-1',
    path: join(ROOT, '--D-ALPHA--', 'session-empty-1'),
    bytes: 0,
    files: [],
    modified: null,
    archived: false,
  }])

  const report = await applyCleanup(listing)
  assert.equal(report.removed.find((entry) => entry.id === 'session-empty-1').bytes, 0)
  assert.equal(existsSync(join(ROOT, '--D-ALPHA--', 'session-empty-1')), false)
})

test('a candidate that vanished between the listing and the deletion is refused, not failed', async () => {
  const listing = await plan({ only: ARCHIVED_IDS })
  await rm(join(ROOT, '--D-BETA--', 'session-archived-3'), { recursive: true })

  const report = await applyCleanup(listing)

  assert.deepEqual(ids(report.removed), ['session-archived-1', 'session-archived-2'])
  assert.deepEqual(report.refused, [{ id: 'session-archived-3', reason: 'already deleted; nothing to remove' }])
  assert.deepEqual(report.failed, [])
})

test('a candidate replaced by a file between the listing and the deletion is refused', async () => {
  const target = join(ROOT, '--D-ALPHA--', 'session-archived-1')
  const listing = await plan({ only: ARCHIVED_IDS })
  await rm(target, { recursive: true })
  await writeFile(target, 'not a directory')

  const report = await applyCleanup(listing)

  assert.deepEqual(report.refused, [{ id: 'session-archived-1', reason: 'not a real directory; a link is not followed' }])
  assert.equal(report.removed.length, 2)
  assert.ok(existsSync(target), 'the replacement file is untouched')
})

test('a tampered plan cannot delete outside the session storage root', async () => {
  // A directory outside the root, named exactly like the session it claims to be: the id/path binding
  // accepts it, so only the containment check can refuse it.
  const elsewhere = join(TMP, 'elsewhere', 'session-archived-1')
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(elsewhere, 'keep.bin'), Buffer.alloc(64, 3))
  const listing = await plan()
  // The plan is a description of the past, and this one says the session lives somewhere else.
  const tampered = {
    ...listing,
    candidates: [{ id: 'session-archived-1', path: elsewhere, bytes: 64, files: ['keep.bin'], modified: null }],
  }

  const report = await applyCleanup(tampered)

  assert.deepEqual(report.removed, [])
  assert.equal(report.refused.length, 1)
  assert.match(report.refused[0].reason, /resolves outside the session storage root/)
  assert.deepEqual(report.failed, [])
  assert.ok(existsSync(join(elsewhere, 'keep.bin')))
})

test('a plan whose path names a different session than its id is refused', async () => {
  const listing = await plan({ only: ['session-archived-1', 'session-archived-3'] })
  const [first, second] = listing.candidates
  // Both paths are inside the root, so containment alone would not notice that each one now points at
  // the other's session — and the report would name the wrong session.
  const swapped = { ...listing, candidates: [{ ...first, path: second.path }, { ...second, path: first.path }] }

  const report = await applyCleanup(swapped)

  assert.deepEqual(report.removed, [])
  assert.equal(report.refused.length, 2)
  assert.match(report.refused[0].reason, /the path names a different session/)
  assert.ok(existsSync(first.path))
  assert.ok(existsSync(second.path))
})

test('an id that tries to traverse is inert, because the escape makes it one path segment', async () => {
  const nasty = '../../outside'
  await mkdir(OUTSIDE, { recursive: true })
  await writeFile(join(OUTSIDE, 'keep.bin'), Buffer.alloc(64, 3))
  // The separators are escaped; the dots are safe characters and stay literal, which is harmless
  // because the whole segment is neither `.` nor `..`.
  assert.equal(encodeSegment(nasty), '..~002F..~002Foutside')
  await writeWorkspace([...ARCHIVED_IDS, nasty])

  const listing = await plan()
  assert.deepEqual(ids(listing.candidates), STORED_IDS.sort())
  assert.ok(listing.already_gone.includes(nasty))

  const report = await applyCleanup({ ...listing, candidates: [] })
  assert.deepEqual(report.removed, [])
  assert.ok(existsSync(join(OUTSIDE, 'keep.bin')), 'nothing outside the resolved id was reached')
})

test('the id escape always yields one inert path segment', () => {
  const nasty = [
    '.', '..', '../..', '../../etc/passwd', '..\\..\\windows\\system32', 'a/b', 'a\\\\b', 'c:d', '~',
    'x\u0000y', 'session-\u00fcn\u00efcode', '%2e%2e', ' leading', 'trailing ', 'A'.repeat(300),
  ]
  for (const raw of nasty) {
    const encoded = encodeSegment(raw)
    assert.match(encoded, /^[~A-Za-z0-9._-]+$/, `escaped form of ${JSON.stringify(raw)}`)
    assert.equal(encoded.includes('/'), false)
    assert.equal(encoded.includes('\\'), false)
    assert.notEqual(encoded, '.')
    assert.notEqual(encoded, '..')
    assert.equal(decodeSegment(encoded), raw)
  }
})

test('a second directory with the same session id is reported, not silently ignored', async () => {
  const original = join(ROOT, '--D-ALPHA--', 'session-archived-1')
  const duplicate = join(ROOT, '--D-GAMMA--', 'session-archived-1')
  await mkdir(duplicate, { recursive: true })
  await writeFile(join(duplicate, 'session.v4.jsonl.zstd'), Buffer.alloc(42, 4))

  const listing = await plan()
  const candidate = listing.candidates.find((entry) => entry.id === 'session-archived-1')
  assert.ok(candidate, 'one of the two directories is still the candidate')
  assert.ok(
    listing.skipped.some((entry) => entry.path === duplicate && /same session id/.test(entry.reason)),
    'the duplicate is reported',
  )
  // Whichever one was reported, deleting it makes the other a candidate on the next run.
  await applyCleanup({ ...listing, candidates: [candidate] })
  const second = await plan()
  assert.ok(second.candidates.some((entry) => entry.id === 'session-archived-1'))
  assert.ok(existsSync(duplicate) || existsSync(original))
})

test('a file that cannot be unlinked is reported, and the session stays a candidate', {
  // POSIX refuses to remove an entry from a directory it may not write to, which is the portable way to
  // hold a deletion open. Windows offers none without native calls or ACL work — and the branch under
  // test is the same throw either way, so the invariant is covered where it can be.
  skip: process.platform === 'win32' ? 'no portable way to deny an unlink on Windows' : false,
}, async () => {
  const dir = join(ROOT, '--D-ALPHA--', 'session-archived-2')
  const file = join(dir, 'session.v4.jsonl.zstd')
  await chmod(dir, 0o500)

  try {
    const listing = await plan({ only: ['session-archived-2'] })
    const report = await applyCleanup(listing)

    assert.deepEqual(report.removed, [])
    assert.equal(report.removed_bytes, 0)
    assert.equal(report.failed.length, 1)
    assert.equal(report.failed[0].id, 'session-archived-2')
    assert.match(report.failed[0].error, /cannot be removed/)
    assert.ok(existsSync(file), 'a failure leaves the session where it was')

    // The promise the README makes about this state: the log is still on disk, so the next run offers it
    // again and the same call can be repeated.
    const again = await plan({ only: ['session-archived-2'] })
    assert.deepEqual(ids(again.candidates), ['session-archived-2'])
    assert.deepEqual(again.requested, [])
  } finally {
    await chmod(dir, 0o755)
  }
})

test('the engine rejects arguments it cannot honour', async () => {
  assert.throws(() => encodeSegment(''), /non-empty string/)
  assert.throws(() => encodeSegment(42), /non-empty string/)
  assert.throws(() => decodeSegment(''), /non-empty string/)

  await writeWorkspace([7])
  await assert.rejects(() => readArchivedIds(WORKSPACE), /every archived session id must be a non-empty string/)

  await assert.rejects(() => planCleanup({}), /sessionsRoot must be a non-empty string/)
  await assert.rejects(() => planCleanup({ sessionsRoot: ROOT }), /workspaceFile must be a non-empty string/)
  await assert.rejects(
    () => planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, only: 'session-archived-1' }),
    /only must be an array of non-empty session ids/,
  )
  await assert.rejects(
    () => planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, projections: 42 }),
    /projections must be a non-empty string when given/,
  )
})

test('a plan that names a store that is not there fails loudly, and so does a malformed one', async () => {
  // A stale plan is a real risk: the store can move between the listing and the deletion. Failing here
  // is the point — reporting "nothing removed" for a store that is not there would be a lie.
  await assert.rejects(() => applyCleanup(null), /pass the plan returned by planCleanup/)
  await assert.rejects(() => applyCleanup({ candidates: [] }), /the plan must name its session storage root/)
  await assert.rejects(
    () => applyCleanup({ candidates: [], sessions_root: join(TMP, 'gone'), workspace_file: WORKSPACE }),
    /cannot resolve the session storage root/,
  )
})

test('the scanner reports what it found without deciding anything', async () => {
  const { stored, skipped } = await scanStoredSessions(ROOT)
  assert.deepEqual([...stored.keys()].sort(), STORED_IDS.sort())
  assert.equal(stored.get('session-archived-1').bytes, 3000)
  assert.deepEqual(skipped, [])

  const absent = await scanStoredSessions(join(TMP, 'no-such-root'))
  assert.equal(absent.stored.size, 0)
  assert.equal(absent.skipped.length, 1)
})
