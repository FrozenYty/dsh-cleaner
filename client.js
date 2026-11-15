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
    const SHORTCUT_ID = 'session.delete-log'
    const LOCALE_NS = 'dsh-cleaner'
    const LABEL_KEY = 'session.delete'
    /** The host half's route prefix, and the only channel this half has. */
    const ROUTE = '/dsh-cleaner/'

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
          route: 'not called',
          current: 'not read',
          lastClick: 'none',
          fatal: undefined,
        }
        /** Whether the menu row was contributed — reported, because a missing row is the thing people see. */
        let rowRegistered = false

        /**
         * The row's label in the window's language, through the product's own dictionary service.
         *
         * `ctx.locale.register(ns, { en, zh })` contributes the strings and `ctx.locale.bind(ns)` reads them
         * back with the product's fallback chain. A locale service that cannot answer costs the language,
         * never the item.
         */
        const label = () => {
          try {
            const locale = ctx.get('locale')
            if (typeof locale?.bind === 'function') {
              const text = locale.bind(LOCALE_NS)(LABEL_KEY)
              if (typeof text === 'string' && text.length > 0 && text !== LABEL_KEY) return text
            }
          } catch {
            // A locale service that cannot answer costs the language, never the item.
          }
          return 'Delete session'
        }

        /** Contribute this plugin's two strings to the product's dictionary, and nothing else. */
        const registerDictionary = () => {
          const locale = ctx.get('locale')
          if (locale === undefined || typeof locale.register !== 'function') return undefined
          return locale.register(LOCALE_NS, {
            en: { [LABEL_KEY]: 'Delete session' },
            zh: { [LABEL_KEY]: '删除会话' },
          })
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
         * Run the deletion for one session: the same operation the tool and the command run, over the route.
         *
         * The target is named exactly once — in the body — and the caller is the session in front of the person,
         * so the running session stays protected and the answer lands where they are looking.
         */
        const runClean = (sessionId) => {
          const caller = currentSessionId()
          if (caller === undefined) {
            state.lastClick = 'no session is open to name as the caller'
            // Reported even though the click did nothing: the report needs no caller, and this is the only way
            // the next listing can say why the click was a no-op.
            report()
            return
          }
          state.lastClick = `asked for ${sessionId}`
          void post('delete', { caller, ids: [sessionId] }).then((answer) => {
            if (answer.error !== undefined) {
              state.lastClick = `refused: ${answer.error}`
            } else {
              const moved = Array.isArray(answer.removed) ? answer.removed.length : 0
              const refused = Array.isArray(answer.refused) ? answer.refused : []
              state.lastClick = moved > 0
                ? `deleted (recoverable under ${answer.trash?.root ?? 'the trash'})`
                : `nothing moved${refused.length > 0 ? `: ${refused[0]?.reason ?? 'refused'}` : ''}`
            }
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
         * Presentation, in the product's own vocabulary: `order: 350` seats it directly after 分叉会话 (fork
         * 300) and before the id copy (450); `danger` and the icon key are the pair the workspace plugin uses
         * for its own delete row, so this row reads exactly like *删除工作区*.
         */
        const registerMenu = () => {
          const menus = ctx.get('contextMenus')
          if (menus === undefined || typeof menus.register !== 'function') return undefined
          return menus.register({
            id: 'dsh-cleaner.delete-log',
            target: 'session',
            order: 350,
            resolve: (target) => {
              const sessionId = target?.sessionId
              if (typeof sessionId !== 'string' || sessionId.length === 0) return []
              return [{
                id: 'dsh-cleaner.delete-log',
                label: label(),
                icon: { key: 'workspace.delete' },
                danger: true,
                ...shortcutHint(),
                run: () => runClean(sessionId),
              }]
            },
          })
        }

        /**
         * Ctrl+Shift+D (⌘⇧D on macOS): the keyboard path to the same act, on the session the window shows.
         *
         * Registered with the product's own platform table, so the binding appears in the shortcut settings and
         * is remappable there. The registration **waits for the service** (`ctx.inject`) instead of reading
         * `ctx.get('shortcuts')` once while this half loads: a client service that mounts after this plugin is
         * simply not there yet, and that silence is how a keycap went missing while the row worked.
         */
        const registerShortcut = (scope) => {
          const binding = { code: 'KeyD', modifiers: ['primary', 'shift'] }
          try {
            state.service = typeof scope.shortcuts?.register === 'function' ? 'present' : 'unusable'
            scope.effect(() => scope.shortcuts.register({
              id: SHORTCUT_ID,
              label,
              aliases: ['delete session'],
              defaults: {
                'desktop:macos': binding,
                'desktop:windows': binding,
                'desktop:linux': binding,
                'web:macos': binding,
                'web:windows': binding,
                'web:linux': binding,
              },
              resolve: () => {
                const sessionId = currentSessionId()
                if (sessionId === undefined) return { status: 'blocked', reason: 'no session is open' }
                return { status: 'handled', run: () => runClean(sessionId) }
              },
            }))
            state.register = 'registered'
          } catch (error) {
            // Isolated like every contribution: a registry that refuses this definition costs the key only.
            state.register = `refused: ${reasonOf(error)}`
            console.error('dsh-cleaner: the shortcut was refused', error)
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
          state.dictionary = keepRefusal(state.dictionary, ctx.get('locale')?.register === undefined ? 'no locale service' : 'locale service present')
          state.row = keepRefusal(state.row, rowRegistered ? 'contributed' : 'not contributed')
          state.current = currentSessionId() ?? 'none'
          void post('state', { state })
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

