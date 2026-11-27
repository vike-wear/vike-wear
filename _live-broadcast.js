/**
 * Broadcast transport for live data — private Realtime topics, joined once per
 * page, fanned out to every db.subscribe / useLive listener.
 *
 * How it works
 *   1. The first subscriber asks the server which topics THIS identity may
 *      listen to (data route action `liveChannels`: shared, my user topic, my
 *      groups / admin groups / roles, owner) and joins each as a PRIVATE
 *      channel. Realtime evaluates the policy at join with the page's token
 *      (the same guest / session token the database stream used).
 *   2. Every message (event 'app_data') is turned into the listener payloads
 *      the existing per-subscription filter consumes (_live-transport.js), so
 *      callbacks see exactly the shapes they always did.
 *   3. When the SHARED topic cannot be joined (CHANNEL_ERROR / TIMED_OUT before
 *      it ever subscribed) or the topic list cannot be fetched, the page keeps
 *      what it has and tries again (S2, 2026-10-31): a timeout is retried by the
 *      realtime library itself, a refusal or a missing list by us after
 *      LIVE_RETRY_DELAYS_MS (each attempt is a database check at Realtime). It
 *      says so once (`wait`); when the topic joins later the page re-reads
 *      (resync). It never moves to the database change stream — that move turned
 *      a Realtime outage into database load. A bundle stamped `broadcast-pg`
 *      keeps the old move (`pgFallback`), the rollback.
 *   4. A private topic whose join fails is left at once — the library would
 *      otherwise retry it every 10 seconds for as long as the page is open — and
 *      asked for again after LIVE_RETRY_DELAYS_MS, with a fresh list (review R,
 *      2026-11-04: it used to be left for the whole page). The server had just
 *      listed it, and the answer can change: a token that came late, a device id
 *      started over, a membership. Only the policy's own answer counts as refused
 *      (`policyRefusal`, said once per kind, `refused`; `healed` when a retry
 *      joins it). Any other answer, known or not, is no verdict on this person
 *      (`joinFailed`, said with its first word). A topic refused for good costs
 *      one list and one refused join every 5 minutes.
 *   5. A topic that fails later, after it had joined, is an outage like any
 *      other: the library rejoins it, it is counted for the shared topic (the
 *      X-Whacka-RT drop report keeps its meaning "live data was down"), and the
 *      page re-reads on the way back. Unless Realtime answers that join with a
 *      verdict that stays (the policy, or a token it cannot verify): the library
 *      would ask every 10 s for good and the page would never learn why (a page
 *      left on a cell the app moved from), so it goes the way of 3 and 4.
 *   6. A topic Realtime closes (phx_close) never comes back by itself: it is
 *      asked for again, each page at a moment of its own (_realtime-share.js
 *      retryLadder), said once per kind (`closed`), and the page re-reads.
 *   7. An identity change (sign-in / sign-out / team login) re-asks for the
 *      topic list: topics no longer allowed are left, new ones joined. The
 *      shared topic is never left.
 *
 * No timer runs while every topic is joined; a page with no subscriber joins nothing.
 *
 * Cells (M2b, 2026-11-02): the topics answer also names WHERE the app's Realtime is
 * (_realtime-home.js). With `getClient(answer)` the client is built from the first
 * answer, so a page of an app in another cell connects there. `canJoin(client)` may hold
 * the joins back (a cell page whose token does not fit yet: wait `notoken`). A join
 * refused for the TOKEN itself (a key id this Realtime does not hold, a bad
 * signature, an expired token) used to be retried with the same token for as long
 * as it lived (up to 30 days): `onTokenRefused(reason)` now gets one fresh token
 * and the page joins again; when nothing changes it waits as `tok-<kid|sig|exp>`.
 */

import { liveEventsToPayloads, isSharedTopic, diffTopics, createSeenIds, LIVE_EVENT_NAME } from './_live-transport.js'
import { emitResync, noteChannelStatus, retryLadder, CLOSED_SPREAD_MS, RETRY_DELAYS_MS } from './_realtime-share.js'
import { REALTIME_MOVED_EVENT } from './_realtime-home.js'

/** How long to wait before asking again after a join that failed or a missing list. */
export const LIVE_RETRY_DELAYS_MS = RETRY_DELAYS_MS

