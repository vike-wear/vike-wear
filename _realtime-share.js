/**
 * Realtime channel sharing — the pure core behind db.subscribe / db.subscribeShared.
 *
 * ONE physical postgres_changes channel per project, shared by every
 * subscription regardless of collection. Server-side, our app_data
 * subscription can only filter on project_id — so EVERY channel carrying that
 * filter receives the ENTIRE project's change stream, and a channel per
 * collection re-downloads that same stream once per subscribed collection
 * (a busy multi-seat app measured 10-15 duplicated copies of every event on
 * each device). Collection and visibility filtering happen in each listener
 * anyway, so all listeners fan out from a single channel.
 *
 * The channel is RETAINED for the page lifetime once created — leave() only
 * detaches the listener, it never tears the channel down. Tearing down at
 * zero subscribers is a trap twice over with supabase-js: (1) removeChannel()
 * is an async leave, and client.channel(topic) REUSES a same-topic channel
 * that is still leaving, whose .subscribe() silently no-ops (state !==
 * 'closed') — a join landing in that window would poison the shared entry and
 * kill realtime app-wide until reload; (2) any route transition that passes
 * through a zero-subscriber moment would drop every event during the
 * re-join round trip. One idle channel is cheaper than either failure.
 */

/** Shared realtime topic for a project's app_data stream. */
export function appDataTopic(projectId) {
  return `${projectId}:app_data`
}

// ── Drop accounting (observation only — changes no behaviour) ───────────────
// A realtime channel that errors or times out leaves the page's live data
// frozen until something else happens to re-read it: there is no refetch on
// re-subscribe, on focus, or on network recovery. Whether that is a rare blip
// or the normal state of a phone is not knowable from the server — realtime is
// a managed service and a dropped channel writes nothing anywhere. So each
// drop is counted here and the running total rides ALONG the next ordinary
// data request as one header (see db.js `_rawApiCall`): no new endpoint, no
// extra request, no database write, nothing charged to the owner.
//
//   n     outages that STARTED in this window
//   down  seconds spent disconnected during this window (an outage still open
//         contributes the part of it that has elapsed so far)
//   max   longest outage that FINISHED in this window; 0 = none finished yet,
//         so a run of `n=0 down=300 max=0` lines is ONE long outage, not many
const _drops = { n: 0, downMs: 0, maxMs: 0, since: 0, openMs: 0 }
// A channel that never recovers would otherwise put the header on EVERY data
// call — one log line per request, for as long as it stays broken. Reports are
// spaced out instead; nothing is lost, it just lands in the next one.
const MIN_REPORT_GAP_MS = 5 * 60 * 1000
let _lastReportAt = 0

/** Move the time spent down so far into the counters (idempotent). */
function accrueDownTime(now) {
  if (!_drops.since) return
  const d = now - _drops.since
  _drops.since = now
  _drops.downMs += d
  _drops.openMs += d
}

/** Called on every channel status change. `up` = SUBSCRIBED. */
export function noteChannelStatus(up) {
  const now = Date.now()
  if (!up) {
    // Already down: consecutive CHANNEL_ERROR/TIMED_OUT is ONE outage.
    if (!_drops.since) { _drops.since = now; _drops.openMs = 0; _drops.n++ }
    return
  }
  accrueDownTime(now)
  // The outage ENDED here — only now is its full length known, and only a
  // finished outage may set `max` (an open one would re-report its length in
  // every window it spans and inflate the statistic).
  if (_drops.openMs > _drops.maxMs) _drops.maxMs = _drops.openMs
  _drops.since = 0
  _drops.openMs = 0
}

/**
 * Take the counters accumulated since the last report, or '' when there is
 * nothing to say (the overwhelmingly common case — one comparison on the
 * request path). Safe to call on every request.
 */
export function takeRealtimeDropStat() {
  const now = Date.now()
  accrueDownTime(now)
  if (!_drops.n && !_drops.downMs && !_drops.maxMs) return ''
  if (_lastReportAt && now - _lastReportAt < MIN_REPORT_GAP_MS) return ''
  _lastReportAt = now
  const out = `n=${Math.min(_drops.n, 9999)} down=${Math.round(_drops.downMs / 1000)} max=${Math.round(_drops.maxMs / 1000)}`
  _drops.n = 0
  _drops.downMs = 0
  _drops.maxMs = 0
  return out
}

