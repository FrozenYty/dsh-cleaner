/**
 * The trash, against a fixture.
 *
 * A deletion is now **one atomic rename** into a sibling directory, and the bytes are freed when the entry
 * is purged — by hand, or by the retention sweep that runs when somebody looks (this plugin has no timer;
 * ADR 0001). These tests hold the engine to that: a moved session stops being a session at once, a restore
 * puts it back exactly where the backend looks for it, a purge is the only thing that frees bytes, and a
 * tampered index cannot write outside either root.
 */

import assert from 'node:assert/strict'
import { readdir, lstat, mkdir, rm, rmdir, symlink, unlink, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  moveAcrossDevices,
  encodeSegment,
  listTrash,
  moveToTrash,
  planCleanup,
  purgeTrash,
  readTrashIndex,
  restoreFromTrash,
  trashRootOf,
} from '../engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const TMP = join(here, '.tmp-trash')
const HOME = join(TMP, 'home')
const ROOT = join(HOME, 'sessions')
const TRASH = trashRootOf(HOME)
const WORKSPACE = join(HOME, 'storages', 'workspace.json')

const STORED = [
  { id: 'session-old-1', project: '--D-ALPHA--', files: { 'session.v4.jsonl.zstd': 1000 } },
  { id: 'session-old-2', project: '--D-BETA--', files: { 'session.v4.jsonl.zstd': 2000, 'session.v3.jsonl.zstd': 5 } },
]

async function writeSession({ id, project, files }, root = ROOT) {
  const dir = join(root, project, encodeSegment(id))
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), Buffer.alloc(bytes, 7))
  return dir
}

async function writeWorkspace(ids = []) {
  await mkdir(dirname(WORKSPACE), { recursive: true })
  await writeFile(WORKSPACE, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: ids, pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }, null, 2))
}

/** Build the fixture and return a plan naming every stored session. */
async function planned(ids = STORED.map((entry) => entry.id)) {
  await writeWorkspace()
  const plan = await planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, only: ids })
  return plan
}

/** The projection cache a real profile keeps: one `<id>.json` per session, and nothing else. */
const PROJECTIONS = join(HOME, 'storages', 'session_projcache', 'sessions')

/**
 * Build the fixture **with projections**, which is the shape a real profile has.
 *
 * The cache package documents pruning checkpoints as "out-of-band maintenance, same stance as session persistence
 * itself", which is why a deletion takes each session's derived record with its log.
 */
async function plannedWithProjections(ids) {
  await mkdir(PROJECTIONS, { recursive: true })
  for (const id of ids) {
    await writeFile(join(PROJECTIONS, `${id}.json`), JSON.stringify({ version: 7, record: { identity: { cwd: 'D:\\PROJ' }, rows: { title: { val: `title of ${id}` } } } }))
  }
  await writeWorkspace()
  return await planCleanup({ sessionsRoot: ROOT, workspaceFile: WORKSPACE, only: ids, projections: PROJECTIONS })
}

/**
 * Remove a link of either kind.
 *
 * POSIX removes a symlink with `unlink` and refuses `rmdir` on it; Windows reports a junction as a directory
 * and removes it with `rmdir`, refusing `unlink`. One helper, so the teardown works on both.
 */
async function removeLink(path) {
  try {
    await unlink(path)
  } catch {
    await rmdir(path)
  }
}

/**
 * Remove a fixture tree, links included.
 *
 * `rm(…, { recursive: true })` cannot remove a Windows junction — and a *dangling* one survives it, so a
 * single leftover link would fail every later teardown.
 */
async function removeTree(path) {
  let names
  try {
    names = await readdir(path)
  } catch {
    return
  }
  for (const name of names) {
    const child = join(path, name)
    let info
    try {
      info = await lstat(child)
    } catch {
      // A dangling junction cannot even be `lstat`ed on Windows; removing the link itself still works.
      await removeLink(child)
      continue
    }
    if (info.isSymbolicLink()) await removeLink(child)
    else if (info.isDirectory()) await removeTree(child)
    else await rm(child, { force: true })
  }
  await rmdir(path)
}

beforeEach(async () => {
  await removeTree(TMP)
  await mkdir(ROOT, { recursive: true })
  for (const entry of STORED) await writeSession(entry)
})

afterEach(async () => {
  await removeTree(TMP)
})

test('the trash root is a sibling of the session store, never inside it', () => {
  assert.equal(trashRootOf(HOME), TRASH)
  assert.equal(TRASH.includes(join('home', 'sessions')), false)
})

test('a move takes the session out of the store at once, and keeps every byte', async () => {
  const plan = await planned(['session-old-1'])
  const moved = await moveToTrash(TRASH, plan)

  assert.equal(moved.moved.length, 1)
  assert.equal(moved.moved[0].id, 'session-old-1')
  assert.equal(moved.moved[0].bytes, 1000)
  // Gone from the store: the backend looks there, so the session stops existing.
  assert.deepEqual(await readdir(join(ROOT, '--D-ALPHA--')), [])
  assert.equal((await readdir(TRASH)).filter((name) => name !== 'index.json').length, 1)

  const { entries } = await readTrashIndex(TRASH)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, plan.candidates[0].path, 'the original path is recorded for the restore')
  assert.ok(entries[0].trashed_at)
})

