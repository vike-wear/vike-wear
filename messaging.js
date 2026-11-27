/**
 * Messaging helper — direct messages and group chat for generated apps.
 * Supports real-time message delivery via Supabase Realtime.
 * Requires Auth — user must be signed in to use messaging.
 */

import { createClient } from '@supabase/supabase-js'
import { getAppUserId } from './user'
import { getHeaders } from './_headers'
import { getSupabaseToken, getRealtimeTokenFor, replaceRefusedToken } from './_supabase-token'
import { realtimeClientOptions, registerRealtimeClient, holdFittingToken } from './_realtime-options'
import { appRealtimeHome } from './_realtime-ask'
import { chatTopic, notePageMoved, privateChannels, REALTIME_MOVED_EVENT } from './_realtime-home'
import { tokenRefusal } from './_live-broadcast'
import { retryLadder, CLOSED_SPREAD_MS } from './_realtime-share'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { unsubscribeHandle } from './_unsubscribe'
import { createSeen, isOldNews, later, pickMissed, CATCH_UP_MIN_GAP_MS, ECHO_WAIT_MS, LATE_JOIN_MS } from './_messaging-catchup'
import { hasUnsignedPrivateFile, inOrderWithFileLinks } from './_private-files'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

let _clientPromise = null
let _home = null // where this page's chat connects (cells M2b): its app's cell names it

function getClient() {
  if (_clientPromise) return _clientPromise
  _clientPromise = (async () => {
    // The app's cell says where its Realtime is (_realtime-home.js); a server that
    // names none leaves the bundle's own, as before cells.
    const home = await appRealtimeHome()
    if (!home.url || !home.publishableKey) return null
    _home = home
    // Same background-survivable keep-alive as db.js (_realtime-options.js), and
    // re-authenticated on every sign-in / sign-out / team login like it.
    const client = createClient(home.url, home.publishableKey, realtimeClientOptions(home))
    registerRealtimeClient(client, home)
    const token = home.kid ? await getRealtimeTokenFor(home) : await getSupabaseToken()
    if (token) {
      try { await client.realtime.setAuth(token) }
      catch (e) { console.warn('[messaging] setAuth failed:', e) }
    }
    return client
  })()
  return _clientPromise
}

function fromRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    content: row.content,
    type: row.type,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

// ── What this page knows of each conversation (delivery ledger P52, 2026-10-20) ──
// The newest message the page has seen — from the app's own getMessages /
// getChannels, a send, a live event — and the ids the app fetched itself. A
// catch-up read hands onMessage only what is newer than the page's newest at
// the moment it went away, and never an id the app already has.
const _known = new Map() // channelId → { loaded, newest, fetched }

function knownOf(channelId) {
  let k = _known.get(channelId)
  if (!k) { k = { loaded: false, newest: null, fetched: createSeen() }; _known.set(channelId, k) }
  return k
}

/** `loaded`: the list is the conversation's latest page (or the whole of it). */
function noteKnown(channelId, messages, { loaded = false, fetched = false } = {}) {
  if (typeof channelId !== 'string' || !channelId) return
  const k = knownOf(channelId)
  if (loaded) k.loaded = true
  for (const m of messages || []) {
    if (!m) continue
    k.newest = later(k.newest, m.createdAt)
    if (fetched) k.fetched.add(m.id)
  }
}

// Local copy ON PURPOSE — do not rewire onto _realtime-share.js. These are
// per-conversation channels on app_messages (narrow server-side filter), so
// they must keep reference-counted teardown; the shared core retains its one
// app_data channel for the page lifetime instead. Deferred cleanup keeps
// StrictMode double-mounts from tripping Supabase's "cannot add callbacks
// after subscribe()" error. Known pre-existing limit: a re-join racing the
// async removeChannel can strand ONE conversation's live updates until reload.
const _sharedChannels = new Map() // name → entry

// Each message reaches a conversation's listeners once: the live event, send()'s
// own message and a catch-up read can all carry the same id. Listeners get the
// formatted message (the same shape as getMessages), each its own copy as before.
function deliver(entry, msg) {
  if (!msg || typeof msg.id !== 'string' || entry.shown.has(msg.id)) return
  entry.shown.add(msg.id)
  noteKnown(entry.channelId, [msg])
  for (const fn of [...entry.listeners]) {
    try { fn({ ...msg }) } catch (e) { console.error('[messaging] listener error:', e) }
  }
}

