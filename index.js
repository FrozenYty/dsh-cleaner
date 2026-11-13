/**
 * dsh-cleaner — permanently delete the logs of archived sessions, on request.
 *
 * THE CONTRACT
 * An archive is not a deletion: it hides the session and touches nothing. This plugin is the removal,
 * and it happens in exactly three steps: it lists, the person approves, it deletes the ids they named
 * and reports the bytes reclaimed. There is no timer, no interval, no age threshold and no background
 * sweep anywhere in this file or in the engine — a schedule is a policy about the future, and the rule
 * here is that deletion is an act somebody asked for. The listing tool cannot delete; the deleting tool
 * cannot invent an id, because every id in its argument came from the listing.
 *
 * TWO TOOLS, NOT TWO MODES OF ONE
 * `list_archived_sessions` has no side effect and no required argument, so calling it can never be a
 * mistake. `delete_archived_sessions` requires the ids by name, so nothing is ever deleted by
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
 * verification: `delete_archived_sessions` asks the mounted backend whether it still lists the ids it
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
import { join } from 'node:path'

import { applyCleanup, planCleanup } from './engine.js'

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
function storagePaths() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    sessionsRoot: join(home, 'sessions'),
    workspaceFile: join(home, 'storages', 'workspace.json'),
    projections: join(home, 'storages', 'session_projcache', 'sessions'),
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
    protect.push({ id, reason: 'a live agent holds this session' })
  }
  return protect
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

/** Every line a listing answers with, including the ones that explain an empty result. */
function renderList(value) {
  const lines = []
  lines.push(
    value.candidates.length === 0
      ? 'No archived session log is on disk: there is nothing to delete.'
      : `Archived session logs on disk: ${value.candidates.length} of ${value.archived_ids} archived ids, `
        + `${formatBytes(value.total_bytes)}.`,
  )
  lines.push(
    `The session store holds ${value.stored_sessions} directories, ${formatBytes(value.stored_bytes)} in all.`,
  )
  for (const candidate of value.candidates) {
    lines.push(
      `  ${title(candidate)}${candidate.id}  ${formatBytes(candidate.bytes)}  ${files(candidate.files.length)}  `
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
      'Nothing was deleted. Show this list to the person and call delete_archived_sessions with the ids '
      + 'they approve.',
    )
  }
  return lines.join('\n')
}

/** Every line a deletion answers with, including what it kept and what it could not remove. */
function renderDelete(value) {
  const lines = []
  lines.push(
    value.removed.length === 0
      ? 'Deleted nothing: no archived session log on disk matched the ids given.'
      : `Deleted ${directories(value.removed.length)}: ${formatBytes(value.removed_bytes)} reclaimed.`,
  )
  for (const entry of value.removed) {
    lines.push(`  ${title(entry)}${entry.id}  ${formatBytes(entry.bytes)}  ${files(entry.files)}  ${entry.path}`)
  }
  for (const entry of value.failed) {
    lines.push(`Partially removed: ${entry.id} — ${entry.error} (${formatBytes(entry.bytes_freed)} freed)`)
  }
  for (const entry of value.refused) lines.push(`Kept: ${entry.id} — ${entry.reason}`)
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

/** The listing's canonical value. Keys are the plan's, so nothing is renamed on the way out. */
const LIST_VALUE = {
  type: 'object',
  required: [
    'sessions_root', 'workspace_file', 'archived_ids', 'stored_sessions', 'stored_bytes', 'candidates',
    'total_bytes', 'already_gone', 'protected', 'skipped', 'requested',
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
  },
}

/** The deletion's canonical value; every key is present on every answer, empty or not. */
const DELETE_VALUE = {
  type: 'object',
  required: ['sessions_root', 'removed', 'removed_count', 'removed_bytes', 'failed', 'refused', 'verify'],
  properties: {
    sessions_root: { type: 'string' },
    removed: { type: 'array', items: { type: 'object' } },
    removed_count: { type: 'number' },
    removed_bytes: { type: 'number' },
    failed: { type: 'array', items: { type: 'object' } },
    refused: { type: 'array', items: { type: 'object' } },
    verify: { type: 'object' },
  },
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'list_archived_sessions',
    description:
      'List the archived DeepSeek Harness sessions whose logs are still on disk: each one\'s bytes and last write, '
      + 'and what the store holds in total. An archive only hides a session — its log stays on disk and nothing in '
      + 'the product removes it. Read-only and argument-free, so calling it can never be a mistake. Show it to the '
      + 'person, then pass the ids they approve to delete_archived_sessions.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LIST_VALUE, render: (_args, value) => [{ type: 'text', text: renderList(value) }] },
    async execute(_args, exec) {
      return planCleanup({ ...storagePaths(), protect: protections(ctx, exec) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delete_archived_sessions',
    description:
      'Permanently delete the stored logs of the named archived sessions, and report the bytes reclaimed. Pass '
      + 'exactly the ids from list_archived_sessions that the person approved: this call is the confirmation step, '
      + 'so never pass an id nobody has seen. An id that cannot be deleted — not archived, already gone, or held by '
      + 'a running session — is refused in the answer with the reason instead of failing the call. Each session\'s '
      + 'own directory is removed whole; no log line is rewritten.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_ids'],
      properties: {
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact session ids from list_archived_sessions — never an id from memory.',
        },
      },
    },
    output: { schema: DELETE_VALUE, render: (_args, value) => [{ type: 'text', text: renderDelete(value) }] },
    async execute(args, exec) {
      if (exec?.agent === undefined) {
        throw new Error('delete_archived_sessions needs a calling Agent: without one the running session cannot be protected')
      }
      const requested = Array.isArray(args?.session_ids) ? args.session_ids : undefined
      if (requested === undefined || requested.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new Error('delete_archived_sessions: session_ids must be an array of non-empty session ids')
      }
      const ids = [...new Set(requested)]
      if (ids.length === 0) throw new Error('delete_archived_sessions: session_ids must name at least one session')

      const paths = storagePaths()
      const plan = await planCleanup({ ...paths, protect: protections(ctx, exec), only: ids })
      const report = await applyCleanup(plan)
      return {
        sessions_root: paths.sessionsRoot,
        removed: report.removed,
        removed_count: report.removed.length,
        removed_bytes: report.removed_bytes,
        failed: report.failed,
        refused: [...plan.requested, ...report.refused],
        verify: report.removed.length === 0
          ? { backend: 'not-asked' }
          : await verifyRemoved(ctx, report.removed.map((entry) => entry.id)),
      }
    },
  }))
}
