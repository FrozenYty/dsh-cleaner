/**
 * dsh-cleaner — the deletion engine.
 *
 * WHAT THIS IS FOR
 * An archive in DeepSeek Harness only hides a session: its log stays on disk until something removes
 * it, and the official persistence seam does not do that. `@deepseek-ai/dsh-session-persistence`
 * lists "No deletion or retention API — pruning stored sessions is out-of-band backend maintenance"
 * among its known limitations, and its JSONL backend says the same in one line: "Nothing deletes
 * session files — logs accumulate under root until removed externally." This module is that external
 * maintenance, and nothing more.
 *
 * WHY IT TAKES PATHS
 * Every entry point receives the session storage root and the workspace storage file as arguments,
 * so each test runs against a fixture and never touches a real ~/.dsh. The bundle entry resolves the
 * two paths from DSH_HOME and passes them here; this file never reads the environment.
 *
 * WHAT IT WILL NOT DO
 * - It never touches a session the store does not hold, and it re-checks every candidate against the live
 *   filesystem at deletion time: the directory must still be a real directory, still encode this id, and
 *   still resolve inside the storage root.
 * - It never touches an id the caller protects — the Session running the command, or one whose agent is
 *   busy.
 * - It never follows a link. Symlinked project and session directories are skipped by the walk, a
 *   session directory holding anything but regular files is refused rather than removed, every
 *   candidate is resolved under the storage root before a byte is unlinked, and files are unlinked
 *   one at a time instead of handing a recursive delete the whole tree.
 * - It never opens a session log, reads an event or rewrites a line. The unit of removal is the
 *   session's own directory, which is what the backend owns and what a later generation would
 *   otherwise inherit.
 *
 * THE LAYOUT IT EXPECTS
 * Read from the installed asar, not from memory: `dsh-session-persistence-jsonl` stores one session
 * per directory as `<root>/<project-key>/<encoded-id>/session.vN.jsonl.zstd`, where the project key
 * is a readable transform of the session's cwd and the session id is escaped to a single path
 * segment by `encodeSegment`. `encodeSegment` below is that function, reproduced because a
 * profile-linked bundle cannot import an @deepseek-ai package (dsh-team ADR 0002).
 */

import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Escape one string to a single safe path segment, as `dsh-session-persistence-jsonl` does: safe
 * code units stay literal, every other unit — `~` included — becomes `~XXXX`, and `.`/`..` are
 * special-cased so neither can traverse. Reproduced, not imported; the backend's own doc comment
 * states the rule this mirrors.
 * @param raw - the session id to encode; must be non-empty.
 * @returns the escaped path segment, decodable back to `raw`.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('a session id must be a non-empty string')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The inverse of {@link encodeSegment}: the id an escaped directory name came from.
 *
 * The escape is injective — a safe unit stays literal and every other unit becomes `~XXXX`, `~` included
 * — so the directory name is a complete record of the id, and the store can be enumerated without an
 * archive list or any other index. A name that is not a valid escape cannot come from this backend, and
 * the caller keeps it as it stands.
 * @param encoded - one directory name under a project key.
 * @returns the session id it encodes.
 */
export function decodeSegment(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('an encoded session id must be a non-empty string')
  }
  return encoded.replace(/~([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * The archived session ids, read from the workspace storage file's `global.archivedSessionIds`.
 *
 * A missing file is an empty archive: a fresh installation has archived nothing. A file that exists
 * but cannot be read or parsed is an error, never an empty list — "nothing is archived" and "the
 * archive list is unreadable" must not look alike to a caller that is about to delete something.
 * @param workspaceFile - absolute path of the workspace storage file.
 * @returns the archived ids, de-duplicated, in stored order.
 */
export async function readArchivedIds(workspaceFile) {
  let text
  try {
    text = await readFile(workspaceFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`cannot read the workspace storage file ${workspaceFile}: ${error?.message ?? error}`)
  }
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`the workspace storage file ${workspaceFile} is not valid JSON: ${error?.message ?? error}`)
  }
  const ids = document?.global?.archivedSessionIds
  if (ids === undefined) return []
  if (!Array.isArray(ids)) {
    throw new Error(`the workspace storage file ${workspaceFile}: global.archivedSessionIds is not an array`)
  }
  const seen = new Set()
  const archived = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`the workspace storage file ${workspaceFile}: every archived session id must be a non-empty string`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    archived.push(id)
  }
  return archived
}

/**
 * The files directly inside one session directory, or the reason it cannot be removed safely.
 * Only regular files count: a link or a nested directory would need a decision this plugin does not
 * make, so the directory is reported to the caller instead of being deleted.
 *
 * `modified` is the newest file's write time — for a session log that is the last time the session
 * appended anything, which is the fact a person needs to decide whether an old session still matters.
 * An empty directory has no write time and reports `null`.
 * @param dir - a candidate session directory.
 * @returns `{ ok: true, files, bytes, modified }` or `{ ok: false, reason }`.
 */
