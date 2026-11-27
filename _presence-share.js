/**
 * Presence room sharing — the pure core behind realtime.presence().
 *
 * ONE physical channel per room per page, shared by every presence() call for
 * that room. supabase-js hands back the SAME channel for a topic that is
 * already open (client.channel(topic) reuses it), and realtime-js throws
 * "cannot add `presence` callbacks for … after `subscribe()`" when presence
 * listeners are added to a channel that is joining or joined. So a second
 * realtime.presence('room') while the first was still in the room — an app
 * announcing "I'm here" from App.jsx while an admin panel reads the list, a
 * chat page and its info sheet — threw inside the second component's effect
 * and took the page down to its error boundary (2026-10-04: 18 apps in 30
 * days; apps that hit it had the agent hand-write a module singleton).
 *
 * Every call now gets its own handle with its own listeners on the shared
 * channel; the channel closes when the LAST handle leaves. A room joined once
 * makes the same channel calls as before. Two handles are the same person on
 * the same page, so they share one tracked presence: a join that brings info
 * merges it in, updateInfo replaces it (last report wins), and a re-join after
 * a dropped connection re-announces the latest info, not the first.
 */
import { retryLadder, CLOSED_SPREAD_MS } from './_realtime-share.js'

/**
 * @param {object} p
 * @param {Map} p.rooms - the page's room registry (one per realtime client)
 * @param {object} p.client - the supabase client
 * @param {string} p.channelKey - realtime topic, unique per project + room
 * @param {string} p.channelName - the app's room name (logs)
 * @param {string} p.userId - presence key
 * @param {object} [p.userInfo]
 * @param {boolean} [p.isPrivate] - a private channel (cells M2b: a cell whose Realtime takes private channels only)
 * @param {(err: unknown) => void} [p.onChannelError] - the join errored (the caller may replace a refused token, cells M4)
 */
export function joinPresenceRoom({ rooms, client, channelKey, channelName, userId, userInfo, isPrivate = false, onChannelError }) {
  let room = rooms.get(channelKey)
  if (!room) {
    room = openRoom({ client, channelKey, channelName, userId, userInfo, isPrivate, onChannelError })
    rooms.set(channelKey, room)
  } else if (userInfo && Object.keys(userInfo).length > 0) {
    room.info = { ...room.info, ...userInfo }
    if (room.subscribed) announce(room).catch(() => {})
  }
  // A room the server closed (phx_close) is waiting to be opened again under its
  // handles (see openRoom): someone new in it need not wait.
  if (room.closed) room.reopenNow()

  const syncListeners = new Set()
  const joinListeners = new Set()
  const leaveListeners = new Set()
  const handle = { sync: syncListeners, join: joinListeners, leave: leaveListeners }
  room.handles.add(handle)
  let left = false

  return {
    /**
     * Leave the presence channel.
     */
    leave() {
      if (left) return
      left = true
      room.handles.delete(handle)
      syncListeners.clear()
      joinListeners.clear()
      leaveListeners.clear()
      if (room.handles.size === 0) {
        room.reopen.cancel()
        if (rooms.get(channelKey) === room) rooms.delete(channelKey)
        // An already-closed channel needs no leave — and removeChannel drops
        // channels from the client by TOPIC, so it would also drop a fresh
        // room that replaced this one.
        if (!room.closed) {
          Promise.resolve(room.channel.untrack()).catch(() => {})
          client.removeChannel(room.channel)
        }
      }
      console.log(`[realtime] Left presence channel: ${channelName}`)
    },

    /**
     * Called whenever the presence state syncs (includes all online users).
     * @param {function} callback - Called with array of user objects
     * @returns {function} unsubscribe
     */
    onSync(callback) {
      syncListeners.add(callback)
      // Fire immediately with current state
      if (room.users.length > 0) {
        try { callback(room.users) } catch { /* ignore */ }
      }
      return () => syncListeners.delete(callback)
    },

    /**
     * Called when a user joins the channel.
     * @param {function} callback - Called with user object
     * @returns {function} unsubscribe
     */
    onJoin(callback) {
      joinListeners.add(callback)
      return () => joinListeners.delete(callback)
    },

    /**
     * Called when a user leaves the channel.
     * @param {function} callback - Called with user object
     * @returns {function} unsubscribe
     */
    onLeave(callback) {
      leaveListeners.add(callback)
      return () => leaveListeners.delete(callback)
    },

    /**
     * Get the current list of online users.
     * @returns {Array<{ id, userId, ...userInfo }>}
     */
    getUsers() {
      return room.users
    },

    /**
     * Update your presence info without leaving the channel.
     * @param {object} newInfo - Updated user info
     */
    async updateInfo(newInfo) {
      if (left) return
      room.info = { ...newInfo }
      // Before the join lands the info is only stored — the SUBSCRIBED
      // handler announces whatever is current.
      if (room.subscribed) await announce(room)
    },
  }
}

