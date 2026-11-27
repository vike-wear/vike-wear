/**
 * Platform-branding visibility — the client half of the app's branding (W3,
 * 2026-10-28; docs/claude-md/your-brand.md): "Whacka branding" off (Pro) and
 * "Your brand" (Ultra — the app's own icon and name in Whacka's place).
 *
 * One server answer covers every platform-drawn surface in the app: the
 * "Made with Whacka" corner badge and the desktop frame (main.jsx), the auth
 * modal's header and footer (auth-modal.js), the TeamLogin footer and icon,
 * the AI wall (credits-gate.js). The server is the authority — GET
 * /api/app/{id}/badge asks the one judgment (src/lib/app/brand.ts: the owner's
 * choice AND the plan the app is served at) on every fetch, so a downgrade
 * restores Whacka without any client-side logic here.
 *
 * Fail-open to branding: branding shows until the server confirms otherwise.
 * The last confirmed answer is cached per device so repeat launches don't
 * flicker. In the editor preview every project shares the platform origin, so
 * the cache is kept per project there (PREVIEW_SCOPE, as the identity keys).
 */

import { PREVIEW_SCOPE } from './_session-store.js'

const KEY = '_whacka_badge_pro_hidden' + PREVIEW_SCOPE
const BRAND_KEY = '_whacka_brand' + PREVIEW_SCOPE

/** A brand the surfaces may draw: a short name, an https icon or none. */
function cleanBrand(b) {
  if (!b || typeof b !== 'object') return null
  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  if (!name) return null
  const icon = typeof b.icon === 'string' && /^https:\/\//i.test(b.icon) ? b.icon : null
  return { name, icon }
}

let hidden = (() => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
})()

let brand = (() => {
  try { return hidden ? cleanBrand(JSON.parse(localStorage.getItem(BRAND_KEY) || 'null')) : null } catch { return null }
})()

const listeners = new Set()
let inflight = null

/** Synchronous answer: true when platform branding is hidden for this app. */
export function brandingHidden() {
  return hidden
}

/** The app's own { name, icon } while "Your brand" is live, else null. */
export function brandIdentity() {
  return hidden ? brand : null
}

/** True when this device has a stored server answer (either way). A first-ever
 *  visit has none — callers can hold branding's first paint briefly so
 *  white-labeled apps never flash it while the server confirms. */
export function brandingKnown() {
  try { return localStorage.getItem(KEY) !== null } catch { return false }
}

/** Subscribe to changes: cb(hidden, brand) when the answer differs from the seed. */
export function onBrandingChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function apply(nextHidden, nextBrand) {
  const b = nextHidden ? cleanBrand(nextBrand) : null
  try {
    localStorage.setItem(KEY, nextHidden ? '1' : '0')
    if (b) localStorage.setItem(BRAND_KEY, JSON.stringify(b)); else localStorage.removeItem(BRAND_KEY)
  } catch {}
  const changed = nextHidden !== hidden || JSON.stringify(b) !== JSON.stringify(brand)
  hidden = nextHidden
  brand = b
  if (changed) listeners.forEach((cb) => { try { cb(hidden, brand) } catch {} })
}

/**
 * Confirm with the server. Deduped across callers; skipped in the editor
 * preview (no published-app identity there — the workspace bridge below says
 * what the owner chose). Resolves with the current answer either way. A
 * network failure clears the dedup so a later caller (e.g. opening the auth
 * modal) retries — a served non-OK answer does not (server was reachable,
 * fail-open stands for the session).
 */
export function refreshBranding() {
  if (inflight) return inflight
  const projectId = import.meta.env.VITE_PROJECT_ID
  if (!projectId || import.meta.env.VITE_PREVIEW_TOKEN) return Promise.resolve(hidden)
  const base = import.meta.env.VITE_API_BASE || ''
  inflight = fetch(`${base}/api/app/${projectId}/badge`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return hidden
      apply(!!d.hideBadge, d.brand)
      return hidden
    })
    .catch(() => {
      inflight = null
      return hidden
    })
  return inflight
}

/** Wait for the server's answer on a device that has none yet, at most `ms`. */
export function brandingSettled(ms = 1200) {
  if (brandingKnown()) return Promise.resolve(hidden)
  return Promise.race([refreshBranding(), new Promise((r) => setTimeout(() => r(hidden), ms))])
}

// Preview bridge. The builder preview has no published-app identity, so
// refreshBranding() is a no-op there. The workspace posts what the owner chose
// (any plan may try it here — pixels only, nothing on the server reads it) over
// postMessage (see PreviewFrame); reflect it live so the owner sees it without
// a republish. Installed only in a PREVIEW build inside its frame, and only
// from the workspace itself: a published app framed by any other page must
// never take its branding from that page (W3 review, 2026-10-28).
const WORKSPACE_HOSTS = new Set(['whacka.app', 'www.whacka.app', 'localhost', '127.0.0.1'])
try {
  if (import.meta.env.VITE_PREVIEW_TOKEN && typeof window !== 'undefined' && window.self !== window.top) {
    window.addEventListener('message', (e) => {
      try {
        if (e.source !== window.parent) return
        if (!WORKSPACE_HOSTS.has(new URL(e.origin).hostname)) return
      } catch { return }
      if (!e.data || e.data.type !== 'whacka-set-branding') return
      apply(!!e.data.hideBadge, e.data.brand)
    })
  }
} catch {}
