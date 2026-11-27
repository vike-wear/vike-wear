/**
 * Supabase JWT manager — fetches and caches a token for Realtime / RLS auth.
 *
 * Two paths:
 *   - Authenticated user → token saved at signin/signup time (auth-modal.js)
 *   - Anonymous user → POST /api/auth/guest-token with X-Whacka-UID header
 *
 * Refreshes when the cached token is expiring within 24h or absent.
 * Returns null (gracefully) if server doesn't support it (SUPABASE_LEGACY_JWT_SECRET unset).
 *
 * Internal: not exposed to generated app code. Used by db.js / messaging.js / realtime.js.
 */

// Explicit .js extensions + a guarded env read keep this chain importable by
// plain node for the lib's unit tests (Vite resolves both forms identically).
import { getAuthHeaders } from './_headers.js'
import { getPlatformToken } from './_platform-auth.js'
import { getAppUserId, startFreshAnonymousId } from './user.js'
import { noteIdentityChange } from './_identity-change.js'
import { storeGet, storeSet, storeRemove } from './_session-store.js'
import { sdkFetch } from './_fetch.js'

const STORAGE_KEY = '__whacka_supabase_token'
const GATE_TOKEN_KEY = '__whacka_gate_token'
// The anonymous device identity token (visitor-identity fix 2026-10-31): the
// KEY the server signs for this browser's device id. The device id (in
// localStorage, _session-store) is a public NAME; this token is what proves the
// browser owns it. Kept across sign-in/out (sign-in rides Authorization; this
// is the visitor's own anonymous identity) and never dropped on expiry — the
// mint refreshes from an expired-but-authentic token, so only a full storage
// wipe resets the identity (a fresh id, as before the fix).
const DEVICE_TOKEN_KEY = '__whacka_device_token'
const REFRESH_BEFORE_SECONDS = 24 * 60 * 60 // refresh if exp < 1 day away

/** The stored device token, or null. Read by _headers.js (sent as
 *  X-Whacka-Device on every runtime request) and by the guest-token refresh. */
export function getDeviceToken() {
  try { return storeGet(DEVICE_TOKEN_KEY) } catch { return null }
}

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
// A guest token is fetched on the way to the first realtime subscribe; a
// stalled request here used to hold every live list on the page hostage.
const GUEST_TOKEN_TIMEOUT_MS = 15_000

function readStored() {
  return storeGet(STORAGE_KEY)
}

function writeStored(token) {
  if (token) storeSet(STORAGE_KEY, token)
  else storeRemove(STORAGE_KEY)
}

function decodeExp(jwtStr) {
  try {
    const payload = jwtStr.split('.')[1]
    if (!payload) return 0
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const { exp } = JSON.parse(json)
    return typeof exp === 'number' ? exp : 0
  } catch { return 0 }
}

function isExpiringSoon(jwtStr) {
  const exp = decodeExp(jwtStr)
  if (!exp) return true
  return (exp - Math.floor(Date.now() / 1000)) < REFRESH_BEFORE_SECONDS
}

function decodeClaim(jwtStr, key) {
  try {
    const json = atob(jwtStr.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)[key]
  } catch { return undefined }
}

// On a PRIVATE app this device has unlocked, sign-in / OAuth / team-join later
// call setSupabaseToken with a fresh token that has NO gate claim — silently
// dropping realtime/direct reads (RLS needs the agp claim). Detect that (a gate
// pass exists, but the cached token's agp doesn't match this app) and force one
// refetch through the gate-aware guest-token path, which restamps the claim.
let _gateRefetchTried = false
function gateClaimStale(jwtStr) {
  const pass = storeGet(GATE_TOKEN_KEY)
  if (!pass) return false // not a gated context → no claim needed
  const projectId = ENV.VITE_PROJECT_ID
  if (!projectId) return false
  return decodeClaim(jwtStr, 'agp') !== projectId
}

// A pass names the app it is for (`pid`, independent review R, 2026-11-04) and opens nothing
// else. One naming another app is on this origin only when the address changed hands (a name
// taken again, a custom domain moved), or a sign-in that knew no app handed one that names none:
// this app's topics refuse it, and a policy's refusal does not read as a refused token, so it
// counts as no pass. A pass with no pid is from before the rule, and still takes its own app.
function namesAnotherApp(jwtStr) {
  const pid = decodeClaim(jwtStr, 'pid')
  return typeof pid === 'string' && !!ENV.VITE_PROJECT_ID && pid !== String(ENV.VITE_PROJECT_ID).toLowerCase()
}