function _joinSharedChannel(client, channelId, buildChannel, listener, { late = false } = {}) {
  const name = `messages:${channelId}`
  let entry = _sharedChannels.get(name)
  if (entry) {
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer)
      entry.cleanupTimer = null
    }
    entry.listeners.add(listener)
    if (entry.closed) entry.reopen.schedule(CLOSED_SPREAD_MS)
  } else {
    entry = { channelId, channel: null, listeners: new Set([listener]), cleanupTimer: null, shown: createSeen(), joined: false, gap: null, closed: false, reopen: null }
    _sharedChannels.set(name, entry)
    watchPageReturns()
    // A join that waited (cells M2b: for where to connect, or a token its cell trusts)
    // missed what was sent meanwhile: its first SUBSCRIBED catches up from the page's newest.
    if (late) openGap(entry)
    // A live message comes straight from the database: a private file in it
    // still has its stable address, so that one message is read again through
    // the server (catchUp), which hands back working links (_private-files.js).
    const live = inOrderWithFileLinks(
      (msg) => deliver(entry, msg),
      (msg) => hasUnsignedPrivateFile(msg && msg.metadata),
      async (msg) => {
        const at = Date.parse(msg.createdAt)
        if (Number.isNaN(at)) return null
        const data = await msgAction('catchUp', { channels: [{ id: msg.channelId, after: new Date(at - 1).toISOString() }] })
        return ((data && data.messages) || []).find((m) => m && m.id === msg.id) || null
      },
    )
    const open = () => { entry.channel = buildChannel((payload) => {
      if (!payload || !payload.new) return
      const msg = fromRow(payload.new)
      if (!isOldNews(msg.createdAt, knownOf(channelId).newest)) live(msg)
    }).subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[messaging] realtime channel ${status} on ${name}`, err || '')
        entry.joined = false
        openGap(entry)
        // Refused for the token itself (cells M2b): one fresh token, which the
        // channel's own rejoin then carries.
        if (status === 'CHANNEL_ERROR' && tokenRefusal(err)) {
          void replaceRefusedToken(_home).then((fresh) => {
            if (fresh) { try { Promise.resolve(client.realtime.setAuth(fresh)).catch(() => {}) } catch { /* the next rejoin asks again */ } }
          }).catch(() => {})
        }
      } else if (status === 'CLOSED') {
        entry.joined = false
        openGap(entry)
        // We leave a conversation only when nobody listens to it. Anything else is Realtime
        // closing it, and the library never comes back from that (review R, 2026-11-04).
        if (_sharedChannels.get(name) === entry && entry.listeners.size > 0) {
          console.warn(`[messaging] realtime channel closed by the server on ${name}; opening it again`)
          entry.closed = true
          entry.reopen.schedule(CLOSED_SPREAD_MS)
        }
      } else if (status === 'SUBSCRIBED') {
        entry.joined = true
        if (entry.gap) scheduleCatchUp()
      }
    }) }
    entry.reopen = retryLadder(async () => {
      if (_sharedChannels.get(name) !== entry || !entry.closed) return
      try {
        // As the first join: a cell's conversation only with a token that cell trusts.
        if (await holdFittingToken(client)) {
          if (_sharedChannels.get(name) !== entry || !entry.closed) return
          entry.closed = false
          open()
          return
        }
      } catch (e) {
        entry.closed = true
        console.warn(`[messaging] realtime channel could not be opened again on ${name}:`, e)
      }
      entry.reopen.schedule(CLOSED_SPREAD_MS)
    })
    open()
  }
  return () => {
    const cur = _sharedChannels.get(name)
    if (!cur) return
    cur.listeners.delete(listener)
    if (cur.listeners.size === 0 && !cur.cleanupTimer) {
      cur.cleanupTimer = setTimeout(() => {
        if (cur.listeners.size === 0) {
          cur.reopen.cancel()
          // A channel Realtime closed is gone already, and removing it would drop the topic from the client.
          if (!cur.closed) client.removeChannel(cur.channel)
          _sharedChannels.delete(name)
        }
      }, 0)
    }
  }
}

// ── Catching up (delivery ledger P52, 2026-10-20) ─────────────────────────────
// The change stream replays nothing: whatever was sent while this page's
// connection was down never reaches onMessage. A gap opens when a
// conversation's channel errors / times out / closes, when the page is hidden
// and when the browser goes offline; it remembers the newest message the page
// had then. When the channel is back, the page is visible again or the browser
// is online again, ONE read asks for every listened-to conversation with an
// open gap (messaging action `catchUp`) and onMessage gets what came in
// between, in time order. At most once per CATCH_UP_MIN_GAP_MS; no gap = no
// request. App code sees no new event — only messages it had not been handed.
function openGap(entry) {
  if (entry.gap) return
  const k = _known.get(entry.channelId)
  // An empty conversation the app has loaded: every message counts ('').
  entry.gap = { since: k && k.loaded ? (k.newest || '') : (k && k.newest) || null }
}

let _watching = false
function watchPageReturns() {
  if (_watching) return
  _watching = true
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const openAll = () => { for (const e of _sharedChannels.values()) openGap(e) }
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') openAll()
      else if (document.visibilityState === 'visible') scheduleCatchUp()
    })
    window.addEventListener('offline', openAll)
    window.addEventListener('online', () => scheduleCatchUp())
  } catch { /* a runtime without these events catches up on reconnects only */ }
}

let _lastCatchUpAt = 0
let _catchUpTimer = null
let _catchUpRunning = false
let _catchUpAgain = false

function scheduleCatchUp() {
  if (_catchUpTimer) return
  const wait = Math.max(0, _lastCatchUpAt + CATCH_UP_MIN_GAP_MS - Date.now())
  _catchUpTimer = setTimeout(() => { _catchUpTimer = null; void runCatchUp() }, wait)
}

async function runCatchUp() {
  if (_catchUpRunning) { _catchUpAgain = true; return }
  const ask = []
  for (const entry of _sharedChannels.values()) {
    if (!entry.gap || !entry.listeners.size) continue
    if (entry.gap.since === null) { entry.gap = null; continue } // nothing loaded before it went away: nothing to compare with
    ask.push(entry)
  }
  if (!ask.length) return
  _catchUpRunning = true
  _lastCatchUpAt = Date.now()
  try {
    const data = await msgAction('catchUp', { channels: ask.map((e) => ({ id: e.channelId, after: e.gap.since })) })
    const messages = data && Array.isArray(data.messages) ? data.messages : []
    for (const entry of ask) {
      const k = _known.get(entry.channelId)
      const mine = messages.filter((m) => m && m.channelId === entry.channelId)
      for (const m of pickMissed(mine, { since: entry.gap.since, seen: [entry.shown, k ? k.fetched : createSeen()] })) deliver(entry, m)
      // Back on the stream: the gap is closed. Still off it: what came after
      // this read is still missed — keep the gap open from here.
      if (entry.joined) entry.gap = null
      else { const kk = _known.get(entry.channelId); entry.gap = { since: (kk && kk.newest) || entry.gap.since } }
    }
  } catch {
    /* the gap stays open; the next return (reconnect / visible / online) asks again */
  } finally {
    _catchUpRunning = false
    if (_catchUpAgain) { _catchUpAgain = false; scheduleCatchUp() }
  }
}

// ─────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────

// Failures throw the SDK's standard Error (.message = the server's sentence,
// .status, .code — e.g. AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, RATE_LIMITED;
// TIMEOUT / NETWORK without a status when the server never answered).
async function msgAction(action, params = {}) {
  const userId = getAppUserId()
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/messaging`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ action, userId, ...params }),
  }, { route: 'messaging' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Messaging action failed', 'messaging')
  return res.json()
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const messaging = {
  /**
   * Create or get a direct message channel with another user.
   * If a DM channel already exists, returns the existing one.
   *
   * @param {string} userId - The other user's ID
   * @returns {Promise<{ id, type, name, createdAt }>}
   *
   * @example const channel = await messaging.createDM(otherUserId)
   */
  async createDM(userId) {
    const data = await msgAction('createDM', { targetId: userId })
    return data.channel
  },

  /**
   * Create a group chat channel.
   *
   * @param {object} options
   * @param {string} options.name - Group name
   * @param {string[]} [options.members] - User IDs to add (creator is auto-added)
   * @returns {Promise<{ id, type, name, createdAt }>}
   *
   * @example
   * const channel = await messaging.createGroup({
   *   name: 'Family Chat',
   *   members: [user1Id, user2Id]
   * })
   */
  async createGroup(options) {
    const data = await msgAction('createGroup', options)
    return data.channel
  },

  /**
   * Send a message to a channel.
   *
   * @param {string} channelId - Target channel ID
   * @param {object} message
   * @param {string} [message.text] - Text content
   * @param {string} [message.image] - Image URL
   * @param {string} [message.audio] - Audio URL
   * @param {string} [message.file] - File URL
   * @returns {Promise<{ id, channelId, senderId, content, type, createdAt }>}
   *
   * @example
   * await messaging.send(channelId, { text: 'Hello!' })
   * await messaging.send(channelId, { image: imageUrl })
   */
  async send(channelId, message) {
    let content = message.text || message.content || ''
    let type = 'text'
    let metadata = {}

    if (message.image) {
      type = 'image'
      metadata = { imageUrl: message.image }
      content = content || '[Image]'
    } else if (message.audio) {
      type = 'audio'
      metadata = { audioUrl: message.audio, duration: message.duration }
      content = content || '[Audio]'
    } else if (message.file) {
      type = 'file'
      metadata = { fileUrl: message.file, fileName: message.fileName }
      content = content || '[File]'
    }

    const data = await msgAction('send', { channelId, content, type, metadata })
    const sent = data && data.message
    if (sent) {
      noteKnown(channelId, [sent])
      // The sender's own message reaches this page's onMessage even when its
      // echo never comes back on the change stream (a dropped connection, a
      // Realtime incident): ECHO_WAIT_MS after the send, unless the echo came
      // first. Never sooner — an app that adds send()'s message itself has
      // done so by then, and its onMessage finds the id already there.
      const name = `messages:${channelId}`
      const entry = _sharedChannels.get(name)
      if (entry) setTimeout(() => { if (_sharedChannels.get(name) === entry) deliver(entry, sent) }, ECHO_WAIT_MS)
    }
    return data.message
  },

  /**
   * Get message history for a channel.
   *
   * @param {string} channelId
   * @param {object} [options]
   * @param {number} [options.limit=50] - Max number of messages
   * @param {string} [options.before] - Cursor for pagination (ISO date string)
   * @returns {Promise<Array<{ id, channelId, senderId, content, type, metadata, createdAt }>>}
   *
   * @example
   * const messages = await messaging.getMessages(channelId)
   * const older = await messaging.getMessages(channelId, { before: messages[0].createdAt })
   */
  async getMessages(channelId, options = {}) {
    const data = await msgAction('getMessages', { channelId, ...options })
    noteKnown(channelId, data.messages, { loaded: !options.before, fetched: true })
    return data.messages
  },

  /**
   * Get all channels (DMs and groups) the current user is part of.
   * Includes last message preview and other user info for DMs.
   *
   * @returns {Promise<Array<{ id, type, name, otherUser?, lastMessage?, createdAt }>>}
   *
   * @example
   * const channels = await messaging.getChannels()
   * channels.forEach(ch => {
   *   if (ch.type === 'direct') console.log('DM with', ch.otherUser.displayName)
   *   else console.log('Group:', ch.name)
   * })
   */
  async getChannels() {
    const data = await msgAction('getChannels')
    for (const ch of data.channels || []) {
      if (ch && ch.id) noteKnown(ch.id, ch.lastMessage ? [ch.lastMessage] : [], { loaded: true })
    }
    return data.channels
  },

  /**
   * Subscribe to real-time messages in a channel.
   * The callback fires for every new message sent by any member.
   *
   * @param {string} channelId
   * @param {function} callback - Called with message object
   * @returns {(() => void) & { unsubscribe: () => void }} — call it, or its .unsubscribe()
   *
   * @example
   * const sub = messaging.onMessage(channelId, (msg) => {
   *   console.log(`${msg.senderId}: ${msg.content}`)
   * })
   * // Later: sub.unsubscribe()
   */
  onMessage(channelId, callback) {
    let stopped = false
    let cleanup = null
    const askedAt = Date.now()

    const start = async (attempt) => {
      const client = await getClient()
      if (stopped || !client) return
      const home = _home
      // A cell page joins only with a token that cell trusts — never the public key,
      // which would read as nobody and silently get no message (cells M2b) — and the
      // client that joins holds it.
      if (!(await holdFittingToken(client))) {
        if (stopped) return
        console.warn(`[messaging] no realtime token this app's cell trusts yet — ${channelId} joins later`)
        setTimeout(() => { void start(attempt + 1) }, Math.min(300_000, 15_000 * 2 ** Math.min(attempt, 4)))
        return
      }
      if (stopped) return

      // The conversation's topic: messages:<id> where the cell takes public channels,
      // <app>:m:<id> (its members only) where it takes private ones only.
      const name = chatTopic(home, PROJECT_ID, channelId)
      const listener = (msg) => callback(msg)
      const unsubscribe = _joinSharedChannel(client, channelId, (fanout) =>
        client.channel(name, privateChannels(home) ? { config: { private: true } } : undefined).on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'app_messages', filter: `channel_id=eq.${channelId}` },
          fanout,
        ).on('broadcast', { event: REALTIME_MOVED_EVENT }, () => notePageMoved()),
      listener, { late: Date.now() - askedAt > LATE_JOIN_MS })

      if (stopped) unsubscribe()
      else cleanup = unsubscribe
    }
    void start(0)

    return unsubscribeHandle(() => {
      stopped = true
      if (cleanup) cleanup()
    })
  },
}
