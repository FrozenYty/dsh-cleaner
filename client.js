/**
 * The browser half: one row in a session's menu, one keystroke, and a report about itself.
 *
 * What it does **not** do any more: repair the sidebar's stored view. That repair was built on
 * `ctx.remote.session.list`, and this build's client root has no `remote` service at all — the client
 * service directory lists `sessions`, `uiWorkspace`, `workspaces`, `layout`, `locale`, `slots`, `theme` and
 * `timer`, and nothing else — so every call through it threw and was swallowed. A deleted session's row is
 * hidden by the **archive write** the host half performs (the sidebar never draws an archived session), and
 * that is the official seam. Superseded decision: docs/adr/0013-reuse-the-client-sessions-service.md.
 *
 * Everything here therefore goes through a service that exists on the client root:
 *
 * - `contextMenus.register` for the row;
 * - `locale.register` / `locale.bind` for its label;
 * - `shortcuts.register` for Ctrl+Shift+D;
 * - `sessions.retain(id, { source })` → `binding.session.command(line)` for the click and the report — the
 *   same admission the composer runs, and the only client-side way to act on a session this window is not
 *   showing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cleaner',
  factory(require) {
    const SHORTCUT_ID = 'session.delete-log'
    const LOCALE_NS = 'dsh-cleaner'
    const LABEL_KEY = 'session.delete'

    /**
     * A one-line reason from anything that was thrown.
     *
     * `error instanceof Error` is false for an error built in another realm — the page's own — so the message
     * field is read directly when it is a string. Without this a report says "Error: …" and the reader has to
     * guess which half of the line is the reason.
     */
    const reasonOf = (error) => (typeof error?.message === 'string' ? error.message : String(error))

    return {
      /**
       * @param ctx - the browser plugin context. No declared dependencies: every service is optional and read
       * lazily, so a profile without one of them still gets the rest — that rule has already earned its keep.
       */
      apply(ctx) {
        /**
         * Everything this half knows about itself, sent to the host so that a listing can print it.
         *
         * It exists because a browser half that loads but contributes nothing looks exactly like one that
         * never loaded, and that confusion cost several releases: the row was missing and nothing said why.
         */
        const state = {
          inject: typeof ctx.inject === 'function',
          service: 'not seen',
          register: 'not attempted',
          catalog: 'not read',
          menu: 'not asked',
          dictionary: 'not asked',
          row: 'not contributed',
          transport: 'not attempted',
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
         * back with the product's fallback chain (any language we do not translate lands on `en`). A locale
         * service that cannot answer costs the language, never the item.
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
         * The workspace plugin keeps it in `dsh.sessions.current` as `{ sessionId, subagentAddress? }` (read
         * out of that package's client half, not guessed). This is also the session that carries the command:
         * a command needs an agent, and the session in front of the person always has one.
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
         * Act on a session the official way: retain it, use the binding it hands back, release it.
         *
         * `ctx.sessions.retain(id, { source })` returns a reference whose `ready` resolves to a
         * `SessionBinding`, and `binding.session.command(line)` is the admission the composer runs —
         * `ISession.command(line): { ok, value: { matched } }`. Retaining also starts an initial history open,
         * which is why a session nobody had open still gets a live binding: that is what makes the row work
         * for a closed session.
         */
        const withSession = async (sessionId, operation) => {
          const sessions = ctx.get('sessions')
          if (sessions === undefined || typeof sessions.retain !== 'function') {
            state.transport = 'no sessions service'
            return undefined
          }
          let reference
          try {
            reference = sessions.retain(sessionId, { source: 'gateway' })
            const binding = await reference.ready
            return await operation(binding)
          } catch (error) {
            state.transport = `failed: ${reasonOf(error)}`
            return undefined
          } finally {
            try {
              reference?.release()
            } catch {
              // A reference that cannot be released must not cost the result.
            }
          }
        }

        /**
         * Run the deletion for one session: the same command the tool and the composer run.
         *
         * The carrier is the session the window is showing, and the target is passed **as an argument**, so
         * the receipt appears where the person is looking and the running session stays the protected caller.
         */
        const runClean = (sessionId) => {
          const carrier = currentSessionId()
          if (carrier === undefined) {
            state.lastClick = 'no session is open to carry the command'
            return
          }
          state.lastClick = `asked ${carrier} to delete ${sessionId}`
          void withSession(carrier, async (binding) => {
            const result = await binding.session.command(`/clean ${sessionId}`)
            state.lastClick = result?.ok === false
              ? `refused: ${result.error?.message ?? 'unknown'}`
              : `sent, matched=${String(result?.value?.matched)}`
            // Say what the click did, on the channel the host already reads: a click whose outcome never
            // leaves the window is the failure mode this whole report exists for.
            report()
          })
        }

        /**
         * `{ commandId }` when the shortcut catalogue holds this plugin's key, otherwise nothing.
         *
         * The overlay prints keys with `catalog.find((entry) => entry.id === action.commandId)`, so a
         * *dangling* association is the one shape this bundle will not ship: 0.2.4 named a static one and
         * took every session menu down with it. Read synchronously, guarded twice.
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
         * `resolve` is **synchronous and asks nothing**: every version that asked the host something while
         * the menu was opening found a way to take the menu down with it.
         *
         * Presentation, in the product's own vocabulary: `order: 350` seats it directly after 分叉会话 (fork
         * 300) and before 复制 Session ID (450); `danger` and the icon key are the pair the workspace plugin
         * uses for its own delete row, so this row reads exactly like *删除工作区*.
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
         * Registered with the product's own platform table, so the binding appears in the shortcut settings
         * and is remappable there. The registration **waits for the service** (`ctx.inject`) instead of
         * reading `ctx.get('shortcuts')` once while this half loads: a client service that mounts after this
         * plugin is simply not there yet, and that silence is how a keycap went missing while the row worked.
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
            // Isolated like every contribution: a registry that refuses this definition costs the key only,
            // and the reason is kept — "refused" without a reason is the same silence one layer down.
            state.register = `refused: ${reasonOf(error)}`
            console.error('dsh-cleaner: the shortcut was refused', error)
          }
        }

        /**
         * Tell the host what this half managed to do, through the same official channel: a command carried by
         * the session the window shows, answered silently by the host, printed by the next listing.
         *
         * It is sent first, before anything that can throw, and again from the guard that catches a setup
         * failure — a diagnostic that dies with the thing it reports is not a diagnostic.
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
          state.dictionary = ctx.get('locale')?.register === undefined ? 'no locale service' : 'locale service present'
          state.row = rowRegistered ? 'contributed' : 'not contributed'
          state.current = currentSessionId() ?? 'none'
          const sessionId = currentSessionId()
          if (sessionId === undefined) return
          void withSession(sessionId, (binding) => binding.session.command(`/clean --state ${JSON.stringify(state)}`))
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
            // A second report, so a service that mounted late has had its turn before the answer is recorded.
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