async function readDirectoryFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { ok: false, reason: `cannot be listed: ${error?.message ?? error}`, bytes: 0, files: 0 }
  }
  const files = []
  let bytes = 0
  let newest = 0
  // The first refusal decides why this directory is not a candidate, but the walk does not stop there:
  // every regular file it can measure still belongs to the store, and a total that silently omits them
  // would be smaller than what the person sees on disk. Entries that are not regular files are never
  // measured — that is the same rule as never following them.
  let refusal
  for (const entry of entries) {
    if (!entry.isFile()) {
      refusal ??= `holds a non-file entry (${entry.name}); a link or a nested directory is refused, not followed`
      continue
    }
    let info
    try {
      info = await lstat(join(dir, entry.name))
    } catch (error) {
      refusal ??= `cannot be read (${entry.name}): ${error?.message ?? error}`
      continue
    }
    if (!info.isFile()) {
      refusal ??= `holds a non-file entry (${entry.name}); a link or a nested directory is refused, not followed`
      continue
    }
    files.push(entry.name)
    bytes += info.size
    newest = Math.max(newest, info.mtimeMs)
  }
  if (refusal !== undefined) return { ok: false, reason: refusal, bytes }
  return { ok: true, files, bytes, modified: newest === 0 ? null : new Date(newest).toISOString() }
}

/**
 * The title a person gave a session, read from the runtime's projection cache.
 *
 * Decoration, never a decision: a missing file, an older record version or invalid JSON all mean "no
 * title", and the listing answers without one. Nothing here is written, and no log is touched to get a
 * title — the cache is the runtime's own derived record, and reading it is the only use this plugin makes
 * of it.
 * @param cacheDir - the projection cache's session directory.
 * @param id - a session id.
 * @returns the title, whitespace-collapsed and bounded, or undefined.
 */
async function readProjectionTitle(cacheDir, id) {
  const title = await readProjectionRow(cacheDir, id, 'title')
  if (title === undefined) return undefined
  const trimmed = title.trim().replace(/\s+/g, ' ').replace(/"/g, "'")
  return trimmed === '' ? undefined : trimmed.slice(0, 60)
}

/**
 * One string row of a session's derived record, read from the projection cache.
 *
 * The cache is a table of named rows — `title`, `workingDirectory`, `blank` … — and a row holds
 * `{ ver, seq, val }`. Reading one row is the whole operation, so the name is a parameter rather than a copy of
 * the JSON walk per fact; sanitising stays with the caller, because "a title" and "a path" are tidied differently.
 * @param cacheDir - the projection cache's session directory.
 * @param id - a session id.
 * @param row - the row name, as the runtime spells it.
 * @returns the row's string value, or undefined when it is missing or not a string.
 */
async function readProjectionRow(cacheDir, id, row) {
  let text
  try {
    text = await readFile(join(cacheDir, `${encodeSegment(id)}.json`), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text)?.record?.rows?.[row]?.val
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Every session-owned directory under the storage root, keyed by its on-disk directory name.
 *
 * The walk is two levels deep on purpose, because that is the backend's layout: a project key
 * directory, then one directory per session. Neither level is entered when the entry is not a real
 * directory, so a junction or symlink is reported rather than followed.
 *
 * `refused` is the part that keeps the rest of the answer honest: a session directory that exists but
 * was refused is not a candidate, and it is not *gone* either. The ids it holds must not be reported as
 * already deleted, or the listing would claim a log is gone while it sits there taking space.
 * @param sessionsRoot - absolute path of the session storage root.
 * @returns `{ stored, skipped, refused, refusedBytes }`.
 */
export async function scanStoredSessions(sessionsRoot) {
  const stored = new Map()
  const skipped = []
  const refused = new Map()
  let refusedBytes = 0
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        stored,
        skipped: [{ path: sessionsRoot, reason: 'the session storage root does not exist' }],
        refused,
        refusedBytes,
      }
    }
    throw new Error(`cannot read the session storage root ${sessionsRoot}: ${error?.message ?? error}`)
  }
  for (const project of projects) {
    const projectDir = join(sessionsRoot, project.name)
    if (!project.isDirectory()) {
      skipped.push({ path: projectDir, reason: 'not a directory; a link at this level is not followed' })
      continue
    }
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: projectDir, reason: `cannot be listed: ${error?.message ?? error}` })
      continue
    }
    for (const entry of entries) {
      const dir = join(projectDir, entry.name)
      if (!entry.isDirectory()) {
        skipped.push({ path: dir, reason: 'not a directory; a link at this level is not followed' })
        continue
      }
      const reading = await readDirectoryFiles(dir)
      if (!reading.ok) {
        skipped.push({ path: dir, reason: reading.reason })
        refused.set(entry.name, reading.reason)
        refusedBytes += reading.bytes
        continue
      }
      // One session id should live in one project directory, but a moved cwd or a copied tree can leave
      // a second directory with the same name. Keeping the first and reporting the second turns a silent
      // under-count into a visible one; deleting the reported session makes the other a candidate next run.
      if (stored.has(entry.name)) {
        skipped.push({ path: dir, reason: 'a second directory with the same session id; the other one is the candidate' })
        continue
      }
      stored.set(entry.name, { dir, files: reading.files, bytes: reading.bytes, modified: reading.modified })
    }
  }
  return { stored, skipped, refused, refusedBytes }
}

/**
 * Work out what a deletion would remove, without removing anything.
 *
 * `protect` carries the ids that must not be touched and why; the bundle entry fills it with the
 * Session running the command and every live agent. `only` narrows the candidate set to the ids a
 * person approved, and every requested id that does not become a candidate is reported in
 * `requested` with the reason.
 * @param options - `{ sessionsRoot, workspaceFile, protect, only }`.
 * @returns a JSON-serialisable plan, consumed by {@link moveToTrash}.
 */
