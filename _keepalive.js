// Keep-alive JSON envelope (platform: src/lib/http/keepalive-json.ts).
// Long runtime calls (ai.run / ai.chat / ai.stream, docs.*, the long audio
// ops) would otherwise die at Cloudflare's 100s origin timeout as a 524 HTML
// page. With the header below the server answers 200 at once, streams a
// heartbeat space every 15s, then ONE {__wk:'envelope', status, body}. Leading
// spaces are valid JSON, so `await res.json()` still parses; unwrapKeepalive
// restores the status semantics the callers already handle. The pure parts are
// tested in _keepalive.test.mjs.
//
// L2 pass (2026-09-27): readKeepaliveJson() is the one reader every keep-alive
// caller goes through. A body that does not parse — the connection was cut
// while the heartbeat was still running — used to surface as a bare
// SyntaxError; it is now an SDK error with code KEEPALIVE_CUT and NO status
// (the server never finished answering), reported to app health like a
// timeout. throwFromEnvelope() throws the same Error shape as
// throwFromResponse for an envelope whose status is ≥ 400, so an app sees one
// contract whether the failure came as a real status or inside the envelope.
import { sdkError, codeForResponse } from './_errors.js'
import { reportSdkFailure } from './_client-report.js'

export const KEEPALIVE_HEADERS = { 'X-Whacka-Keepalive': '1' }

export function isKeepaliveEnvelope(data) {
  return !!data && typeof data === 'object' && data.__wk === 'envelope' && typeof data.status === 'number'
}

/** { ok, status, body } for any parsed JSON — envelope or plain response. */
export function unwrapKeepalive(data, httpStatus) {
  if (isKeepaliveEnvelope(data)) return { ok: data.status < 400, status: data.status, body: data.body }
  const status = typeof httpStatus === 'number' ? httpStatus : 200
  return { ok: status < 400, status, body: data }
}

/** Longest a keep-alive body may take to arrive after the headers did. */
export const DEFAULT_KEEPALIVE_BODY_TIMEOUT_MS = 330_000

/**
 * Parse a keep-alive (or plain) 2xx response into { ok, status, body }.
 * Throws an SDK error `KEEPALIVE_CUT` (no status) when the body cannot be
 * parsed — the stream was cut before the envelope arrived — and `TIMEOUT`
 * (no status) when the envelope never arrives within `timeoutMs`: under
 * keep-alive the headers come back at once, so sdkFetch's deadline has
 * already been satisfied and only THIS timer bounds a provider that hangs
 * (review 2026-09-27).
 */
export async function readKeepaliveJson(res, route, { timeoutMs = DEFAULT_KEEPALIVE_BODY_TIMEOUT_MS } = {}) {
  let data
  let timer = null
  const DEADLINE = Symbol('deadline')
  const deadline = new Promise((_, reject) => {
    if (timeoutMs > 0) timer = setTimeout(() => reject(DEADLINE), timeoutMs)
  })
  try {
    data = await Promise.race([res.json(), deadline])
  } catch (err) {
    if (err === DEADLINE) {
      try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel() } catch { /* best effort */ }
      const e = sdkError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'TIMEOUT', route })
      reportSdkFailure({ route, status: 0, code: 'TIMEOUT', message: e.message })
      throw e
    }
    const e = sdkError('The connection dropped before the server finished — please try again', {
      code: 'KEEPALIVE_CUT', route, cause: err,
    })
    reportSdkFailure({ route, status: 0, code: 'KEEPALIVE_CUT', message: e.message })
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
  return unwrapKeepalive(data, res.status)
}

/**
 * Throw for an envelope outcome with status ≥ 400: same Error shape as
 * throwFromResponse (.message = the server's sentence or the fallback,
 * .status, .code, .route, .body), 5xx reported to the platform.
 */
export function throwFromEnvelope(out, res, fallback, route) {
  const body = out && out.body && typeof out.body === 'object' ? out.body : {}
  const status = out && typeof out.status === 'number' ? out.status : 500
  const code = codeForResponse({ status, headers: res && res.headers }, body)
  const message = (typeof body.error === 'string' && body.error) || `${fallback} (${status})`
  const e = sdkError(message, { status, code, route, body })
  if (status >= 500) reportSdkFailure({ route, status, code, message })
  throw e
}
