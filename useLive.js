import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { db } from './db'
import { LIST_DEFAULT_LIMIT } from './_list-limit'
import { onRealtimeResync } from './_realtime-share'
import { onIdentityChange, identityEpoch } from './_identity-change'
import { dropCachedReads } from './_live-refresh'
import { earliestLinkExpiry, LINK_RENEW_MARGIN_MS } from './_private-files'
import { includeOf, linkedCollections, linkedIds, linkedChangeMatters } from './_include'

// ─────────────────────────────────────────────
// Live data hooks — a self-updating list you just render.
// ─────────────────────────────────────────────
//
// useLiveShared('tasks') / useLive('notes') fetch once, then stay current via
// real-time subscriptions. They NEVER poll on a timer.
//
// Design note — why a coalesced refetch instead of patching local state per
// event: shared data is filtered by SERVER-SIDE visibility (public / group /
// role / user), which the client can't reliably re-evaluate. So when the
// collection changes we re-run the server query to always show exactly what this
// user is allowed to see. The refetch is debounced (a burst collapses into one)
// with a max-wait (a continuous stream still refreshes ~every MAX_WAIT_MS instead
// of starving). No changes means zero requests; there is never a setInterval.
// This keeps real-time apps correct AND well under the data API's quota — the
// thing hand-rolled "subscribe + setInterval + reselect" gets wrong.
//
// Recovery (L2 pass, 2026-09-27): a realtime channel that dropped replays
// nothing when it comes back, a phone that was locked or offline missed every
// event in between — before this the list stayed frozen on whatever it showed
// last, until something else happened to re-read it. Now the hook re-runs its
// query ONCE (through the same coalesced schedule) when the shared channel
// re-subscribes after a drop (`resync` from _realtime-share.js), when the page
// becomes visible again, and when the browser reports it is back online — at
// most once per RECOVERY_MIN_GAP_MS per hook, so a flapping connection cannot
// turn into a refetch storm. Still no timer; the app is never notified.
//
// Identity (delivery ledger P11, 2026-10-18): a sign-in, sign-out or Teams login
// without a reload changes whose rows the server returns, but the hook only
// re-read on a live event — the list went on showing the previous person's rows
// (a shop tablet after a shift change), and a private list kept listening for
// the previous person's rows, so the new person's saves never appeared. Now a
// change of identity empties the list at once, then reads and subscribes again
// as the new person (_identity-change.js).
//
// Quick changes (delivery ledger P38, 2026-10-20): a notice that came within
// 1.5 s of the list's previous read was answered from db.js's read cache with
// the list from before the change — that change stayed off the screen until
// the next one (someone else's second order 0.6 s after the first never
// showed). Now the re-read a notice or a recovery asks for drops the
// collection's cached reads that started by the newest notice
// (_live-refresh.js) and waits until MIN_READ_GAP_MS after the previous read:
// never an old list, and no more reads than the cache allowed before — two
// lists of the same query still share one read (10-21: dropping every cached
// read made each of them read on its own).
//
// Private files (2026-10-21): a list whose rows hold private-file links (they
// work for about a day, _private-files.js) reads again once shortly before the
// first of them stops working — one timer per link window, not polling.
//
// Linked rows (2026-11-04, _include.js): a list read with `include` brings the
// rows its rows point to (an order's customer). It listens to those collections
// too, and a change to a row it shows — or one it points to that was not there
// yet, a delete, a bulk notice — re-reads the list through the same schedule, so
// a brought row is never shown out of date. A change to another row of them
// reads nothing.

const DEBOUNCE_MS = 300   // collapse a burst of events into one refetch
const MAX_WAIT_MS = 2000  // ...but during a continuous stream, refresh at least this often
                         //    (so an always-active collab session never starves)
const MIN_READ_GAP_MS = 1500 // a list re-reads at most this often (= the read cache's life, _read-resilience.js)
const RECOVERY_MIN_GAP_MS = 5000 // recovery refetches (resync / visible / online) at most this often

function useIdentityEpoch() {
  return useSyncExternalStore(onIdentityChange, identityEpoch, identityEpoch)
}

