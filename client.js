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
         * Whether the host actually has the command this row runs.
         *
         * A row that runs a command the host does not know is worse than no row at all: the click is
         * admitted as ordinary text, the session's own agent answers instead, and the person reads a
         * failure for a deletion that never happened. That is exactly what a window shows when the browser
         * half is newer than the loaded bundle — which is the normal state right after an update, because
         * this half reloads with the page and the host half only reloads with the process.
         *
         * Asked once per session and remembered; a list that cannot be read fails **open**, because a row
         * that works is better than a row that hides.
         */
        const knownCommands = new Map()
        const commandExists = async (sessionId) => {
          if (knownCommands.has(sessionId)) return knownCommands.get(sessionId)
          let known = true
          try {
            const answer = await ctx.remote.commands.list(sessionId)
            const items = Array.isArray(answer) ? answer : answer?.items
            known = (Array.isArray(items) ? items : []).some((entry) => entry?.name === 'clean')
          } catch {
            // No answer means no evidence against it: keep the row.
          }
          knownCommands.set(sessionId, known)
          return known
        }

        /**
         * Run the deletion for one session: the same command the tool and the composer run.
         * The command answers in the transcript, so a caller here has nothing to show and a rejected promise
         * would be an unhandled rejection with no reader.
         */
        const runClean = (sessionId) => {
          void Promise.resolve(ctx.remote.commands.execute(sessionId, `/clean ${sessionId}`, [])).catch(() => {})
        }

        /**
         * The same operation as the tool and the command, from the sidebar: one row in a session's own menu.
         *
         * A data contribution, not a component — `resolve` returns the item and `run` is the click, so this
         * half needs no renderer and no stylesheet. It calls the command rather than a host method of its
         * own so that everything a person can do to a log goes through one implementation
         * (docs/adr/0011-one-operation-two-callers.md).
         *
         * Presentation, in the product's own vocabulary:
         * - `order: 9000` sorts it after every other session action this build registers (pin 100, rename
         *   200, fork 300, copy-id 450, archive 600), so it is the last contribution in the menu.
         * - the icon key is the workspace plugin's own trash glyph from the shared `contextMenu.icon` slot —
         *   borrowing it is what makes the row look like its neighbours without this bundle resolving an
         *   `@deepseek-ai` package it cannot resolve.
         * - the row is **not** `danger`: the label and the trash glyph already say what it does, and a red
         *   row in a menu of neutral ones draws the eye towards the one action that cannot be undone. The
         *   product colours its own destructive row red; this plugin was asked not to.
         */
        const registerMenu = () => {
          const menus = ctx.get('contextMenus')
          if (menus === undefined || typeof menus.register !== 'function') return undefined
          return menus.register({
            id: 'dsh-cleaner.delete-log',
            target: 'session',
            order: 9000,
            resolve: async (target) => {
              const sessionId = target?.sessionId
              if (typeof sessionId !== 'string' || sessionId.length === 0) return []
              if (!await commandExists(sessionId)) return []
              return [{
                id: 'dsh-cleaner.delete-log',
                label: label(),
                icon: { key: 'workspace.delete' },
                run: () => runClean(sessionId),
              }]
            },
          })
        }

        return ctx.effect(() => {
          void prune()
          // A deletion made while this window was in the background is covered when it comes back.
          const onFocus = () => void prune()
          window.addEventListener('focus', onFocus)
          // Every contribution is optional and isolated: a service that refuses this plugin's definition
          // must cost the menu row, never the view pruning or another plugin's menu. The rule was learned
          // the hard way — a rejected registration took the whole menu down with it once.
          let unregisterMenu
          try {
            unregisterMenu = registerMenu()
          } catch (error) {
            console.error('dsh-cleaner: the session menu row was refused', error)
          }
          return () => {
            window.removeEventListener('focus', onFocus)
            try {
              unregisterMenu?.()
            } catch {
              // A disposer that throws must not stop the rest of the cleanup.
            }
          }
        })
      },
    }
  },
})
