/**
 * The browser half: drop the sidebar rows of sessions whose logs are gone.
 *
 * A window keeps its own sidebar view — `dsh.workspace.view.v5`, a map of account to ordered Session ids —
 * in its own storage and re-reads it on every start. "The log is gone", "the project no longer names it"
 * and "the archive no longer hides it" are host-side facts; nothing rewrites that view for them, so a row
 * can outlive everything it stood for, and clicking it answers `session/not-found`.
 *
 * So this half does at every page load what the sidebar does when a person re-orders a bucket: it asks the
 * host which Sessions still exist and drops the ids the view kept that are not among them. It repairs one
 * stored copy and nothing else — it reads one list, edits one storage value, and never opens a session,
 * touches a log or writes a project record.
 *
 * Why the host cannot do this: the view is browser storage of a renderer the Host process does not own.
 * Why the plugin needs it at all: a deletion is complete for a person only when the row they can see is
 * gone, and the alternative is asking them to re-order the sidebar by hand.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cleaner',
  factory(require) {
    const VIEW_PREFIX = 'dsh.workspace.view.'
    const ACCOUNT_KEY = 'sessionOrderByAccount'
    const MARK_KEY = 'dsh-cleaner.client.v1'
    const SHORTCUT_ID = 'session.delete-log'

    /**
     * The ids a session-list answer names, whichever field its records carry.
     * @param answer - the `remote.session.list` result.
     * @returns the ids that still exist, as strings.
     */
    const idsOf = (answer) => {
      const items = Array.isArray(answer) ? answer : answer?.items
      const ids = (Array.isArray(items) ? items : []).map(
        (item) => String(item?.sessionId ?? item?.id ?? item?.header?.id ?? ''),
      )
      return new Set(ids.filter((id) => id.length > 0))
    }

    /**
     * Drop the ids every stored view kept that the host no longer lists.
     * @param storage - the window's localStorage face.
     * @param live - the ids that still exist.
     * @returns how many ids were dropped; 0 also means nothing was written.
     */
    const pruneView = (storage, live) => {
      let dropped = 0
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index)
        if (name === null || !name.startsWith(VIEW_PREFIX)) continue
        const raw = storage.getItem(name)
        if (raw === null) continue
        let view
        try {
          view = JSON.parse(raw)
        } catch {
          continue
        }
        const buckets = view?.[ACCOUNT_KEY]
        if (buckets === null || typeof buckets !== 'object') continue
        let changed = false
        for (const account of Object.keys(buckets)) {
          const ids = buckets[account]
          if (!Array.isArray(ids)) continue
          const kept = ids.filter((id) => live.has(id))
          if (kept.length === ids.length) continue
          dropped += ids.length - kept.length
          buckets[account] = kept
          changed = true
        }
        if (changed) storage.setItem(name, JSON.stringify(view))
      }
      return dropped
    }

    return {
      inject: ['remote.session', 'remote.commands'],
      /**
       * @param ctx - the browser plugin context.
       */
      apply(ctx) {
        /**
         * Ask the host and prune. An unanswerable or empty list prunes nothing: a view is evidence of what
         * a person arranged, and it is only ever repaired against a list that proves an id is gone.
         */
        const prune = async () => {
          let answer
          try {
            answer = await ctx.remote.session.list({})
          } catch {
            return
          }
          const live = idsOf(answer)
          if (live.size === 0) return
          let dropped = 0
          try {
            dropped = pruneView(window.localStorage, live)
          } catch {
            // A storage that refuses to be read or written is the window's problem, never the page's.
          }
          // One small record per pass, so "did the half load, and was there anything to repair" is a fact
          // this machine can read back from the outside rather than a promise.
          try {
            window.localStorage.setItem(MARK_KEY, JSON.stringify({ at: new Date().toISOString(), listed: live.size, dropped }))
          } catch {
            // The mark is a courtesy; losing it costs nothing.
          }
        }

        /** The menu label in the language the window is showing, without a dictionary to register. */
        const label = () => {
          let active = ''
          try {
            active = String(ctx.get('locale')?.getLocale?.().active ?? '')
          } catch {
            // A locale service that cannot answer costs the language, never the item.
          }
          return active.toLowerCase().startsWith('zh') ? '删除会话' : 'Delete session'
        }

        /**
         * Run the deletion for one session: the same command the tool and the composer run.
         *
         * No render-time ask, no guard, no cache: the row is plain data and this is its only call. That is
         * deliberate. Three earlier versions asked the host whether the command existed before offering the
         * row, and every one of them cost more than it bought — a call that does not settle hides the row on
         * exactly the host where it works, and a synchronous throw in a menu's `resolve` takes the whole
         * popup down (`操作失败，请重试`). A click whose worst case is "nothing happens" is the cheaper trade.
         *
         * Every failure mode here is silent by design: an unknown command answers `undefined`, a missing
         * namespace throws inside the `try`, and the person sees the row and nothing else.
         */
        const runClean = (sessionId) => {
          try {
            void Promise.resolve(ctx.remote.commands.execute(sessionId, `/clean ${sessionId}`, [])).catch(() => {})
          } catch {
            // A client without the command namespace has nothing to run, and nothing to report.
          }
        }

        /**
         * The same operation as the tool and the command, from the sidebar: one row in a session's own menu.
         *
         * A data contribution, not a component — `resolve` returns the item and `run` is the click, so this
         * half needs no renderer and no stylesheet. It calls the command rather than a host method of its
         * own so that everything a person can do to a log goes through one implementation
         * (docs/adr/0011-one-operation-two-callers.md).
         *
         * `resolve` is **synchronous and asks nothing**: the row is a constant plus the window's language,
         * and the only call this contribution makes happens when it is clicked. Every version that asked the
         * host something while the menu was opening found a way to take the menu down with it.
         *
         * Presentation, in the product's own vocabulary:
         * - `order: 350` seats it directly after 分叉会话 (fork 300) and before 复制 Session ID (450), which is
         *   where it was asked to go. It is a plain number: the menu sorts data contributions by it and
         *   renders the product's own component rows after them.
         * - `danger` and the icon key are the pair the workspace plugin uses for its own delete row, so this
         *   row reads exactly like *删除工作区* does: the product's destructive treatment, with the trash
         *   glyph it registers in the shared `contextMenu.icon` slot. Borrowing that key is deliberate —
         *   re-drawing the glyph here would be a guess at the neighbours' stroke, size and colour, and this
         *   bundle cannot resolve `@deepseek-ai/dsh-client-ui-primitives` to import the real one. If that
         *   plugin is ever absent the key resolves to nothing and the row loses its icon rather than failing.
         * - **`commandId`, but only when the catalogue really holds it**: that association is what prints the
         *   keys beside the label, and the overlay looks it up with `catalog.find((entry) => entry.id ===
         *   action.commandId)` — a plain `.find`, so an entry that is missing would silently cost the hint
         *   rather than fail. 0.2.4 broke every session menu with a static `commandId`, so this one is read
         *   from the live catalogue at the moment the menu resolves: present → the keys print, absent → no
         *   association at all, and never a dangling one.
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
         * `{ commandId }` when the shortcut catalogue holds this plugin's key, otherwise nothing.
         *
         * A synchronous read of the catalogue the overlay itself reads, guarded twice: a service, a store or a
         * malformed row must cost the hint and never the menu. This is the difference between 0.2.4 — a static
         * `commandId` that took every popup down — and a hint that can only appear when it can be rendered.
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
         * The session the window is looking at, read from the sidebar's own persisted selection.
         *
         * The workspace plugin keeps it in `dsh.sessions.current` as `{ sessionId, subagentAddress? }` (read
         * from that package's client half, not guessed), which is what lets a global key act on the
         * conversation the person is in. A shape this does not recognise means no session, and the shortcut
         * says so instead of guessing one.
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
         * Ctrl+Shift+D (⌘⇧D on macOS): the keyboard path to the same act, on the session the window shows.
         *
         * Registered with the product's own default table, so the binding appears in the shortcut settings
         * and is remappable there — a global key listener would have been invisible and unconfigurable.
         * Isolated like every contribution: a registry that refuses this definition costs the key, never the
         * row or the view pruning.
         */
        const registerShortcut = () => {
          const shortcuts = ctx.get('shortcuts')
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') return undefined
          const binding = { code: 'KeyD', modifiers: ['primary', 'shift'] }
          return shortcuts.register({
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
          })
        }

        return ctx.effect(() => {
          void prune()
          // A deletion made while this window was in the background is covered when it comes back.
          const onFocus = () => void prune()
          window.addEventListener('focus', onFocus)
          // Every contribution is optional and isolated: a service that refuses this plugin's definition
          // must cost that one thing, never the rest. The rule was learned the hard way — a contribution the
          // popup could not render took every session's menu down with it once.
          let unregisterMenu
          let unregisterShortcut
          try {
            unregisterMenu = registerMenu()
          } catch (error) {
            console.error('dsh-cleaner: the session menu row was refused', error)
          }
          try {
            unregisterShortcut = registerShortcut()
          } catch (error) {
            console.error('dsh-cleaner: the shortcut was refused', error)
          }
          return () => {
            window.removeEventListener('focus', onFocus)
            for (const unregister of [unregisterMenu, unregisterShortcut]) {
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
