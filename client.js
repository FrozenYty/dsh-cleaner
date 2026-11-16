/**
 * The browser half: one row in a session's menu, one keystroke, and a report about itself.
 *
 * How it reaches the host: **an HTTP route** — `POST /dsh-cleaner/<action>` on the product's own web carrier,
 * registered by the host half. This is the third and finally correct answer to the same question, and the
 * reason the first two failed is worth writing down:
 *
 * - `ctx.remote.*` does not exist on this build's client root (the directory lists `layout`, `locale`,
 *   `sessions`, `slots`, `theme`, `timer`, `uiWorkspace`, `workspaces`), so every call through it threw and
 *   was swallowed;
 * - a *command* — carried by `ctx.sessions.retain(id)` or by any other agent-scoped handle — needs a live
 *   agent, and the session behind a sidebar row is usually **closed**: its log is on disk and nothing holds it,
 *   which is exactly the session a person wants to delete.
 *
 * A route needs neither. The shipped community plugin that does this same job
 * (`TOBYCAI/dsh-sessions-manager`) posts to its own `/archived-sessions/*` routes for the same reason.
 *
 * What it does **not** do: repair the sidebar's stored view. That was 0.2.x's job and it never ran, because the
 * call it needed does not exist here; a deleted session's row is hidden by the **archive write** the host half
 * performs ([ADR 0013](docs/adr/0013-reuse-the-client-sessions-service.md),
 * [ADR 0014](docs/adr/0014-route-transport-and-recoverable-deletion.md)).
 */

