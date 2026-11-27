/**
 * App-session expiry + renewal — internal, not exposed to app code.
 *
 * Why (NANO / adlta2020, 2026-09-15): the Whacka ID session token a visitor gets
 * at sign-in lives 30 days, and this lib never looked at its `exp`. Past it the
 * SDK kept sending the dead token next to X-Whacka-UID, the server quietly
 * treated the device as "uid only" (rows the visitor created + public rows —
 * no group rows, no owner override), and auth.getCurrentUser() still said
 * signed in. A clinic owner saw 1 of his 296 reports and the build agent spent
 * 8 paid turns on a panel that was never broken.
 *
 * Contract:
 *   sweepExpiredSession() — a stored token past its exp (60s skew) is treated as
 *     a sign-out: token + user + realtime token are removed and auth listeners
 *     fire with null, so the app shows its signed-out state instead of a half
 *     working one. Called at auth.js load and before every API request.
 *   absorbSessionRenewal(res) — the server slides a session that is inside its
 *     renew window by answering with X-Whacka-Session-Renew: <fresh token>;
 *     stored only while a session is still present (never resurrects one the
 *     visitor signed out of mid-flight).
 *   endSessionFor(sentToken) — the server answered 401 SESSION_ENDED (the owner
 *     disabled or removed this team seat, delivery ledger P10): the same
 *     sign-out, listeners hear { ended: true }. Only while the stored token is
 *     the one the refused request carried — a colleague who signed in on the
 *     same device meanwhile keeps their session. Called by sdkFetch.
 *   isJwtExpired(token, skew) — pure decode of the exp claim, no verification
 *     (the server verifies; here it is only a clock).
 *
 * All identity keys go through _session-store (storage-blocked browsers keep one
 * identity per page — taswikpro 2026-09-02).
 */

import { storeGet, storeSet, storeRemove } from './_session-store.js'

const TOKEN_KEY = '__whacka_auth_token'
const USER_KEY = '__whacka_auth_user'
const SUPABASE_TOKEN_KEY = '__whacka_supabase_token'

export const SESSION_RENEW_HEADER = 'X-Whacka-Session-Renew'
/** Clock skew tolerated before a token counts as expired (seconds). */
export const EXPIRY_SKEW_SECONDS = 60

const expiredListeners = new Set()

/** auth.js registers here so an expiry sweep updates its in-memory user + listeners. */
export function onSessionExpired(fn) {
  expiredListeners.add(fn)
  return () => expiredListeners.delete(fn)
}

function decodeBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  if (typeof atob === 'function') return atob(b64 + pad)
  return Buffer.from(b64 + pad, 'base64').toString('binary')
}

/** The `exp` claim (unix seconds) of a JWT, or 0 when absent/unreadable. */
export function decodeJwtExp(token) {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return 0
    const { exp } = JSON.parse(decodeBase64Url(part))
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : 0
  } catch { return 0 }
}

/**
 * True when the token carries an exp that is already past (minus skew). A token
 * without a readable exp is NOT expired — never sign anyone out on a decode error.
 */
export function isJwtExpired(token, skewSeconds = EXPIRY_SKEW_SECONDS, nowSeconds = Math.floor(Date.now() / 1000)) {
  const exp = decodeJwtExp(token)
  if (!exp) return false
  return exp + skewSeconds <= nowSeconds
}

function dropSession(note, info) {
  storeRemove(TOKEN_KEY)
  storeRemove(USER_KEY)
  storeRemove(SUPABASE_TOKEN_KEY)
  console.warn(note)
  for (const fn of expiredListeners) {
    try { fn(info) } catch (err) { console.error('[auth] expiry listener error:', err) }
  }
}

/**
 * Drop a stored session whose token has expired. Returns true when a session was
 * removed. Safe to call on every request (one base64 decode).
 */
export function sweepExpiredSession(nowSeconds = Math.floor(Date.now() / 1000)) {
  const token = storeGet(TOKEN_KEY)
  if (!token || !isJwtExpired(token, EXPIRY_SKEW_SECONDS, nowSeconds)) return false
  dropSession('[auth] Session expired — signed out. Sign in again to continue.', { ended: false })
  return true
}

/**
 * The server ended the session this token belongs to (401 SESSION_ENDED).
 * Returns true when the stored session was that one and was removed.
 */
export function endSessionFor(sentToken) {
  const token = storeGet(TOKEN_KEY)
  if (!token || !sentToken || token !== sentToken) return false
  dropSession('[auth] This account no longer has access to this app — signed out.', { ended: true })
  return true
}

/**
 * Store the renewed session token a response may carry. Returns true when one
 * was stored. Only while a session is present: a sign-out that raced the request
 * must win.
 */
export function absorbSessionRenewal(res) {
  try {
    const next = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get(SESSION_RENEW_HEADER)
      : null
    if (!next) return false
    const current = storeGet(TOKEN_KEY)
    if (!current) return false
    // Never replace a session with an older or unreadable token.
    if (decodeJwtExp(next) <= decodeJwtExp(current)) return false
    storeSet(TOKEN_KEY, next)
    return true
  } catch { return false }
}