// A pass names the person it is for (`sub`): the account signed in, else this device's id. One naming anyone else is
// refused on this person's own topics (`u:<id>`, every group) for as long as it lives, up to 30 days, and a policy's
// refusal does not read as a refused token (review R, 2026-11-04). It gets into the store by a sign-in that handed
// none, which leaves the guest's there, by a session that ended, and by a round trip that landed after a sign-in (older
// bundles; mintAndKeep below no longer does). Where the platform can hand over a sign-in of its own, in a frame and
// only after load (_platform-auth.js), the page cannot say who its requests go out as, so it does not judge.
function whoThePageIs() {
  try {
    if (getPlatformToken() || (typeof window !== 'undefined' && window.parent && window.parent !== window)) return null
    return getAppUserId() || null
  } catch { return null }
}

function namesSomeoneElse(jwtStr) {
  const sub = decodeClaim(jwtStr, 'sub')
  const me = whoThePageIs()
  return typeof sub === 'string' && !!sub && !!me && sub !== me
}

// One question per person and stored token, per page, and the server's answer stands, whatever it names: a page
// whose token never fits must not ask on every heartbeat. While the answer is on its way whoever asks waits for it.
let _ownerSettled = null
function ownerInQuestion(jwtStr) {
  if (!namesSomeoneElse(jwtStr)) return false
  const question = `${whoThePageIs()} ${jwtStr}`
  if (_ownerSettled !== question) {
    _ownerSettled = question
    return true
  }
  return !!_inflight
}

let _inflight = null
let _sent = null // who the page was and what it held as the last guest-token request left

// A device id another browser already holds (DEVICE_TAKEN: it was claimed
// first, by whoever minted its token — the browser that made it, or someone
// who copied it from a shared row). This browser can never prove it, and the
// server answers every request under it as nobody: no data on screen, writes
// refused, and a reload changes nothing. So the page starts over as a new
// visitor — a fresh id, claimed at once (2026-11-01). Anonymous pages only (an
// account rides Authorization); once per page, so it can never loop.
let _startedFresh = false
async function startFreshOnTaken(res) {
  if (_startedFresh || res.status !== 403) return false
  let code = null
  try { code = (await res.json())?.code ?? null } catch { return false }
  if (code !== 'DEVICE_TAKEN') return false
  try { if (storeGet('__whacka_auth_token')) return false } catch { return false }
  _startedFresh = true
  try {
    startFreshAnonymousId()
    storeRemove(DEVICE_TOKEN_KEY)
    writeStored(null)
  } catch { return false }
  noteIdentityChange()
  return true
}