/** The kind of a private topic (<project>:<kind>…): shared | owner | u | g | ga | gr. */
export function topicKind(topic) {
  const kind = String(topic || '').split(':')[1]
  return /^[a-z]{1,8}$/.test(kind || '') ? kind : 'unknown'
}

const answerText = (err) => String((err && (err.message || err.reason)) || err || '')

/** A join refused for its token (not for the policy): 'kid' | 'sig' | 'exp', else null. */
export function tokenRefusal(err) {
  const m = answerText(err)
  if (/JwtSignerError|key ID \(kid\)/i.test(m)) return 'kid'
  if (/JwtSignatureError|signature/i.test(m)) return 'sig'
  if (/InvalidJWTToken|Token has expired/i.test(m)) return 'exp'
  return null
}

/**
 * The policy said no. Measured on fra1 (docs/claude-md/cell-realtime.md): "Unauthorized:
 * You do not have permissions to read from this Channel topic: …". Everything else a
 * join can answer is not that: the socket's own words ("socket closed: 1006", "channel
 * error: …"), Realtime's trouble (UnableToSetPolicies, ChannelRateLimitReached,
 * InitializingProjectConnection …) or something nobody has met yet, so an answer this
 * does not know is never taken for a refusal.
 */
export function policyRefusal(err) {
  return /^\s*Unauthorized\b|permissions to read from this Channel/i.test(answerText(err))
}

/** The first word of an answer, for the report: UnableToSetPolicies, socket, channel … */
export function answerWord(err) {
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(answerText(err))
  return m ? m[1] : 'unknown'
}

