// ─────────────────────────────────────────────
// SDK error contract — one shape for every thrown Error (L2 pass, 2026-09-27)
// ─────────────────────────────────────────────
// Every public module throws through throwFromResponse(): the Error carries
// the server's sentence as .message, plus .status (HTTP), .code (the server's
// stable code, from the body or the X-Whacka-Code header, else derived from
// the status), .route and .body. App code (and the build agent's teaching)
// can branch on `err.code` instead of parsing sentences. .say is the sentence
// a person reads, in the app's language (_say.js, 2026-11-09): .message is
// written for the builder. Internal: not exposed to generated app code directly.
import { absorbSessionRenewal } from './_session-expiry.js'
import { handleGatedResponse } from './_gate.js'
import { reportSdkFailure } from './_client-report.js'
import { sayFor } from './_say.js'

const CODE_BY_STATUS = {
  400: 'BAD_REQUEST', 401: 'AUTH_REQUIRED', 402: 'PAYMENT_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED',
  500: 'INTERNAL', 502: 'UPSTREAM_UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'TIMEOUT',
}

/**
 * Build an SDK error. `status` is only set for a server-answered failure — a
 * network failure or a client-side timeout has NO status (the outbox keys on
 * that to decide "queue it, the server never answered"). `say` names the kind
 * of sentence for an error the SDK makes itself (_say.js SAY_TEXT keys); a
 * server's answer names its own in the body.
 */
export function sdkError(message, { status, code, route, body, cause, say } = {}) {
  const e = new Error(message)
  if (typeof status === 'number') e.status = status
  if (code) e.code = code
  if (route) e.route = route
  if (body !== undefined) e.body = body
  if (cause) e.cause = cause
  try { e.say = sayFor({ status, code, body, say }) } catch { /* never in the way of the error */ }
  e.sdk = true
  return e
}

export async function readErrorBody(res) {
  try {
    const data = await res.json()
    // A keep-alive envelope that carried an error: unwrap to its body.
    if (data && typeof data === 'object' && data.__wk === 'envelope') return data.body || {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** Code for a failed response: the body's, else the header's, else by status. */
export function codeForResponse(res, body) {
  if (body && typeof body.code === 'string' && body.code) return body.code
  try { const h = res.headers && res.headers.get && res.headers.get('X-Whacka-Code'); if (h) return h } catch {}
  return CODE_BY_STATUS[res.status] || (res.status >= 500 ? 'INTERNAL' : 'REQUEST_FAILED')
}

/**
 * Throw the standard Error for a non-OK response. Also absorbs a session
 * renewal header and reloads into the lock screen on a gated 401 (the two
 * things db.js always did and most other modules forgot). 5xx failures are
 * reported to the platform (sdk:<route>) so a route that breaks shows up in
 * app health without the app having to catch anything.
 */
export async function throwFromResponse(res, fallback, route) {
  const body = await readErrorBody(res)
  try { absorbSessionRenewal(res) } catch {}
  if (res.status === 401) { try { handleGatedResponse(body) } catch {} }
  const code = codeForResponse(res, body)
  const message = (body && typeof body.error === 'string' && body.error) || `${fallback} (${res.status})`
  const e = sdkError(message, { status: res.status, code, route, body })
  if (res.status >= 500) reportSdkFailure({ route, status: res.status, code, message })
  throw e
}

/** A platform wall (credits / quota / rate) rather than a bug in the call. */
export function isWall(err) {
  return !!err && (err.status === 429 || err.code === 'CREDITS_EXHAUSTED' || err.code === 'QUOTA_EXCEEDED' || err.code === 'RATE_LIMITED' || err.code === 'DAILY_LIMIT')
}
