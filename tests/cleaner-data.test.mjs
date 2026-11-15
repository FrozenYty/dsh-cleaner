/**
 * Where this plugin keeps its own data, and how a profile changes that.
 *
 * The trash is the only thing dsh-cleaner owns, and it must never live in the session store (a trashed session
 * has to stop being a session) nor in the Host's installation (that is not a workspace). What is left is a
 * directory in the workspace — `.agents/cleaner`, beside the memory notebook — with an override for the cases
 * where a profile wants it somewhere else. These tests hold the resolution order, the validation and the cap.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import test, { after, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CLEANER_DIR,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TRASH_LIMIT,
  listTrash,
  moveToTrash,
  planCleanup,
  resolveCleanerConfig,
  resolveDataDir,
  trashRootOf,
} from '../engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const TMP = join(here, '.tmp-cleaner-data')
const HOME = join(TMP, 'home')
const WORKSPACE = join(TMP, 'workspace')
const STORE = join(TMP, 'storages', 'sessions')
const SESSIONS = join(TMP, 'sessions')

// Every case starts with an empty fixture: a trash that accumulated across tests would answer about the wrong
// entries, which is how the cap case above first failed.
beforeEach(() => rm(TMP, { recursive: true, force: true }))
after(() => rm(TMP, { recursive: true, force: true }))

const encode = (id) => id.replace(/[^A-Za-z0-9._-]/gu, (character) => (
  `~${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
))

async function fixture(ids) {
  await mkdir(join(TMP, 'storages'), { recursive: true })
  await writeFile(join(TMP, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: ids }, tables: {} }))
  for (const id of ids) {
    const dir = join(SESSIONS, '--D-ALPHA--', encode(id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(64, 1))
  }
}

test('the data directory is the configured path, then the environment, then the workspace', () => {
  // The order matters: a profile's own patch row is the documented knob, the environment is how a launcher or a
  // test moves it, and the workspace is what most people get without configuring anything.
  assert.equal(resolveDataDir({}, HOME, WORKSPACE), resolve(WORKSPACE, CLEANER_DIR))
  assert.equal(resolveDataDir({ DSH_CLEANER_DATA_DIR: join(TMP, 'env') }, HOME, WORKSPACE), resolve(TMP, 'env'))
  // No workspace: the frozen fallback, a real directory a person can open, outside every workspace.
  assert.equal(resolveDataDir({}, HOME), join(HOME, '.dsh', 'cleaner'))
  assert.equal(CLEANER_DIR, '.agents/cleaner')
})

test('a Host installation is never treated as a workspace', () => {
  // A `.agents` directory inside the sealed asar, or beside the executable, is not a workspace: one write fails
  // and the other litters an installation. Both fall through to the frozen directory.
  const asar = join(TMP, 'app.asar', 'dsh')
  assert.equal(resolveDataDir({}, HOME, asar), join(HOME, '.dsh', 'cleaner'))
  const besideExecutable = dirname(process.execPath)
  assert.equal(resolveDataDir({}, HOME, besideExecutable), join(HOME, '.dsh', 'cleaner'))
  assert.equal(resolveDataDir({}, HOME, besideExecutable).startsWith(besideExecutable + sep), false)
})

test('the trash is one directory inside the data directory', () => {
  assert.equal(trashRootOf(join(TMP, 'data')), join(TMP, 'data', 'trash'))
  assert.throws(() => trashRootOf(''), /data directory is required/)
  assert.equal(trashRootOf(resolveDataDir({}, HOME, WORKSPACE)).startsWith(resolve(WORKSPACE, CLEANER_DIR)), true)
})

test('the config is validated before the plugin registers anything', () => {
  assert.deepEqual(resolveCleanerConfig(undefined), {
    retentionDays: DEFAULT_RETENTION_DAYS,
    trashLimit: DEFAULT_TRASH_LIMIT,
  })
  assert.deepEqual(resolveCleanerConfig({ dataDir: 'D:/somewhere', retentionDays: 7, trashLimit: 5 }), {
    dataDir: 'D:/somewhere',
    retentionDays: 7,
    trashLimit: 5,
  })
  // A present wrong value fails the load, with the field and the value named — never the first deletion.
  assert.throws(() => resolveCleanerConfig({ retentionDays: '30' }), /field "retentionDays" must be an integer >= 1; received "30"/)
  assert.throws(() => resolveCleanerConfig({ trashLimit: 0 }), /field "trashLimit" must be an integer >= 1; received 0/)
  assert.throws(() => resolveCleanerConfig({ trashLimit: 1.5 }), /received 1\.5/)
  assert.throws(() => resolveCleanerConfig({ trashLimit: null }), /received null/)
  assert.throws(() => resolveCleanerConfig({ dataDir: '   ' }), /field "dataDir" must be a non-empty path/)
  assert.throws(() => resolveCleanerConfig({ dataDir: 42 }), /received 42/)
  assert.throws(() => resolveCleanerConfig('everything'), /config must be an object; received "everything"/)
})

test('the cap prunes the oldest entry, and says why it went', async () => {
  const ids = ['session-one', 'session-two', 'session-three']
  await fixture(ids)
  const trash = trashRootOf(join(TMP, 'data'))
  // Three entries, filed one second apart, so "the oldest" is a fact rather than a guess.
  for (const [index, id] of ids.entries()) {
    const plan = await planCleanup({ sessionsRoot: SESSIONS, workspaceFile: join(TMP, 'storages', 'workspace.json'), only: [id] })
    await moveToTrash(trash, plan, new Date(Date.UTC(2026, 10, 15, 10, 0, index)))
  }

  const listed = await listTrash(trash, { limit: 2 })
  assert.equal(listed.entries.length, 2, 'the cap is honoured')
  assert.deepEqual(listed.entries.map((entry) => entry.id), ['session-two', 'session-three'], 'the newest two stay')
  assert.equal(listed.purged.length, 1)
  assert.equal(listed.purged[0].id, 'session-one')
  assert.equal(listed.purged[0].why, 'past the entry cap')
  assert.equal(listed.purged[0].bytes, 64)

  // The index agrees with the directory: a pruned entry is gone from both.
  const index = JSON.parse(await readFile(join(trash, 'index.json'), 'utf8'))
  assert.deepEqual(index.entries.map((entry) => entry.id), ['session-two', 'session-three'])
})

test('a listing with no cap set prunes nothing, even when it is full', async () => {
  // The listing is a read. Retention and the cap belong to the operations that already change things, and the
  // read must be safe to call on a trash of any size.
  await fixture(['session-kept'])
  const trash = trashRootOf(join(TMP, 'data'))
  const plan = await planCleanup({ sessionsRoot: SESSIONS, workspaceFile: join(TMP, 'storages', 'workspace.json'), only: ['session-kept'] })
  await moveToTrash(trash, plan)

  const listed = await listTrash(trash)
  assert.equal(listed.entries.length, 1)
  assert.deepEqual(listed.purged, [])
})
