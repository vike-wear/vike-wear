// The credentials frame (2026-11-08). In a published app, the Whacka e-mail and
// password are typed in a page the platform serves from its own origin
// (/api/auth/app-credentials), framed inside the sign-in window. The window
// lives in the app's page, so the app's own code could hear every key typed in
// it and replace fetch; it cannot read a frame from another origin. The frame
// sends the request itself and hands back a one-time code, which the window
// exchanges for the session as it does after Google or Apple.
//
// This module is the transport: the frame's address and the messages, which
// only the frame can send (its origin AND its window) and only the frame
// receives. What they mean is auth-modal.js's. The server side and the page:
// src/lib/auth/credentials-frame*.ts. Record: docs/claude-md/app-signin.md.
//
// The page is the same for every app since 2026-11-09 and the browser keeps it a
// day: its address carries only its version (VITE_CREDENTIALS_FRAME_V, stamped at
// publish), the app is told in `init`, and a page that can open the window warms it
// (warmCredentialsFrame) so the fields come up with the window.

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
// The frame page's version (its content hash, build.ts): a changed page is a new address.
const FRAME_V = ENV.VITE_CREDENTIALS_FRAME_V || ''

/** The platform's origin. Never the app's own: a published app's API_BASE is '' (its own host),
 *  where the frame would be the app's page again. */
export function credentialsFrameOrigin() {
  try { return new URL(API_BASE || 'https://whacka.app').origin } catch { return 'https://whacka.app' }
}

/** A store build's webview: https://localhost (Android), capacitor://localhost (iOS). Every
 *  Capacitor app has that origin, so it names no app, and no frame is made for it. */
export function isStoreShellPage(loc) {
  try {
    return loc.protocol === 'capacitor:' || (loc.protocol === 'https:' && loc.hostname === 'localhost' && !loc.port)
  } catch { return false }
}

/** Fields in the window itself: the editor preview (VITE_PREVIEW_TOKEN, a build only the owner
 *  opens) and a store build. Decided by the build and the page's own address, which no app code
 *  can change; never by whether the frame loads. */
export function credentialsInPage() {
  if (ENV.VITE_PREVIEW_TOKEN) return true
  // The operator's switch, fixed at publish (APP_CREDENTIALS_FRAME=0 → '0'): bundles published
  // while it is off keep the fields in the window, as before 2026-11-08. Nothing at run time sets it.
  if (ENV.VITE_CREDENTIALS_FRAME === '0') return true
  return typeof location === 'undefined' || isStoreShellPage(location)
}

/** One address for every app (the frame learns its app from the window): one page the browser keeps. */
export function credentialsFrameUrl() {
  return `${credentialsFrameOrigin()}/api/auth/app-credentials${FRAME_V ? `?v=${encodeURIComponent(FRAME_V)}` : ''}`
}

/**
 * A frame for this page. `onMessage(m)` hears the frame's messages ({ type, … }), nothing
 * else; `post(m)` reaches the frame alone. `close()` removes both.
 */
export function openCredentialsFrame(onMessage) {
  const origin = credentialsFrameOrigin()
  const frame = document.createElement('iframe')
  frame.src = credentialsFrameUrl()
  frame.setAttribute('scrolling', 'no')
  function heard(e) {
    if (e.source !== frame.contentWindow || e.origin !== origin) return
    const m = e.data
    if (!m || typeof m !== 'object' || m.wkCred !== 1 || typeof m.type !== 'string') return
    onMessage(m)
  }
  window.addEventListener('message', heard)
  return {
    frame,
    post(m) {
      try { if (frame.contentWindow) frame.contentWindow.postMessage({ ...m, wkCred: 1 }, origin) } catch { /* gone */ }
    },
    close() {
      window.removeEventListener('message', heard)
      try { frame.remove() } catch { /* gone */ }
    },
  }
}

// ── Warm-up ──────────────────────────────────────────────────────────────────
// A page that can open the window (auth-modal.js loaded, nobody signed in) fetches the
// frame's page before it is needed: a preconnect to the platform at once, and once the
// page has loaded and gone idle, a frame nobody sees, removed when it has loaded (or
// after WARM_LIFE_MS). Chrome keeps a frame's documents apart from what fetch() gets,
// so only a frame leaves the page where the window's frame will find it. That frame is
// never told anything: it learns no app, says nothing but `ready`, and the window hears
// only its own frame's window. Never in the editor preview or a store build, nor when
// the browser asks to save data. Costs one ~44 KB request per browser per day.
export const WARM_DELAY_MS = 2000
export const WARM_LIFE_MS = 15000
const UNSEEN = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
let warming = false

export function warmCredentialsFrame() {
  if (warming) return
  warming = true
  if (typeof window === 'undefined' || typeof document === 'undefined' || credentialsInPage()) return
  try { if (navigator.connection && navigator.connection.saveData) return } catch { /* no hint */ }
  try {
    const hint = document.createElement('link')
    hint.rel = 'preconnect'
    hint.href = credentialsFrameOrigin()
    ;(document.head || document.documentElement).appendChild(hint)
  } catch { /* only a hint */ }
  const mount = () => {
    try {
      const frame = document.createElement('iframe')
      frame.src = credentialsFrameUrl()
      frame.title = ''
      frame.tabIndex = -1
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('scrolling', 'no')
      frame.inert = true
      frame.style.cssText = UNSEEN
      let gone = false
      let timer = null
      const remove = () => {
        if (gone) return
        gone = true
        clearTimeout(timer)
        try { frame.remove() } catch { /* gone */ }
      }
      timer = setTimeout(remove, WARM_LIFE_MS)
      frame.addEventListener('load', remove)
      ;(document.body || document.documentElement).appendChild(frame)
    } catch { /* only a hint */ }
  }
  const whenIdle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(mount, { timeout: 5000 }) : mount())
  const later = () => setTimeout(whenIdle, WARM_DELAY_MS)
  try {
    if (document.readyState === 'complete') later()
    else window.addEventListener('load', later, { once: true })
  } catch { /* only a hint */ }
}
