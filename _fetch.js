// ─────────────────────────────────────────────
// sdkFetch — fetch with a deadline (L2 pass, 2026-09-27)
// ─────────────────────────────────────────────
// Not one request in the SDK carried a timeout before this: a stalled network
// left the app waiting forever (a WhatsApp CRM owner added his own 12s timer
// in app code; the first-screen gate check could hang into "Something went
// wrong"). Default 30s; long routes pass their own (ai/docs/audio); callers
// may pass their own AbortSignal too. A timeout or a network failure throws an
// SDK error WITHOUT a status (so the offline outbox still queues it) and
// reports itself (sampled for network — that is usually the visitor's link).
import { reportSdkFailure } from './_client-report.js'
import { sdkError } from './_errors.js'
import { endSessionFor } from './_session-expiry.js'
import { HOLD_RETRIES, holdRetryMs, neverRan } from './_hold-codes.js'

export const DEFAULT_TIMEOUT_MS = 30_000

export function routeOf(url) {
  const m = String(url).match(/\/api\/app\/[^/]+\/([^?]+)/)
  return m ? m[1] : String(url).slice(0, 80)
}

// 401 SESSION_ENDED: the owner disabled or removed this team seat (delivery
// ledger P10). Every module's request passes here, so the device signs out
// whichever call hears it first — when it still holds the session that call sent.
function noteEndedSession(res, init) {
  if (!res || res.status !== 401 || !res.headers || typeof res.headers.get !== 'function') return
  if (res.headers.get('X-Whacka-Code') !== 'SESSION_ENDED') return
  const h = init && init.headers
  const auth = h && (typeof h.get === 'function' ? h.get('Authorization') : (h.Authorization || h.authorization))
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) endSessionFor(auth.slice(7))
}

// A move holds an app for seconds, and apps almost never show a write's error: told that
// nothing of a request ran, it goes again after the Retry-After, twice, each try with its
// own deadline. A body that was a stream cannot go twice.
function canSendAgain(init) {
  const b = init && init.body
  return !(typeof ReadableStream === 'function' && b instanceof ReadableStream)
}

function saidNothingRan(res) {
  if (!res || res.status !== 503 || !res.headers || typeof res.headers.get !== 'function') return false
  return neverRan(res.headers.get('X-Whacka-Code'))
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

export async function sdkFetch(url, init = {}, opts = {}) {
  for (let tries = 0; ; tries++) {
    const res = await fetchOnce(url, init, opts)
    if (tries >= HOLD_RETRIES || !saidNothingRan(res) || !canSendAgain(init)) return res
    try { if (res.body) res.body.cancel().catch(() => {}) } catch { /* its connection goes when it can */ }
    await pause(holdRetryMs(res.headers.get('Retry-After')), init && init.signal)
  }
}

async function fetchOnce(url, init = {}, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const route = opts.route || routeOf(url)
  const outer = init && init.signal
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  let timer = null
  const onOuterAbort = () => { if (ctrl) ctrl.abort() }
  if (ctrl) {
    if (outer) {
      if (outer.aborted) ctrl.abort()
      else outer.addEventListener('abort', onOuterAbort, { once: true })
    }
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  }
  try {
    const res = await fetch(url, ctrl ? { ...init, signal: ctrl.signal } : init)
    try { noteEndedSession(res, init) } catch { /* never in the way of the response */ }
    return res
  } catch (err) {
    if (outer && outer.aborted && !timedOut) throw err // the caller aborted on purpose
    // opts.report === false: the caller knows this failure has no consequence
    // (the gate probe on an app that is not locked) and keeps it out of app
    // health; the error itself is thrown exactly as before (2026-09-30).
    if (timedOut) {
      const e = sdkError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'TIMEOUT', route, cause: err })
      if (opts.report !== false) reportSdkFailure({ route, status: 0, code: 'TIMEOUT', message: e.message })
      throw e
    }
    const e = sdkError('Network error — check your connection and try again', { code: 'NETWORK', route, cause: err })
    if (opts.report !== false) reportSdkFailure({ route, status: 0, code: 'NETWORK', message: (err && err.message ? String(err.message) : 'fetch failed').slice(0, 120), sample: 20 })
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    if (outer && typeof outer.removeEventListener === 'function') outer.removeEventListener('abort', onOuterAbort)
  }
}
