/**
 * Identity storage with an in-memory fallback — internal, not exposed to app code.
 *
 * Why (taswikpro 2026-09-02): some browsers refuse site storage outright —
 * Chrome with "on-device site data" set to don't-allow, a webview with DOM
 * storage off — and every localStorage access throws
 * `SecurityError: Access is denied for this document`. Every identity read in
 * this lib was a bare try/catch → null, so on such a device the anonymous id
 * was re-minted on EVERY call (the insert and the list right after it belonged
 * to two different visitors) and a successful sign-in was thrown away one
 * request later (the modal's setItem failed silently, _headers/getAppUserId
 * read nothing back, the SDK fetched a guest token). The user saw "the app
 * doesn't keep my data"; the build agent saw one phone as ~69 devices and
 * called it a platform bug.
 *
 * Contract: localStorage stays the source of truth whenever it WORKS — reads go
 * to it first, so a healthy browser behaves byte-identically to before (a
 * sign-out in another tab is still seen on the next read). Only when
 * localStorage THROWS do reads fall back to the in-memory mirror that every
 * write populates. On a storage-blocked device identity is therefore stable for
 * the lifetime of the page: sign in once → every request carries the token →
 * rows land under the real account and persist across visits (the visitor has
 * to sign in again next time, but nothing is lost).
 */

const mem = new Map()
let denied = false

// ── Preview scope (2026-09-28) ───────────────────────────────────────────────
// Every project's editor preview is served from ONE origin
// (whacka.app/api/preview/<id>/proxy), so the identity keys below were shared
// across projects in the builder's browser: a staff-seat login in app A's
// preview (its token is bound to A — src/lib/auth/utils.ts pid) rode into app
// B's preview, the server rejected it (`[Auth] pid-mismatch token rejected`),
// and since the L2 pass stopped trusting the bare account id next to it the
// person was a visitor in B while looking signed in. Six A→B pairs and ~320
// refused requests on the first day it was visible. Published apps each have
// their own origin and never shared anything, so ONLY a preview build (the
// VITE_PREVIEW_TOKEN it alone carries) suffixes these keys with the project
// id; a published bundle keeps the bare names byte for byte — renaming them
// there would sign every visitor out at the next publish.
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
export const PREVIEW_SCOPE = ENV.VITE_PREVIEW_TOKEN && ENV.VITE_PROJECT_ID ? `:${ENV.VITE_PROJECT_ID}` : ''
/** The identity keys (the ones the storage-denied test guards); caches are not scoped. */
export const SCOPED_KEYS = Object.freeze([
  '__whacka_auth_token', '__whacka_auth_user', '__whacka_user_id',
  '__whacka_supabase_token', '__whacka_gate_token', '__whacka_migration_pending',
  // The device identity token (visitor-identity fix 2026-10-31) is bound to the
  // scoped '__whacka_user_id' did, so it MUST be scoped the same way: otherwise
  // one project's preview stores a token for its did under a shared key and the
  // next project's preview (a different scoped did) sends that stale token or
  // none, mixing up identity and dropping bare requests as :claimed. Published
  // apps each have their own origin, so the bare key is already per-app there.
  '__whacka_device_token',
])
/** Pure: the storage name of `key` under `scope` ('' = the bare key). */
export function scopeKey(key, scope) {
  return scope && SCOPED_KEYS.includes(key) ? `${key}${scope}` : key
}
function k(key) { return scopeKey(key, PREVIEW_SCOPE) }

/** Read a key: localStorage first; the memory mirror only when storage throws. */
export function storeGet(key) {
  const name = k(key)
  try {
    return localStorage.getItem(name)
  } catch {
    denied = true
    return mem.has(name) ? mem.get(name) : null
  }
}

/** Write a key to the mirror and (best-effort) to localStorage. */
export function storeSet(key, value) {
  const name = k(key)
  mem.set(name, String(value))
  try { localStorage.setItem(name, value) } catch { denied = true }
}

/** Remove a key from both. */
export function storeRemove(key) {
  const name = k(key)
  mem.delete(name)
  try { localStorage.removeItem(name) } catch { denied = true }
}

/** True once any identity read/write has hit a throwing localStorage. */
export function storageDenied() {
  return denied
}

/** Active probe (a read of a key no one writes). False = this browser blocks site storage. */
export function probeStorage() {
  try {
    localStorage.getItem('__whacka_storage_probe')
    return true
  } catch {
    denied = true
    return false
  }
}

/** Test-only: forget the mirror + the denied flag. */
export function _resetSessionStore() {
  mem.clear()
  denied = false
}
