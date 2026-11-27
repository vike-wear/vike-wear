/**
 * Live-update transport — the pure bits behind db.subscribe's broadcast path.
 *
 * A bundle carries VITE_WHACKA_LIVE = 'broadcast' | 'pg' (stamped at publish:
 * 'broadcast' unless the server runs APP_DATA_LIVE_TRANSPORT=pg, the rollback;
 * a bundle built before the stamp existed reads as 'pg'). 'pg' is the database change stream the SDK
 * has always used; 'broadcast' listens on private Realtime topics the server
 * posts to after every successful write (src/lib/data/app-data-live.ts).
 *
 * The wire, one message per topic, event 'app_data':
 *   { events: [{ t, c, id, o, v, g, cb, d }] }
 * `liveEventsToPayloads` turns that into the payload shape the existing
 * per-subscription listener (makeAppDataListener in _realtime-share.js) already
 * consumes, so a db.subscribe callback receives exactly what it always did:
 * { type: 'INSERT' | 'UPDATE' | 'DELETE', data: { id, ...fields } } — plus
 * type 'REFRESH' (data: { id: undefined }) when the server collapsed a bulk
 * write into "this collection changed, re-read it". The live hooks refetch on
 * any event and never look at the type.
 */

export const LIVE_EVENT_NAME = 'app_data'

/**
 * 'broadcast' | 'broadcast-pg' | 'pg' from the bundle's env (anything else is 'pg').
 * 'broadcast-pg' = broadcast that still moves to the database stream when its topics
 * cannot be joined (the rollback stamp, APP_DATA_LIVE_PG_FALLBACK=1); 'broadcast'
 * never does since S2 (2026-10-31) — see _live-broadcast.js.
 */
export function readLiveTransport(env) {
  const v = String((env && env.VITE_WHACKA_LIVE) || '').trim().toLowerCase()
  return v === 'broadcast' || v === 'broadcast-pg' ? v : 'pg'
}

/** The shared topic of a project — the one whose failure to join means "fall back". */
export function isSharedTopic(topic) {
  return typeof topic === 'string' && /:shared$/.test(topic)
}

function rowOf(e) {
  return {
    collection: e.c,
    doc_id: e.id,
    owner_id: e.o == null ? null : e.o,
    data: e.d && typeof e.d === 'object' ? e.d : {},
    deleted_at: null,
  }
}

/**
 * Seen message ids: a page that joined two topics an event went to (creator +
 * group member, owner + group) receives it twice; the server stamps one `mid`
 * per event, the same on every topic, so the second copy is dropped. Bounded
 * (oldest ids go once the map is full); ids live for a few seconds only.
 */
export function createSeenIds(max = 500) {
  const seen = new Map()
  return {
    has(id) { return seen.has(id) },
    add(id) {
      seen.set(id, Date.now())
      if (seen.size > max) {
        const cutoff = Date.now() - 10_000
        for (const [k, t] of seen) { if (t < cutoff || seen.size > max) seen.delete(k); else break }
      }
    },
    size() { return seen.size },
  }
}

/**
 * One broadcast payload → the listener payloads ({ eventType, new, old }) the
 * per-subscription filter consumes. Unknown or malformed events are skipped;
 * never throws (a bad message must not break the page). `seen` (createSeenIds)
 * drops an event whose `mid` already arrived on another topic.
 */
export function liveEventsToPayloads(payload, seen) {
  const events = payload && Array.isArray(payload.events) ? payload.events : []
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object' || typeof e.c !== 'string') continue
    if (seen && typeof e.mid === 'string') {
      if (seen.has(e.mid)) continue
      seen.add(e.mid)
    }
    const t = e.t
    if (t === 'DELETE') {
      if (typeof e.id !== 'string') continue
      out.push({ eventType: 'DELETE', new: {}, old: rowOf(e) })
    } else if (t === 'INSERT' || t === 'UPDATE') {
      if (typeof e.id !== 'string') continue
      const row = rowOf(e)
      out.push({ eventType: t, new: row, old: row })
    } else if (t === 'REFRESH') {
      const row = rowOf({ c: e.c, id: undefined, o: null, d: {} })
      out.push({ eventType: 'REFRESH', new: row, old: row })
    }
  }
  return out
}

/** Set difference helper for topic lists (pure). */
export function diffTopics(current, next) {
  const cur = new Set(current || [])
  const nxt = new Set(next || [])
  return {
    join: [...nxt].filter((t) => !cur.has(t)),
    leave: [...cur].filter((t) => !nxt.has(t) && !isSharedTopic(t)),
  }
}