function createLiveHook(selectFn, subscribeFn, shared) {
  return function useLiveData(collection, opts = {}) {
    // No limit = the whole list, up to the 1000-row single-read cap (_list-limit.js);
    // a limit is for "the newest N" only.
    const { filters, limit = LIST_DEFAULT_LIMIT, order } = opts
    const include = includeOf(opts)
    // Stable dependency: callers usually pass an inline `filters` object literal;
    // compare by value so we don't tear down + re-subscribe on every render.
    const filtersKey = JSON.stringify(filters || {})
    const includeKey = include ? JSON.stringify(include) : ''

    const [data, setData] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    // Latest query params, read by the (stable) fetch so `refetch` always uses
    // current values without re-creating callbacks.
    const paramsRef = useRef({})
    paramsRef.current = { collection, filters, limit, order, include }

    const runRef = useRef(() => {})
    const refetch = useCallback(() => runRef.current(), [])

    const epoch = useIdentityEpoch()
    const shownEpochRef = useRef(epoch)

    useEffect(() => {
      let alive = true
      // Another person now: what the list shows is the previous one's.
      if (shownEpochRef.current !== epoch) {
        shownEpochRef.current = epoch
        setData([])
        setError(null)
      }
      setLoading(true)

      let lastRunAt = 0
      let lastNoticeAt = 0 // the newest change notice or recovery; a re-read drops what was read by then
      let shownLinks = new Map() // linked collection → the ids the shown rows point to
      let renewTimer = null
      const renewLinks = (rows) => {
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null }
        const exp = earliestLinkExpiry(rows)
        if (exp == null) return
        renewTimer = setTimeout(() => { renewTimer = null; if (alive) run(true) }, Math.max(60_000, exp - Date.now() - LINK_RENEW_MARGIN_MS))
      }
      const run = async (fresh) => {
        lastRunAt = Date.now()
        const p = paramsRef.current
        if (fresh) dropCachedReads(p.collection, lastNoticeAt)
        try {
          const rows = await selectFn(p.collection, p.filters || {}, p.include ? { limit: p.limit, order: p.order, include: p.include } : { limit: p.limit, order: p.order })
          if (alive) {
            setData(Array.isArray(rows) ? rows : []); setError(null); renewLinks(rows)
            if (p.include) shownLinks = linkedIds(rows, p.include)
          }
        } catch (e) {
          if (alive) setError(e)
        } finally {
          if (alive) setLoading(false)
        }
      }
      runRef.current = run

      run() // initial load

      // Live updates → one coalesced refetch. Never a setInterval: this only
      // fires when the data actually changed. Quiet for DEBOUNCE_MS → refetch;
      // but never wait past MAX_WAIT_MS since the first un-served change, so a
      // continuously-active session still refreshes instead of starving; and
      // never sooner than MIN_READ_GAP_MS after the previous read.
      let timer = null
      let firstPendingAt = 0
      const schedule = () => {
        if (!alive) return
        const now = Date.now()
        lastNoticeAt = now
        if (!firstPendingAt) firstPendingAt = now
        if (timer) clearTimeout(timer)
        const fireAt = Math.max(Math.min(now + DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS), lastRunAt + MIN_READ_GAP_MS)
        timer = setTimeout(() => { firstPendingAt = 0; timer = null; run(true) }, Math.max(0, fireAt - now))
      }
      const sub = subscribeFn(collection, schedule)
      // The collections the list's include brings rows from: a change to one it shows re-reads it.
      const linkedSubs = linkedCollections(include, collection, shared).map((l) =>
        (l.shared ? db.subscribeShared(l.collection, onLinked(l.collection)) : db.subscribe(l.collection, onLinked(l.collection))))
      function onLinked(linkedCollection) {
        return (ev) => { if (linkedChangeMatters(ev, shownLinks.get(linkedCollection))) schedule() }
      }

      // Recovery refetch (see the header): rides the same coalesced schedule so a
      // resync landing next to a burst of real events is still ONE request.
      let lastRecoveryAt = 0
      const recover = () => {
        if (!alive) return
        const now = Date.now()
        if (now - lastRecoveryAt < RECOVERY_MIN_GAP_MS) return
        lastRecoveryAt = now
        schedule()
      }
      const offResync = onRealtimeResync(recover)
      const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined'
      const onVisible = () => { if (document.visibilityState === 'visible') recover() }
      const onOnline = () => recover()
      if (hasDom) {
        try {
          document.addEventListener('visibilitychange', onVisible)
          window.addEventListener('online', onOnline)
        } catch { /* a runtime without these events simply has no recovery triggers */ }
      }

      return () => {
        alive = false
        if (timer) clearTimeout(timer)
        if (renewTimer) clearTimeout(renewTimer)
        try { offResync() } catch (e) { /* ignore */ }
        if (hasDom) {
          try {
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('online', onOnline)
          } catch (e) { /* ignore */ }
        }
        try { if (sub && sub.unsubscribe) sub.unsubscribe() } catch (e) { /* ignore */ }
        for (const s of linkedSubs) { try { if (s && s.unsubscribe) s.unsubscribe() } catch (e) { /* ignore */ } }
      }
    }, [collection, filtersKey, includeKey, limit, order, epoch])

    return { data, loading, error, refetch }
  }
}

/**
 * Live list of SHARED (cross-user) data. Mirrors db.selectShared (options filters, limit, order, include).
 * @example
 *   const { data: tasks, loading } = useLiveShared('tasks', { order: '-createdAt' })
 * @example
 *   const { data: orders } = useLiveShared('orders', { include: { customer: { from: 'customers', by: 'customerId' } } })
 *   // orders[i].customer — and a change to that customer re-reads the list
 */
export const useLiveShared = createLiveHook(
  (c, f, o) => db.selectShared(c, f, o),
  (c, cb) => db.subscribeShared(c, cb),
  true,
)

/**
 * Live list of USER-scoped (private) data. Mirrors db.select.
 * @example
 *   const { data: notes } = useLive('notes')
 */
export const useLive = createLiveHook(
  (c, f, o) => db.select(c, f, o),
  (c, cb) => db.subscribe(c, cb),
  false,
)