async function fetchGuestToken() {
  let uid
  try { uid = getAppUserId() } catch { return null }
  if (!uid) return null
  try {
    // Carry the private-app gate pass (and the owner preview token) + projectId
    // so a refreshed token keeps its gate claim — otherwise a token refresh on a
    // private app would silently drop the claim and break direct/realtime reads.
    // The full auth header set (review 2026-09-27): a signed-in bundle must
    // send its Authorization next to the account id, or the server refuses to
    // mint a realtime token for an account it cannot verify.
    const headers = { ...getAuthHeaders(), 'X-Whacka-UID': uid, 'Content-Type': 'application/json' }
    const g = storeGet(GATE_TOKEN_KEY); if (g) headers['X-Whacka-Gate'] = g
    const preview = ENV.VITE_PREVIEW_TOKEN
    if (preview) headers['X-Whacka-Preview'] = preview
    // Ask the server to claim this device id and hand back its token: the stored
    // token (refresh / prove prior holding), or "new" on first acquisition.
    headers['X-Whacka-Device'] = getDeviceToken() || 'new'
    _sent = { uid, held: readStored() }
    const res = await sdkFetch(`${API_BASE}/api/auth/guest-token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: ENV.VITE_PROJECT_ID }),
    }, { timeoutMs: GUEST_TOKEN_TIMEOUT_MS, route: 'auth/guest-token' })
    if (!res.ok) return (await startFreshOnTaken(res)) ? fetchGuestToken() : null
    const { supabaseToken, deviceToken } = await res.json()
    if (deviceToken) { try { storeSet(DEVICE_TOKEN_KEY, deviceToken) } catch {} }
    return supabaseToken || null
  } catch { return null }
}

function pageChangedSinceSent() {
  let me = null
  try { me = getAppUserId() } catch { /* unreadable: nobody it can match */ }
  return !_sent || me !== _sent.uid || readStored() !== _sent.held
}

// One guest-token round trip at a time; whoever asks meanwhile gets its answer. The page may have changed while it
// was in the air: a sign-in put its own token in the store, a sign-out took one out, or the person changed with no
// token at all. The answer names whoever the page was when it left. Kept, it would overwrite the sign-in's token (and
// be believed for up to 30 days) or leave an account's token on a signed-out device, so whoever asked gets what the
// page holds now, or one more round trip as who it is now (review R, 2026-11-04).
function mintAndKeep() {
  if (_inflight) return _inflight
  _inflight = (async () => {
    try {
      for (let turn = 0; turn < 2; turn++) {
        const token = await fetchGuestToken()
        if (!token) return null
        if (!pageChangedSinceSent()) {
          writeStored(token)
          _ownerSettled = `${whoThePageIs()} ${token}`
          // Re-armable: if the refetch restored a matching claim, leave the guard
          // off so a LATER drop (e.g. a team-join after sign-in, same load) is also
          // restored. Only latch it when the refetch came back claimless (stale
          // pass post-Renew) — that's the case that would otherwise loop, and
          // gate/status re-locks the visitor on the next boot anyway.
          _gateRefetchTried = gateClaimStale(token)
          return token
        }
        const now = readStored()
        if (now && !namesSomeoneElse(now) && !namesAnotherApp(now)) return now
      }
      return null
    } finally {
      _inflight = null
    }
  })()
  return _inflight
}

/**
 * Get a usable Supabase JWT. Returns null if not available (e.g. offline,
 * server doesn't support it). Callers should fall back to anon-key context.
 */
export async function getSupabaseToken() {
  // A fresh stored token wins over an in-flight GUEST fetch (review
  // 2026-09-27): a sign-in that lands while the boot guest-token round trip is
  // still running must not hand the realtime re-auth the guest token.
  const cached = readStored()
  // Fresh + claim intact (or we already tried and the pass turned out stale) → use it.
  // Otherwise a gate pass exists but the cached token lost its claim (a post-unlock
  // sign-in/OAuth/team-join overwrote it) → fall through and restore it.
  const usable = !!cached && !isExpiringSoon(cached) && !namesAnotherApp(cached) && (!gateClaimStale(cached) || _gateRefetchTried)
  const someoneElses = usable && ownerInQuestion(cached)
  if (usable && !someoneElses) return cached
  const token = await mintAndKeep()
  // No answer to the question: what the page held, as if it had not been asked.
  return token || (someoneElses && readStored() === cached ? cached : null)
}

// ── The token a realtime connection carries (delivery ledger P62, 2026-10-21) ──
// realtime-js asks for it on connect, after every channel join and on every
// heartbeat (~25 s) — see _realtime-options.js. The answer is what the page's
// requests carry: the stored token while fresh, else one guest-token round trip
// (getSupabaseToken). A round trip that failed is not repeated for
// REALTIME_RETRY_MS while the stored token stays the same (the heartbeat would
// ask every 25 s); a stored token past its refresh point is still used until it
// expires. null = nothing usable: the caller falls back to the anon key.
const REALTIME_RETRY_MS = 60_000
let _realtimeRetryAt = 0
let _realtimeRetryFor = null

export async function getRealtimeToken() {
  const stored = readStored()
  if (!(Date.now() < _realtimeRetryAt && stored === _realtimeRetryFor)) {
    const token = await getSupabaseToken()
    if (token) return token
    _realtimeRetryAt = Date.now() + REALTIME_RETRY_MS
    _realtimeRetryFor = readStored()
  }
  const still = readStored()
  return still && decodeExp(still) > Math.floor(Date.now() / 1000) && !namesAnotherApp(still) ? still : null
}

// ── A token the app's cell trusts (cells M2b, 2026-11-02) ──────────────────────
// Each cell's Supabase trusts our signing key under its OWN key id (the `kid` in the
// token's header). A page of an app in a cell other than the global project is told
// that kid (_realtime-home.js); the token it holds may be for another cell — the
// global sign-in routes mint for the global project, an HS256 token from before
// 10-31 carries no kid, a move changed the app's cell. Such a token is refused at
// every join (JwtSignerError), so it is swapped first: guest-token runs in the app's
// cell and signs for it. Never more than once a minute for the same stored token. A
// page has several clients and each asks at its own moment: whoever asks during a swap
// waits for its answer (review R, 2026-11-04: it got "none", and joined without a token).

function headerKid(jwtStr) {
  try {
    const head = String(jwtStr).split('.')[0]
    const json = atob(head.replace(/-/g, '+').replace(/_/g, '/'))
    const { kid } = JSON.parse(json)
    return typeof kid === 'string' && kid ? kid : null
  } catch { return null }
}

/** The key id in a token's header (null for an HS256 token or garbage). */
export function tokenKid(jwtStr) {
  return jwtStr ? headerKid(jwtStr) : null
}

/** A token straight from guest-token (the app's cell), whatever is stored; joins a round trip already under way. */
export function refetchSupabaseToken() {
  return mintAndKeep()
}

const FIT_RETRY_MS = 60_000
let _fitTriedFor = null // the stored token the last swap was asked for
let _fitGot = null // what that swap handed back
let _fitTriedAt = 0
let _fitInflight = null // the swap under way

/**
 * The token a realtime client of `home` joins with. A home without a kid (the
 * global project) gets exactly getRealtimeToken(). A cell's home gets the stored
 * token when its kid fits, else one swapped from guest-token; null when none fits
 * (the caller then does not join — never on the public key).
 */
export async function getRealtimeTokenFor(home) {
  const want = home && home.kid
  if (!want) return getRealtimeToken()
  const token = await getRealtimeToken()
  if (token && headerKid(token) === want) return token
  if (!_fitInflight) {
    const stored = token || ''
    // The same token the last swap was for, or the one it handed back: not again within the minute.
    if (Date.now() - _fitTriedAt < FIT_RETRY_MS && (stored === _fitTriedFor || stored === _fitGot)) return null
    _fitTriedFor = stored
    _fitTriedAt = Date.now()
    _fitInflight = (async () => {
      let fresh = null
      try { fresh = await refetchSupabaseToken() } catch { fresh = null }
      _fitGot = fresh || ''
      _fitInflight = null
      return fresh
    })()
  }
  const fresh = await _fitInflight
  return fresh && headerKid(fresh) === want ? fresh : null
}

let _refusedFor = null
let _refusedAt = 0
/** At most one fresh token per this long: each one goes into the store, so a Realtime that refuses every token would otherwise loop for as long as the page is open. */
export const REFUSED_TOKEN_RETRY_MS = 5 * 60_000

/**
 * A join was refused for the token itself (a key id this Realtime does not hold, a
 * bad signature, an expired token): one fresh token from guest-token per stored
 * token and at most one per REFUSED_TOKEN_RETRY_MS, or null when that changes
 * nothing (the caller waits and reports).
 */
export async function replaceRefusedToken(home) {
  const stored = readStored() || ''
  if (_refusedFor === stored) return null
  if (_refusedAt && Date.now() - _refusedAt < REFUSED_TOKEN_RETRY_MS) return null
  _refusedFor = stored
  _refusedAt = Date.now()
  let fresh = null
  try { fresh = await refetchSupabaseToken() } catch { fresh = null }
  if (!fresh || fresh === stored) return null
  if (home && home.kid && headerKid(fresh) !== home.kid) return null
  return fresh
}

/** Test-only. */
export function _resetTokenFit() {
  _fitTriedFor = null
  _fitGot = null
  _fitTriedAt = 0
  _fitInflight = null
  _refusedFor = null
  _refusedFor = null
  _refusedAt = 0
}

/**
 * Called by auth-modal.js on successful signin/signup to persist the token
 * returned by the server (avoids a round-trip through guest-token).
 */
export function setSupabaseToken(token) {
  writeStored(token)
}

/**
 * Called by auth.signOut() to discard the user's token. Next call will
 * fall back to the guest-token path under the new anonymous UID.
 */
export function clearSupabaseToken() {
  writeStored(null)
}