// ── Resync (L2 pass, 2026-09-27) ────────────────────────────────────────────
// When the shared app_data channel comes back (SUBSCRIBED after a
// CHANNEL_ERROR / TIMED_OUT / CLOSED), every change that happened while it was
// down is gone for good — realtime replays nothing. The drop counters above
// only MEASURE that; this is the recovery: the share emits one `resync` per
// re-entry and the live hooks (useLive / useLiveShared) re-run their query
// once. App code sees no new event — db.subscribe's callback contract is
// unchanged; only the platform's own hooks listen here.
const _resyncListeners = new Set()

/** Called with no arguments each time a shared channel re-enters SUBSCRIBED after a drop. */
export function onRealtimeResync(fn) {
  if (typeof fn === 'function') _resyncListeners.add(fn)
  return () => _resyncListeners.delete(fn)
}

export function emitResync() {
  for (const fn of [..._resyncListeners]) {
    try { fn() } catch (e) { console.error('[db] resync listener error:', e) }
  }
}

// ── Asking again (S2, 2026-10-31; a channel Realtime closed, review R 2026-11-04) ──
// Each attempt is a database check at Realtime, so a retry waits longer each time, up
// to 5 minutes. It starts over only after RETRY_QUIET_MS without one: never because a
// join succeeded, or a Realtime that closes what it has just let in would be asked every
// 5 seconds for good.
//
// A channel Realtime closes (phx_close: a token it no longer takes, an operational
// disconnect, the project past its budget) never comes back by itself: realtime-js
// rejoins a channel after a dropped socket, not one the server closed. It is opened
// again, and CLOSED_SPREAD_MS gives each page a moment of its own, because that budget
// closes every channel of the project at once: every page of every app coming back in
// the same second would be the next trip.
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
export const RETRY_QUIET_MS = 10 * 60_000
export const CLOSED_SPREAD_MS = 30_000

export function retryLadder(run, { setTimer, clearTimer, random } = {}) {
  const later = setTimer || ((fn, ms) => setTimeout(fn, ms))
  const stop = clearTimer || ((h) => clearTimeout(h))
  let timer = null
  let steps = 0
  let lastAt = 0
  const cancel = () => { if (timer) { stop(timer); timer = null } }
  return {
    /** Run after the next delay, plus up to spreadMs. A timer already waiting stands. */
    schedule(spreadMs = 0) {
      if (timer) return
      const now = Date.now()
      if (now - lastAt >= RETRY_QUIET_MS) steps = 0
      lastAt = now
      const delay = RETRY_DELAYS_MS[Math.min(steps, RETRY_DELAYS_MS.length - 1)]
      steps += 1
      timer = later(() => { timer = null; run() }, spreadMs ? delay + Math.floor((random || Math.random)() * spreadMs) : delay)
    },
    cancel,
    /** Something changed (a new identity, a new token): the next attempt is the first. */
    reset() { cancel(); steps = 0 },
  }
}

/**
 * Returns a join(client, name, buildChannel, listener) function; join returns
 * the matching leave() cleanup. All listeners on the same topic share one
 * physical channel (built by the first joiner, then reused for the page
 * lifetime). A failed build (e.g. WebSocket unavailable) is recovered: the
 * half-built channel is dropped from the client so the next join can rebuild
 * fresh instead of reusing a zombie with duplicate bindings.
 *
 * options.countDrops (default true): feed the channel's outages into the
 *   X-Whacka-RT drop counters above — ON only for the app_data stream, so the
 *   statistic keeps meaning "live data was down", never "a payment poke was".
 * options.resync (default true): emit `resync` when the channel comes back.
 * options.onChannelError(err, client): a join errored (the module may replace a refused token).
 *
 * A channel Realtime closes is built again from the same buildChannel, under the same
 * listeners (retryLadder above).
 */
