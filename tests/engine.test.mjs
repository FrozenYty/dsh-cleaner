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
import { mkdir, readdir, rm, rmdir, symlink, writeFile, chmod } from 'node:fs/promises'
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
  // 15845 archived + 777 live; the empty session directory adds nothing.
  assert.equal(listing.stored_bytes, ARCHIVED_BYTES + 777)
  assert.deepEqual(listing.already_gone, [])
  assert.deepEqual(listing.protected, [])
  // The listing describes 3 files in the first directory and 1 in each of the others.
  assert.deepEqual(
    listing.candidates.map((candidate) => candidate.files.length).sort(),
    [1, 1, 2],
  )
  // The last write is a real timestamp, because it is what a person uses to judge an old session.
  for (const candidate of listing.candidates) {
    assert.match(candidate.modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.ok(Date.now() - Date.parse(candidate.modified) < 60 * 60 * 1000)
  }
  // A tool result has to be lossless JSON: an `undefined` field would silently vanish here.
  assert.deepEqual(JSON.parse(JSON.stringify(listing)), listing)

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
  assert.deepEqual(asked.requested, [
    { id: LIVE.id, reason: 'not an archived session; archive it first to make it a candidate' },
  ])
  const nothing = await applyCleanup(asked)
  assert.deepEqual(nothing.removed, [])
  assert.ok(existsSync(join(ROOT, '--D-ALPHA--', LIVE.id)))
})

test('a refusal says whether the id needs archiving or does not exist at all', async () => {
  const asked = await plan({ only: [LIVE.id, 'session-never-existed'] })

  assert.deepEqual(asked.candidates, [])
  assert.deepEqual(asked.requested, [
    { id: LIVE.id, reason: 'not an archived session; archive it first to make it a candidate' },
    { id: 'session-never-existed', reason: 'not an archived session, and no log is stored under that id' },
  ])
  const report = await applyCleanup(asked)
  assert.deepEqual(report.removed, [])
  // Nothing was a candidate, so the deletion had nothing to re-check: the reasons live in the plan, and
  // the tool answer merges plan.requested with report.refused.
  assert.deepEqual(report.refused, [])
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
  assert.deepEqual(report.refused, [{ id: 'session-archived-3', reason: 'no longer archived' }])
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
  // The directory exists, so the log is not gone: reporting it as already deleted would be a lie about
  // the disk. Its measurable bytes still belong to the store, so the total does not omit them.
  assert.deepEqual(listing.already_gone, [])
  assert.equal(listing.stored_bytes, ARCHIVED_BYTES + 777 + 12)

  const asked = await plan({ only: ['session-archived-5'] })
  assert.equal(asked.requested.length, 1)
  assert.match(
    asked.requested[0].reason,
    /^archived, but its directory is not a candidate: holds a non-file entry \(artifacts\)/,
  )

  const report = await applyCleanup(listing)
  assert.ok(existsSync(join(nested, 'artifacts', 'part.bin')), 'nothing inside the refused directory was removed')
  assert.equal(report.removed.length, 3)
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
    assert.match(listing.requested[0].reason, /^archived, but its directory is not a candidate: cannot be listed/)

    const report = await applyCleanup(listing)
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.refused, [])
    assert.ok(existsSync(dir), 'the unreadable directory is still there')
  } finally {
    await chmod(dir, 0o755)
  }
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

test('an empty archived session directory is a candidate with zero bytes and no write time', async () => {
  const dir = join(ROOT, '--D-ALPHA--', 'session-archived-6')
  await mkdir(dir, { recursive: true })
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), 'session-archived-6'])

  const listing = await plan()
  assert.deepEqual(listing.candidates.find((entry) => entry.id === 'session-archived-6'), {
    id: 'session-archived-6',
    path: dir,
    bytes: 0,
    files: [],
    modified: null,
  })

  const report = await applyCleanup(listing)
  assert.equal(existsSync(dir), false)
  assert.equal(report.removed.find((entry) => entry.id === 'session-archived-6').bytes, 0)
})

test('a candidate that vanished between the listing and the deletion is refused, not failed', async () => {
  const listing = await plan()
  await rm(join(ROOT, '--D-BETA--', 'session-archived-3'), { recursive: true })

  const report = await applyCleanup(listing)

  assert.deepEqual(report.removed.map((entry) => entry.id).sort(), ['session-archived-1', 'session-archived-2'])
  assert.deepEqual(report.refused, [{ id: 'session-archived-3', reason: 'already deleted; nothing to remove' }])
  assert.deepEqual(report.failed, [])
})

test('a candidate replaced by a file between the listing and the deletion is refused', async () => {
  const target = join(ROOT, '--D-ALPHA--', 'session-archived-1')
  const listing = await plan()
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
  const listing = await plan()
  const [first, second, ...rest] = listing.candidates
  // Both ids are archived and both paths are inside the root, so containment alone would not notice
  // that each one now points at the other's session — and the report would name the wrong session.
  const swapped = {
    ...listing,
    candidates: [{ ...first, path: second.path }, { ...second, path: first.path }, ...rest],
  }

  const report = await applyCleanup(swapped)

  assert.deepEqual(report.removed.map((entry) => entry.id), ['session-archived-3'])
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
  await writeWorkspace([...ARCHIVED.map((entry) => entry.id), nasty])

  const listing = await plan()
  assert.equal(listing.candidates.length, 3)
  assert.ok(listing.already_gone.includes(nasty))

  const report = await applyCleanup(listing)
  assert.equal(report.refused.length, 0)
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
  await applyCleanup(listing)
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

    // The promise the README makes about this state: the id is still archived and still on disk, so the
    // next run offers it again and the same call can be repeated.
    const again = await plan({ only: ['session-archived-2'] })
    assert.deepEqual(again.candidates.map((candidate) => candidate.id), ['session-archived-2'])
    assert.deepEqual(again.requested, [])
  } finally {
    await chmod(dir, 0o755)
  }
})

test('the engine rejects arguments it cannot honour', async () => {
  assert.throws(() => encodeSegment(''), /non-empty string/)
  assert.throws(() => encodeSegment(42), /non-empty string/)

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