window.__ModuleLoader__.load({
  id: 'dsh-cleaner',
  factory(require) {
    // React comes from the page's own module table — the documented shape for a Client module — so a panel
    // needs no duplicate installation and no import of anything else.
    const React = require('react')
    const h = React.createElement

    const SHORTCUT_ID = 'session.delete-log'
    const LOCALE_NS = 'dsh-cleaner'
    const LABEL_KEY = 'session.delete'
    /** The host half's route prefix, and the only channel this half has. */
    const ROUTE = '/dsh-cleaner/'
    /** The settings page this half contributes, and the seats it takes. */
    const PANEL_ID = 'dsh-cleaner.trash'
    const PANEL_SLOT = 'settings.section'
    const ICON_SLOT = 'settings.section.icon'
    /** A floating notice at the frame level, so a click always says what it did. */
    const NOTICE_ID = 'dsh-cleaner.notice'
    const NOTICE_SLOT = 'shell.overlay'

    /**
     * A one-line reason from anything that was thrown.
     *
     * `error instanceof Error` is false for an error built in another realm, so the message field is read
     * directly when it is a string.
     */
    const reasonOf = (error) => (typeof error?.message === 'string' ? error.message : String(error))

    /**
     * A refusal survives a later report.
     *
     * `report()` recomputes what each service looked like, and would otherwise overwrite "refused: …" with
     * "not contributed" — turning the one sentence that explains a failure into the symptom it explains.
     */
    const keepRefusal = (value, fallback) => (typeof value === 'string' && value.startsWith('refused:') ? value : fallback)

    return {
      /**
       * @param ctx - the browser plugin context. No declared dependencies: every service is optional and read
       * lazily, so a profile without one of them still gets the rest.
       */
      apply(ctx) {
        /**
         * Everything this half knows about itself, sent to the host so a listing can print it.
         *
         * It exists because a browser half that loads but contributes nothing looks exactly like one that never
         * loaded, and that confusion cost several releases.
         */
        const state = {
          inject: typeof ctx.inject === 'function',
          service: 'not seen',
          register: 'not attempted',
          catalog: 'not read',
          menu: 'not asked',
          dictionary: 'not asked',
          row: 'not contributed',
          panel: 'not contributed',
          panel_icon: 'not contributed',
          notice: 'not contributed',
          route: 'not called',
          report: 'not sent',
          current: 'not read',
          lastClick: 'none',
          fatal: undefined,
        }
        // The last click's outcome survives a reload, in the window's own storage. Without this the only record of
        // what a click did is gone the moment the page refreshes — which is how one live fault became unreadable
        // today: the person reloaded, and the evidence went with it.
        const CLICK_KEY = 'dsh.cleaner.lastClick'
        try {
          const remembered = JSON.parse(localStorage.getItem(CLICK_KEY) ?? 'null')
          if (remembered !== null && typeof remembered === 'object') {
            if (typeof remembered.lastClick === 'string') state.lastClick = remembered.lastClick
          }
        } catch {
          // Storage that cannot be read costs the memory of one click, never the plugin.
        }
        const remember = () => {
          try {
          } catch {
            // Same: a window with no writable storage still deletes.
          }
        }
        /** Whether the menu row was contributed — reported, because a missing row is the thing people see. */
        let rowRegistered = false

        /**
         * One string in the window's language, through the product's dictionary service.
         *
         * `ctx.locale.register(ns, { en, zh })` contributes the strings and `ctx.locale.bind(ns)` reads them
         * back with the product's fallback chain. A locale service that cannot answer costs the language,
         * never the item.
         */
        const text = (key, fallback) => {
          // The product first: `bind()` walks the active language's declared fallback chain in our namespace and then
          // in the shared one (locale `Service` contract), so whatever it resolves is right. A refused registration
          // throws, and it must not take the rest of the resolution down with it - two separate attempts, one per
          // source, for exactly that reason.
          try {
            const value = ctx.get('locale')?.bind?.(LOCALE_NS)?.(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) return value
          } catch {
            // A refused registration falls through to the plugin's own table below.
          }
          try {
            // Ours, for the case `bind` cannot cover: a registration refused as a duplicate (an earlier load of this
            // half leaves one behind) answers with the key itself. `active` is a full tag - `zh-CN`, `en-US` - not
            // the two-letter id, so the match is by prefix; reading it as `'zh'` was wrong.
            const active = String(ctx.get('locale')?.getLocale?.()?.active ?? '').toLowerCase()
            const own = active.startsWith('zh') ? STRINGS.zh : active.startsWith('en') ? STRINGS.en : undefined
            const value = own?.[key]
            if (typeof value === 'string' && value.length > 0) return value
          } catch {
            // A locale service that cannot answer costs the language, never the item.
          }
          return fallback
        }

        /** The row's label in the window's language. */
        const label = () => text(LABEL_KEY, 'Delete session')

        /**
         * The last thing this half did, as a subscribable value.
         *
         * The click happens in a plain function and the notice is a component, so they meet here rather than in
         * React state. One writer (`notify`), any number of readers.
         */
        let noticeText
        const noticeReaders = new Set()
        const notify = (text) => {
          noticeText = text
          for (const reader of noticeReaders) {
            try {
              reader()
            } catch {
              // A reader that throws must not stop the others, nor the click.
            }
          }
        }

        /**
         * A frame-level notice: one line, self-dismissing, and it says what the click did.
         *
         * This exists because "点击没有效果" was never a wrong symptom — it was the absence of one. A row that
         * deletes nothing and says nothing is indistinguishable from a row that is not wired at all, and that
         * ambiguity is what cost the most rounds here.
         */
        function Notice() {
          const [text, setText] = React.useState(noticeText)
          React.useEffect(() => {
            const update = () => setText(noticeText)
            noticeReaders.add(update)
            update()
            return () => noticeReaders.delete(update)
          }, [])
          React.useEffect(() => {
            if (text === undefined) return undefined
            const timer = setTimeout(() => {
              noticeText = undefined
              setText(undefined)
            }, 12000)
            return () => clearTimeout(timer)
          }, [text])
          if (text === undefined || text === '') return null
          return h('div', {
            role: 'status',
            style: {
              position: 'fixed',
              bottom: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 2147483000,
              maxWidth: 'min(92vw, 560px)',
              padding: '9px 16px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
              background: 'var(--dsw-alias-bg-layer-2, #232323)',
              color: 'var(--dsw-alias-label-primary, #e6e6e6)',
              fontSize: '12px',
              lineHeight: 1.5,
              boxShadow: '0 8px 24px rgb(0 0 0 / 0.25)',
              pointerEvents: 'none',
            },
          }, text)
        }
        /** Every string the trash panel needs, resolved when it renders rather than when it loads. */
        const labels = () => ({
          // "Trash" is what a person already calls this place on every desktop they use; "deleted sessions"
          // described the contents and read like a log title.
          title: text('trash.title', 'Trash'),
          restore: text('trash.restore', 'Restore'),
          purge: text('trash.purge', 'Delete for good'),
          empty: text('trash.empty', 'The trash is empty.'),
          loading: text('trash.loading', 'Reading the trash…'),
          unavailable: text('trash.unavailable', 'Host half not loaded — restart to use this page.'),
          bytes: text('trash.bytes', 'bytes'),
          confirm: text('trash.confirm', 'Confirm'),
          restoreAll: text('trash.restoreAll', 'Restore all'),
          purgeAll: text('trash.purgeAll', 'Empty the trash'),
          confirmAll: text('trash.confirmAll', 'Delete {n} for good?'),
          today: text('trash.today', 'today'),
          yesterday: text('trash.yesterday', 'yesterday'),
          unnamed: text('trash.unnamed', 'Untitled'),
          count: text('trash.count', '{n} entries'),
          swept: text('trash.swept', '{n} entries expired and were removed'),
        })
        /** The strings in both languages: `text` reads this table before any service. */
        const STRINGS = {
            en: {
              [LABEL_KEY]: 'Delete session',
              'trash.title': 'Trash',
              'trash.restore': 'Restore',
              'trash.purge': 'Delete for good',
              'trash.empty': 'The trash is empty.',
              'trash.loading': 'Reading the trash…',
              'trash.unavailable': 'Host half not loaded — restart to use this page.',
              'trash.bytes': 'bytes',
              'trash.limits': 'Kept {days} days · at most {limit} entries',
              'trash.confirm': 'Confirm',
              'trash.restoreAll': 'Restore all',
              'trash.purgeAll': 'Empty the trash',
              'trash.confirmAll': 'Delete {n} for good?',
              'trash.today': 'today',
              'trash.yesterday': 'yesterday',
              'trash.unnamed': 'Untitled',
              'trash.count': '{n} entries',
              'trash.swept': '{n} entries expired and were removed',
              'notice.deleted': 'Deleted',
              'notice.kept': 'Not deleted',
              'notice.gone': 'No log — row removed',
              'notice.requested': 'Delete requested — see this conversation',
              'notice.failed': 'Delete failed',
              'notice.unmatched': 'the Host matched no /clean command',
              'notice.working': 'Deleting…',
              'notice.noSession': 'No session is open to name as the caller',
            },
            zh: {
              [LABEL_KEY]: '删除会话',
              'trash.title': '回收站',
              'trash.restore': '恢复',
              'trash.purge': '彻底删除',
              'trash.empty': '回收站是空的。',
              'trash.loading': '正在读取回收站……',
              'trash.unavailable': '宿主半边未加载，重启后可用。',
              'trash.bytes': '字节',
              'trash.limits': '保留 {days} 天 · 最多 {limit} 条',
              'trash.confirm': '确认删除',
              'trash.restoreAll': '全部恢复',
              'trash.purgeAll': '清空回收站',
              'trash.confirmAll': '确认永久删除 {n} 条？',
              'trash.today': '今天',
              'trash.yesterday': '昨天',
              'trash.unnamed': '未命名会话',
              'trash.count': '{n} 条',
              'trash.swept': '{n} 条已过期并清理',
              'notice.deleted': '已删除',
              'notice.kept': '未删除',
              'notice.gone': '无日志，已移出列表',
              'notice.requested': '已请求删除，回执见本会话',
              'notice.failed': '删除失败',
              'notice.unmatched': '宿主没有匹配到 /clean 命令',
              'notice.working': '正在删除……',
              'notice.noSession': '没有打开的会话可作为调用者',
            },
        }


        /** Contribute this plugin's strings to the product's dictionary, and nothing else. */
        const registerDictionary = () => {
          const locale = ctx.get('locale')
          if (locale === undefined || typeof locale.register !== 'function') return undefined
          // Inside `ctx.effect`, like every other contribution: disabling the plugin evicts its client module, and
          // the effect is what removes the strings with it. A bare `register` would leave this plugin's dictionary
          // behind in a window that no longer has the plugin.
          return ctx.effect(() => locale.register(LOCALE_NS, STRINGS), 'dsh-cleaner: dictionary')
        }

        /**
         * The session the window is looking at, read from the sidebar's own persisted selection.
         *
         * It travels with every request as `caller`, because the host protects the session it is running for:
         * without a caller a deletion is refused, exactly as a tool call without an agent is.
         */
        const currentSessionId = () => {
          try {
            const parsed = JSON.parse(window.localStorage.getItem('dsh.sessions.current'))
            const id = parsed?.sessionId ?? parsed?.id
            return typeof id === 'string' && id.length > 0 ? id : undefined
          } catch {
            return undefined
          }
        }

        /**
         * Ask the host half to do something. One function, because there is one channel.
         * @param action - `delete`, `list`, `trash` or `state`, appended to the prefix.
         * @param body - the JSON request body.
         * @returns the parsed answer, or `{ error }` — this never rejects, so a caller can always report.
         */
        const post = async (action, body) => {
          try {
            const response = await window.fetch(ROUTE + action, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
              // The product's carrier authenticates with its own cookie; same-origin keeps it on the request.
              credentials: 'same-origin',
            })
            const text = await response.text()
            let parsed
            try {
              parsed = text === '' ? {} : JSON.parse(text)
            } catch {
              return { error: `the host answered ${response.status} with something that is not JSON` }
            }
            if (!response.ok) return { error: String(parsed?.error ?? `the host answered ${response.status}`), status: response.status }
            state.route = `ok (${action})`
            return parsed
          } catch (error) {
            state.route = `failed: ${reasonOf(error)}`
            return { error: reasonOf(error) }
          }
        }

        /**
         * The older carrier: run one of the host's own lines in the session in front of the person.
         *
         * This is what makes the row work on a Host that predates the route, and it is not a fallback nobody
         * uses: `/clean` has been registered since 0.2.18, while the route only exists from 0.3.0. A command is
         * admitted by `sessions.retain(id)`, which is the same mechanism the sidebar uses to open a session —
         * so a closed session is opened by this call rather than refused.
         * @param caller - the session that carries the line; it is the one the host protects.
         * @param line - the command line, exactly as a person would type it.
         * @returns `{ ok, matched }` or `{ error }`; never rejects.
         */
        const commandViaSession = async (caller, line) => {
          let reference
          try {
            const sessions = ctx.get('sessions')
            if (sessions === undefined || typeof sessions.retain !== 'function') {
              return { error: 'this Host has no sessions service' }
            }
            reference = sessions.retain(caller, { source: 'gateway' })
            const binding = await reference.ready
            const result = await binding.session.command(line)
            if (result?.ok === false) return { error: result.error?.message ?? 'refused' }
            return { ok: true, matched: result?.value?.matched }
          } catch (error) {
            return { error: reasonOf(error) }
          } finally {
            try {
              reference?.release?.()
            } catch {
              // A reference that cannot be released must not cost the result.
            }
          }
        }

        /** Delete one session through the command the older Host serves. */
        const cleanViaCommand = (caller, target) => commandViaSession(caller, `/clean ${target}`)

        /**
         * Leave the view of a session that was just deleted, when it is the one on screen.
         *
         * A deleted session is released from the Host's store ([ADR 0025](docs/adr/0025-a-deletion-releases-the-live-session.md)),
         * so the window would otherwise sit on a dead page: a conversation whose session no longer exists. The
         * product already has the call — `uiWorkspace.startSession()` is what the sidebar's *新会话* button runs, and
         * with no workspace able to take a draft it clears the view to the default page — so this reuses the same
         * seam instead of inventing a navigation of its own.
         *
         * Two guards, and both matter: only after a deletion that really happened (`moved` or `no log`, never a
         * refusal — the session is alive there and the page is where the person wants to stay), and only when the
         * id is the one the window shows.
         * @param sessionId - the session the deletion named.
         */
        const leaveDeletedSession = (sessionId) => {
          try {
            if (sessionId !== currentSessionId()) return
            const ui = ctx.get('uiWorkspace')
            if (typeof ui?.startSession !== 'function') return
            ui.startSession()
          } catch (error) {
            // The row and the log are gone either way; a window this call cannot move is reported, not thrown.
            state.lastClick = `${state.lastClick}; could not leave the deleted view: ${reasonOf(error)}`
          }
        }

        /**
         * Run the deletion for one session: the same operation the tool and the command run.
         *
         * Two carriers, tried in one order and reported either way. The route answers with the deletion's own
         * value, so the answer can be shown as it is; the command answers with "did a command match", so its
         * result is reported for what it is instead of being dressed up as a receipt. The caller is the session
         * in front of the person in both cases, which is what keeps the running session protected.
         */
        const runClean = (sessionId) => {
          const caller = currentSessionId()
          if (caller === undefined) {
            state.lastClick = 'no session is open to name as the caller'
            // Reported even though the click did nothing: the report needs no caller, and this is the only way
            // the next listing can say why the click was a no-op.
            notify(text('notice.noSession', 'Delete session: no session is open, so there is nothing to name as the caller.'))
            report()
            return
          }
          state.lastClick = `asked for ${sessionId}`
          notify(text('notice.working', 'Deleting…'))
          void post('delete', { caller, ids: [sessionId] }).then(async (answer) => {
            if (answer.error === undefined) {
              const moved = Array.isArray(answer.removed) ? answer.removed.length : 0
              // The answer's own fields decide what happened; a reason string is not an interface. An id with no
              // directory is reported under `unlogged`, an id that is held back under `protected`, and something
              // the plan could not use under `refused` — reading the wrong one is how a finished deletion looked
              // like a bare "nothing moved" with the row still standing.
              const idOf = (entry) => (typeof entry === 'string' ? entry : entry?.id)
              const unlogged = (Array.isArray(answer.unlogged) ? answer.unlogged : []).map(idOf)
              // The deletion answer does **not** carry `unlogged` — that field belongs to the listing. What it
              // carries is `workspace.orphans`: the ids the registry was asked to drop because their log is gone.
              // That is the structural signal for "there was nothing to delete, and the row is dealt with", and
              // reading it is what stops a finished click from printing 未删除.
              const orphans = Array.isArray(answer.workspace?.orphans) ? answer.workspace.orphans : []
              const held = Array.isArray(answer.protected) ? answer.protected : []
              const refused = Array.isArray(answer.refused) ? answer.refused : []
              const noLog = moved === 0 && (orphans.includes(sessionId) || unlogged.includes(sessionId))
              const why = refused.find((entry) => idOf(entry) === sessionId)?.reason
                ?? held.find((entry) => idOf(entry) === sessionId)?.reason
                ?? refused[0]?.reason
              state.lastClick = moved > 0
                ? `deleted over the route (recoverable under ${answer.trash?.root ?? 'the trash'})`
                : `${noLog ? 'nothing to delete: no log' : 'nothing moved'}${why === undefined ? '' : `: ${why}`}`
              if (moved > 0) {
                notify(text('notice.deleted', 'Deleted'))
              } else if (noLog) {
                notify(text('notice.gone', 'No log — row removed'))
              } else {
                notify(why === undefined ? text('notice.kept', 'Not deleted') : `${text('notice.kept', 'Not deleted')}：${why}`)
              }
              // Only a deletion that really happened, and only for the session being looked at: the view of a
              // session that no longer exists is a dead page, and `startSession()` is the product's own "new
              // session" (the same call the sidebar button makes, which falls back to the default page when no
              // workspace can take a draft). A refused deletion leaves the session alive, so it must not move.
              // The window's own list still holds the id after the Host has let it go, and the product draws every
              // listed session no workspace claims under its "ungrouped" bucket - which is exactly what a person saw
              if (moved > 0 || noLog) leaveDeletedSession(sessionId)
              report()
              return
            }
            // The route is not there (a Host older than 0.3.0 answers 405): use the command it does serve.
            const routeError = answer.error
            const viaCommand = await cleanViaCommand(caller, sessionId)
            // `matched: false` means no command by that line exists in this Host — a failure, not a handover. The
            // matrix check found this: the branch treated "the Host did not match the command" as "the Host was
            // asked", which reads as success while nothing at all happened.
            const handed = viaCommand.error === undefined && viaCommand.matched !== false
            const failure = viaCommand.error ?? (viaCommand.matched === false ? text('notice.unmatched', 'the Host matched no /clean command') : undefined)
            state.lastClick = handed
              ? `handed to /clean (matched=${String(viaCommand.matched)}); route unavailable (${routeError})`
              : `refused: ${failure}; route unavailable (${routeError})`
            // The command answers with "did a command match", not with what it deleted, so this carrier must not
            // claim a deletion it cannot see. The Host prints its own answer in this conversation, which is where
            // the outcome actually is — a blank session genuinely has no log to delete, and saying "deleted"
            // there would be the kind of quiet lie that cost the most rounds here.
            notify(handed
              ? text('notice.requested', 'Delete requested — the Host\'s answer is in this conversation.')
              : `${text('notice.failed', 'Delete failed')}: ${failure}`)
            report()
          })
        }

        /**
         * `{ commandId }` when the shortcut catalogue holds this plugin's key, otherwise nothing.
         *
         * The overlay prints keys with `catalog.find((entry) => entry.id === action.commandId)`, so a dangling
         * association is the one shape this bundle will not ship: 0.2.4 named a static one and took every
         * session menu down with it.
         */
        const shortcutHint = () => {
          try {
            const catalog = ctx.get('shortcuts')?.catalog?.getSnapshot?.()
            const found = Array.isArray(catalog) && catalog.some((entry) => entry?.id === SHORTCUT_ID)
            return found ? { commandId: SHORTCUT_ID } : {}
          } catch {
            return {}
          }
        }

        /**
         * The same operation as the tool and the command, from the sidebar: one row in a session's own menu.
         *
         * A data contribution, not a component — `resolve` returns the item and `run` is the click, and
         * `resolve` is **synchronous and asks nothing**: every version that asked the host something while the
         * menu was opening found a way to take the menu down with it.
         *
         * Presentation, in the product's own vocabulary. Two facts had to be read from the installed renderer
         * rather than assumed: a data action sorts by `order` then id, **but** the overlay splits actions into
         * `items` and `footer` by `afterContent`, and *归档会话* is a footer action (`ui-workspace` returns
         * `afterContent: true` for it) — so no `order` value can seat this row below it. `afterContent: true`
         * here puts us in the same footer, where the product's own order (600) then sorts before ours (700).
         *
         * `separatorBefore` is deliberately **not** set: the archive row already carries it, so the destructive
         * block below the item list is divided once, and a second divider between two adjacent rows reads as a
         * mistake.
         */
        const registerMenu = () => {
          const menus = ctx.get('contextMenus')
          if (menus === undefined || typeof menus.register !== 'function') return undefined
          // `ctx.effect` is the documented pattern, and the reason is this plugin's own promise: closing the plugin
          // must take the row out of every session menu. A bare `register` returns a disposer nobody would call.
          return ctx.effect(() => menus.register({
            id: 'dsh-cleaner.delete-log',
            target: 'session',
            order: 700,
            resolve: (target) => {
              const sessionId = target?.sessionId
              if (typeof sessionId !== 'string' || sessionId.length === 0) return []
              return [{
                id: 'dsh-cleaner.delete-log',
                label: label(),
                icon: { key: 'workspace.delete' },
                danger: true,
                afterContent: true,
                ...shortcutHint(),
                run: () => runClean(sessionId),
              }]
            },
          }))
        }

        /**
         * Ctrl+Shift+D (⌘⇧D on macOS): the keyboard path to the same act, on the session the window shows.
         *
         * The defaults are declared **per profile**, and that list is load-bearing rather than cosmetic. The
         * product's own validation (its `protocol.js`, read from the installed asar) admits a binding only if
         * *every* declared profile admits it: `web:linux` accepts three fixed combinations and nothing else, so
         * declaring it with `Control+Shift+D` made `register()` throw `Unsupported Web shortcut` and **the whole
         * registration was refused** — no entry in the catalogue, hence no keycap beside the menu row and a key
         * that never fired. An omitted profile is simply unbound, which is the honest state on that platform.
         *
         * The registration **waits for the service** (`ctx.inject`) instead of reading `ctx.get('shortcuts')`
         * once while this half loads: a client service that mounts after this plugin is simply not there yet.
         */
        const registerShortcut = (scope) => {
          const binding = { code: 'KeyD', modifiers: ['primary', 'shift'] }
          // Verified against the product's rules, profile by profile: desktop accepts it everywhere, web accepts
          // it on macOS and Windows, and web on Linux does not — so that one is left unbound.
          const supported = {
            'desktop:macos': binding,
            'desktop:windows': binding,
            'desktop:linux': binding,
            'web:macos': binding,
            'web:windows': binding,
          }
          // If a profile above ever becomes unsupported, the desktop set still registers: a refused key must cost
          // the key, not every key on every platform.
          const desktopOnly = {
            'desktop:macos': binding,
            'desktop:windows': binding,
            'desktop:linux': binding,
          }
          const define = (defaults) => ({
            id: SHORTCUT_ID,
            label,
            aliases: ['delete session'],
            defaults,
            resolve: () => {
              const sessionId = currentSessionId()
              if (sessionId === undefined) return { status: 'blocked', reason: 'no session is open' }
              return { status: 'handled', run: () => runClean(sessionId) }
            },
          })
          try {
            state.service = typeof scope.shortcuts?.register === 'function' ? 'present' : 'unusable'
            scope.effect(() => scope.shortcuts.register(define(supported)))
            state.register = 'registered'
          } catch (error) {
            // Isolated like every contribution, and reported with the product's own words: "refused" without a
            // reason is the same silence one layer down.
            const reason = reasonOf(error)
            try {
              scope.effect(() => scope.shortcuts.register(define(desktopOnly)))
              state.register = `registered desktop-only; the full set was refused (${reason})`
            } catch (retry) {
              state.register = `refused: ${reason}; desktop-only also refused (${reasonOf(retry)})`
              console.error('dsh-cleaner: the shortcut was refused', error)
            }
          }
        }

        /**
         * Tell the host what this half managed to do, over the same route.
         *
         * Sent first, before anything that can throw, and again from the guard that catches a setup failure: a
         * diagnostic that dies with the thing it reports is not a diagnostic. It is also sent after a click, so
         * the next listing says what the click did.
         */
        const report = () => {
          try {
            const catalog = ctx.get('shortcuts')?.catalog?.getSnapshot?.()
            state.catalog = Array.isArray(catalog)
              ? (catalog.some((entry) => entry?.id === SHORTCUT_ID) ? 'holds the id' : 'does not hold the id')
              : 'not readable'
          } catch {
            state.catalog = 'not readable'
          }
          state.menu = ctx.get('contextMenus') === undefined ? 'no menu service' : 'menu service present'
          // Two facts that decide a restore, reported at load so they can be read without clicking anything: the
          // version of this half is then knowable from the Host, and so is whether the window has the levers at all.
          state.locale = ctx.get('locale')?.getLocale?.()?.active ?? 'unknown'
          state.handoff = 'first'
          state.levers = [
            typeof ctx.get('sessions')?.retain === 'function' ? 'retain' : 'no retain',
            typeof ctx.get('uiWorkspace')?.openSession === 'function' ? 'openSession' : 'no openSession',
          ].join('+')
          state.dictionary = keepRefusal(state.dictionary, ctx.get('locale')?.register === undefined ? 'no locale service' : 'locale service present')
          state.row = keepRefusal(state.row, rowRegistered ? 'contributed' : 'not contributed')
          state.current = currentSessionId() ?? 'none'
          remember()
          void post('state', { state: { ...state, report: 'route' } }).then(async (answer) => {
            if (answer.error === undefined) {
              state.report = 'route'
              return
            }
            // No route on this Host: the same sentence rides the command it does serve, and the next listing
            // prints it either way. Without this the report is lost on every Host older than 0.3.0 — which is
            // exactly the Host this half was being debugged on. The payload is written *before* it is sent, so
            // the sentence that arrives also says how it arrived.
            const caller = currentSessionId()
            if (caller === undefined) {
              state.report = `no route (${answer.error}) and no session to carry the command`
              return
            }
            // Once per page load on this carrier, deliberately: the running Host parses a command line, and its
            // answer is printed in the conversation. A report after every click would add a line to somebody's
            // transcript each time and teach them to ignore it.
            if (state.report.startsWith('command')) return
            const payload = { ...state, report: `command (route unavailable: ${answer.error})` }
            const carried = await commandViaSession(caller, `/clean --state ${JSON.stringify(payload)}`)
            state.report = carried.error === undefined
              ? payload.report
              : `nowhere: route ${answer.error}; command ${carried.error}`
          })
        }

        /**


        /**
         * A byte count a person can read at a glance.
         *
         * The one piece of arithmetic this panel does, kept a plain function so the formula is not buried in
         * the render tree.
         */
        const formatBytes = (value) => {
          const bytes = Number(value)
          if (!Number.isFinite(bytes) || bytes < 0) return '—'
          if (bytes < 1024) return `${bytes} B`
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
          return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
        }

        /**
         * The last segment of a workspace path, which is the name a person uses for it.
         *
         * The stored value is a path, because that is the fact; `D:\MYPROJS\DSH_FILES\dsh-team-roster` is shown as
         * `dsh-team-roster`, and a path that ends in a separator (a drive root) keeps its last real segment.
         */
        const workspaceName = (path) => {
          if (typeof path !== 'string' || path.trim() === '') return undefined
          const parts = path.trim().split(/[\\/]+/).filter((part) => part !== '')
          return parts.length === 0 ? path.trim() : parts[parts.length - 1]
        }

        /**
         * A deletion time in the window's own clock, the way a person says it.
         *
         * `2026-11-16T02:16:36.066Z` is a timestamp for a log, not for a person: it is in UTC, it carries
         * milliseconds nobody asked for, and the `T` and `Z` are punctuation from a format, not words. So: today and
         * yesterday keep the day as a word, anything older in this year drops the year, and another year keeps it —
         * `今天 10:16`, `昨天 22:41`, `11-14 09:03`, `2025-12-01 09:03` — always in local time, and the exact value
         * stays in the row's tooltip for whoever wants it.
         * @param iso - the stored timestamp.
         * @param now - the clock to measure "today" against, so a test can pin it.
         */
        const when = (iso, now = Date.now()) => {
          const at = Date.parse(String(iso ?? ''))
          if (!Number.isFinite(at)) return '—'
          const date = new Date(at)
          const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
          const midnight = (ms) => {
            const mark = new Date(ms)
            mark.setHours(0, 0, 0, 0)
            return mark.getTime()
          }
          const today = midnight(now)
          if (at >= today) return `${text('trash.today', 'today')} ${clock}`
          if (at >= today - 86_400_000) return `${text('trash.yesterday', 'yesterday')} ${clock}`
          const month = String(date.getMonth() + 1).padStart(2, '0')
          const day = String(date.getDate()).padStart(2, '0')
          const sameYear = date.getFullYear() === new Date(now).getFullYear()
          return sameYear ? `${month}-${day} ${clock}` : `${date.getFullYear()}-${month}-${day} ${clock}`
        }

        /**
         * The trash panel: a settings page that makes "a deletion is recoverable" something a person can see
         * and click, instead of a line they have to ask a model to print.
         *
         * Every act goes through the same route the menu row uses, so the panel and the row cannot drift, and
         * every failure is shown in place — a page that silently keeps a stale list is worse than no page.
         */
        function TrashPanel() {
          const [state, setState] = React.useState({ status: 'loading', entries: [], swept: [], error: undefined })
          const [busy, setBusy] = React.useState(undefined)
          // Which purge is waiting for its second click: `purge:<id>` for a row, `purge-all` for the header. One
          // at a time, deliberately — a question asked twice at once is a question nobody answers.
          const [confirming, setConfirming] = React.useState(undefined)

          const load = () => {
            const caller = currentSessionId()
            void post('trash', { op: 'list', ...(caller === undefined ? {} : { caller }) }).then((answer) => {
              if (answer.error !== undefined) {
                setState({ status: 'unavailable', entries: [], swept: [], error: answer.error })
                return
              }
              const trash = answer.trash ?? {}
              setState({
                status: 'ready',
                entries: Array.isArray(trash.entries) ? trash.entries : [],
                swept: Array.isArray(answer.swept) ? answer.swept : [],
                error: undefined,
                root: trash.root,
                retentionDays: trash.retention_days,
                limit: trash.limit,
              })
            })
          }

          React.useEffect(load, [])

        /**
         * Ask the product to load a session a restore just put back.
         *
         * This is the half that was still missing after the files, the projection, the membership and the archive flag
         * were all correct: a sidebar row needs a summary in the window's own list, and a session the window has never
         * loaded has none — `orderByRecency` drops every id it has no summary for, which is why a restored session kept
         * being invisible even after a reload. The product's own answer is `sessions.retain(id, { source })`, the very
         * call `uiWorkspace.replaceMain` makes when a person opens a row: it loads the session through the Host, and
         * the Host entering and announcing it is what puts it in the list. A reference whose `release` exists is kept
         * for this page only, so the load is not mistaken for "this is the session on screen".
         * @param ids - the sessions the Host reported as restored.
         */
        const loadRestored = async (ids) => {
          try {
            const sessions = ctx.get('sessions')
            const ui = ctx.get('uiWorkspace')
            let opened = false
            // Reported, not assumed: what the product's own client service offers, what it returned, and whether the
            // reference became ready. The next listing prints it, which is how a window-side failure is diagnosed
            // without guessing at another package's internals.
            const offered = sessions === undefined ? 'absent' : Object.keys(sessions).filter((key) => typeof sessions[key] === 'function').join(',')
            if (typeof sessions?.retain !== 'function') {
              state.lastClick = `${state.lastClick}; the client sessions service offers: ${offered}`
              report()
              return
            }
            for (const id of ids) {
              // The durable half is the product's own navigation: a session the window has *opened* is held by the main
              // view, so its row survives this plugin being switched off — exactly what a person observed when the one
              // session they chatted with stayed and the untouched one vanished. `retain` alone is held by this page,
              // so it dies with the plugin; it is kept for the remaining ids, which at least stay listed while the
              // plugin is on, and opening one is what makes it permanent.
              // The list the sidebar draws from is a Host-derived snapshot, so it has to be re-read after a restore or
              // projection the row renders. Both are best-effort: a Host that cannot answer costs the row, not the log.
              await Promise.resolve(sessions.refreshProjections?.(id)).catch(() => {})
              if (!opened && typeof ui?.openSession === 'function') {
                opened = true
                ui.openSession(id)
                state.lastClick = `${state.lastClick}; opened ${id}`
                continue
              }
              const reference = sessions.retain(id, { source: 'controllerOperation' })
              state.lastClick = `${state.lastClick}; retained ${id} -> ${String(reference?.sessionId ?? reference)} (offered: ${offered})`
              Promise.resolve(reference?.ready).then(
                (ready) => { state.lastClick = `${state.lastClick}; ready ${id} -> ${ready?.sessionId ?? String(ready)}` },
                (error) => { state.lastClick = `${state.lastClick}; ready ${id} FAILED: ${reasonOf(error)}` },
              )
            }
            report()
          } catch (error) {
            // A window that cannot load it still got the files back; the restore is not failed by a list.
            state.lastClick = `${state.lastClick}; retain threw: ${reasonOf(error)}`
            report()
          }
        }

          const act = (op, ids) => {
            setBusy(ids[0] ?? 'all')
            setConfirming(undefined)
            const caller = currentSessionId()
            void post('trash', { op, ids, ...(caller === undefined ? {} : { caller }) }).then(async (answer) => {
              setBusy(undefined)
              if (answer.error !== undefined) {
                setState((previous) => ({ ...previous, status: 'unavailable', error: answer.error }))
                return
              }
              // The hand-off comes first, deliberately: it is what makes the row exist, and a listing that throws must
              // not be able to skip it. This ordering was the bug behind "restored but no row" once already.
              if (op === 'restore') void loadRestored((answer.restored ?? []).map((entry) => entry.id))
              // A deletion has to leave the window's own list as well, or the product keeps drawing the id under its
              // removes what the Host no longer has. `restore` was already handled; this covers the other direction.
              // Reload the page's own list, but never let it take the restore down with it.
              try {
                load()
              } catch (error) {
                state.lastClick = `${state.lastClick}; the listing did not reload: ${reasonOf(error)}`
                report()
              }
            })
          }

          /**
           * Purge, but only on the second click.
           *
           * Purging is the one action on this page that cannot be undone — a restore is always available and a
           * deletion is recoverable — so it is the one that has to ask. Asking in place (the button becomes its own
           * confirmation) keeps a mis-click recoverable without a dialog in the middle of a settings page, and any
           * other action clears the question.
           * @param op - `purge`, or `purge-all` for the header button.
           * @param ids - what the second click would free.
           */
          const askThen = (op, ids) => {
            if (confirming === op) act('purge', ids)
            else setConfirming(op)
          }

          const words = labels()
          const totalBytes = state.entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
          const allIds = state.entries.map((entry) => entry.id)
          const rows = state.entries.map((entry) => h('div', {
            key: entry.id,
            style: {
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #2a2a2a)',
            },
          }, [
            h('div', { key: 'what', style: { flex: '1 1 auto', minWidth: 0 } }, [
              h('div', {
                key: 'title',
                // The title leads, because it is the only thing a person recognises. The session id is a uuid and
                // belongs in the tooltip: glued to the title it was the loudest text in the row and told nobody
                // anything. A session with no title keeps a short id, so two blank sessions are still told apart.
                title: entry.id,
                style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #e6e6e6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, entry.title === undefined || entry.title === '' ? `${words.unnamed} ${String(entry.id).slice(-8)}` : entry.title),
              h('div', {
                key: 'meta',
                title: entry.trashed_at === undefined ? undefined : String(entry.trashed_at),
                style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #9a9a9a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, [workspaceName(entry.workspace), formatBytes(entry.bytes), when(entry.trashed_at)].filter(Boolean).join(' · ')),
            ]),
            h('button', {
              key: 'restore', type: 'button', disabled: busy !== undefined,
              onClick: () => act('restore', [entry.id]),
              style: buttonStyle(false),
            }, words.restore),
            h('button', {
              key: 'purge', type: 'button', disabled: busy !== undefined,
              onClick: () => askThen(`purge:${entry.id}`, [entry.id]),
              style: buttonStyle(confirming === `purge:${entry.id}`),
            }, confirming === `purge:${entry.id}` ? words.confirm : words.purge),
          ]))

          const body = state.status === 'loading'
            ? h('p', { style: mutedStyle }, words.loading)
            : state.status === 'unavailable'
              ? h('p', { style: mutedStyle }, `${words.unavailable}${state.error === undefined ? '' : ` (${state.error})`}`)
              : state.entries.length === 0
                ? h('p', { style: mutedStyle }, words.empty)
                : h('div', undefined, rows)

          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 2px 24px' } }, [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: '10px' } }, [
              h('h2', { key: 'title', style: { fontSize: '16px', fontWeight: 650, margin: 0, color: 'var(--dsw-alias-label-primary, #e6e6e6)' } }, words.title),
              // What the page holds, at a glance: a number and a size answer "is there anything to do here?" before
              // the list is read row by row.
              h('span', { key: 'count', style: { ...mutedStyle, fontSize: '11px', flex: '1 1 auto' } }, state.status === 'ready'
                ? `${words.count.replace('{n}', String(state.entries.length))} · ${formatBytes(totalBytes)}`
                : ''),
              // The two things a person comes here to do in bulk. Restoring is safe and always offered; emptying the
              // trash is the one irreversible action, so it asks in place — the button becomes the question, and any
              // other click clears it.
              ...(state.entries.length === 0 ? [] : [
                h('button', {
                  key: 'restore-all', type: 'button', disabled: busy !== undefined,
                  onClick: () => act('restore', allIds),
                  style: buttonStyle(false),
                }, words.restoreAll),
                h('button', {
                  key: 'purge-all', type: 'button', disabled: busy !== undefined,
                  onClick: () => askThen('purge-all', allIds),
                  style: buttonStyle(confirming === 'purge-all'),
                }, confirming === 'purge-all'
                  ? words.confirmAll.replace('{n}', String(state.entries.length))
                  : words.purgeAll),
              ]),
            ]),
            ...(state.swept.length === 0 ? [] : [h('p', { key: 'swept', style: mutedStyle },
              words.swept.replace('{n}', String(state.swept.length)))]),
            h('div', { key: 'body' }, body),
            // The path is reference, not a headline: it stays for the person who wants to look in a file manager,
            // and the two numbers the Host enforces live in its tooltip instead of on the page — they are the same
            // for every row and answer a question a person asks once, not every time they open this page.
            h('p', {
              key: 'where',
              // The retention window and the cap are facts about the store, not something a person needs on screen:
              // the path stays, the sentence does not. The listing tool still answers both numbers in its own answer.
              style: { ...mutedStyle, marginTop: '10px', fontSize: '11px' },
            }, `${state.root ?? ''}`),
          ])
        }

        /** A control that looks like the product's own, in the same two intents. */
        const buttonStyle = (danger) => ({
          appearance: 'none',
          minHeight: '30px',
          padding: '0 12px',
          borderRadius: '8px',
          border: `1px solid ${danger ? 'color-mix(in srgb, #e5484d 45%, transparent)' : 'var(--dsw-alias-border-l2, #3a3a3a)'}`,
          background: danger ? 'color-mix(in srgb, #e5484d 10%, transparent)' : 'var(--dsw-alias-bg-layer-1, #1b1b1b)',
          color: danger ? '#e5484d' : 'var(--dsw-alias-label-secondary, #9a9a9a)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        })

        const mutedStyle = {
          margin: 0,
          fontSize: '12px',
          lineHeight: 1.55,
          color: 'var(--dsw-alias-label-tertiary, #7a7a7a)',
        }

        /**
         * The page's icon: its own trash can, in the product's line style.
         *
         * The default gear belonged to the settings seat's generic fallback and said nothing about this page.
         * Drawn here rather than borrowed for one reason: `settings.section.icon` asks for a component, not for
         * an icon *key* — the keyed table belongs to the context menu.
         */
        function PanelIcon() {
          return h('svg', {
            viewBox: '0 0 24 24',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block' },
          }, [
            h('path', { key: 'lid', d: 'M4 7h16' }),
            h('path', { key: 'neck', d: 'M9.5 7V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3V7' }),
            h('path', { key: 'body', d: 'M6.5 7l.9 12.3A1.6 1.6 0 0 0 9 20.8h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7' }),
            h('path', { key: 'slot-a', d: 'M10.2 11v6' }),
            h('path', { key: 'slot-b', d: 'M13.8 11v6' }),
          ])
        }

        /**
         * The panel's seat: one settings page, by the shape the product documents (`slots.inject` then
         * `slots.register`), plus the icon addressed by the same id.
         *
         * `ctx.inject(['slots'], …)` rather than a declared `inject`: the menu row, the key and the dictionary
         * must keep working in a profile without a slot service, and a hard dependency would take all three
         * down with the panel.
         */
        const registerPanel = (scope) => {
          try {
            scope.effect(() => scope.slots.inject(PANEL_SLOT, () => scope.slots.register({
              name: PANEL_SLOT,
              id: PANEL_ID,
              order: 500,
              label: () => labels().title,
            }, TrashPanel)))
            state.panel = 'contributed'
          } catch (error) {
            // Isolated like every contribution: a refused page costs the page, and the reason is reported.
            state.panel = `refused: ${reasonOf(error)}`
            console.error('dsh-cleaner: the trash panel was refused', error)
          }
          try {
            scope.effect(() => scope.slots.inject(ICON_SLOT, () => scope.slots.register({
              name: ICON_SLOT,
              // The id is what pairs an icon with its page: same page, same id.
              id: PANEL_ID,
              order: 500,
            }, PanelIcon)))
            state.panel_icon = 'contributed'
          } catch (error) {
            state.panel_icon = `refused: ${reasonOf(error)}`
            console.error('dsh-cleaner: the trash page icon was refused', error)
          }
          try {
            // One frame-level seat for the notice: a click always says what it did, even when what it did was
            // nothing.
            scope.effect(() => scope.slots.inject(NOTICE_SLOT, () => scope.slots.register({
              name: NOTICE_SLOT,
              id: NOTICE_ID,
              order: 900,
            }, Notice)))
            state.notice = 'contributed'
          } catch (error) {
            state.notice = `refused: ${reasonOf(error)}`
            console.error('dsh-cleaner: the notice was refused', error)
          }
        }

        return ctx.effect(() => {
          let unregisterMenu
          let unregisterDictionary
          try {
            // First, before anything that can throw: the host should hear from this half in every outcome.
            report()
            try {
              unregisterMenu = registerMenu()
              rowRegistered = unregisterMenu !== undefined
            } catch (error) {
              state.row = `refused: ${reasonOf(error)}`
              console.error('dsh-cleaner: the session menu row was refused', error)
            }
            try {
              unregisterDictionary = registerDictionary()
            } catch (error) {
              state.dictionary = `refused: ${reasonOf(error)}`
              console.error('dsh-cleaner: the dictionary was refused', error)
            }
            // The key waits for its service; the fallback is for a Context without that Core API.
            if (typeof ctx.inject === 'function') ctx.inject(['shortcuts'], registerShortcut)
            else if (ctx.get('shortcuts') !== undefined) registerShortcut({ shortcuts: ctx.get('shortcuts'), effect: ctx.effect })
            else console.warn('dsh-cleaner: no shortcut service yet, so Ctrl+Shift+D is not bound')
            // The panel waits for the slot service, for the same reason and with the same fallback.
            if (typeof ctx.inject === 'function') ctx.inject(['slots'], registerPanel)
            else if (ctx.get('slots') !== undefined) registerPanel({ slots: ctx.get('slots'), effect: ctx.effect })
            else console.warn('dsh-cleaner: no slot service yet, so the trash page is not contributed')
            // Report again now that every synchronous contribution has had its turn: the first report is sent
            // before anything can throw, and it cannot know yet what the row and the key did.
            report()
            // And once more later, for a service that mounted in the meantime.
            setTimeout(report, 2000)
          } catch (error) {
            state.fatal = reasonOf(error)
            console.error('dsh-cleaner: the window half failed while setting up', error)
            report()
          }
          return () => {
            for (const unregister of [unregisterMenu, unregisterDictionary]) {
              try {
                unregister?.()
              } catch {
                // A disposer that throws must not stop the rest of the cleanup.
              }
            }
          }
        })
      },
    }
  },
})