test('a restore puts the directory back where the backend looks, byte for byte', async () => {
  const plan = await planned(['session-old-2'])
  const original = plan.candidates[0].path
  await moveToTrash(TRASH, plan)

  const restored = await restoreFromTrash(TRASH, ROOT, ['session-old-2'])
  assert.equal(restored.restored.length, 1)
  assert.equal(restored.restored[0].path, original)
  assert.deepEqual(await readdir(original).then((names) => names.sort()), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])
  assert.deepEqual((await readTrashIndex(TRASH)).entries, [], 'the trash forgets what it no longer holds')
})

test('a restore refuses to overwrite a directory that reappeared', async () => {
  const plan = await planned(['session-old-1'])
  const original = plan.candidates[0].path
  await moveToTrash(TRASH, plan)
  await mkdir(original, { recursive: true })
  await writeFile(join(original, 'somebody-else'), 'not ours')

  const restored = await restoreFromTrash(TRASH, ROOT, ['session-old-1'])
  assert.equal(restored.restored.length, 0)
  assert.match(restored.refused[0].reason, /already occupies/)
  assert.equal((await readFile(join(original, 'somebody-else'), 'utf8')), 'not ours', 'and nothing was overwritten')
  assert.equal((await readTrashIndex(TRASH)).entries.length, 1, 'the entry stays in the trash')
})

test('a purge is the only thing that frees bytes, and it says how many', async () => {
  const plan = await planned()
  await moveToTrash(TRASH, plan)

  const purged = await purgeTrash(TRASH, ['session-old-1', 'session-old-2'])
  assert.equal(purged.purged.length, 2)
  assert.equal(purged.purged.reduce((sum, entry) => sum + entry.bytes, 0), 3005)
  assert.deepEqual((await readTrashIndex(TRASH)).entries, [])
  assert.deepEqual(await readdir(TRASH).then((names) => names.filter((name) => name !== 'index.json')), [])
})

test('purging and restoring name ids that are not there, instead of inventing them', async () => {
  const purged = await purgeTrash(TRASH, ['session-never-there'])
  assert.deepEqual(purged.purged, [])
  const restored = await restoreFromTrash(TRASH, ROOT, ['session-never-there'])
  assert.deepEqual(restored.restored, [])
})

test('the retention sweep runs when somebody looks, and there is no timer', async () => {
  const plan = await planned(['session-old-1'])
  const moved = await moveToTrash(TRASH, plan)
  // File the entry as if it were ten days old.
  const index = JSON.parse(await readFile(join(TRASH, 'index.json'), 'utf8'))
  index.entries[0].trashed_at = new Date(Date.now() - 10 * 86_400_000).toISOString()
  await writeFile(join(TRASH, 'index.json'), JSON.stringify(index))

  const held = await listTrash(TRASH, { purgeAfterDays: 30 })
  assert.equal(held.entries.length, 1, 'younger than the retention window, so kept')
  assert.deepEqual(held.purged, [])

  const swept = await listTrash(TRASH, { purgeAfterDays: 7 })
  assert.equal(swept.entries.length, 0)
  assert.equal(swept.purged.length, 1)
  assert.equal(swept.purged[0].bytes, 1000)
  assert.equal(moved.moved[0].trash_path.startsWith(TRASH), true)
})

test('an entry whose directory vanished is reported missing, not held', async () => {
  const plan = await planned(['session-old-1'])
  const moved = await moveToTrash(TRASH, plan)
  await rm(moved.moved[0].trash_path, { recursive: true, force: true })

  const listed = await listTrash(TRASH)
  assert.deepEqual(listed.entries, [])
  assert.deepEqual(listed.missing, ['session-old-1'])
})

test('a tampered index cannot write outside the session store', async () => {
  const plan = await planned(['session-old-1'])
  await moveToTrash(TRASH, plan)
  const index = JSON.parse(await readFile(join(TRASH, 'index.json'), 'utf8'))
  index.entries[0].path = join(TMP, 'somewhere-else', encodeSegment('session-old-1'))
  await writeFile(join(TRASH, 'index.json'), JSON.stringify(index))

  const restored = await restoreFromTrash(TRASH, ROOT, ['session-old-1'])
  assert.equal(restored.restored.length, 0)
  assert.match(restored.refused[0].reason, /outside the session storage root/)
})

test('a link is never moved into the trash or purged through', async () => {
  const plan = await planned(['session-old-1'])
  // Replace the session directory with a link to somewhere else, after the plan was made.
  await rm(plan.candidates[0].path, { recursive: true, force: true })
  const outside = join(TMP, 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'precious'), 'x')
  await symlink(outside, plan.candidates[0].path, 'junction')

  const moved = await moveToTrash(TRASH, plan)
  assert.equal(moved.moved.length, 0)
  // Windows reports a junction as a directory through `lstat`, so the refusal arrives from the resolved-path
  // check rather than the link check. Either way it is a refusal, and the tree behind the link is untouched.
  assert.match(moved.refused[0].reason, /link is not followed|outside the session storage root/)
  assert.equal((await readFile(join(outside, 'precious'), 'utf8')), 'x')
  // The junction itself goes last: a recursive delete cannot remove one on Windows, and leaving it behind
  // would poison every later test in this file. `rmdir` is what removes a link whose target is a directory.
  await removeLink(plan.candidates[0].path)
})

