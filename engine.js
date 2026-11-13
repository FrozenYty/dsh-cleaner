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
 * - It never touches a session that is not listed in `global.archivedSessionIds` of the workspace
 *   file, and it re-reads that list at deletion time, so a session restored between the listing and
 *   the deletion is kept.
 * - It never touches an id the caller protects — the Session running the command, or one a live
 *   agent holds.
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

import { lstat, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'

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
    return { ok: false, reason: `cannot be listed: ${error?.message ?? error}` }
  }
  const files = []
  let bytes = 0
  let newest = 0
  for (const entry of entries) {
    if (!entry.isFile()) {
      return { ok: false, reason: `holds a non-file entry (${entry.name}); a link or a nested directory is refused, not followed` }
    }
    let info
    try {
      info = await lstat(join(dir, entry.name))
    } catch (error) {
      return { ok: false, reason: `cannot be read (${entry.name}): ${error?.message ?? error}` }
    }
    if (!info.isFile()) {
      return { ok: false, reason: `holds a non-file entry (${entry.name}); a link or a nested directory is refused, not followed` }
    }
    files.push(entry.name)
    bytes += info.size
    newest = Math.max(newest, info.mtimeMs)
  }
  return { ok: true, files, bytes, modified: newest === 0 ? null : new Date(newest).toISOString() }
}

/**
 * Every session-owned directory under the storage root, keyed by its on-disk directory name.
 *
 * The walk is two levels deep on purpose, because that is the backend's layout: a project key
 * directory, then one directory per session. Neither level is entered when the entry is not a real
 * directory, so a junction or symlink is reported rather than followed.
 * @param sessionsRoot - absolute path of the session storage root.
 * @returns `{ stored: Map<directoryName, {dir, files, bytes, modified}>, skipped: [{path, reason}] }`.
 */
export async function scanStoredSessions(sessionsRoot) {
  const stored = new Map()
  const skipped = []
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { stored, skipped: [{ path: sessionsRoot, reason: 'the session storage root does not exist' }] }
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
  return { stored, skipped }
}

/**
 * Work out what a deletion would remove, without removing anything.
 *
 * `protect` carries the ids that must not be touched and why; the bundle entry fills it with the
 * Session running the command and every live agent. `only` narrows the candidate set to the ids a
 * person approved, and every requested id that does not become a candidate is reported in
 * `requested` with the reason.
 * @param options - `{ sessionsRoot, workspaceFile, protect, only }`.
 * @returns a JSON-serialisable plan, consumed by {@link applyCleanup}.
 */
export async function planCleanup({ sessionsRoot, workspaceFile, protect = [], only } = {}) {
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) {
    throw new Error('planCleanup: sessionsRoot must be a non-empty string')
  }
  if (typeof workspaceFile !== 'string' || workspaceFile.length === 0) {
    throw new Error('planCleanup: workspaceFile must be a non-empty string')
  }
  if (only !== undefined && (!Array.isArray(only) || only.some((id) => typeof id !== 'string' || id.length === 0))) {
    throw new Error('planCleanup: only must be an array of non-empty session ids')
  }
  const protectedReason = new Map()
  for (const entry of protect) {
    if (typeof entry?.id === 'string' && entry.id.length > 0) protectedReason.set(entry.id, entry.reason ?? 'protected')
  }

  const archived = await readArchivedIds(workspaceFile)
  const { stored, skipped } = await scanStoredSessions(sessionsRoot)
  const requested = new Set(only ?? [])
  const candidates = []
  const alreadyGone = []
  const protectedSessions = []

  for (const id of archived) {
    if (requested.size > 0 && !requested.has(id)) continue
    const entry = stored.get(encodeSegment(id))
    // An archived id that is not on disk is not a failure: it is exactly what a second run finds
    // after the first one worked. Reported on every run, so "0 candidates" is explained, not bare.
    if (entry === undefined) {
      alreadyGone.push(id)
      continue
    }
    if (protectedReason.has(id)) {
      protectedSessions.push({ id, path: entry.dir, bytes: entry.bytes, reason: protectedReason.get(id) })
      continue
    }
    candidates.push({ id, path: entry.dir, bytes: entry.bytes, files: entry.files, modified: entry.modified })
  }

  // Every id the caller asked for must be accounted for, with a reason a person can act on. "Not
  // archived" covers two different situations worth telling apart: the session exists and only needs
  // archiving, or nothing is stored under that id at all.
  const requestedReport = []
  if (requested.size > 0) {
    for (const id of requested) {
      if (candidates.some((candidate) => candidate.id === id)) continue
      const encoded = encodeSegment(id)
      let reason
      if (!archived.includes(id)) {
        reason = stored.has(encoded)
          ? 'not an archived session; archive it first to make it a candidate'
          : 'not an archived session, and no log is stored under that id'
      } else if (!stored.has(encoded)) {
        reason = 'archived, but no session directory is stored; already deleted'
      } else {
        // Archived, stored and skipped above: protection is the only reason left.
        reason = protectedReason.get(id) ?? 'protected'
      }
      requestedReport.push({ id, reason })
    }
  }

  return {
    sessions_root: sessionsRoot,
    workspace_file: workspaceFile,
    archived_ids: archived.length,
    stored_sessions: stored.size,
    // Everything the store holds, not only what is reclaimable: a listing that says "4 MiB" without
    // saying "of 84 MiB" leaves the person unable to judge whether the cleanup is worth it.
    stored_bytes: [...stored.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    candidates,
    total_bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    already_gone: alreadyGone,
    protected: protectedSessions,
    skipped,
    requested: requestedReport,
  }
}