export function createChannelShare(logPrefix = '[db]', { countDrops = true, resync = true, onChannelError } = {}) {
  const channels = new Map()

  return function join(client, name, buildChannel, listener) {
    let entry = channels.get(name)
    if (entry) {
      entry.listeners.add(listener)
    } else {
      entry = { channel: null, listeners: new Set([listener]), down: false }
      channels.set(name, entry)
      // Snapshot the listener set per event: a listener that synchronously
      // unsubscribes a peer must not make that peer miss the in-flight event.
      const fanout = (payload) => {
        for (const fn of [...entry.listeners]) {
          try { fn(payload) } catch (e) { console.error(`${logPrefix} listener error:`, e) }
        }
      }
      let ch = null
      const open = () => {
        ch = buildChannel(fanout)
        entry.channel = ch.subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn(`${logPrefix} realtime channel ${status} on ${name}`, err || '')
            entry.down = true
            if (countDrops) noteChannelStatus(false)
            if (status === 'CHANNEL_ERROR' && onChannelError) { try { onChannelError(err, client) } catch { /* the next rejoin asks again */ } }
          } else if (status === 'CLOSED') {
            // Realtime closed it: this share never leaves a channel, and a socket
            // that went away reads CHANNEL_ERROR. Not an outage for the counters
            // (they keep their exact pre-L2 meaning), but events were missed, so
            // the recovery refetch still runs on the way back.
            entry.down = true
            console.warn(`${logPrefix} realtime channel closed by the server on ${name}; opening it again`)
            ladder.schedule(CLOSED_SPREAD_MS)
          } else if (status === 'SUBSCRIBED') {
            ladder.cancel()
            if (countDrops) noteChannelStatus(true)
            if (entry.down) {
              entry.down = false
              if (resync) emitResync()
            }
          }
        })
      }
      const ladder = retryLadder(() => {
        try { open() } catch (e) {
          console.warn(`${logPrefix} realtime channel could not be opened again on ${name}:`, e)
          ladder.schedule(CLOSED_SPREAD_MS)
        }
      })
      try {
        open()
      } catch (e) {
        // Un-register the half-built channel: client.channel(topic) reuses
        // same-topic instances, and a zombie would collect a second binding
        // (duplicate events) on the next attempt.
        channels.delete(name)
        if (ch) { try { Promise.resolve(client.removeChannel(ch)).catch(() => {}) } catch { /* ignore */ } }
        console.warn(`${logPrefix} realtime channel setup failed on ${name}:`, e)
      }
    }
    return () => {
      const cur = channels.get(name)
      if (cur) cur.listeners.delete(listener)
    }
  }
}

/**
 * Per-subscription filter + event mapping for the shared app_data stream.
 * sharedOnly: true  → db.subscribeShared semantics (shared rows only)
 * sharedOnly: false → db.subscribe semantics (own rows; rows without an
 *                     owner pass through, as they always have). userId may be
 *                     a function — read on every event, so the filter follows
 *                     a sign-in / sign-out made after the subscription (P11).
 *
 * DELETE events carry the row in payload.old (payload.new is an EMPTY object,
 * never null — `new ?? old` would route every DELETE to `{}` and drop it).
 * Known limit: with default pk-only REPLICA IDENTITY the old record has no
 * `collection` column, so such DELETEs still can't be routed — unchanged.
 */
export function makeAppDataListener(tableName, { userId = null, sharedOnly = false } = {}, callback) {
  return (payload) => {
    const row = payload.eventType === 'DELETE' ? payload.old : payload.new
    if (row?.collection !== tableName) return
    if (sharedOnly) {
      if (row.owner_id !== null) return
    } else {
      let uid = userId
      if (typeof uid === 'function') { try { uid = uid() } catch { uid = null } }
      if (uid && row.owner_id && row.owner_id !== uid) return
    }
    // Owner-side soft delete arrives as an UPDATE that sets deleted_at —
    // surface it as a DELETE so live lists drop the row.
    const type = payload.eventType === 'UPDATE' && payload.new?.deleted_at
      ? 'DELETE'
      : payload.eventType
    callback({
      type,
      data: { id: row.doc_id || row.id, ...(row.data || {}) },
    })
  }
}