test('an unreadable index is an error, not an empty trash', async () => {
  await mkdir(TRASH, { recursive: true })
  await writeFile(join(TRASH, 'index.json'), 'not json at all')
  await assert.rejects(() => readTrashIndex(TRASH), /is not JSON/)
  await assert.rejects(() => listTrash(TRASH), /is not JSON/)
})

test('the engine refuses arguments it cannot honour', async () => {
  const plan = await planned()
  await assert.rejects(async () => moveToTrash('', plan), /trash root/)
  await assert.rejects(() => restoreFromTrash(TRASH, ROOT, []), /name at least one session id/)
  await assert.rejects(() => purgeTrash(TRASH, []), /name at least one session id/)
  await assert.rejects(() => listTrash(''), /trash root/)
})



test('a restore measures the store, not the index, so success cannot be reported while the store is empty', async () => {
  // The index records where a directory **was**. Quoting it back is how a restore reports success with nothing on
  // disk — the shape a lost log takes when seen from outside. The answer carries the destination's own measurement.
  const plan = await planned(['session-old-2'])
  const original = plan.candidates[0].path
  await moveToTrash(TRASH, plan)

  const put = await restoreFromTrash(TRASH, ROOT, ['session-old-2'])
  assert.equal(put.restored.length, 1)
  assert.equal(put.restored[0].path, original)
  assert.equal(put.restored[0].verified, true, 'the store holds it after the move')
  assert.deepEqual(await readdir(original).then((names) => names.sort()), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])
  assert.ok(put.restored[0].bytes > 0, 'and the bytes are measured at the destination')

  // Nothing left to move: the second call names a restored id and reports nothing, rather than a success.
  const again = await restoreFromTrash(TRASH, ROOT, ['session-old-2'])
  assert.equal(again.restored.length, 0)
  assert.equal(again.failed.length + again.refused.length, 0)
})

test('a move takes the derived record with the log, a restore puts it back, and a purge frees it', async () => {
  // A blank session's row is drawn from its projection — title, cwd and the blank flag — so a deletion that moved
  // only the log would leave the record that draws the row. The cache package calls pruning "out-of-band
  // maintenance, same stance as session persistence itself", which is exactly what this plugin is.
  const ids = ['session-old-2']
  const plan = await plannedWithProjections(ids)
  const projection = join(PROJECTIONS, 'session-old-2.json')
  assert.ok(existsSync(projection), 'the fixture starts with a projection')

  const moved = await moveToTrash(TRASH, plan)
  assert.equal(moved.moved.length, 1)
  assert.equal(existsSync(projection), false, 'the derived record left with the log')
  assert.ok(existsSync(join(TRASH, moved.moved[0].trash_path.split(/[\\/]/u).pop(), 'projection.json')), 'and it is inside the trashed folder')

  const back = await restoreFromTrash(TRASH, ROOT, ids)
  assert.equal(back.restored[0].projection, true, 'the restore says the record went back')
  assert.ok(existsSync(projection), 'the projection is where the sidebar reads it')

  // Purge: the folder walk already owns every file inside, so the record is freed with the log and counted.
  await moveToTrash(TRASH, await plannedWithProjections(ids))
  const purged = await purgeTrash(TRASH, ids)
  assert.equal(purged.purged.length, 1)
  assert.equal(existsSync(projection), false, 'a purge frees the derived record too')
})

test('a move across devices copies, verifies, and only then removes the source', async () => {
  // The case that broke every real deletion once the trash moved into the workspace: `rename` answers EXDEV when
  // the store and the trash are on different volumes. The fallback must never be able to lose a session, so it
  // stages the copy, compares what arrived with what is there, and removes the source last.
  const source = join(ROOT, '--D-ALPHA--', 'session-old-1')
  const target = join(TRASH, 'crossed', 'session-old-1')
  await mkdir(dirname(target), { recursive: true })

  const before = await readdir(source)
  const transfer = await moveAcrossDevices(source, target, { copy: true })
  assert.equal(transfer.copied, true, 'the forced path is the copy path')
  assert.ok(transfer.bytes > 0)
  assert.deepEqual((await readdir(target)).sort(), before.sort(), 'every file arrived')
  assert.equal(existsSync(source), false, 'and the source is gone only after the copy was verified')

  // And back again: a restore crosses the boundary in the other direction.
  const back = join(ROOT, '--D-ALPHA--', 'session-back-1')
  const returned = await moveAcrossDevices(target, back, { copy: true })
  assert.equal(returned.files, before.length, 'the count is a number on the copy path, where it was measured')
  assert.deepEqual((await readdir(back)).sort(), before.sort())
})