/**
 * Delete the candidates of one plan and report what actually left the disk.
 *
 * The archive list is re-read here rather than trusted from the plan: this call is the deliberate
 * act, and an id restored between the listing and now must survive it. Every check the walk made is
 * repeated against the live filesystem, because a plan is a description of the past.
 * @param plan - a plan returned by {@link planCleanup}.
 * @returns `{ removed, removed_bytes, failed, refused }`.
 */
export async function applyCleanup(plan) {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.candidates)) {
    throw new Error('applyCleanup: pass the plan returned by planCleanup')
  }
  if (typeof plan.sessions_root !== 'string' || typeof plan.workspace_file !== 'string') {
    throw new Error('applyCleanup: the plan must name its session storage root and workspace storage file')
  }
  const archived = new Set(await readArchivedIds(plan.workspace_file))
  let root
  try {
    root = await realpath(plan.sessions_root)
  } catch (error) {
    throw new Error(`cannot resolve the session storage root ${plan.sessions_root}: ${error?.message ?? error}`)
  }

  const removed = []
  const failed = []
  const refused = []
  let removedBytes = 0
  for (const candidate of plan.candidates) {
    const outcome = await removeCandidate(candidate, root, archived)
    if (outcome.kind === 'removed') {
      removed.push({ id: outcome.id, path: outcome.path, files: outcome.files, bytes: outcome.bytes })
      removedBytes += outcome.bytes
    } else if (outcome.kind === 'refused') {
      refused.push({ id: outcome.id, reason: outcome.reason })
    } else {
      failed.push({ id: outcome.id, path: outcome.path, error: outcome.error, bytes_freed: outcome.bytesFreed })
      removedBytes += outcome.bytesFreed
    }
  }
  return { removed, removed_bytes: removedBytes, failed, refused }
}

/**
 * Remove one session directory, or explain why not. Never throws: a failure belongs in the report
 * beside the candidates that did work, and an interrupted deletion is still described truthfully.
 * @param candidate - one entry of `plan.candidates`.
 * @param root - the resolved session storage root.
 * @param archived - the archive list, re-read at deletion time.
 * @returns `{ kind: 'removed'|'refused'|'failed', ... }`.
 */
async function removeCandidate(candidate, root, archived) {
  const id = candidate?.id
  const path = candidate?.path
  if (typeof id !== 'string' || typeof path !== 'string') {
    return { kind: 'refused', id: String(id), reason: 'the plan entry has no usable id or path' }
  }
  if (!archived.has(id)) return { kind: 'refused', id, reason: 'no longer archived' }
  // The id and the path have to describe the same session, or the report names the wrong one. Inside a
  // plan this file produced they always agree, because the scan looks the directory up by the encoded
  // id; the check is here so that a plan is held to it too.
  if (basename(path) !== encodeSegment(id)) {
    return { kind: 'refused', id, reason: `the path names a different session (${basename(path)})` }
  }

  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'refused', id, reason: 'already deleted; nothing to remove' }
    return { kind: 'failed', id, path, error: `cannot be inspected: ${error?.message ?? error}`, bytesFreed: 0 }
  }
  if (!info.isDirectory()) return { kind: 'refused', id, reason: 'not a real directory; a link is not followed' }

  let resolved
  try {
    resolved = await realpath(path)
  } catch (error) {
    return { kind: 'failed', id, path, error: `cannot be resolved: ${error?.message ?? error}`, bytesFreed: 0 }
  }
  const inside = relative(root, resolved)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { kind: 'refused', id, reason: `resolves outside the session storage root (${resolved})` }
  }

  const reading = await readDirectoryFiles(path)
  if (!reading.ok) return { kind: 'refused', id, reason: reading.reason }

  // Unlink one regular file at a time. `rm -r` would be shorter, and would also decide what to do
  // with a link that appeared between the listing above and now; this way the decision stays here.
  let bytesFreed = 0
  let count = 0
  for (const name of reading.files) {
    const file = join(path, name)
    let before
    try {
      before = await lstat(file)
    } catch (error) {
      return { kind: 'failed', id, path, error: `cannot be inspected (${name}): ${error?.message ?? error}`, bytesFreed }
    }
    if (!before.isFile()) {
      return { kind: 'failed', id, path, error: `${name} is no longer a regular file`, bytesFreed }
    }
    try {
      await unlink(file)
    } catch (error) {
      return { kind: 'failed', id, path, error: `cannot be removed (${name}): ${error?.message ?? error}`, bytesFreed }
    }
    bytesFreed += before.size
    count += 1
  }
  try {
    await rmdir(path)
  } catch (error) {
    return { kind: 'failed', id, path, error: `the directory could not be removed: ${error?.message ?? error}`, bytesFreed }
  }
  return { kind: 'removed', id, path, files: count, bytes: bytesFreed }
}
