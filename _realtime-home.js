/**
 * Where this page's realtime lives (cells M2b, 2026-11-02).
 *
 * An app's live updates are on the Realtime of the cell (the Whacka region) the app
 * lives in, and no bundle carries a cell's address: a bundle outlives a move, and
 * one key rotation would otherwise mean republishing every app. The app's cell
 * names its Realtime at runtime, in the data route's `liveChannels` answer:
 *
 *   realtime: { url, publishableKey, publicChannels, kid? }
 *
 *   - `kid` comes only from a cell that is not the global project: the token this
 *     page joins with must carry it (_supabase-token.js getRealtimeTokenFor), and
 *     the page never joins on the public key there (a join on it silently drops
 *     every private row — delivery ledger P62).
 *   - `publicChannels: false`: that Realtime takes private channels only.
 *
 * An answer without `realtime` (a server from before this change, during a rolling
 * deploy) keeps the bundle's own VITE_SUPABASE_* — the global project, today's
 * behaviour. The bundle's URL also stays the one for Storage: audio.js and
 * game/asset-path.js never read this module.
 */

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** The bundle's own: the global project, what every page connected to before cells. */
export function bundleRealtimeHome(env = ENV) {
  return {
    url: String((env && env.VITE_SUPABASE_URL) || '').replace(/\/+$/, ''),
    publishableKey: String((env && env.VITE_SUPABASE_ANON_KEY) || ''),
    publicChannels: true,
    kid: null,
    from: 'bundle',
  }
}

/** The home a liveChannels answer names, or the bundle's when it names none. */
export function homeFromAnswer(answer, env = ENV) {
  const r = answer && typeof answer === 'object' ? answer.realtime : null
  if (!r || typeof r !== 'object') return bundleRealtimeHome(env)
  if (typeof r.url !== 'string' || !/^https?:\/\/[^/\s]+/.test(r.url)) return bundleRealtimeHome(env)
  if (typeof r.publishableKey !== 'string' || !r.publishableKey) return bundleRealtimeHome(env)
  return {
    url: r.url.replace(/\/+$/, ''),
    publishableKey: r.publishableKey,
    publicChannels: r.publicChannels !== false,
    kid: typeof r.kid === 'string' && r.kid ? r.kid : null,
    from: 'answer',
  }
}

/** One key for one Realtime: the same URL, browser key and key id. */
export function homeKey(home) {
  return home ? `${home.url}|${home.publishableKey}|${home.kid || ''}` : ''
}

export function sameHome(a, b) {
  return !!a && !!b && homeKey(a) === homeKey(b)
}

// This page's home: the first answer names it. A later answer that names another
// Realtime means the app has moved (cells M4): the old one will never carry this
// app's updates again, so the page follows. An answer naming none (a server from
// before M2b) never displaces a home.
let _home = null

/** Note a liveChannels answer; returns the page's home after it. */
export function noteRealtimeAnswer(answer, env = ENV) {
  const named = homeFromAnswer(answer, env)
  if (!_home || (named.from === 'answer' && !sameHome(_home, named))) _home = named
  return _home
}

/** The page's home once an answer came, else null. */
export function pageRealtimeHome() {
  return _home
}

// ── A module with no topics answer of its own (chat, presence, payment pokes) ──
export const HOME_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
let _ask = null

/**
 * The page's home for chat, presence and payment pokes: the one an answer already
 * named (db.js asks with its topics), else ONE ask per page through `fetchAnswer`
 * (_realtime-ask.js: liveChannels with homeOnly), retried with the live transport's
 * delays until the app's cell answers. An answer that names none = the bundle's.
 */
export function askRealtimeHome(fetchAnswer, { delays = HOME_RETRY_DELAYS_MS, setTimer, env = ENV } = {}) {
  if (_home) return Promise.resolve(_home)
  if (_ask) return _ask
  const later = setTimer || ((fn, ms) => setTimeout(fn, ms))
  _ask = new Promise((resolve) => {
    let tries = 0
    const attempt = () => {
      if (_home) { resolve(_home); return }
      Promise.resolve().then(fetchAnswer).then(
        (answer) => resolve(noteRealtimeAnswer(answer, env)),
        () => {
          if (_home) { resolve(_home); return }
          later(attempt, delays[Math.min(tries++, delays.length - 1)])
        },
      )
    }
    attempt()
  })
  return _ask
}

/** The realtime topic for each module's channel, by the home's scheme (cells M2b). */
export function chatTopic(home, projectId, channelId) {
  return home && home.publicChannels === false ? `${projectId}:m:${channelId}` : `messages:${channelId}`
}
export function presenceTopic(home, projectId, room) {
  return home && home.publicChannels === false ? `${projectId}:p:${room}` : `presence:${projectId}:${room}`
}
export function paymentsTopic(_home, projectId) {
  return `${projectId}:payments`
}
/** Whether a module's channels on this home are private (every cell but the global project). */
export function privateChannels(home) {
  return !!home && home.publicChannels === false
}

// ── A move (cells M2b: M4's cutover) ──
// The server tells pages still on the app's old cell (src/lib/cells/realtime.ts
// announceMoved). The page offers its refresh — main.jsx shows the same "Updated — tap
// to refresh" pill a publish shows — and a refreshed page asks where to connect again.
export const REALTIME_MOVED_EVENT = 'rt_moved'
export const PAGE_MOVED_EVENT = 'whacka:realtime-moved'
let _movedSaid = false
export function notePageMoved() {
  if (_movedSaid) return
  _movedSaid = true
  try { window.dispatchEvent(new CustomEvent(PAGE_MOVED_EVENT)) } catch { /* no window: nothing to offer */ }
}

/** Test-only. */
export function _resetRealtimeHome() {
  _home = null
  _ask = null
  _movedSaid = false
}
