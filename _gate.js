/**
 * Private-app access gate (client side). The server enforces the gate on every
 * data/capability call (withRuntimeGuard); this module only decides whether to
 * show the lock screen vs. the app, and handles the magic-link auto-unlock.
 *
 *   - popMagicKey()    — pull a `#k=CODE` magic-link key out of the URL (and
 *                        strip it from history) so the visitor never types.
 *   - fetchGateStatus()— { gated, unlocked, stealth, appName, appIcon, themeColor }
 *   - submitGateCode() — exchange a code for a long-lived device pass, stored so
 *                        this device is remembered and never prompted again.
 *
 * L2 pass (2026-09-27): both requests run through sdkFetch. The boot probe has
 * an 8s deadline — it sits between the splash and the first screen of every
 * published app, and a stalled request used to hold the splash until the
 * browser gave up, then landed on "Something went wrong". Past the deadline
 * (or on a network failure) main.jsx boots the app as if it were not gated:
 * the server still refuses every data call of a locked-out visitor, the lock
 * screen is only the UX. submitGateCode() reports WHY it failed (status +
 * code), so the lock screen can tell a wrong code from a rate limit or a dead
 * connection.
 */

// Explicit .js extensions + a guarded env read keep this module importable by
// plain node (it sits in _errors.js's import chain, which the lib's unit tests load).
import { getAuthHeaders } from './_headers.js'
import { setSupabaseToken } from './_supabase-token.js'
import { storeSet, storeRemove, storeGet } from './_session-store.js'
import { sdkFetch } from './_fetch.js'
import { throwFromResponse, readErrorBody, codeForResponse } from './_errors.js'

const GATE_TOKEN_KEY = '__whacka_gate_token'
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const PROJECT_ID = ENV.VITE_PROJECT_ID
const API_BASE = ENV.VITE_API_BASE || ''

/** The first-screen probe's deadline (fail-open past it — see the header). */
export const GATE_STATUS_TIMEOUT_MS = 8_000
const GATE_UNLOCK_TIMEOUT_MS = 15_000

function setGateToken(t) {
  storeSet(GATE_TOKEN_KEY, t)
}

// Drop the stored pass — called when the app reports it's no longer gated, so a
// leftover pass doesn't trigger a wasted gate-claim refetch on every boot.
export function clearGateToken() {
  storeRemove(GATE_TOKEN_KEY)
}

// ── Gate seed (mirrors _branding.js's per-device seed/reconcile cache) ──────
// The last server-confirmed gate answer. 'open' lets boot mount a public app
// immediately and reconcile async instead of awaiting the status round trip
// on every launch. Only a served "not gated" answer is ever cached as open —
// gated apps (even when this device is unlocked) always take the awaited path
// so private content never flashes.

const GATE_SEED_KEY = '__whacka_gate_seed'

/** True when the last server-confirmed answer said this app is NOT gated. */
export function gateSeedIsOpen() {
  try { return localStorage.getItem(GATE_SEED_KEY) === 'open' } catch { return false }
}

/** A previous boot CONFIRMED this app is gated (review 2026-09-27): when the
 *  status probe fails on a later boot, show the lock instead of the app — a
 *  fail-open mount would 401 on its first data call and reload into this same
 *  probe, looping on a link where every request outlasts the 8 s deadline. */
export function gateSeedIsLocked() {
  try { return localStorage.getItem(GATE_SEED_KEY) === 'locked' } catch { return false }
}

/** Record the latest server answer (open = not gated). */
export function setGateSeed(open) {
  try { localStorage.setItem(GATE_SEED_KEY, open ? 'open' : 'locked') } catch {}
}

/**
 * Mid-session gate 401: when a runtime API answers 401 with {gated:true}
 * (the owner enabled the gate — or rotated the code — while this visitor had
 * the app open), drop the cached 'open' seed and reload; boot then takes the
 * awaited path and lands on the lock screen instead of leaving the visitor on
 * a broken app. Mirrors _rate-limit.js's shared-interceptor style. Returns
 * true when the payload was a gate rejection. Guarded so concurrent 401s
 * reload once, and inert in the editor preview.
 *
 * Only while the APP is on screen (delivery ledger P65, 2026-10-22). The lock
 * screen's page still runs the app's module-level code — push.js registers
 * the device again on load, the outbox re-sends a queued write, a store build
 * records a purchase — and a device without a pass is refused each time; the
 * reload brought back the same lock screen, which asked again, once or twice
 * a second until push/subscribe's per-minute limit answered (a shop's lock
 * screen restarted 9–22 times in a row, five times in a day, clearing the code
 * being typed; a queued write had no limit at all). With the lock up, or
 * before the boot has decided (its status probe will), a gate refusal changes
 * nothing on screen.
 */