export async function planCleanup({ sessionsRoot, workspaceFile, protect = [], only, projections } = {}) {
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) {
    throw new Error('planCleanup: sessionsRoot must be a non-empty string')
  }
  if (typeof workspaceFile !== 'string' || workspaceFile.length === 0) {
    throw new Error('planCleanup: workspaceFile must be a non-empty string')
  }
  if (projections !== undefined && (typeof projections !== 'string' || projections.length === 0)) {
    throw new Error('planCleanup: projections must be a non-empty string when given')
  }
  if (only !== undefined && (!Array.isArray(only) || only.some((id) => typeof id !== 'string' || id.length === 0))) {
    throw new Error('planCleanup: only must be an array of non-empty session ids')
  }
  const protectedReason = new Map()
  for (const entry of protect) {
    if (typeof entry?.id === 'string' && entry.id.length > 0) protectedReason.set(entry.id, entry.reason ?? 'protected')
  }

  const archived = await readArchivedIds(workspaceFile)
  const archivedSet = new Set(archived)
  const { stored, skipped, refused, refusedBytes } = await scanStoredSessions(sessionsRoot)
  const requested = new Set(only ?? [])
  const candidates = []
  const alreadyGone = []
  const protectedSessions = []

  // The store is the index: every session whose log is on disk is a candidate, archived or not. Archiving
  // is the product's way to hide a session, not this plugin's precondition, and requiring it was what made
  // a deletion take two surfaces and produce a class of refusals nobody could act on.
  for (const [encoded, entry] of stored) {
    const id = decodeSegment(encoded)
    if (requested.size > 0 && !requested.has(id)) continue
    if (protectedReason.has(id)) {
      protectedSessions.push({ id, path: entry.dir, bytes: entry.bytes, reason: protectedReason.get(id) })
      continue
    }
    candidates.push({
      id,
      path: entry.dir,
      bytes: entry.bytes,
      files: entry.files,
      modified: entry.modified,
      archived: archivedSet.has(id),
    })
  }
  // An archived id with no directory is worth saying out loud even when nothing was asked for: it is the
  // one state a person cannot see on disk, and it is what an earlier deletion leaves in the archive list.
  for (const id of archived) {
    if (requested.size > 0 && !requested.has(id)) continue
    const encoded = encodeSegment(id)
    if (!stored.has(encoded) && !refused.has(encoded)) alreadyGone.push(id)
  }

  // A title only for what a person is about to decide about, and only when one could be read: the
  // listing is where ids have to be matched against the sessions someone remembers by name. The workspace goes
  // with it, because two sessions can carry the same title in different projects, and the trash page shows both.
  if (projections !== undefined) {
    for (const candidate of candidates) {
      const title = await readProjectionTitle(projections, candidate.id)
      if (title !== undefined) candidate.title = title
      const workspace = await readProjectionRow(projections, candidate.id, 'workingDirectory')
      const trimmed = workspace?.trim()
      if (trimmed !== undefined && trimmed !== '') candidate.workspace = trimmed
    }
  }

  // Every id the caller asked for must be accounted for, with a reason a person can act on: it is
  // protected, its directory was refused, or nothing is stored under it at all.
  const requestedReport = []
  const unlogged = []
  if (requested.size > 0) {
    for (const id of requested) {
      if (candidates.some((candidate) => candidate.id === id)) continue
      const encoded = encodeSegment(id)
      // No directory under this id at all, archived or not: the caller named a session whose log is gone,
      // and a record somewhere may still name it. That is the set the caller can have a ghost row for.
      if (!stored.has(encoded)) unlogged.push(id)
      let reason
      if (protectedReason.has(id)) reason = protectedReason.get(id)
      else if (refused.has(encoded)) reason = `its directory is not a candidate: ${refused.get(encoded)}`
      else reason = archivedSet.has(id)
        ? 'no session directory is stored under that id; already deleted'
        : 'no session directory is stored under that id'
      requestedReport.push({ id, reason })
    }
  }

  return {
    sessions_root: sessionsRoot,
    workspace_file: workspaceFile,
    // The projection cache, when the caller named one, travels with the plan so a move can take each session's
    // derived record with its log (the cache package documents pruning checkpoints as out-of-band maintenance).
    ...(projections === undefined ? {} : { projections }),
    archived_ids: archived.length,
    stored_sessions: stored.size,
    // Everything the store holds, not only what is reclaimable: a listing that says "4 MiB" without
    // saying "of 84 MiB" leaves the person unable to judge whether the cleanup is worth it. A refused
    // directory contributes the bytes that could be measured before the refusal.
    stored_bytes: [...stored.values()].reduce((sum, entry) => sum + entry.bytes, refusedBytes),
    candidates,
    total_bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    already_gone: alreadyGone,
    // Named ids with no stored directory, whether or not the archive still lists them. A record can name
    // such a session even after it was unarchived, which is exactly the state a ghost row is found in.
    unlogged,
    protected: protectedSessions,
    skipped,
    requested: requestedReport,
  }
}

