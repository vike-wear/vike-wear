/**
 * Realtime helper — presence (online users) for generated apps.
 * Built on Supabase Realtime channels.
 */

import { createClient } from '@supabase/supabase-js'
import { getAppUserId } from './user'
import { getSupabaseToken, getRealtimeTokenFor, replaceRefusedToken } from './_supabase-token'
import { tokenRefusal } from './_live-broadcast.js'
import { realtimeClientOptions, registerRealtimeClient } from './_realtime-options'
import { joinPresenceRoom } from './_presence-share.js'
import { appRealtimeHome } from './_realtime-ask'
import { presenceTopic, privateChannels } from './_realtime-home'

let _clientPromise = null
let _home = null // where this page's presence rooms are (cells M2b): its app's cell names it
const rooms = new Map()
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

function getClient() {
  if (_clientPromise) return _clientPromise
  _clientPromise = (async () => {
    // The app's cell says where its Realtime is (_realtime-home.js); a server that
    // names none leaves the bundle's own, as before cells.
    const home = await appRealtimeHome()
    if (!home.url || !home.publishableKey) {
      console.warn('[realtime] Supabase not configured')
      return null
    }
    _home = home
    // Same background-survivable keep-alive as db.js — a locked phone must not
    // read as "this person left" (see _realtime-options.js).
    const client = createClient(home.url, home.publishableKey, realtimeClientOptions(home))
    // Re-authenticated on every sign-in / sign-out / team login (auth.js →
    // reauthRealtimeClients), like the other realtime clients on the page.
    registerRealtimeClient(client, home)
    // A room is open to whoever may open the app (a private app: whoever passed its
    // gate), so the token rides along in the background; a cell's room takes one that
    // cell trusts.
    const token = home.kid ? getRealtimeTokenFor(home) : getSupabaseToken()
    Promise.resolve(token).then((t) => {
      if (t) client.realtime.setAuth(t).catch(() => {})
    }).catch(() => {})
    return client
  })()
  return _clientPromise
}

// realtime.presence() answers at once, as it always did; the room is joined once the
// page knows where its app's Realtime is (cells M2b). Listeners and info given before
// that are kept and handed to the room; a leave before it means the room is never joined.
function deferredPresence(ready) {
  const regs = { onSync: new Map(), onJoin: new Map(), onLeave: new Map() }
  let real = null
  let left = false
  let info = null
  const attach = (method, cb) => {
    regs[method].set(cb, real ? real[method](cb) : null)
    return () => {
      const off = regs[method].get(cb)
      regs[method].delete(cb)
      if (typeof off === 'function') off()
    }
  }
  ready.then((handle) => {
    if (!handle) return
    if (left) { handle.leave(); return }
    real = handle
    for (const method of Object.keys(regs)) {
      for (const cb of [...regs[method].keys()]) regs[method].set(cb, handle[method](cb))
    }
    if (info) void handle.updateInfo(info)
  }).catch(() => {})
  return {
    leave() {
      left = true
      if (real) real.leave()
    },
    onSync: (cb) => attach('onSync', cb),
    onJoin: (cb) => attach('onJoin', cb),
    onLeave: (cb) => attach('onLeave', cb),
    getUsers: () => (real ? real.getUsers() : []),
    async updateInfo(newInfo) {
      if (left) return
      if (real) return real.updateInfo(newInfo)
      info = { ...newInfo }
    },
  }
}

export const realtime = {
  /**
   * Join a presence channel to track online users.
   * Returns a presence object with methods to manage the connection.
   *
   * @param {string} channelName - Channel identifier (e.g. 'lobby', 'room-123')
   * @param {object} [userInfo] - Info to share with other users (e.g. { name, avatar })
   * @returns {{ leave, onSync, onJoin, onLeave, getUsers, updateInfo }}
   *
   * @example
   * const room = realtime.presence('chat-room', { name: 'Alice', avatar: url })
   * room.onSync((users) => setOnlineUsers(users))
   * room.onJoin((user) => console.log(user.name, 'joined'))
   * room.onLeave((user) => console.log(user.name, 'left'))
   * // Later: room.leave()
   */
  presence(channelName, userInfo = {}) {
    // One channel per room on this page, however many components join it
    // (see _presence-share.js — a second join used to crash the page). The topic is
    // presence:<project>:<room> where the app's cell takes public channels and
    // <project>:p:<room> where it takes private ones only (cells M2b).
    // Return no-op if Supabase isn't configured: getClient() answers null and the
    // handle does nothing, as before.
    return deferredPresence(getClient().then((client) => (client
      ? joinPresenceRoom({
        rooms,
        client,
        channelKey: presenceTopic(_home, PROJECT_ID, channelName),
        isPrivate: privateChannels(_home),
        channelName,
        userId: getAppUserId(),
        userInfo,
        // Refused for the token itself (a move changed which Realtime this page is on, cells M4): one fresh token, which the channel's own rejoin carries.
        onChannelError: (err) => {
          if (!tokenRefusal(err)) return
          void replaceRefusedToken(_home).then((fresh) => {
            if (fresh) Promise.resolve(client.realtime.setAuth(fresh)).catch(() => {})
          }).catch(() => {})
        },
      })
      : null)))
  },
}
