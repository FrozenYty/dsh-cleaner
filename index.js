/**
 * dsh-cleaner — permanently delete the logs of sessions, on request.
 *
 * THE CONTRACT
 * An archive is not a deletion: it hides the session and touches nothing. This plugin is the removal,
 * and it happens in exactly three steps: it lists, the person approves, it deletes the ids they named
 * and reports the bytes reclaimed. There is no timer, no interval, no age threshold and no background
 * sweep anywhere in this file or in the engine — a schedule is a policy about the future, and the rule
 * here is that deletion is an act somebody asked for. The listing tool cannot delete; the deleting tool
 * cannot invent an id, because every id in its argument came from the listing. Archiving is not a
 * precondition: the store is the index, and what protects a session is that it is running, that an agent
 * is busy with it, or that nobody named it.
 *
 * TWO TOOLS, NOT TWO MODES OF ONE
 * `list_session_logs` has no side effect and no required argument, so calling it can never be a
 * mistake. `delete_session_logs` requires the ids by name, so nothing is ever deleted by
 * default and a person can approve a subset. The confirmation is the conversational step between
 * them; the description of each tool says so, because that is the only place the model reads it.
 *
 * WHAT THE OFFICIAL SEAM DOES AND DOES NOT OFFER
 * Read from the installed asar rather than assumed: `@deepseek-ai/dsh-session-persistence` exposes
 * `create`, `open`, `flush`, `stat` and `list`, and no deletion — "No deletion or retention API —
 * pruning stored sessions is out-of-band backend maintenance" is one of its documented limitations,
 * repeated by the JSONL backend as "Nothing deletes session files". So this plugin *is* the
 * out-of-band maintenance: it removes whole session directories and never opens a handle, never
 * reads an event and never rewrites a line. The seam is still used, after the fact and only for
 * verification: `delete_session_logs` asks the mounted backend whether it still lists the ids it
 * just removed, and reports the answer. That check can fail without failing the deletion, because by
 * then the work is done.
 *
 * WHERE THE PATHS COME FROM
 * `DSH_HOME` (default `~/.dsh`), then `sessions/` and `storages/workspace.json` under it. The engine
 * receives both as arguments so its tests run against a fixture, and this file is the only place that
 * reads the environment.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM THE HARNESS
 * A profile-linked bundle resolves bare imports from its own workspace directory, where no
 * `@deepseek-ai/*` package exists, so a bare import fails the load with ERR_MODULE_NOT_FOUND. Tool
 * definitions are therefore plain canonical JSON Schema objects — the shape `ctx.tools.register`
 * consumes — and every service is reached through `ctx`. Same rule as the sibling bundles.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  listTrash,
  moveToTrash,
  planCleanup,
  purgeTrash,
  resolveCleanerConfig,
  resolveDataDir,
  restoreFromTrash,
  trashRootOf,
} from './engine.js'

export const name = 'dsh-cleaner'

/** `tools` publishes the two surfaces; everything else this plugin touches is optional and read-only. */
export const inject = ['tools']

/** Build a registry-ready definition from canonical JSON Schemas. */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value) }]),
    },
    execute: options.execute,
  }
}

/** The paths this plugin works on: the session root, the workspace store, and the cache it reads titles from. */
/**
 * The settings this plugin runs with, resolved once from the bundle patch row.
 *
 * The defaults are the documented behaviour with no configuration at all: a 30-day window and a 200-entry cap,
 * in a `.agents/cleaner` folder inside the workspace. A profile that wants something else writes the fields
 * into its own patch row ([ADR 0015](docs/adr/0015-our-own-data-directory.md)).
 */
let settings = resolveCleanerConfig(undefined)

/**
 * The data directory this process bound itself to, resolved once.
 *
 * Once, and not per call: a session's working directory can change while it runs (`working_directory` is a
 * tool), and re-resolving would move the trash out from under a deletion that is in flight. What is durable is
 * the directory and its `index.json`, and every listing prints the path that is in effect, so a person can see
 * where their bytes went without asking.
 */
let boundDataDir

/** The workspace this process speaks for, when the Host can say. */
function defaultWorkspace(ctx) {
  try {
    const directory = ctx.get('workingDirectory')?.defaultDirectory
    return typeof directory === 'string' && directory.length > 0 ? directory : undefined
  } catch {
    return undefined
  }
}

function storagePaths() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dataDir = boundDataDir ?? resolveDataDir(process.env, homedir(), undefined)
  return {
    sessionsRoot: join(home, 'sessions'),
    workspaceFile: join(home, 'storages', 'workspace.json'),
    projections: join(home, 'storages', 'session_projcache', 'sessions'),
    // This plugin's own data, never inside the session store: a trashed session must stop being a session.
    dataDir,
    trashRoot: trashRootOf(dataDir),
  }
}

/**
 * The sessions that must not be touched, with the reason each one is protected.
 *
 * The contract names the first one: the Session executing this command is being written while the
 * command runs, so its log cannot be removed by the command. The rest follow from the same rule — a
 * Session a live agent holds is being used — and the engine reports each protected id rather than
 * silently dropping it, so a refusal is visible in the answer.
 * @param ctx - plugin context.
 * @param exec - the call's execution context.
 * @returns `[{id, reason}]`, the caller first.
 */
function protections(ctx, exec) {
  const protect = []
  const callerId = exec?.agent?.session?.id
  if (callerId !== undefined) protect.push({ id: String(callerId), reason: 'the session running this command' })
  const agents = ctx.get('agents')
  for (const agent of agents?.list?.() ?? []) {
    if (agent?.id === undefined) continue
    const id = String(agent.id)
    if (protect.some((entry) => entry.id === id)) continue
    // An idle agent is resident only: nothing is being written, and an archived session cannot start a
    // model step anyway (the Host's archive gate refuses one), so its log is not going to be appended to
    // under this call. A busy one is being written right now, and that is the case this guards.
    if (agent.status === 'idle') continue
    const status = typeof agent.status === 'string' ? ` (status: ${agent.status})` : ''
    protect.push({ id, reason: `a live agent holds this session${status}` })
  }
  return protect
}