function openRoom({ client, channelKey, channelName, userId, userInfo, isPrivate, onChannelError }) {
  const room = { channel: null, userId, info: { ...(userInfo || {}) }, users: [], handles: new Set(), subscribed: false, closed: false, reopen: null, reopenNow: null }
  const connect = () => connectRoom(room, { client, channelKey, channelName, userId, isPrivate, onChannelError })
  // realtime-js never rejoins a channel the server closed, so the room gets a new one
  // under its handles and announces whoever is in it (review R, 2026-11-04).
  const again = () => {
    if (!room.closed || room.handles.size === 0) return
    room.closed = false
    try { connect() } catch (e) {
      room.closed = true
      console.warn(`[realtime] presence channel could not be opened again on ${channelName}:`, e)
      room.reopen.schedule(CLOSED_SPREAD_MS)
    }
  }
  room.reopen = retryLadder(again)
  room.reopenNow = () => { room.reopen.cancel(); again() }
  connect()
  return room
}

function connectRoom(room, { client, channelKey, channelName, userId, isPrivate, onChannelError }) {
  const channel = client.channel(channelKey, {
    config: isPrivate ? { presence: { key: userId }, private: true } : { presence: { key: userId } },
  })
  room.channel = channel

  const fanOut = (kind, label, arg) => {
    for (const h of room.handles) {
      for (const fn of h[kind]) {
        try { fn(arg) } catch (e) { console.error(`[realtime] ${label} listener error:`, e) }
      }
    }
  }

  // Track presence state. All listeners go on BEFORE subscribe() — the only
  // order realtime-js accepts — and fan out to every handle.
  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState()
    room.users = Object.entries(state).map(([key, presences]) => ({
      id: key,
      ...presences[0], // Take the first presence for each user
    }))
    fanOut('sync', 'sync', room.users)
  })

  channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
    fanOut('join', 'join', { id: key, ...newPresences[0] })
  })

  channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
    fanOut('leave', 'leave', { id: key, ...leftPresences[0] })
  })

  // Subscribe and announce presence. realtime-js rejoins a dropped channel on
  // its own and this callback fires SUBSCRIBED again — track() re-announces
  // this person, so a blip never leaves them silently absent from the room.
  channel.subscribe(async (status, err) => {
    if (status === 'SUBSCRIBED') {
      room.subscribed = true
      await announce(room)
      console.log(`[realtime] Joined presence channel: ${channelName}`)
    } else {
      room.subscribed = false
      if (status === 'CLOSED') {
        room.closed = true
        if (room.handles.size > 0) room.reopen.schedule(CLOSED_SPREAD_MS)
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[realtime] presence channel ${status} on ${channelName}`, err || '')
        if (status === 'CHANNEL_ERROR' && onChannelError) { try { onChannelError(err) } catch { /* the next rejoin asks again */ } }
      }
    }
  })
}

function announce(room) {
  return room.channel.track({
    userId: room.userId,
    ...room.info,
    joinedAt: new Date().toISOString(),
  })
}