export function createLiveBroadcast({ client, getClient, fetchTopics, canJoin, onTokenRefused, logPrefix = '[db]', pgFallback = false, setTimer, clearTimer, random }) {
  let cl = client || null
  let tokenRecovering = false
  const listeners = new Set()
  const channels = new Map() // topic → { ch, everSubscribed, down }
  const fallbackFns = new Set()
  const liveFns = new Set()
  const waitFns = new Set()
  const refusedFns = new Set()
  const healedFns = new Set()
  const joinFailedFns = new Set()
  const closedFns = new Set()
  const movedFns = new Set()
  let state = 'idle' // idle | joining | waiting | live | failed (failed: broadcast-pg bundles only)
  let topics = []
  let joinSeq = 0
  const ladder = retryLadder(() => { void rejoin() }, { setTimer, clearTimer, random })
  let waited = false
  // What was said, once each per identity.
  const said = { refused: new Set(), healed: new Set(), joinFailed: new Set(), closed: new Set() }
  const refusedTopics = new Set() // refused and not joined since
  const missed = new Set() // private topics that failed or closed: what changed meanwhile never arrived
  const seen = createSeenIds()

  const fanout = (message) => {
    let payloads
    try { payloads = liveEventsToPayloads(message && message.payload, seen) } catch { payloads = [] }
    for (const p of payloads) {
      for (const fn of [...listeners]) {
        try { fn(p) } catch (e) { console.error(`${logPrefix} listener error:`, e) }
      }
    }
  }

  function say(once, value, fns) {
    if (once.has(value)) return
    once.add(value)
    for (const fn of [...fns]) { try { fn(value) } catch { /* ignore */ } }
  }

  // broadcast-pg bundles only: the old move to the database stream.
  function fail(reason) {
    if (state === 'failed') return
    state = 'failed'
    ladder.cancel()
    leaveAll()
    for (const fn of [...fallbackFns]) {
      try { fn(reason) } catch { /* never throw into the transport */ }
    }
  }

  function scheduleRetry(spreadMs) {
    if (state !== 'failed') ladder.schedule(spreadMs)
  }

  // The shared topic is not joined: keep what the page has and try again.
  function wait(reason, retry, spreadMs) {
    if (pgFallback) { fail(reason); return }
    if (state !== 'waiting') {
      state = 'waiting'
      waited = true
      noteChannelStatus(false)
      for (const fn of [...waitFns]) { try { fn(reason) } catch { /* ignore */ } }
    }
    if (retry) scheduleRetry(spreadMs)
  }

  function leaveTopic(topic) {
    const entry = channels.get(topic)
    if (!entry) return
    channels.delete(topic)
    try { Promise.resolve(cl.removeChannel(entry.ch)).catch(() => {}) } catch { /* ignore */ }
  }

  // The token itself was refused: one fresh token, then every topic again; or wait.
  async function recoverToken(kind) {
    if (tokenRecovering || state === 'failed') return
    tokenRecovering = true
    let replaced = false
    try { replaced = onTokenRefused ? await onTokenRefused(kind) : false } catch { replaced = false }
    tokenRecovering = false
    if (replaced) {
      ladder.reset()
      await rejoin()
      return
    }
    if (state === 'live') scheduleRetry()
    else wait(`tok-${kind}`, true)
  }

  function leaveAll() {
    for (const topic of [...channels.keys()]) leaveTopic(topic)
  }

  function joinTopic(topic) {
    if (channels.has(topic)) return
    const entry = { ch: null, everSubscribed: false, down: false }
    channels.set(topic, entry)
    try {
      const ch = cl.channel(topic, { config: { private: true } })
      ch.on('broadcast', { event: LIVE_EVENT_NAME }, fanout)
      // The app moved to another cell (cells M2b): every page joins the shared topic, so it hears it there.
      if (isSharedTopic(topic)) ch.on('broadcast', { event: REALTIME_MOVED_EVENT }, () => { for (const fn of [...movedFns]) { try { fn() } catch { /* ignore */ } } })
      entry.ch = ch
      ch.subscribe((status, err) => {
        if (channels.get(topic) !== entry) return // left meanwhile
        const shared = isSharedTopic(topic)
        if (status === 'SUBSCRIBED') {
          const cameBack = entry.down || missed.delete(topic)
          entry.everSubscribed = true
          entry.down = false
          if (refusedTopics.delete(topic)) say(said.healed, topicKind(topic), healedFns)
          if (shared) {
            noteChannelStatus(true)
            if (state !== 'live') {
              const hadWaited = waited
              state = 'live'
              waited = false
              for (const fn of [...liveFns]) { try { fn() } catch { /* ignore */ } }
              // Joined after the page had waited: what changed meanwhile never arrived.
              if (hadWaited) emitResync()
            }
          }
          if (cameBack) emitResync()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          const tokenKind = status === 'CHANNEL_ERROR' ? tokenRefusal(err) : null
          const refused = status === 'CHANNEL_ERROR' && !tokenKind && policyRefusal(err)
          if (entry.everSubscribed && !refused && tokenKind !== 'kid' && tokenKind !== 'sig') {
            // An outage: the library rejoins it. An expired token is one too: the
            // heartbeat brings the next, and that rejoin carries it.
            entry.down = true
            if (shared) noteChannelStatus(false)
            return
          }
          // Refused for the token, not the policy: the same token would be refused for
          // as long as it lives. One fresh token, then every topic again (or wait).
          if (tokenKind) {
            console.warn(`${logPrefix} live topic ${topic} refused the token (${tokenKind})`, err || '')
            leaveTopic(topic)
            if (!shared) missed.add(topic)
            else if (entry.everSubscribed) {
              state = 'joining'
              waited = true
              noteChannelStatus(false)
            }
            void recoverToken(tokenKind)
            return
          }
          if (shared) {
            console.warn(`${logPrefix} live broadcast could not join ${topic} (${status})`, err || '')
            if (status === 'CHANNEL_ERROR') {
              // Refused or errored: the library would ask every 10 s for good; we wait longer.
              leaveTopic(topic)
              wait(status, true)
            } else {
              // A timeout: the library asks again by itself.
              wait(status, false)
            }
            return
          }
          if (status === 'CHANNEL_ERROR') {
            // Left either way: the library would ask again every 10 s while the page is open.
            // Asked for again either way: the server just listed this topic for this identity.
            console.warn(`${logPrefix} live topic ${refused ? 'refused' : 'failed to join'} ${topic} (${status})`, err || '')
            leaveTopic(topic)
            missed.add(topic)
            if (refused) {
              refusedTopics.add(topic)
              say(said.refused, topicKind(topic), refusedFns)
            } else {
              say(said.joinFailed, answerWord(err), joinFailedFns)
            }
            scheduleRetry()
          } else {
            // A timeout: the library asks again by itself; what changed meanwhile never arrived.
            entry.down = true
          }
        } else if (status === 'CLOSED') {
          // A topic we leave is off the list before we leave it (above), so this is Realtime closing it.
          console.warn(`${logPrefix} live topic ${topic} closed by Realtime; asking for it again`)
          channels.delete(topic)
          say(said.closed, topicKind(topic), closedFns)
          if (shared) wait('CLOSED', true, CLOSED_SPREAD_MS)
          else {
            missed.add(topic)
            scheduleRetry(CLOSED_SPREAD_MS)
          }
        }
      })
    } catch (e) {
      channels.delete(topic)
      if (isSharedTopic(topic)) { console.warn(`${logPrefix} live broadcast setup failed on ${topic}:`, e); wait('setup', true) }
      else {
        missed.add(topic)
        scheduleRetry()
      }
    }
  }

  // Ask for the list and join what is not joined: the first join, a retry, an identity change.
  async function rejoin() {
    if (state === 'failed') return
    const seq = ++joinSeq
    let answer
    try { answer = await fetchTopics() } catch (e) {
      if (seq !== joinSeq) return
      console.warn(`${logPrefix} live topics unavailable:`, e && e.message ? e.message : e)
      if (state === 'live') scheduleRetry()
      else wait('topics', true)
      return
    }
    if (seq !== joinSeq || state === 'failed') return
    // fetchTopics answers the topic list, or the whole liveChannels answer (cells M2b).
    const list = Array.isArray(answer) ? answer : (answer && Array.isArray(answer.topics) ? answer.topics : null)
    if (!Array.isArray(list) || !list.some(isSharedTopic)) {
      if (state === 'live') scheduleRetry()
      else wait('no-shared-topic', true)
      return
    }
    // The client comes from the answer: it names the app's cell's Realtime. One that names
    // another Realtime means the app moved (cells M4): everything joined is on a Realtime
    // that will hear nothing again, so the page leaves it and joins the new one.
    if (getClient) {
      let next = null
      try { next = await getClient(answer) } catch { next = null }
      if (seq !== joinSeq || state === 'failed') return
      if (!next && !cl) { wait('client', true); return }
      if (next && cl && next !== cl) {
        leaveAll()
        topics = []
        waited = true
        state = 'waiting'
        noteChannelStatus(false)
      }
      if (next) cl = next
    }
    // What this identity may no longer hear goes first, whether or not it can join
    // anything yet (a sign-out on a cell page while no token can be had).
    const { leave } = diffTopics(topics, list)
    for (const t of leave) leaveTopic(t)
    topics = list
    // A cell page joins only with a token that cell trusts (never the public key).
    if (canJoin) {
      let why = null
      try { why = await canJoin(cl) } catch { why = 'notoken' }
      if (seq !== joinSeq || state === 'failed') return
      if (why) {
        if (state === 'live') scheduleRetry()
        else wait(why, true)
        return
      }
    }
    // joinTopic skips what is joined; a topic left after a failure is asked for again.
    for (const t of list) joinTopic(t)
  }

  async function join() {
    if (state !== 'idle') return
    state = 'joining'
    await rejoin()
  }

  async function refresh() {
    // Identity changed. On the database stream (failed) there is nothing to do:
    // setAuth already re-sent the token on that channel.
    if (state === 'failed' || state === 'idle') return
    ladder.reset()
    for (const once of Object.values(said)) once.clear()
    refusedTopics.clear()
    missed.clear()
    await rejoin()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (state === 'idle') void join()
      return () => listeners.delete(listener)
    },
    onFallback(fn) { fallbackFns.add(fn); return () => fallbackFns.delete(fn) },
    onLive(fn) { liveFns.add(fn); return () => liveFns.delete(fn) },
    onWait(fn) { waitFns.add(fn); return () => waitFns.delete(fn) },
    onRefused(fn) { refusedFns.add(fn); return () => refusedFns.delete(fn) },
    onHealed(fn) { healedFns.add(fn); return () => healedFns.delete(fn) },
    onJoinFailed(fn) { joinFailedFns.add(fn); return () => joinFailedFns.delete(fn) },
    onClosed(fn) { closedFns.add(fn); return () => closedFns.delete(fn) },
    onMoved(fn) { movedFns.add(fn); return () => movedFns.delete(fn) },
    refresh,
    state: () => state,
    topics: () => [...topics],
    /** Test-only introspection. */
    _entries: () => new Map(channels),
  }
}
