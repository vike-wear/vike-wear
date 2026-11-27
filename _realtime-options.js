// ── Realtime client options, shared by db.js (live data), realtime.js
//    (presence), messaging.js (chat) and payments.js (payment pokes) so the
//    connections never drift apart ─────────────────────────────────────────
//
// A realtime connection stays alive only while the client keeps saying "still
// here" every ~25s. By default supabase-js sends that on a plain setInterval —
// i.e. on the main thread, which every mobile browser throttles or freezes
// outright the moment the app leaves the screen (battery policy). The server
// hears nothing, assumes the device is gone, and closes the line. The person
// is still there: their phone just locked, or they switched apps for a few
// seconds. Two visible consequences: presence reports them offline while their
// app is open, and their live data stops arriving without anyone noticing.
//
// The library ships a Web Worker variant of the same ping (`worker: true`),
// which browsers do NOT throttle on the same schedule. The worker body is
// bundled inside the library and instantiated from a blob URL — no network
// fetch, no extra dependency, nothing new to serve. It is off by default.
//
// Honest limits: iOS suspends a fully backgrounded page including its workers,
// so this buys short backgrounding and screen-lock, not an app left off-screen
// for minutes; and an app that is genuinely CLOSED still drops off, which is
// correct. `Worker` is feature-detected — a runtime without it (SSR, some
// embedded webviews) silently keeps the old main-thread ping rather than
// handing the library an option it cannot honour.
//
// ── The token on every join (delivery ledger P62, 2026-10-21) ──────────────
// realtime-js asks its accessToken callback for the token on connect, after
// every channel join and on every heartbeat, and every join from then on
// carries the answer — the callback, not setAuth(token), is its source of
// truth. supabase-js's own callback answers the anon key here (these clients
// hold no Supabase session), so only the page's first joins carried the
// page's token: a conversation opened later, a list mounted again, every
// channel after a reconnect and, a heartbeat after a sign-in, every joined
// channel went back to the anon key. The server accepts that join and the read
// policies then drop every row meant for this person, without an error. Every
// client gets this callback instead: the page's own token
// (_supabase-token.js getRealtimeToken), the anon key only when there is none.
import { getSupabaseToken, getRealtimeToken, getRealtimeTokenFor } from './_supabase-token.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}

async function realtimeAccessToken() {
  let token = null
  try { token = await getRealtimeToken() } catch { token = null }
  return token || ENV.VITE_SUPABASE_ANON_KEY
}

// A cell's Realtime (a home with a kid, cells M2b): the page's token, swapped for one
// that cell trusts — never the public key. A join without a token reads as nobody
// there and silently loses every private row, so callers do not join until a token
// fits (holdFittingToken below). With none to be had it answers null, never the key. A
// null is not known to end what the previous identity joined (Realtime's source, as
// remembered, re-checks the token it already holds; untested), so whoever joined those
// channels leaves them (_live-broadcast.js rejoin).
function cellAccessToken(home) {
  return async () => {
    try { return (await getRealtimeTokenFor(home)) || null } catch { return null }
  }
}

/**
 * Options for a page's realtime client. `home` (from _realtime-home.js) is where it
 * connects; without one, or for the global project (no kid), the token callback is
 * the one every client always had.
 */
export function realtimeClientOptions(home) {
  const accessToken = home && home.kid ? cellAccessToken(home) : realtimeAccessToken
  if (typeof Worker === 'undefined') return { realtime: { accessToken } }
  return { realtime: { worker: true, accessToken } }
}

// ── Re-authentication on identity change (L2 pass, 2026-09-27) ─────────────
// Every realtime client is created once per page and authenticated with the
// Supabase token of whoever was signed in AT THAT MOMENT. Before this, a
// sign-in / sign-out / team login later in the same page never reached the
// socket: RLS kept evaluating the OLD identity, so a visitor who signed in kept
// missing every group-visible event until a reload (and a signed-out device
// kept receiving the previous account's stream). Each module registers its
// client here; auth.js calls reauthRealtimeClients() after every identity
// change and the fresh token (session token when signed in, a guest token for
// the anonymous uid otherwise — see _supabase-token.js) is pushed to every
// live socket with setAuth(), which realtime-js re-sends on every joined
// channel. No token at all → setAuth() with no argument = back to the anon key.
const _clients = new Map() // client → its home (null = the bundle's, as before cells)
let _reauthSeq = 0
// Broadcast transport (L5, 2026-09-30): the topics a page may listen to depend
// on WHO is signed in, so db.js re-asks for its topic list after every re-auth.
const _reauthListeners = new Set()

export function onRealtimeReauth(fn) {
  if (typeof fn === 'function') _reauthListeners.add(fn)
  return () => _reauthListeners.delete(fn)
}

export function registerRealtimeClient(client, home) {
  if (client && client.realtime) _clients.set(client, home || null)
}

/**
 * A cell's client, about to join: true once it HOLDS a token that cell trusts (a home
 * without a kid has nothing to fit). A join carries what the client holds at that moment
 * (realtime-js reads it at subscribe() and phoenix computes the frame once, even when
 * the frame waits for the socket), not what the store holds or what the callback above
 * would answer a tick later: a client built before a token fitted joined as nobody,
 * refused every private topic and silently lost its rows (review R, 2026-11-04).
 */
export async function holdFittingToken(client) {
  const home = _clients.get(client)
  if (!home || !home.kid) return true
  let token = null
  try { token = await getRealtimeTokenFor(home) } catch { token = null }
  if (!token) return false
  const rt = client.realtime
  if (rt.accessTokenValue !== token) {
    try { await rt.setAuth(token) } catch { return false }
  }
  return rt.accessTokenValue === token
}

export async function reauthRealtimeClients() {
  if (!_clients.size) return
  const seq = ++_reauthSeq
  let token = null
  try { token = await getSupabaseToken() } catch { token = null }
  // A newer identity change started while the token was being fetched — its
  // own run carries the right token; this one must not overwrite it.
  if (seq !== _reauthSeq) return
  for (const [client, home] of [..._clients]) {
    // A cell's client gets the new identity's token swapped for that cell (cells M2b).
    let t = token
    if (home && home.kid) {
      try { t = await getRealtimeTokenFor(home) } catch { t = null }
      if (seq !== _reauthSeq) return
    }
    try {
      const p = t ? client.realtime.setAuth(t) : client.realtime.setAuth()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch { /* a socket that cannot re-auth keeps its old context; never throw into auth */ }
  }
  for (const fn of [..._reauthListeners]) {
    try { fn() } catch { /* a listener that throws never breaks re-auth */ }
  }
}

/** Test-only introspection. */
export function _realtimeClientCount() {
  return _clients.size
}