/**
 * The trash: a sibling of the session store, so that a deletion is **one atomic rename** and the session
 * stops being a session at once.
 *
 * Layout, all of it ours:
 *
 * ```
 * <dataDir>/trash/
 *   index.json                    { version: 1, entries: [{ id, path, trashed_at, files, bytes, title? }] }
 *   <stamp>-<encoded-id>/         the session's directory, byte for byte as it was
 * ```
 *
 * Why a rename rather than an unlink: a rename either happens or does not, so a session a live writer is
 * holding cannot be left half-removed (the per-session kernel lock is not observable from here — see
 * `docs/seams.md`). The store stops listing the session the moment the rename lands, and the bytes are freed
 * when the entry is purged, by hand or by the retention sweep.
 *
 * `index.json` is written atomically (temp file + rename) and re-read on every operation: it is the only
 * record of what is in the trash, so it is never trusted from memory.
 */
const TRASH_VERSION = 1

/**
 * The directory this plugin owns, relative to the **user's home** directory.
 *
 * One folder holds everything dsh-cleaner writes — the trash and its index. The base is the home directory and
 * never a workspace, a profile default or the checkout: those move, and a data directory that moves is the one
 * failure this plugin cannot undo. `~/.agents/<plugin>` is the machine-wide home for plugin data, chosen so that
 * every bundle's own state sits in one place a person can open, back up and reason about.
 */
export const CLEANER_DIR = '.agents/cleaner'

/** Environment override for that directory; tests use it too, so no test can reach a real workspace. */
const DATA_DIR_ENV = 'DSH_CLEANER_DATA_DIR'

/** How long a trashed session is kept when the plugin config says nothing. */
export const DEFAULT_RETENTION_DAYS = 30

/**
 * How many trashed sessions are kept when the config says nothing.
 *
 * **The reason, not the number**: a trashed session on this machine averages a few hundred kilobytes, so two
 * hundred is tens of megabytes against a store measured in gigabytes, and the error is irreversible — a pruned
 * artifact has no bytes left to restore. A default belongs on the generous side when the cost is a rounding
 * error and the failure cannot be undone.
 */
export const DEFAULT_TRASH_LIMIT = 200

/** The config fields this plugin reads, each validated before anything is registered. */
export const CONFIG_FIELDS = Object.freeze({
  dataDir: 'dataDir',
  retentionDays: 'retentionDays',
  trashLimit: 'trashLimit',
})

/**
 * The default data directory: the home directory's `.agents/cleaner`.
 *
 * It is the same answer on every machine, in every workspace and under every profile, which is the whole point:
 * a location that cannot drift. A machine with neither a config field nor the environment override still has a
 * destination for the bytes, and it is a directory a person can open.
 * @param home - the user's home directory.
 * @returns the default directory.
 */
export function frozenDataDir(home = homedir()) {
  return join(home, '.agents', 'cleaner')
}

/** The directory an operator configured, or undefined when none is set. */
function configuredDataDir(env) {
  const override = env?.[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return undefined
}

/**
 * Resolve the plugin data directory: the configured override, then the workspace, then the frozen fallback.
 *
 * Every leg is a destination, never a guess: the frozen one is a real directory a person can open, which is
 * what lets the plugin promise that a deletion always has somewhere to put the bytes.
 * @param env - process environment.
 * @param home - the user's home directory.
 * @param cwd - the workspace this call speaks for, when one is known.
 * @returns the absolute data directory.
 */
export function resolveDataDir(env = process.env, home = homedir(), cwd) {
  const configured = configuredDataDir(env)
  if (configured !== undefined) return resolve(configured)
  // `cwd` is accepted and **ignored**, deliberately: it used to be the workspace leg, and a workspace moves. The
  // parameter stays so a caller that still passes one cannot silently mean "write somewhere else"; the answer is
  // the home directory's `.agents/cleaner` either way.
  void cwd
  return frozenDataDir(home)
}

/** The trash root inside a data directory. */
export function trashRootOf(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('trashRootOf: a data directory is required')
  return join(dataDir, 'trash')
}

/** Render one rejected value so a message distinguishes `'30'` from `30` and shows `null` and `NaN`. */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value)
  return String(value)
}

/**
 * Resolve the settings this plugin runs with, from the bundle patch row's `config`.
 *
 * The official rows in the Host declare integer fields with a default and `minimum: 1`, and refuse a value
 * outside the range rather than clamping it. This mirrors that: an absent field takes its default, and a
 * present wrong value fails the **load**, with the field, the value it saw and the minimum named — never the
 * first deletion, hours later.
 * @param config - the plugin config the loader passed from the patch row; `undefined` when nothing is set.
 * @returns `{ dataDir?, retentionDays, trashLimit }`.
 * @throws {TypeError} when a field is present and not what its contract says.
 */
export function resolveCleanerConfig(config) {
  if (config === undefined || config === null) {
    return { retentionDays: DEFAULT_RETENTION_DAYS, trashLimit: DEFAULT_TRASH_LIMIT }
  }
  if (typeof config !== 'object') {
    throw new TypeError(`dsh-cleaner: config must be an object; received ${describeValue(config)}`)
  }
  const settings = { retentionDays: DEFAULT_RETENTION_DAYS, trashLimit: DEFAULT_TRASH_LIMIT }
  const dataDir = config[CONFIG_FIELDS.dataDir]
  if (dataDir !== undefined) {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new TypeError(
        `dsh-cleaner: config field "${CONFIG_FIELDS.dataDir}" must be a non-empty path; received ${describeValue(dataDir)}`,
      )
    }
    settings.dataDir = dataDir.trim()
  }
  for (const [field, fallback] of [
    [CONFIG_FIELDS.retentionDays, DEFAULT_RETENTION_DAYS],
    [CONFIG_FIELDS.trashLimit, DEFAULT_TRASH_LIMIT],
  ]) {
    const value = config[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new TypeError(`dsh-cleaner: config field "${field}" must be an integer >= 1; received ${describeValue(value)}`)
    }
    settings[field] = value
  }
  return settings
}

