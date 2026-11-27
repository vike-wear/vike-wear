// ─────────────────────────────────────────────
// Client error reporting — published apps only
// ─────────────────────────────────────────────
// index.html's inline error script catches uncaught errors / rejections /
// render crashes BEFORE modules load, and (a) postMessages them to the editor
// parent (preview) and (b) buffers them on window.__whackaErrors. In the
// PUBLISHED app there is no editor parent, so those crashes would vanish — yet
// they are exactly the white-screen class the build agent can't otherwise see.
//
// This module (which, unlike the inline script, has import.meta.env) drains the
// buffer and forwards future errors to /api/app/{id}/client-error so app_health
// can surface them. Published only: in the editor preview the parent already
// gets them. Capped per session so an error loop can never storm the endpoint.
//
// L2 pass (2026-09-27): the report also carries the page path (no query) and
// the SDK stamp, and the SDK's own failures (a 5xx from a route, a timeout, a
// network error) are reported through reportSdkFailure — before, every SDK
// module logged with a `[tag]` prefix that the inline capture filtered out,
// so a broken route never reached app health unless the app itself crashed.
//
// Internal: not exposed to generated app code. Called once from main.jsx.

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID
const SDK_STAMP = ENV.VITE_WHACKA_SDK || null
const MAX_PER_SESSION = 20
const MAX_SDK_PER_SESSION = 12

let sent = 0
let sdkSent = 0
const sdkSeen = new Set()

function pagePath() {
  try {
    const l = window.location
    return String((l.pathname || '/') + (l.hash || '')).slice(0, 200)
  } catch { return null }
}

function canReport() {
  try {
    if (typeof window === 'undefined') return false
    // Preview runs inside the editor iframe (self !== top); it reports via
    // postMessage already. Only the published, top-level app forwards to server.
    if (window.self !== window.top) return false
    return !!PROJECT_ID
  } catch { return false }
}

function post(message, source) {
  if (sent >= MAX_PER_SESSION || !message) return
  sent++
  try {
    fetch(`${API_BASE}/api/app/${PROJECT_ID}/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: String(message).slice(0, 1000),
        source: source ? String(source).slice(0, 300) : null,
        path: pagePath(),
        sdk: SDK_STAMP,
      }),
      keepalive: true, // survive a navigation/unload right after a crash
    }).catch(() => {})
  } catch (e) { /* never let reporting throw into the app */ }
}

export function installClientErrorReporting() {
  try {
    if (!canReport()) return

    // Forward anything the inline script captured before this module loaded.
    const buffered = window.__whackaErrors || []
    for (const e of buffered) post(e && e.message, e && e.source)

    // Route future captures (the inline report() calls this if present).
    window.__whackaReportToServer = post
  } catch (e) { /* reporting is best-effort */ }
}

/**
 * An SDK-level failure the app may never surface itself: a route answered
 * 5xx, a request timed out, the network failed. One report per
 * route+code+status per session; `sample: n` reports one in n (network
 * failures are mostly the visitor's connection). Never throws.
 */
export function reportSdkFailure({ route, status, code, message, sample }) {
  try {
    if (!canReport()) return
    const key = `${route}|${code}|${status}`
    if (sdkSeen.has(key)) return
    if (sample && Math.random() * sample >= 1) return
    if (sdkSent >= MAX_SDK_PER_SESSION) return
    sdkSeen.add(key)
    sdkSent++
    post(`[sdk] ${route} ${status || '-'} ${code}: ${String(message || '').slice(0, 200)}`, `sdk:${route}`)
  } catch { /* best-effort */ }
}