/**
 * Ask the mounted session-query service whether it still lists the ids that were just deleted.
 *
 * This is a different service from the persistence seam, and it is the one a window renders its session
 * rows from: a session can be gone from the store and still be listed here, which is why a row can outlive
 * the log. Reported, never a gate — the files are already gone.
 * @param ctx - plugin context.
 * @param ids - the ids the deletion removed.
 * @returns `{backend, still_listed}` or `{backend, error}` or `{backend: 'absent'}`.
 */
async function verifyNotListed(ctx, ids) {
  const backend = 'sessionQuery'
  const query = ctx.get(backend)
  if (query === undefined || typeof query.listSessions !== 'function') return { backend: 'absent' }
  try {
    const sessions = await query.listSessions()
    const listed = new Set(sessions.map((session) => String(session?.sessionId ?? session?.header?.id)))
    return { backend, still_listed: ids.filter((id) => listed.has(id)) }
  } catch (error) {
    return { backend, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Ask the mounted persistence backend whether it still lists the ids that were just deleted.
 *
 * This is the whole use this plugin makes of the official seam, and it is deliberately a report and
 * not a gate: the seam cannot delete, so it must not be able to veto a deletion either. A profile
 * without the service, or a backend read that throws, is described in the answer; neither can fail a
 * call whose files are already gone.
 * @param ctx - plugin context.
 * @param ids - the ids the deletion removed.
 * @returns `{backend, still_listed}` or `{backend, error}`.
 */
async function verifyRemoved(ctx, ids) {
  const backend = 'sessionPersistence'
  const persistence = ctx.get(backend)
  if (persistence === undefined || typeof persistence.list !== 'function') return { backend: 'absent' }
  try {
    const snapshots = await persistence.list()
    const listed = new Set(snapshots.map((snapshot) => String(snapshot?.header?.id)))
    return { backend, still_listed: ids.filter((id) => listed.has(id)) }
  } catch (error) {
    return { backend, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Hide the sessions a deletion is about to remove — **before** the files go.
 *
 * A window draws its rows from the workspace records, not from the disk, and the sidebar's default filter
 * is `!archived.has(id)`: **an archived session is never drawn**. So `archiveSession` is the one call that
 * makes a row disappear from an open window, and the workspace feed publishes it to every window at once —
 * no reload, no restart. Unarchiving is exactly backwards, and is never asked for here.
 *
 * Three facts force the order. `archiveSession` refuses a session that is "neither live nor in session
 * persistence" (`WorkspaceUnknownSessionError`), so it must run while the log still exists; a removal that
 * fails has to give the archive state back, or a session whose log is still on disk would be hidden; and
 * the project membership is dropped in the same pass, because the id names nothing there any more.
 *
 * Best-effort: the deletion itself must not fail because a record could not be written, and a profile
 * without the registry still answers.
 * @param ctx - plugin context.
 * @param removing - the ids whose files are about to be removed.
 * @param orphaned - named ids whose log is already gone; only their project membership can be dropped,
 *   because the registry refuses to archive a session it cannot find.
 * @returns `{registry, detached, archived, failed?}` or `{registry, error}` or `{registry: 'absent'}`.
 */
async function hideSessions(ctx, removing, orphaned = []) {
  const registry = 'workspaceRegistry'
  const workspaces = ctx.get(registry)
  if (workspaces === undefined || typeof workspaces.list !== 'function') return { registry: 'absent' }
  const detached = []
  const archived = []
  const failed = []
  const fail = (id, error) => failed.push({ id, error: error instanceof Error ? error.message : String(error) })
  try {
    const archiveSet = typeof workspaces.archivedSessionIds === 'object' ? workspaces.archivedSessionIds : []
    for (const id of [...removing, ...orphaned]) {
      try {
        const holder = workspaces.list().find((workspace) => workspace?.sessionIds?.includes(id))
        if (holder !== undefined) await holder.detachSession(id)
        detached.push(id)
      } catch (error) {
        fail(id, error)
        continue
      }
      // Already archived is already hidden (and the registry resolves that as a no-op), and an id with no
      // log cannot be archived at all: the registry answers "no such session".
      if (orphaned.includes(id) || archiveSet.includes(id) || typeof workspaces.archiveSession !== 'function') continue
      try {
        await workspaces.archiveSession(id)
        archived.push(id)
      } catch (error) {
        fail(id, error)
      }
    }
  } catch (error) {
    return { registry, error: error instanceof Error ? error.message : String(error) }
  }
  return failed.length === 0 ? { registry, detached, archived } : { registry, detached, archived, failed }
}

/**
 * Give back the archive state of a session whose removal did not happen.
 *
 * `unarchiveSession` runs no existence check (dropping an id cannot introduce an unknown one), which is
 * what makes the repair possible after a failed unlink. Only ids this call archived are restored, so a
 * session the person had already archived keeps the state they chose.
 * @param ctx - plugin context.
 * @param ids - the ids whose files are still there.
 * @param archivedByUs - the ids the preceding {@link hideSessions} archived.
 * @returns the ids whose archive entry was removed again.
 */
async function restoreSessions(ctx, ids, archivedByUs) {
  const workspaces = ctx.get('workspaceRegistry')
  if (workspaces === undefined || typeof workspaces.unarchiveSession !== 'function') return []
  const restored = []
  for (const id of ids) {
    if (!archivedByUs.includes(id)) continue
    try {
      await workspaces.unarchiveSession(id)
      restored.push(id)
    } catch {
      // The deletion's own answer already says the file could not be removed; a record that stays hidden
      // is the smaller surprise, and the next call finds the session and tries again.
    }
  }
  return restored
}

/** Bytes as a person reads them, with the exact count beside the unit, because both are asked for. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`
  return `${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`
}

/** Counted nouns the way a person writes them, because "1 file(s)" reads like a template leak. */
const files = (count) => `${count} file${count === 1 ? '' : 's'}`
const directories = (count) => `${count} session director${count === 1 ? 'y' : 'ies'}`

/** A session's own title, when the cache had one: the way a person recognises which log this is. */
const title = (entry) => (typeof entry.title === 'string' && entry.title !== '' ? `"${entry.title}"  ` : '')

/** A bounded enumeration: the count is the fact, the ids are the detail, and a long tail is marked. */
function listIds(ids) {
  const shown = ids.slice(0, 10)
  const rest = ids.length - shown.length
  return ` — ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
}

/**
 * The listing, as a value. One implementation behind the tool and the human command, so the two can never
 * report different things about the same store.
 * @param ctx - the plugin context.
 * @param exec - the tool execution, carrying the calling agent.
 * @returns the plan: what is on disk, what is protected, and what a deletion would take.
 */
function listLogs(ctx, exec) {
  return planCleanup({ ...storagePaths(), protect: protections(ctx, exec) })
    .then(async (plan) => ({
      ...plan,
      human_command: humanCommand,
      client_half: clientHalf,
      window_transport: windowTransport,
      // Read-only, and deliberately not a sweep: a listing is the one call that can never be a mistake, so it
      // reports what the retention rule would do and lets the next deletion do it.
      ...(await trashReadout()),
    }))
}

/**
 * What the trash holds, as facts a listing can print. Nothing is removed here.
 * @returns `{ trash }` with the count, the bytes, the root and how many entries are past retention.
 */
async function trashReadout() {
  const paths = storagePaths()
  let listed
  try {
    listed = await listTrash(paths.trashRoot)
  } catch (error) {
    return { trash: { root: paths.trashRoot, retention_days: settings.retentionDays, error: String(error?.message ?? error) } }
  }
  const cutoff = Date.now() - settings.retentionDays * 86_400_000
  const expired = listed.entries.filter((entry) => {
    const at = Date.parse(String(entry.trashed_at ?? ''))
    return Number.isFinite(at) && at <= cutoff
  })
  return {
    trash: {
      root: paths.trashRoot,
      retention_days: settings.retentionDays,
      count: listed.entries.length,
      bytes: listed.entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
      entries: listed.entries.map((entry) => ({
        id: entry.id,
        bytes: entry.bytes,
        trashed_at: entry.trashed_at,
        ...(entry.title === undefined ? {} : { title: entry.title }),
      })),
      expired: expired.length,
      missing: listed.missing,
    },
  }
}

/**
 * The sweep, run by the operations that already change something.
 *
 * Retention is enforced when somebody acts, never on a timer — the same rule the plugin has had since the
 * first ADR. The listing only reports what this would do.
 * @returns `{ purged, root }` — what the sweep freed, for the answer that triggered it.
 */
async function sweepTrash() {
  const paths = storagePaths()
  // Both rules run here, and only here: age, and the cap on entries. A listing is still only a read.
  const listed = await listTrash(paths.trashRoot, {
    purgeAfterDays: settings.retentionDays,
    limit: settings.trashLimit,
  })
  return { purged: listed.purged, root: paths.trashRoot, retention_days: settings.retentionDays, limit: settings.trashLimit }
}

/**
 * The recoverable half of the deletion, as a value: what the trash holds, put one back, or free its bytes.
 *
 * Restoring is also the one place this plugin unarchives — it is what makes "delete" honest as a reversible
 * step, and ADR 0012's rule (never unarchive a *deletion*) still holds, because a restore is not a deletion.
 * @param ctx - the plugin context.
 * @param exec - the tool execution (or `{ agent }` from a command).
 * @param action - `list`, `restore` or `purge`.
 * @param requested - the ids, required for everything but `list`.
 * @returns the trash report.
 */
async function trashLogs(ctx, exec, action, requested) {
  const paths = storagePaths()
  if (action === 'list') {
    const swept = await sweepTrash()
    return { action, ...(await trashReadout()), swept: swept.purged, restored: [], purged: [], refused: [] }
  }
  const ids = [...new Set(Array.isArray(requested) ? requested : [])]
  if (ids.length === 0) throw new Error(`trash ${action} must name at least one session id`)
  if (action === 'purge') {
    // Purge is the irreversible one, so the sweep does not run first and nothing else is touched: the bytes
    // reported are the bytes this call freed.
    const report = await purgeTrash(paths.trashRoot, ids)
    return { action, session_ids: ids, purged: report.purged, failed: report.failed, refused: report.refused, restored: [], swept: [] }
  }
  if (action !== 'restore') throw new Error(`unknown trash action: ${String(action)}`)
  // 1. The directory goes back where the backend looks for it, and only the ids that actually moved are
  //    unarchived — a restore that failed must not leave a row visible again.
  const report = await restoreFromTrash(paths.trashRoot, paths.sessionsRoot, ids)
  const back = report.restored.map((entry) => entry.id)
  const unarchived = await unarchiveSessions(ctx, back)
  const swept = await sweepTrash()
  return {
    action,
    session_ids: ids,
    restored: report.restored,
    unarchived,
    refused: report.refused,
    failed: report.failed,
    purged: [],
    swept: swept.purged,
  }
}

/**
 * Ask the workspace registry to show the restored sessions again.
 *
 * The mirror of `hideSessions`, and the only place `unarchiveSession` is called: a restore that cannot
 * unarchive still restored the log, so this reports rather than fails.
 * @param ctx - the plugin context.
 * @param ids - the session ids whose directories are back.
 * @returns `{ registry, unarchived, error? }`.
 */
async function unarchiveSessions(ctx, ids) {
  if (ids.length === 0) return { registry: 'not-asked' }
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch (error) {
    return { registry: 'error', error: String(error?.message ?? error) }
  }
  if (registry === undefined || typeof registry.unarchiveSession !== 'function') return { registry: 'absent' }
  const unarchived = []
  const failed = []
  for (const id of ids) {
    try {
      await registry.unarchiveSession(id)
      unarchived.push(id)
    } catch (error) {
      failed.push({ id, error: String(error?.message ?? error) })
    }
  }
  return { registry: 'asked', unarchived, failed }
}

/**
 * The deletion, as a value. One implementation behind the tool and the human command.
 *
 * The order here is deliberate and load-bearing: the files go first, and every later step is a report about
 * work already done, so a profile without one of those services still gets an honest answer.
 * @param ctx - the plugin context.
 * @param exec - the tool execution (or `{ agent }` from a command), carrying the calling agent.
 * @param requested - the ids the caller named, exactly as they were given.
 * @returns the deletion report: what was removed, what was kept, and what the records now say.
 */
async function deleteLogs(ctx, exec, requested) {
  if (exec?.agent === undefined) {
    throw new Error('a deletion needs a calling Agent: without one the running session cannot be protected')
  }
  const ids = [...new Set(requested)]
  if (ids.length === 0) throw new Error('a deletion must name at least one session')

  const paths = storagePaths()
  const plan = await planCleanup({ ...paths, protect: protections(ctx, exec), only: ids })
  const target = plan.candidates.map((candidate) => candidate.id)
  const orphans = plan.unlogged
  // Hide first, because the registry refuses to archive a session whose log is already gone — and hiding
  // is what makes the row leave the window at once.
  const hidden = target.length + orphans.length === 0
    ? { registry: 'not-asked' }
    : await hideSessions(ctx, target, orphans)
  let report
  try {
    // One atomic rename per session: either the store stops holding it or nothing happened, so a session a
    // live writer is holding cannot be left half-removed. The bytes are freed on purge, not here.
    report = await moveToTrash(paths.trashRoot, plan)
  } catch (error) {
    // Nothing was moved, so nothing may stay hidden: give the archive state back and let the failure be
    // the caller's to see.
    if (Array.isArray(hidden.archived)) await restoreSessions(ctx, target, hidden.archived)
    throw error
  }
  const removedIds = report.moved.map((entry) => entry.id)
  const kept = target.filter((id) => !removedIds.includes(id))
  const restored = Array.isArray(hidden.archived) ? await restoreSessions(ctx, kept, hidden.archived) : []
  const drop = [...removedIds, ...orphans]
  // Ask the host what it still lists: that answer is reported either way, and it is the difference between
  // "the host let go" and "the host still holds it in memory".
  const query = drop.length === 0 ? { backend: 'not-asked' } : await verifyNotListed(ctx, drop)
  return {
    sessions_root: paths.sessionsRoot,
    // "Removed" means removed from the session store — the backend looks there, so the session is gone. The
    // bytes are in the trash until an entry is purged, which is what `trash` below says in words.
    removed: report.moved,
    removed_count: report.moved.length,
    removed_bytes: report.moved.reduce((sum, entry) => sum + entry.bytes, 0),
    trash: {
      root: paths.trashRoot,
      retention_days: settings.retentionDays,
      // Recoverable by name until the sweep: the same ids go back where the backend looks for them.
      recoverable: report.moved.map((entry) => entry.id),
    },
    failed: report.failed,
    refused: [...plan.requested, ...report.refused],
    workspace: hidden.registry === 'not-asked'
      ? hidden
      : {
        ...hidden,
        orphans,
        // Only the ids whose log is actually gone stayed hidden; the rest were put back above.
        archived: (hidden.archived ?? []).filter((id) => !restored.includes(id)),
        restored,
      },
    query,
    verify: removedIds.length === 0 ? { backend: 'not-asked' } : await verifyRemoved(ctx, removedIds),
  }
}

/**
 * The trash as lines for the listing that prints it.
 *
 * A deletion is recoverable, and a person cannot act on what they cannot see: the count, the bytes, where it
 * is and how long it is kept are all facts, and the last line names the two operations that use them.
 * @param trash - the `trash` object a listing carries.
 * @returns the lines, possibly none.
 */
function trashLines(trash) {
  if (trash === undefined) return []
  if (trash.error !== undefined) return [`Trash: unreadable (${trash.error}) — deletions are unaffected.`]
  const held = Number(trash.count) || 0
  if (held === 0) return [`Trash: empty. Purged automatically after ${trash.retention_days} days, never by a timer.`]
  const lines = [
    `Trash: ${directories(held)}, ${formatBytes(Number(trash.bytes) || 0)} held under ${trash.root};`
    + ` kept ${trash.retention_days} days`
    + (Number(trash.expired) > 0 ? `, ${trash.expired} of them past that and freed by the next deletion` : '')
    + '.',
  ]
  for (const entry of (trash.entries ?? []).slice(0, 10)) {
    lines.push(`  ${title(entry)}${entry.id}  ${formatBytes(Number(entry.bytes) || 0)}  trashed ${entry.trashed_at ?? 'unknown'}`)
  }
  const rest = (trash.entries?.length ?? 0) - 10
  if (rest > 0) lines.push(`  … and ${rest} more`)
  lines.push('  trash_session_logs action=restore puts one back; action=purge frees its bytes for good.')
  if (Array.isArray(trash.missing) && trash.missing.length > 0) {
    lines.push(`Trash entries whose directory is gone: ${trash.missing.length}${listIds(trash.missing)}`)
  }
  return lines
}

/** Every line a listing answers with, including the ones that explain an empty result. */
function renderList(value) {  const lines = []
  lines.push(
    value.candidates.length === 0
      ? 'No session log is on disk: there is nothing to delete.'
      : `Session logs on disk: ${value.candidates.length}, ${formatBytes(value.total_bytes)}`
        + ` (${value.candidates.filter((candidate) => candidate.archived).length} of them archived).`,
  )
  lines.push(
    `The session store holds ${value.stored_sessions} directories, ${formatBytes(value.stored_bytes)} in all.`,
  )
  // The one fact about this plugin that lives in a registry rather than on disk, and the one that failed
  // silently once: whether the human command is actually registered in the profile that is running.
  lines.push(`Human command: /clean — ${value.human_command}`)
  // What the window half last reported about itself. It is the only way to see that half from here: a browser
  // half that loads but fails to contribute anything is otherwise invisible, which cost several releases.
  lines.push(`Window half: ${value.client_half}`)
  // How the window reaches this plugin at all. A missing route is why a sidebar row can look right and do
  // nothing, so it is printed beside the other facts a person cannot see from disk.
  lines.push(`Window transport: ${value.window_transport}`)
  lines.push(...trashLines(value.trash))
  for (const candidate of value.candidates) {
    lines.push(
      `  ${title(candidate)}${candidate.id}  ${formatBytes(candidate.bytes)}  ${files(candidate.files.length)}  `
      + `${candidate.archived ? 'archived' : 'not archived'}  `
      + `last write ${candidate.modified ?? 'unknown'}  ${candidate.path}`,
    )
  }
  if (value.already_gone.length > 0) {
    // Nothing here is actionable — these ids have no log left to delete — so a long tail is counted and
    // marked rather than printed, which is the difference between a line and a page after a big cleanup.
    lines.push(
      `Already gone (archived, but no directory is stored): ${value.already_gone.length}`
      + listIds(value.already_gone),
    )
  }
  for (const entry of value.protected) lines.push(`Kept, protected: ${entry.id} — ${entry.reason}`)
  for (const entry of value.skipped) lines.push(`Not a candidate: ${entry.path} — ${entry.reason}`)
  // Only invite a deletion when there is something to approve: telling a model to call the deleting
  // tool with approved ids, on an answer that listed none, is how a wasted call gets made.
  if (value.candidates.length > 0) {
    lines.push(
      'Nothing was deleted. Show this list to the person and call delete_session_logs with the ids '
      + 'they approve — archived or not.',
    )
  }
  return lines.join('\n')
}

/** Every line a deletion answers with, including what it kept and what it could not remove. */
function renderDelete(value) {
  const lines = []
  lines.push(
    value.removed.length === 0
      ? 'Deleted nothing: no session log on disk matched the ids given.'
      // The store no longer holds them, which is what a deletion has to mean; the bytes move to the trash and
      // are freed on purge. Saying "reclaimed" here would be the kind of quiet lie this answer exists to avoid.
      : `Deleted ${directories(value.removed.length)}: ${formatBytes(value.removed_bytes)} moved out of the`
        + ' session store.',
  )
  if (value.removed.length > 0 && value.trash !== undefined) {
    lines.push(
      `Recoverable until purged: held under ${value.trash.root}, kept ${value.trash.retention_days} days.`
      + ' Restore one with trash_session_logs action=restore; free its bytes with action=purge.',
    )
  }
  for (const entry of value.removed) {
    lines.push(`  ${title(entry)}${entry.id}  ${formatBytes(entry.bytes)}  ${files(entry.files)}  ${entry.path}`)
  }
  for (const entry of value.failed) {
    lines.push(`Partially removed: ${entry.id} — ${entry.error} (${formatBytes(entry.bytes_freed)} freed)`)
  }
  for (const entry of value.refused) lines.push(`Kept: ${entry.id} — ${entry.reason}`)
  if (value.workspace?.registry === 'absent') {
    lines.push('No workspace registry is mounted, so the sidebar drops them at its next refresh.')
  } else if (value.workspace?.error !== undefined) {
    lines.push(`The workspace list could not be updated (${value.workspace.error}); the sidebar drops them at its next refresh.`)
  } else if (value.workspace?.failed?.length > 0) {
    const ids = value.workspace.failed.map((entry) => entry.id)
    lines.push(`The workspace list kept ${ids.join(', ')}; the row stays until its next refresh.`)
  } else if ((value.workspace?.detached?.length ?? 0) > 0) {
    const orphans = value.workspace.orphans?.length ?? 0
    const archived = value.workspace.archived?.length ?? 0
    lines.push(
      `The workspace records dropped them (${value.workspace.detached.length} detached`
      + (archived > 0 ? `, ${archived} archived` : '')
      + '): an archived session is hidden by the sidebar, so the rows are gone from every open window'
      + ' without a reload.'
      + (orphans > 0 ? ` ${orphans} of the ids had no log left to remove.` : ''),
    )
  }
  if ((value.workspace?.restored?.length ?? 0) > 0) {
    lines.push(
      `${value.workspace.restored.length} of the ids could not be removed, so their archive state was put`
      + ' back and their rows are where they were.',
    )
  }
  if (value.query?.still_listed?.length > 0) {
    lines.push(
      `The session list still names ${value.query.still_listed.join(', ')}: the host holds ${value.query.still_listed.length === 1 ? 'that session' : 'those sessions'}`
      + ' in memory. Their rows are hidden like any other deleted session, and the names go when the host'
      + ' releases them — a restart does, and nothing a plugin can call does.',
    )
  } else if (value.query?.error !== undefined) {
    lines.push(`The session list could not be re-read (${value.query.error}); nothing above depends on it.`)
  }
  if (value.removed.length === 0) return lines.join('\n')
  if (value.verify.backend === 'absent') {
    lines.push('Checked against the disk only: no session persistence backend is mounted in this profile.')
  } else if (value.verify.error !== undefined) {
    lines.push(`The persistence backend could not be re-read (${value.verify.error}); the deletion above stands.`)
  } else if (value.verify.still_listed.length === 0) {
    lines.push('The session persistence backend no longer lists any of them.')
  } else {
    lines.push(`The session persistence backend still lists ${value.verify.still_listed.join(', ')}; something rewrote them after the deletion.`)
  }
  return lines.join('\n')
}

/** Every line a trash operation answers with: what moved, what did not, and what the retention rule did. */
function renderTrash(value) {
  const lines = []
  if (value.action === 'restore') {
    lines.push(value.restored.length === 0
      ? 'Restored nothing: no id in the trash matched what was given.'
      : `Restored ${directories(value.restored.length)}: the directories are back where the backend looks for them.`)
    for (const entry of value.restored) {
      lines.push(`  ${title(entry)}${entry.id}  ${formatBytes(Number(entry.bytes) || 0)}  ${entry.path}`)
    }
    for (const entry of value.refused) lines.push(`Not restored: ${entry.id} — ${entry.reason}`)
    for (const entry of value.failed) lines.push(`Not restored: ${entry.id} — ${entry.error}`)
    const shown = value.unarchived
    if (shown?.registry === 'absent') {
      lines.push('No workspace registry is mounted, so the row returns at the sidebar\'s next refresh.')
    } else if (shown?.error !== undefined) {
      lines.push(`The workspace record could not be re-read (${shown.error}); the log is back and the row is not.`)
    } else if ((shown?.failed?.length ?? 0) > 0) {
      lines.push(`The workspace record still hides ${shown.failed.map((entry) => entry.id).join(', ')}; the log is back, the row is not.`)
    } else if ((shown?.unarchived?.length ?? 0) > 0) {
      lines.push('The workspace record unarchived them, so the rows come back without a reload.')
    }
  } else if (value.action === 'purge') {
    const freed = value.purged.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
    lines.push(value.purged.length === 0
      ? 'Freed nothing: no id in the trash matched what was given.'
      : `Purged ${directories(value.purged.length)}: ${formatBytes(freed)} freed for good.`)
    for (const entry of value.purged) lines.push(`  ${title(entry)}${entry.id}  ${formatBytes(Number(entry.bytes) || 0)}`)
    for (const entry of value.refused) lines.push(`Not purged: ${entry.id} — ${entry.reason}`)
    for (const entry of value.failed) {
      lines.push(`Partially purged: ${entry.id} — ${entry.error} (${formatBytes(Number(entry.bytes_freed) || 0)} freed)`)
    }
  } else {
    lines.push(...trashLines(value.trash))
    if ((value.trash?.count ?? 0) === 0) lines.push('Nothing is recoverable right now.')
  }
  if ((value.swept?.length ?? 0) > 0) {
    const freed = value.swept.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
    lines.push(`The ${settings.retentionDays}-day retention sweep also freed ${formatBytes(freed)} from ${directories(value.swept.length)}.`)
  }
  return lines.join('\n')
}

/** The trash operation's canonical value; every key is present on every answer, empty or not. */
const TRASH_VALUE = {
  type: 'object',
  required: ['action', 'trash', 'restored', 'purged', 'refused', 'failed', 'unarchived', 'swept'],
  properties: {
    action: { type: 'string' },
    session_ids: { type: 'array', items: { type: 'string' } },
    trash: { type: 'object' },
    restored: { type: 'array', items: { type: 'object' } },
    purged: { type: 'array', items: { type: 'object' } },
    refused: { type: 'array', items: { type: 'object' } },
    failed: { type: 'array', items: { type: 'object' } },
    unarchived: { type: 'object' },
    swept: { type: 'array', items: { type: 'object' } },
  },
}

/** The listing's canonical value. Keys are the plan's, so nothing is renamed on the way out. */
const LIST_VALUE = {
  type: 'object',
  required: [
    'sessions_root', 'workspace_file', 'archived_ids', 'stored_sessions', 'stored_bytes', 'candidates',
    'total_bytes', 'already_gone', 'protected', 'skipped', 'requested', 'human_command', 'client_half',
    'window_transport', 'trash',
  ],
  properties: {
    sessions_root: { type: 'string' },
    workspace_file: { type: 'string' },
    archived_ids: { type: 'number' },
    stored_sessions: { type: 'number' },
    stored_bytes: { type: 'number' },
    candidates: { type: 'array', items: { type: 'object' } },
    total_bytes: { type: 'number' },
    already_gone: { type: 'array', items: { type: 'string' } },
    protected: { type: 'array', items: { type: 'object' } },
    skipped: { type: 'array', items: { type: 'object' } },
    requested: { type: 'array', items: { type: 'object' } },
    human_command: { type: 'string' },
    client_half: { type: 'string' },
    window_transport: { type: 'string' },
    trash: { type: 'object' },
  },
}

/** The deletion's canonical value; every key is present on every answer, empty or not. */
const DELETE_VALUE = {
  type: 'object',
  required: ['sessions_root', 'removed', 'removed_count', 'removed_bytes', 'trash', 'failed', 'refused', 'workspace', 'query', 'verify'],
  properties: {
    sessions_root: { type: 'string' },
    removed: { type: 'array', items: { type: 'object' } },
    removed_count: { type: 'number' },
    removed_bytes: { type: 'number' },
    trash: { type: 'object' },
    failed: { type: 'array', items: { type: 'object' } },
    refused: { type: 'array', items: { type: 'object' } },
    workspace: { type: 'object' },
    query: { type: 'object' },
    verify: { type: 'object' },
  },
}

export function apply(ctx, config) {
  // Validated before anything is registered: a patch value that cannot be honoured fails this load, with the
  // field and the value named, rather than the first deletion — hours later, in front of a person.
  settings = resolveCleanerConfig(config)
  {
    // The data directory is resolved once, in the documented order: the configured path, then the environment
    // override, then the workspace this process speaks for, then the frozen fallback outside any workspace.
    const workspace = defaultWorkspace(ctx)
    boundDataDir = settings.dataDir !== undefined
      ? resolve(workspace ?? process.cwd(), settings.dataDir)
      : resolveDataDir(process.env, homedir(), workspace)
  }
  ctx.tools.register(defineTool({
    name: 'list_session_logs',
    description:
      'List the DeepSeek Harness sessions whose logs are on disk: each one\'s bytes, file count, last write, whether '
      + 'it is archived, and what the store holds in total. Nothing in the product removes a log; this plugin is '
      + 'what does, and archiving is only how the sidebar hides a session — it is not a requirement to delete one. '
      + 'Read-only and argument-free, so calling it can never be a mistake. Show it to the person, then pass the ids '
      + 'they approve to delete_session_logs.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LIST_VALUE, render: (_args, value) => [{ type: 'text', text: renderList(value) }] },
    execute(_args, exec) {
      return listLogs(ctx, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delete_session_logs',
    description:
      'Delete the stored logs of the named sessions by moving each session directory out of the session store '
      + 'in one atomic rename, and report what moved. Pass exactly the ids from list_session_logs that the '
      + 'person approved: this call is the confirmation step, so never pass an id nobody has seen. An archived '
      + 'session and an unarchived one are both deletable; an id that cannot be deleted — held by the running '
      + 'session or by a busy agent, already gone, or stored under a directory the plugin refuses to touch — is '
      + 'refused in the answer with the reason instead of failing the call. The moved directories are kept in '
      + 'the trash for a retention window, so a mistake is recoverable with trash_session_logs; the bytes are '
      + 'freed when an entry is purged, not here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_ids'],
      properties: {
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact session ids from list_session_logs — never an id from memory.',
        },
      },
    },
    output: { schema: DELETE_VALUE, render: (_args, value) => [{ type: 'text', text: renderDelete(value) }] },
    async execute(args, exec) {
      const requested = Array.isArray(args?.session_ids) ? args.session_ids : undefined
      if (requested === undefined || requested.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new Error('delete_session_logs: session_ids must be an array of non-empty session ids')
      }
      return deleteLogs(ctx, exec, requested)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'trash_session_logs',
    description:
      'The recoverable half of a deletion: list what the trash holds, put a deleted session back, or free its '
      + 'bytes for good. action="list" (the default) is read-only and needs no ids. action="restore" puts the '
      + 'named session directories back where the session backend looks for them and unarchives them, so the '
      + 'row returns; it refuses to overwrite anything already sitting at that path. action="purge" removes the '
      + 'named directories for good and is the only step that frees their bytes. Entries older than the '
      + 'retention window are freed by the next deletion, never on a timer. Name ids exactly as '
      + 'list_session_logs or a trash listing gave them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'restore', 'purge'],
          description: 'list what the trash holds, restore the named ids, or purge them for good. Defaults to list.',
        },
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact session ids, required for restore and purge and ignored by list.',
        },
      },
    },
    output: { schema: TRASH_VALUE, render: (_args, value) => [{ type: 'text', text: renderTrash(value) }] },
    async execute(args, exec) {
      const action = args?.action === undefined ? 'list' : args.action
      if (!['list', 'restore', 'purge'].includes(action)) {
        throw new Error(`trash_session_logs: action must be list, restore or purge (got ${String(action)})`)
      }
      const ids = args?.session_ids
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0))) {
        throw new Error('trash_session_logs: session_ids must be an array of non-empty session ids')
      }
      return trashLogs(ctx, exec, action, ids)
    },
  }))

  // One operation, two callers — the shape the plugin-development skill documents: the command registry's
  // handler and the tool above both end in the same function, so a person who types the command and a model
  // that calls the tool cannot drift apart. The command runs *without* the model: `execute` resolves it and
  // no turn is started, which is what makes a deletion possible with zero tokens spent on deciding.
  //
  // The registration **waits for the registry** instead of reading `ctx.get('commands')` once while this
  // bundle loads: the registry may mount after us, and a miss there is silent — which cost a whole debugging
  // session, because the row in the sidebar then ran a command the host had never heard of. `ctx.inject`
  // holds the callback until the service exists, and its disposal removes the command with this plugin.
  const registerCommand = (scope, commands) => {
    try {
      scope.effect(() => commands.register(CLEAN_COMMAND(ctx)))
      humanCommand = 'registered'
    } catch (error) {
      humanCommand = `not registered (${error instanceof Error ? error.message : String(error)})`
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], (scope) => registerCommand(scope, scope.commands))
  else {
    // An older Context without `inject`: try the one-shot lookup, and let the listing say what happened.
    const commands = ctx.get('commands')
    if (commands === undefined || typeof commands.register !== 'function') humanCommand = 'not registered (no command registry)'
    else registerCommand(ctx, commands)
  }

  // The window half's own transport, and the reason this plugin finally works from the sidebar: an HTTP route
  // on the product's web carrier. A session-menu row acts on a session that may have **no agent at all** — the
  // session is closed, its log is still on disk — and every carrier that runs a command needs one, which is
  // why the row used to do nothing. A route needs nothing but the request.
  //
  // Contract read from the running Host rather than assumed: `webServer.register({ kind, path, resource })`,
  // `kind: 'exact' | 'prefix'`, and `resource: (request: Request, peer?) => Promise<Response>`. The prefix is
  // this plugin's own, so no product route can be shadowed.
  const registerRoutes = (scope, server) => {
    try {
      scope.effect(() => server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        resource: (request) => serveRoute(ctx, request),
      }))
      windowTransport = `route ${ROUTE_PREFIX} registered`
    } catch (error) {
      // Isolated like every other contribution: a carrier that refuses this route costs the sidebar row only,
      // and the listing says so in words.
      windowTransport = `route not registered (${reasonOf(error)})`
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (scope) => registerRoutes(scope, scope.webServer))
  else {
    const server = ctx.get('webServer')
    if (server === undefined || typeof server.register !== 'function') windowTransport = 'not registered (no web server)'
    else registerRoutes(ctx, server)
  }
}

/** This plugin's own route prefix on the browser's HTTP carrier. */
const ROUTE_PREFIX = '/dsh-cleaner/'

/** A JSON response, the one shape this route answers with. */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The window half's whole protocol, in one function.
 *
 * `POST /dsh-cleaner/<action>` with a JSON body:
 *
 * - `delete`  `{ caller, ids }` — the same deletion the tool runs; `caller` is the session the window is
 *   showing, and it is what keeps the running session protected;
 * - `list`    `{}`             — the listing, so the window can show counts without asking a model;
 * - `trash`   `{ caller, op?, ids? }` — `op` is `list`, `restore` or `purge`;
 * - `state`   `{ state }`      — the window's own account of itself, printed by the next listing.
 *
 * Every guard is the one the tools use: this function only chooses a caller and decodes a body.
 * @param ctx - the plugin context.
 * @param request - the Fetch request the carrier hands over.
 * @returns a JSON response; never throws.
 */
async function serveRoute(ctx, request) {
  let action = ''
  try {
    action = new URL(request.url, 'http://localhost').pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '')
  } catch {
    return jsonResponse({ error: 'the request URL cannot be read' }, 400)
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'this route answers POST only' }, 405)
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'the body must be JSON' }, 400)
  }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length > 0) : []
  // The caller is named by the window, because a route has no Agent of its own. Without one a deletion is
  // refused by the same guard that protects the running session from a tool call.
  const caller = typeof body?.caller === 'string' && body.caller.length > 0 ? body.caller : undefined
  const exec = { agent: caller === undefined ? undefined : { session: { id: caller } } }
  try {
    if (action === 'delete') return jsonResponse(await deleteLogs(ctx, exec, ids))
    if (action === 'list') return jsonResponse(await listLogs(ctx, exec))
    if (action === 'trash') {
      const op = body?.op === 'restore' || body?.op === 'purge' ? body.op : 'list'
      return jsonResponse(await trashLogs(ctx, exec, op, ids))
    }
    if (action === 'state') {
      const state = body?.state
      if (state === null || typeof state !== 'object' || Array.isArray(state)) {
        return jsonResponse({ error: 'state must be a JSON object' }, 400)
      }
      clientHalf = formatState(state)
      return jsonResponse({ ok: true, recorded: clientHalf })
    }
    return jsonResponse({ error: `unknown action ${action || '(none)'}; use delete, list, trash or state` }, 404)
  } catch (error) {
    // A route that throws takes the whole page down with it, so a failure is an answer here, never a rejection.
    return jsonResponse({ error: reasonOf(error) }, 500)
  }
}

/**
 * Whether the human command is registered in the running profile — the one fact a person cannot see on disk.
 *
 * Reported in every listing on purpose: it is the difference between a sidebar row that deletes and a row
 * that does nothing, and the answer belongs where a person already looks.
 */
let humanCommand = 'not registered yet'

/**
 * What the window half last said about itself, recorded from `/clean --state <json>` and printed by the next
 * listing.
 *
 * A browser half has no channel to the host except the command registry, so it borrows that one: it answers
 * silently, nothing lands in a transcript, and the next listing can say "the window half loaded, the shortcut
 * service was there, the registration was refused because …". Before this, a half that loaded and contributed
 * nothing was indistinguishable from a half that never loaded.
 */
let clientHalf = 'nothing heard from a window yet'

/**
 * How the window reaches this plugin — the route, or the reason there is none.
 *
 * The same reasoning as `humanCommand`: a sidebar row that is drawn but cannot act looks exactly like a row
 * that works, and this is the fact that tells the two apart.
 */
let windowTransport = 'not registered yet'

/** A one-line reason from anything that was thrown, cross-realm safe. */
const reasonOf = (error) => (typeof error?.message === 'string' ? error.message : String(error))

/** The `/clean` definition, kept beside the registration so the two cannot drift. */
function CLEAN_COMMAND(ctx) {
  return {
    name: 'clean',
    description: 'List the sessions whose logs are on disk, or delete the ones you name.',
    input: { hint: 'no input lists every log; ids (space or comma separated) delete them' },
    handler: async ({ agent, rawInput }) => {
      const exec = { agent }
      if (agent === undefined) {
        return { kind: 'error', text: 'clean needs the Session it was run from: without one the running session cannot be protected' }
      }
      const reported = stateReport(rawInput)
      if (reported !== undefined) {
        clientHalf = reported
        // No text: a diagnostic must not put a line in anybody's transcript.
        return { kind: 'success' }
      }
      const named = rawInput.split(/[\s,]+/).map((token) => token.trim()).filter((token) => token.length > 0)
      if (named.length === 0) {
        const listing = await listLogs(ctx, exec)
        // No tool to call from here, so the one line the listing cannot say itself: how to act on it.
        return {
          kind: 'success',
          text: `${renderList(listing)}\n\nName the ids to delete: /clean <id> <id> …`
            + '\nThe trash: /clean trash · put one back: /clean restore <id> … · free its bytes: /clean purge <id> …',
        }
      }
      // The recoverable half, reachable without a model: three words a person can remember.
      const [first, ...rest] = named
      if (first === 'trash' || first === 'restore' || first === 'purge') {
        const action = first === 'trash' ? 'list' : first
        if (action === 'list') {
          const listing = await listLogs(ctx, exec)
          return { kind: 'success', text: `${renderTrash(await trashLogs(ctx, exec, 'list'))}\n\n${trashLines(listing.trash).join('\n')}` }
        }
        return { kind: 'success', text: renderTrash(await trashLogs(ctx, exec, action, rest)) }
      }
      const report = await deleteLogs(ctx, exec, named)
      return { kind: 'success', text: renderDelete(report) }
    },
  }
}

/**
 * The window half's own account of itself, if this line carries one.
 *
 * `/clean --state {"inject":true,…}` → a one-line summary. Anything that is not a JSON object is not a state
 * report, so a `/clean --state` typed by hand still lists the logs.
 * @param rawInput - the command's input, exactly as given.
 * @returns the summary to record, or `undefined` when this is not a state report.
 */
function stateReport(rawInput) {
  if (!rawInput.startsWith('--state ')) return undefined
  let state
  try {
    state = JSON.parse(rawInput.slice('--state '.length))
  } catch {
    return undefined
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined
  return formatState(state)
}

/**
 * One line about a window half, from the object it sent.
 *
 * Both carriers end here — the route and the `/clean --state` line the older half used — so the next listing
 * reads the same sentence whichever one arrived.
 * @param state - the object the window half reported.
 * @returns the one-line summary.
 */
function formatState(state) {
  const parts = []
  for (const key of ['inject', 'service', 'register', 'catalog', 'menu', 'dictionary', 'row', 'panel', 'panel_icon', 'route', 'current', 'lastClick', 'fatal']) {
    if (state[key] !== undefined) parts.push(`${key}=${String(state[key])}`)
  }
  return parts.length === 0 ? 'the window half sent an empty state' : parts.join('  ')
}

