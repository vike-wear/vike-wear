/**
 * What a chat page has already been handed, and what a catch-up read must add
 * (delivery ledger P52, 2026-10-20).
 *
 * messaging.onMessage rides the database change stream, which replays nothing:
 * a message sent while this page's connection was down (phone locked, network
 * switch, a Realtime incident) never reached onMessage, and the open
 * conversation stayed without it until the person left and came back. Most
 * apps also show the sender's own message only when its echo comes back on
 * that stream. messaging.js now hands send()'s message to onMessage when its
 * echo has not come back in ECHO_WAIT_MS and, when the page comes back, reads
 * once what it missed; this module is the bookkeeping both need. Pure: no
 * imports, so the node tests load it as it is.
 */

/** A page asks for what it missed at most this often (= useLive's recovery gap). */
export const CATCH_UP_MIN_GAP_MS = 5000

/** How long send()'s own message waits for its echo before onMessage gets it anyway. */
export const ECHO_WAIT_MS = 1500
// A conversation's first join that came this long after onMessage (cells M2b: it
// waited for where to connect, or for a token its cell trusts) counts as a gap: its
// first SUBSCRIBED catches up what was sent while it waited.
export const LATE_JOIN_MS = 2000

const SEEN_MAX = 500

/** Message ids, oldest dropped past `max`. */
export function createSeen(max = SEEN_MAX) {
  const ids = new Set()
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (typeof id !== 'string' || !id || ids.has(id)) return
      ids.add(id)
      if (ids.size > max) ids.delete(ids.values().next().value)
    },
    size: () => ids.size,
  }
}

function ms(at) {
  if (typeof at !== 'string' || !at) return NaN
  return Date.parse(at)
}

/** The later of two createdAt values; one that cannot be read loses. */
export function later(a, b) {
  const x = ms(a)
  const y = ms(b)
  if (Number.isNaN(x)) return Number.isNaN(y) ? null : b
  if (Number.isNaN(y)) return a
  return y > x ? b : a
}

// A move back installs an app's whole history in a database this page may still be listening to,
// and the change stream reads every row as new (review R, 2026-11-04). A message is written with
// the database's own clock, so nothing live is this far behind what the page has seen.
export const OLD_NEWS_MS = 10 * 60_000

/** A live event older than the page's newest message by this much is history coming round again. Both times are the server's, never this device's. */
export function isOldNews(at, newest, gap = OLD_NEWS_MS) {
  const x = ms(at)
  const y = ms(newest)
  return !Number.isNaN(x) && !Number.isNaN(y) && y - x > gap
}

/**
 * The messages a catch-up read returned → the ones to hand to onMessage, in
 * time order: newer than `since` ('' = the conversation was empty, every
 * message counts), and not handed over or fetched by the app on this page
 * already. A message whose time cannot be read is left out.
 */
export function pickMissed(messages, { since, seen }) {
  if (!Array.isArray(messages)) return []
  const floor = since === '' ? -Infinity : ms(since)
  if (Number.isNaN(floor)) return []
  const out = []
  for (const m of messages) {
    if (!m || typeof m.id !== 'string' || seen.some((s) => s.has(m.id))) continue
    const t = ms(m.createdAt)
    if (Number.isNaN(t) || t <= floor) continue
    out.push({ m, t })
  }
  out.sort((a, b) => a.t - b.t)
  return out.map((x) => x.m)
}
