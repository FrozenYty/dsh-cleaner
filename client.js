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
          return active.toLowerCase().startsWith('zh') ? '删除日志' : 'Delete log'
        }

        /**
         * The same operation as the tool and the command, from the sidebar: one row in a session's own menu.
         *
         * A data contribution, not a component — `resolve` returns the item and `run` is the click, so this
         * half needs no renderer and no stylesheet. It calls the command rather than a host method of its
         * own so that everything a person can do to a log goes through one implementation
         * (docs/adr/0011-one-operation-two-callers.md).
         */
        const registerMenu = () => {
          const menus = ctx.get('contextMenus')
          if (menus === undefined || typeof menus.register !== 'function') return undefined
          return menus.register({
            id: 'dsh-cleaner.delete-log',
            target: 'session',
            // After the shipped actions (pin 100, rename 200, …) and before nothing: a destructive item
            // belongs where a hand reaches last.
            order: 500,
            resolve: (target) => {
              const sessionId = target?.sessionId
              if (typeof sessionId !== 'string' || sessionId.length === 0) return []
              return [{
                id: 'dsh-cleaner.delete-log',
                label: label(),
                run: () => {
                  // The command answers in the transcript; this item has nothing to show, and a rejected
                  // promise here would be an unhandled rejection with no reader.
                  void Promise.resolve(ctx.remote.commands.execute(sessionId, `/clean ${sessionId}`, [])).catch(() => {})
                },
              }]
            },
          })
        }

        return ctx.effect(() => {
          void prune()
          // A deletion made while this window was in the background is covered when it comes back.
          const onFocus = () => void prune()
          window.addEventListener('focus', onFocus)
          const unregisterMenu = registerMenu()
          return () => {
            window.removeEventListener('focus', onFocus)
            unregisterMenu?.()
          }
        })
      },
    }
  },
})