/**
 * Read the trash index.
 * @param trashRoot - the resolved trash root.
 * @returns `{ version, entries }`; a missing index is an empty trash, not an error.
 */
export async function readTrashIndex(trashRoot) {
  const file = join(trashRoot, 'index.json')
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: TRASH_VERSION, entries: [] }
    throw new Error(`the trash index ${file} cannot be read: ${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Refused, never guessed: an index this build cannot read is somebody else's data, and inventing entries
    // would be worse than saying so.
    throw new Error(`the trash index ${file} is not JSON: ${error?.message ?? error}`)
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : undefined
  if (entries === undefined) throw new Error(`the trash index ${file} has no entries array`)
  return {
    version: typeof parsed.version === 'number' ? parsed.version : TRASH_VERSION,
    entries: entries.filter((entry) => typeof entry?.id === 'string' && typeof entry?.path === 'string'),
  }
}

/** Write the trash index atomically: a reader never sees a half-written file. */
async function writeTrashIndex(trashRoot, entries) {
  await mkdir(trashRoot, { recursive: true })
  const file = join(trashRoot, 'index.json')
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: TRASH_VERSION, entries }, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Move the planned session directories into the trash, one atomic rename each.
 *
 * Every guard the deletion already performed is repeated here against the live filesystem, because a plan is
 * a description of the past: the directory must still be a real directory inside the store, it must still
 * hold only regular files, and its name must still be the escaped form of the id it is filed under.
 * @param trashRoot - where the trash lives.
 * @param plan - a plan from {@link planCleanup}.
 * @param now - the timestamp to file the entries under (defaults to the current time).
 * @returns `{ moved, refused, failed }` — each moved entry names its trash path.
 */
export async function moveToTrash(trashRoot, plan, now = new Date()) {
  if (typeof trashRoot !== 'string' || trashRoot.length === 0) throw new Error('moveToTrash: a trash root is required')
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.candidates)) {
    throw new Error('moveToTrash: pass the plan returned by planCleanup')
  }
  if (typeof plan.sessions_root !== 'string' || plan.sessions_root.length === 0) {
    throw new Error('moveToTrash: the plan must name its session storage root')
  }
  let root
  try {
    root = await realpath(plan.sessions_root)
  } catch (error) {
    throw new Error(`cannot resolve the session storage root ${plan.sessions_root}: ${error?.message ?? error}`)
  }
  const stamp = typeof now?.toISOString === 'function' ? now.toISOString().replace(/[:.]/gu, '-') : String(Date.now())
  const existing = await readTrashIndex(trashRoot)
  const entries = [...existing.entries]
  const moved = []
  const refused = []
  const failed = []
  for (const candidate of plan.candidates) {
    const check = await checkCandidate(candidate, root)
    if (check.kind !== 'ok') {
      const bucket = check.kind === 'refused' ? refused : failed
      bucket.push(check.kind === 'refused'
        ? { id: check.id, reason: check.reason }
        : { id: check.id, path: check.path, error: check.error })
      continue
    }
    const folder = `${stamp}-${encodeSegment(check.id)}`
    const trashPath = join(trashRoot, folder)
    let crossed = false
    try {
      await mkdir(trashRoot, { recursive: true })
      // Across volumes when the trash is not on the store's device: `EXDEV` is the normal case once the data
      // directory lives in the workspace, and a plain `rename` refused every session that had a log.
      const transfer = await moveAcrossDevices(check.path, trashPath)
      crossed = transfer.copied
    } catch (error) {
      failed.push({ id: check.id, path: check.path, error: `cannot be moved into the trash: ${error?.message ?? error}` })
      continue
    }
    const entry = {
      id: check.id,
      // The original path is recorded so a restore puts the directory back where the backend looks for it.
      path: check.path,
      trashed_at: new Date().toISOString(),
      files: check.files,
      bytes: check.bytes,
      folder,
      // Says the transfer crossed a device boundary, which is the difference between an atomic rename and a
      // verified copy: worth recording, because it is the case a reader would otherwise assume cannot happen.
      ...(crossed ? { copied: true } : {}),
    }
    if (candidate.title !== undefined) entry.title = candidate.title
    // The workspace the session belonged to, recorded next to the title at the moment of the move: it is read from
    // the projection, which travels into the trash and may be missing afterwards, and the page needs it to tell two
    // same-titled sessions apart.
    if (candidate.workspace !== undefined) entry.workspace = candidate.workspace
    // The projection is the product's derived record for this id — its title, its `cwd` and whether it is blank —
    // and a **blank** session's row is drawn from exactly that. Its own package documents pruning checkpoints as
    // "out-of-band maintenance, same stance as session persistence itself", so it travels with the log: into the
    // same trash folder, back on restore, freed by a purge. Best-effort: a projection that is missing or held costs
    // its own record, never the deletion — the log is the authority.
    if (typeof plan.projections === 'string' && plan.projections.length > 0) {
      const projection = join(plan.projections, `${check.id}.json`)
      try {
        await moveAcrossDevices(projection, join(trashPath, 'projection.json'))
        entry.projection_path = projection
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          entry.projection_error = String(error?.message ?? error)
        }
      }
    }
    entries.push(entry)
    moved.push({
      id: check.id,
      path: check.path,
      trash_path: trashPath,
      files: check.files,
      bytes: check.bytes,
      // Only when there is one: a key holding `undefined` still answers `'title' in entry`, and the answer
      // would claim a title the cache never had.
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      ...(candidate.workspace === undefined ? {} : { workspace: candidate.workspace }),
    })
  }
  await writeTrashIndex(trashRoot, entries)
  return { moved, refused, failed }
}

/**
 * Check one planned candidate against the live filesystem, without touching it.
 * @param candidate - one entry of `plan.candidates`.
 * @param root - the resolved session storage root.
 * @returns `{ kind: 'ok', id, path, files, bytes }` or a refusal/failure with the reason.
 */
async function checkCandidate(candidate, root) {
  const id = candidate?.id
  const path = candidate?.path
  if (typeof id !== 'string' || typeof path !== 'string') {
    return { kind: 'refused', id: String(id), reason: 'the plan entry has no usable id or path' }
  }
  if (basename(path) !== encodeSegment(id)) {
    // The id and the path must describe the same session, or every record this makes names the wrong one.
    return { kind: 'refused', id, reason: `the path names a different session (${basename(path)})` }
  }
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'refused', id, reason: 'already gone; nothing to move' }
    return { kind: 'failed', id, path, error: `cannot be inspected: ${error?.message ?? error}` }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    // A junction reports as a directory through `lstat` on Windows, so the link is named explicitly: this
    // plugin moves directories it owns, never the tree a link points at.
    return { kind: 'refused', id, reason: `${info.isSymbolicLink() ? 'a link' : 'not a real directory'}; a link is not followed` }
  }
  let resolved
  try {
    resolved = await realpath(path)
  } catch (error) {
    return { kind: 'failed', id, path, error: `cannot be resolved: ${error?.message ?? error}` }
  }
  const inside = relative(root, resolved)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { kind: 'refused', id, reason: `resolves outside the session storage root (${resolved})` }
  }
  const reading = await readDirectoryFiles(path)
  if (!reading.ok) return { kind: 'refused', id, reason: reading.reason }
  let bytes = 0
  for (const name of reading.files) {
    const stat = await lstat(join(path, name))
    if (!stat.isFile()) return { kind: 'refused', id, reason: `${name} is not a regular file` }
    bytes += stat.size
  }
  return { kind: 'ok', id, path, files: reading.files.length, bytes }
}

/**
 * What the trash holds, with the retention sweep applied on the way through.
 *
 * There is no timer anywhere in this plugin (ADR 0001): retention is enforced when somebody looks or acts,
 * which is the only moment it can matter. Two rules run here — the age one, and the cap on how many entries
 * are kept — and the **oldest go first**, because the newest entry is the mistake somebody is most likely to
 * be undoing. Everything pruned is reported with its id and its bytes, so a person can see what it cost.
 * @param trashRoot - the resolved trash root.
 * @param options - `{ sessionsRoot?, purgeAfterDays?, limit?, now? }`.
 * @returns `{ entries, purged, missing }`: entries still held, entries just purged, entries whose directory
 * vanished behind our back.
 */
export async function listTrash(trashRoot, { sessionsRoot, purgeAfterDays = 0, limit = 0, now = new Date() } = {}) {
  if (typeof trashRoot !== 'string' || trashRoot.length === 0) throw new Error('listTrash: a trash root is required')
  const { entries } = await readTrashIndex(trashRoot)
  const running = []
  const missing = []
  for (const entry of entries) {
    const folder = typeof entry.folder === 'string' ? entry.folder : undefined
    const held = folder === undefined ? undefined : join(trashRoot, folder)
    let present = false
    if (held !== undefined) {
      try {
        present = (await lstat(held)).isDirectory()
      } catch {
        present = false
      }
    }
    running.push({ entry, held, present })
    if (!present) missing.push(entry.id)
  }
  const purged = []
  let kept = running
  const doomed = []
  if (purgeAfterDays > 0) {
    const cutoff = now.getTime() - purgeAfterDays * 86_400_000
    for (const candidate of running) {
      const at = Date.parse(String(candidate.entry.trashed_at ?? ''))
      if (Number.isFinite(at) && at <= cutoff) doomed.push({ ...candidate, why: 'past the retention window' })
    }
  }
  if (limit > 0) {
    const held = running.filter(({ present }) => present)
    const alreadyDoomed = new Set(doomed.map(({ entry }) => entry.id))
    const rest = held
      .filter(({ entry }) => !alreadyDoomed.has(entry.id))
      .sort((left, right) => String(left.entry.trashed_at ?? '').localeCompare(String(right.entry.trashed_at ?? '')))
    for (const candidate of rest.slice(0, Math.max(0, rest.length - limit))) {
      doomed.push({ ...candidate, why: 'past the entry cap' })
    }
  }
  for (const { entry, held, why } of doomed) {
    if (held === undefined) continue
    const outcome = await purgeDirectoryIn(trashRoot, held)
    purged.push({ id: entry.id, bytes: outcome.bytes, error: outcome.error, why })
  }
  if (doomed.length > 0) {
    const dropped = new Set(doomed.map(({ entry }) => entry.id))
    kept = running.filter(({ entry }) => !dropped.has(entry.id))
    await writeTrashIndex(trashRoot, kept.filter(({ present }) => present).map(({ entry }) => entry))
  }
  return {
    entries: kept.filter(({ present }) => present).map(({ entry }) => entry),
    purged,
    missing,
    sessions_root: sessionsRoot,
  }
}

/**
 * Put trashed sessions back where the backend looks for them.
 *
 * A restore is the one place this plugin unarchives, and it is the reason the archive flag is not a lie: a
 * deletion hides a row, a restore brings it back ([ADR 0012](docs/adr/0012-archive-never-unarchive.md)).
 * @param trashRoot - the resolved trash root.
 * @param sessionsRoot - the store the directory has to go back into.
 * @param ids - the session ids to restore.
 * @returns `{ restored, refused, failed }`.
 */
export async function restoreFromTrash(trashRoot, sessionsRoot, ids) {
  if (typeof trashRoot !== 'string' || trashRoot.length === 0) throw new Error('restoreFromTrash: a trash root is required')
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) throw new Error('restoreFromTrash: a session storage root is required')
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('restoreFromTrash: name at least one session id')
  let storeRoot
  try {
    storeRoot = await realpath(sessionsRoot)
  } catch (error) {
    throw new Error(`cannot resolve the session storage root ${sessionsRoot}: ${error?.message ?? error}`)
  }
  const { entries } = await readTrashIndex(trashRoot)
  const wanted = new Set(ids.map(String))
  const restored = []
  const refused = []
  const failed = []
  const remaining = []
  for (const entry of entries) {
    if (!wanted.has(entry.id)) {
      remaining.push(entry)
      continue
    }
    const target = entry.path
    // The index is ours, but it is still data on disk: a target outside the store is refused rather than
    // created, so a tampered index cannot write anywhere.
    const inside = relative(storeRoot, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      refused.push({ id: entry.id, reason: `the recorded path is outside the session storage root (${target})` })
      remaining.push(entry)
      continue
    }
    const held = join(trashRoot, String(entry.folder ?? ''))
    let info
    try {
      info = await lstat(held)
    } catch (error) {
      failed.push({ id: entry.id, error: `the trashed directory is gone: ${error?.message ?? error}` })
      continue
    }
    if (!info.isDirectory()) {
      refused.push({ id: entry.id, reason: 'the trashed entry is not a directory' })
      remaining.push(entry)
      continue
    }
    // Decided before the rename, not from its error: on Windows moving onto an occupied directory reports
    // EPERM, which is also what "in use" reports, and this plugin never overwrites what it did not put there.
    let occupied
    try {
      occupied = await lstat(target)
    } catch {
      occupied = undefined
    }
    if (occupied !== undefined) {
      refused.push({ id: entry.id, reason: `a directory already occupies ${target}, so this restore would overwrite it` })
      remaining.push(entry)
      continue
    }
    // The derived record goes back before the directory does: once `held` has moved, the folder that carries the
    // projection is gone. Written back first, and only when the deletion had taken one.
    let projectionRestored = false
    if (typeof entry.projection_path === 'string' && entry.projection_path.length > 0) {
      try {
        await mkdir(dirname(entry.projection_path), { recursive: true })
        await moveAcrossDevices(join(held, 'projection.json'), entry.projection_path)
        projectionRestored = true
      } catch (error) {
        // A projection the restore could not put back is reported, never fatal: the log is the authority and the
        // cache rebuilds itself from it.
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          failed.push({ id: entry.id, error: `the projection could not be put back: ${error?.message ?? error}` })
        }
      }
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await moveAcrossDevices(held, target)
    } catch (error) {
      failed.push({ id: entry.id, error: `cannot be put back at ${target}: ${error?.message ?? error}` })
      remaining.push(entry)
      continue
    }
    // Measured at the destination, after the move, because the index's own numbers describe where the directory
    // **was**. A restore that quotes the record can report success while the store is empty, which is exactly
    // what a lost log looks like from the outside; `verified` is the store's answer, not the index's.
    const landed = await readDirectoryFiles(target)
    restored.push({
      id: entry.id,
      path: target,
      files: landed.files,
      bytes: landed.bytes,
      verified: landed.ok,
      ...(entry.projection_path === undefined ? {} : { projection: projectionRestored }),
      title: entry.title,
      ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
    })
  }
  await writeTrashIndex(trashRoot, remaining)
  return { restored, refused, failed }
}

/**
 * Free the bytes of trashed sessions for good.
 * @param trashRoot - the resolved trash root.
 * @param ids - the session ids to purge; `[]` is refused, because "purge everything" is not an id anybody
 * could have approved.
 * @returns `{ purged, refused, failed }` with the bytes each purge freed.
 */
export async function purgeTrash(trashRoot, ids) {
  if (typeof trashRoot !== 'string' || trashRoot.length === 0) throw new Error('purgeTrash: a trash root is required')
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('purgeTrash: name at least one session id')
  const { entries } = await readTrashIndex(trashRoot)
  const wanted = new Set(ids.map(String))
  const purged = []
  const refused = []
  const failed = []
  const remaining = []
  for (const entry of entries) {
    if (!wanted.has(entry.id)) {
      remaining.push(entry)
      continue
    }
    const held = join(trashRoot, String(entry.folder ?? ''))
    const outcome = await purgeDirectoryIn(trashRoot, held)
    if (outcome.error !== undefined) {
      failed.push({ id: entry.id, error: outcome.error, bytes_freed: outcome.bytes })
      remaining.push(entry)
      continue
    }
    purged.push({ id: entry.id, bytes: outcome.bytes, files: entry.files, title: entry.title })
  }
  await writeTrashIndex(trashRoot, remaining)
  return { purged, refused, failed }
}

/**
 * Move one directory or one file, across devices when it has to be.
 *
 * `rename` is the whole point of this plugin's deletion: it is atomic, so a session is either in the store or in
 * the trash and never half-way. It also fails with `EXDEV` the moment the two ends are on different volumes — which
 * is the normal case once the trash lives in the workspace (`D:\MYPROJS\.agents\cleaner`) while the session store
 * lives under the user profile (`C:\Users\…\.dsh\sessions`). A deletion that reported `EXDEV` looked like a refusal
 * for every session that had a log.
 *
 * The fallback is the one `dsh-team`'s own trash documents — "the cross-device move fallback removes the source it
 * has already copied" — with the order that keeps a crash safe: stage the copy under the trash, **verify** it file
 * by file and byte by byte, and only then remove the source. A failure at any point leaves the source untouched, so
 * the worst outcome is a duplicate, never a loss.
 *
 * Only regular files are copied: a candidate with anything else in it is refused long before this point
 * ([ADR 0004](docs/adr/0004-refuse-links.md)), which is what makes a plain copy faithful.
 * @param source - the file or directory to move.
 * @param target - where it must end up, on the other side.
 * @param options - `copy: true` forces the fallback, which is how a single-volume fixture exercises it.
 * @returns `{ bytes, files, copied }`; `copied` says the rename was not usable.
 */
export async function moveAcrossDevices(source, target, { copy = false } = {}) {
  if (!copy) {
    try {
      await rename(source, target)
      // No measurement on this path: the caller already knows the file count and the bytes from its own plan, and
      // measuring after the move would measure a path that no longer exists.
      return { copied: false }
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
  }
  const staged = `${target}.copying`
  const info = await lstat(source)
  if (info.isFile()) {
    await mkdir(dirname(staged), { recursive: true })
    await copyFile(source, staged)
    const [from, to] = await Promise.all([lstat(source), lstat(staged)])
    if (from.size !== to.size) {
      throw new Error(`the copy of ${basename(source)} is ${to.size} bytes against ${from.size}`)
    }
    await unlink(source)
    await rename(staged, target)
    return { bytes: to.size, files: 1, copied: true }
  }
  const reading = await readDirectoryFiles(source)
  if (!reading.ok) throw new Error(reading.reason)
  await mkdir(staged, { recursive: true })
  for (const name of reading.files) {
    await copyFile(join(source, name), join(staged, name))
    const [from, to] = await Promise.all([lstat(join(source, name)), lstat(join(staged, name))])
    if (from.size !== to.size) {
      throw new Error(`the copy of ${name} is ${to.size} bytes against ${from.size}`)
    }
  }
  // Verified first, removed second: the source is the only copy until every file has arrived.
  for (const name of reading.files) await unlink(join(source, name))
  await rmdir(source)
  await rename(staged, target)
  return { bytes: reading.bytes, files: reading.files.length, copied: true }
}

/**
 * Remove one directory tree that lives inside the given root, one regular file at a time.
 *
 * `rm -r` would be shorter, and would also decide what to do with a link that appeared since the listing; this
 * way the decision stays here, and the bytes reported are the bytes measured on files that really went
 * ([ADR 0004](docs/adr/0004-refuse-links.md)).
 * @param root - the directory the tree must stay inside.
 * @param path - the directory to remove.
 * @returns `{ bytes, files, error? }`; a partial removal still reports what it freed.
 */
async function purgeDirectoryIn(root, path) {
  let resolvedRoot
  let resolvedPath
  try {
    resolvedRoot = await realpath(root)
    resolvedPath = await realpath(path)
  } catch (error) {
    return { bytes: 0, files: 0, error: `cannot be resolved: ${error?.message ?? error}` }
  }
  const inside = relative(resolvedRoot, resolvedPath)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { bytes: 0, files: 0, error: `resolves outside ${resolvedRoot}` }
  }
  const reading = await readDirectoryFiles(resolvedPath)
  if (!reading.ok) return { bytes: 0, files: 0, error: reading.reason }
  let bytes = 0
  let files = 0
  for (const name of reading.files) {
    const file = join(resolvedPath, name)
    let before
    try {
      before = await lstat(file)
    } catch (error) {
      return { bytes, files, error: `cannot be inspected (${name}): ${error?.message ?? error}` }
    }
    if (!before.isFile()) return { bytes, files, error: `${name} is no longer a regular file` }
    try {
      await unlink(file)
    } catch (error) {
      return { bytes, files, error: `cannot be removed (${name}): ${error?.message ?? error}` }
    }
    bytes += before.size
    files += 1
  }
  try {
    await rmdir(resolvedPath)
  } catch (error) {
    return { bytes, files, error: `the directory could not be removed: ${error?.message ?? error}` }
  }
  return { bytes, files }
}