let _gatedReloading = false
let _screen = null // 'app' | 'lock' — what main.jsx mounted last; null until the boot decides

/** main.jsx notes which screen it mounted: 'app' or 'lock'. */
export function noteGateScreen(screen) {
  _screen = screen === 'app' || screen === 'lock' ? screen : null
}

export function handleGatedResponse(payload) {
  if (!payload || payload.gated !== true) return false
  if (ENV.VITE_PREVIEW_TOKEN) return false
  setGateSeed(false)
  if (_screen !== 'app') return true
  if (!_gatedReloading) {
    _gatedReloading = true
    try { window.location.reload() } catch { /* ignore */ }
  }
  return true
}

// Read a magic-link key from the URL hash (`#k=...`, possibly alongside other
// fragment params) and remove it so it doesn't linger in history / get shared on.
export function popMagicKey() {
  try {
    const h = window.location.hash || ''
    const m = h.match(/[#&]k=([^&]+)/)
    if (!m) return null
    const code = decodeURIComponent(m[1])
    let rest = h.replace(/([#&])k=[^&]*/, '$1')        // drop the k= param
    rest = rest.replace(/^#&/, '#').replace(/[#&]+$/, '') // tidy leftover separators
    const newHash = rest && rest !== '#' ? rest : ''
    window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash)
    return code
  } catch {
    return null
  }
}

/**
 * The boot probe. Throws an SDK error (TIMEOUT / NETWORK without a status, or
 * the server's code with one) — main.jsx fails open on any throw. A 5xx is
 * reported to app health by throwFromResponse; a timeout / network failure by
 * sdkFetch, under route `gate/status`.
 */
export async function fetchGateStatus() {
  // A timeout / network failure here is reported to app health ONLY when it
  // has a consequence — the seed says this app is gated and locked, so the
  // visitor sees the lock screen instead of the app. On an app that is not
  // gated (or is unlocked for this device) the probe failing changes nothing:
  // the app mounts as usual, and the report was pure noise — 46 in one night
  // across 18 apps, none of them gated (2026-09-30).
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/gate/status`, {
    headers: getAuthHeaders(),
  }, { timeoutMs: GATE_STATUS_TIMEOUT_MS, route: 'gate/status', report: gateSeedIsLocked() })
  if (!res.ok) await throwFromResponse(res, 'Gate status failed', 'gate/status')
  return res.json()
}

/**
 * Exchange a code for a device pass. Returns { ok: true } and remembers the
 * device (or { ok: true, notGated: true } when the app is no longer private),
 * else { ok: false, error, status, code } — `status` is absent when the server
 * never answered (code TIMEOUT / NETWORK); a wrong code is a 403.
 */
export async function submitGateCode(code) {
  let res
  try {
    res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/gate/unlock`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code }),
    }, { timeoutMs: GATE_UNLOCK_TIMEOUT_MS, route: 'gate/unlock' })
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'network', code: (e && e.code) || 'NETWORK' }
  }
  if (res.ok) {
    let data = {}
    try { data = (await res.json()) || {} } catch { data = {} }
    if (data.token) {
      setGateToken(data.token)
      // Swap in the gate-claim Supabase token so Realtime/direct reads of this
      // private app's data work immediately (gate-aware RLS) without a re-fetch.
      if (data.supabaseToken) { try { setSupabaseToken(data.supabaseToken) } catch {} }
      return { ok: true }
    }
    // Not (or no longer) private → nothing to unlock; the caller reloads / boots
    // and gate/status confirms.
    if (data.notGated) return { ok: true, notGated: true }
    return { ok: false, error: data.error || 'wrong', status: res.status, code: 'INVALID_CODE' }
  }
  const body = await readErrorBody(res)
  return {
    ok: false,
    error: (body && body.error) || 'wrong',
    status: res.status,
    code: codeForResponse(res, body),
  }
}

/** Test-only: whether a device pass is stored. */
export function _hasGateToken() {
  return !!storeGet(GATE_TOKEN_KEY)
}
