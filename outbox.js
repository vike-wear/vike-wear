/**
 * Offline write outbox — queue new records while the network is down, sync
 * automatically (and idempotently) when it comes back.
 *
 * WHAT IT IS FOR: insert-heavy data entry on weak networks (field logs, sales,
 * inspections, orders). A queued entry survives reloads, shows up immediately
 * in useOffline/useOfflineShared lists flagged `_pending: true`, and is written
 * to the real database when a connection exists.
 *
 * WHAT IT DOES NOT DO (be honest with users — never promise past this):
 *   - It does NOT make the app "work offline": the first visit, reads that
 *     aren't cached, photos/files, AI and payments all still need a connection.
 *   - It queues NEW records only — no updates, deletes or counters.
 *   - Data still lives in the cloud database once synced; "data never leaves
 *     the device" is never true for db.* data.
 *   - Other people/devices see a queued entry only AFTER it syncs.
 *
 * @example
 *   import { outbox } from '../lib/outbox'
 *   // like db.insertShared without the id (the outbox picks it), and survives being offline:
 *   await outbox.insertShared('deliveries', { customer, qty, date }, { groupId, visibleTo: 'group' })
 *   // sync state for a badge (or use the useOutboxStatus hook):
 *   const { pending, failed, syncing } = outbox.status()
 *   outbox.flush()          // manual "Sync now" button
 *   outbox.failed()         // rejected entries (server said no) — show each one's `say`, let the user retry/discard
 *   outbox.retryFailed(); outbox.discardFailed(id)
 *
 * A full outbox (500 entries / ~1MB) REJECTS new entries with err.code
 * 'outbox_full' — catch it and tell the user to reconnect; queued entries are
 * never dropped to make room.
 */

import { db } from './db'
import { getAppUserId } from './user'
import { createOutbox } from './_outbox-core'

// localStorage can throw (private mode / disabled). Fall back to an in-memory
// shim: the queue then only lives for the session, but the API keeps working.
function pickStorage() {
  try {
    const probe = '__whacka_outbox_probe'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    const mem = new Map()
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)) },
      removeItem: (k) => { mem.delete(k) },
    }
  }
}

const hasWindow = typeof window !== 'undefined'

export const outbox = createOutbox({
  writes: {
    upsert: (c, d, id, o) => db.upsert(c, d, id, o),
    upsertShared: (c, d, id, o) => db.upsertShared(c, d, id, o),
    insertMany: (c, rows, o) => db.insertMany(c, rows, o),
    insertManyShared: (c, rows, o) => db.insertManyShared(c, rows, o),
  },
  getUserId: getAppUserId,
  storage: hasWindow ? pickStorage() : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  isOnline: () => (hasWindow && typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true),
  requestPersist: () => {
    // Best-effort: asks the browser not to evict this origin's storage under
    // pressure (queued entries are the one thing we can't afford to lose).
    try {
      if (hasWindow && navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {})
      }
    } catch { /* best-effort */ }
  },
})

// ── ambient sync triggers (browser only) ────────────────────────────────────
if (hasWindow) {
  let timer = null
  const ensureTimer = () => {
    if (timer) return
    timer = setInterval(() => {
      if (outbox.status().pending > 0) void outbox.flush()
      else { clearInterval(timer); timer = null }
    }, 30_000)
  }

  outbox.subscribe((s) => { if (s.pending > 0) ensureTimer() })

  window.addEventListener('online', () => { void outbox.flush() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && outbox.status().pending > 0) void outbox.flush()
  })
  // Another tab changed the queue — refresh subscribers (idempotent replay
  // makes a concurrent flush harmless; this is just UI freshness).
  window.addEventListener('storage', (e) => {
    if (e.key === '__whacka_outbox_v1') outbox.refresh()
  })
  // Boot: give auth/token hydration a moment, then sync anything left over.
  setTimeout(() => {
    if (outbox.status().pending > 0) void outbox.flush()
  }, 3_000)
  if (outbox.status().pending > 0) ensureTimer()
}
