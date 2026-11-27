/**
 * Offline-tolerant live data hooks — useLive / useLiveShared plus:
 *   1. the last successful read is persisted (bounded) per collection+filters,
 *      so a reload with no signal still shows the data that was on screen;
 *   2. queued outbox entries are merged into the list immediately, flagged
 *      `_pending: true` (style them dimmed / with a sync icon);
 *   3. `stale` tells the UI it is looking at cached data ("offline — showing
 *      last synced data" banner), `pendingCount` how many entries await sync.
 *
 * ONLINE BEHAVIOR IS IDENTICAL to useLive/useLiveShared (same realtime
 * subscription, no polling) — the cache is only ever READ when a live fetch
 * fails. Pair writes with outbox.insert / outbox.insertShared; a plain
 * db.insert while offline still fails.
 *
 * The read cache is kept PER IDENTITY (L2 pass, 2026-09-27): the key carries
 * the app-user id the rows were read as, so a later sign-in on the same device
 * never sees the previous person's cached list when its own fetch fails, and
 * auth.signOut() removes the departing identity's cache from the device.
 *
 * @example
 *   const { data, loading, stale, pendingCount } = useOfflineShared('deliveries', { order: '-createdAt' })
 *   // data rows created offline carry _pending: true until synced
 *
 * Honest limits (same as outbox.js): this does NOT make the app fully
 * offline — the first-ever visit, uncached collections, photos, AI calls all
 * need a connection.
 */

import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useLive, useLiveShared } from './useLive'
import { LIST_DEFAULT_LIMIT } from './_list-limit'
import { outbox } from './outbox'
import { onIdentityChange, identityEpoch } from './_identity-change'
import { trimForCache, mergePending } from './_outbox-core'
import { getAppUserId } from './user'
import { onIdentityCacheClear } from './_identity-cache'

const CACHE_KEY = '__whacka_offline_readcache_v1'
const MAX_SLOTS = 6            // LRU slots across all cached (collection, filters) pairs
const MAX_ROWS = LIST_DEFAULT_LIMIT // per slot — the live hooks' default; MAX_SLOT_BYTES below
                                   // binds first on most collections (localStorage is shared with the outbox)
const MAX_SLOT_BYTES = 200 * 1024

// The storage key for the CURRENT identity. Falls back to the unscoped key only
// when no identity can be read at all (a storage-denied device mints one in
// memory, so in practice there always is one).
function cacheKeyNow() {
  try {
    const uid = getAppUserId()
    return uid ? `${CACHE_KEY}:${uid}` : CACHE_KEY
  } catch {
    return CACHE_KEY
  }
}

function loadCacheMap(cacheKey) {
  try {
    const raw = window.localStorage.getItem(cacheKey)
    const map = raw ? JSON.parse(raw) : {}
    return map && typeof map === 'object' ? map : {}
  } catch {
    return {}
  }
}

function readCache(slotKey) {
  const slot = loadCacheMap(cacheKeyNow())[slotKey]
  return slot && Array.isArray(slot.rows) ? slot.rows : null
}

let legacyCleared = false
function writeCache(slotKey, rows) {
  // Best-effort cache (NOT user data — the outbox holds that): on any quota
  // trouble, evict oldest slots; if it still won't fit, give up silently.
  try {
    const cacheKey = cacheKeyNow()
    if (!legacyCleared && cacheKey !== CACHE_KEY) {
      // The pre-L2 unscoped blob is never read again — free the space once.
      legacyCleared = true
      try { window.localStorage.removeItem(CACHE_KEY) } catch { /* ignore */ }
    }
    const map = loadCacheMap(cacheKey)
    map[slotKey] = { ts: Date.now(), rows: trimForCache(rows, { maxRows: MAX_ROWS, maxBytes: MAX_SLOT_BYTES }) }
    for (;;) {
      const keys = Object.keys(map)
      if (keys.length <= MAX_SLOTS) break
      keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
      delete map[keys[0]]
    }
    for (;;) {
      try {
        window.localStorage.setItem(cacheKey, JSON.stringify(map))
        return
      } catch {
        const keys = Object.keys(map).filter((k) => k !== slotKey)
        if (!keys.length) return
        keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
        delete map[keys[0]]
      }
    }
  } catch { /* cache is optional */ }
}

// Sign-out: drop the departing identity's cache from the device.
onIdentityCacheClear((uid) => {
  try { window.localStorage.removeItem(`${CACHE_KEY}:${uid}`) } catch { /* ignore */ }
})

// Queued entries are per person (_outbox-core.js): after a sign-in / sign-out
// without a reload the pending rows and the sync badge are read again (P11).
function useIdentityEpoch() {
  return useSyncExternalStore(onIdentityChange, identityEpoch, identityEpoch)
}

function createOfflineHook(liveHook, shared) {
  return function useOfflineData(collection, opts = {}) {
    const live = liveHook(collection, opts)
    const filtersKey = JSON.stringify(opts.filters || {})
    const slotKey = `${shared ? 's' : 'p'}:${collection}:${filtersKey}`

    // Re-render on outbox changes; refetch once per completed sync so rows the
    // outbox just wrote come back through the normal server read.
    const [tick, setTick] = useState(0)
    const epoch = useIdentityEpoch()
    const lastSyncRef = useRef(0)
    const refetchRef = useRef(live.refetch)
    refetchRef.current = live.refetch
    useEffect(() => outbox.subscribe((s) => {
      setTick((t) => t + 1)
      if (s.lastSyncAt && s.lastSyncAt !== lastSyncRef.current) {
        lastSyncRef.current = s.lastSyncAt
        refetchRef.current()
      }
    }), [])

    // Persist every successful read (write-only while online; never read).
    const fresh = !live.loading && !live.error
    useEffect(() => {
      if (fresh) writeCache(slotKey, live.data)
    }, [fresh, live.data, slotKey])

    const stale = !!live.error
    const cached = useMemo(
      () => (stale ? readCache(slotKey) : null),
      [stale, slotKey, tick],
    )
    const base = stale && cached ? cached : live.data
    const pendingRows = useMemo(
      () => outbox.pending(collection, { shared }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [collection, shared, tick, epoch],
    )
    const data = useMemo(
      () => mergePending(base, pendingRows, opts.order),
      [base, pendingRows, opts.order],
    )

    return {
      data,
      loading: live.loading,
      // A served cache is a working (if stale) view — don't push apps into
      // their error branch; `stale` carries the signal instead.
      error: stale && cached ? null : live.error,
      refetch: live.refetch,
      stale,
      pendingCount: pendingRows.length,
    }
  }
}

/**
 * Offline-tolerant live list of SHARED (cross-user) data. Same signature as
 * useLiveShared; adds { stale, pendingCount } and merges _pending rows.
 */
export const useOfflineShared = createOfflineHook(useLiveShared, true)

/**
 * Offline-tolerant live list of USER-scoped (private) data. Same signature as
 * useLive; adds { stale, pendingCount } and merges _pending rows.
 */
export const useOffline = createOfflineHook(useLive, false)

/**
 * Live outbox sync state — for a "N unsynced / syncing / sync failed" badge.
 * @example const { pending, failed, syncing, needsAuth } = useOutboxStatus()
 */
export function useOutboxStatus() {
  const [s, setS] = useState(() => outbox.status())
  useEffect(() => outbox.subscribe(setS), [])
  useEffect(() => onIdentityChange(() => setS(outbox.status())), [])
  return s
}
