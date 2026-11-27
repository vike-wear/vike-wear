// ─────────────────────────────────────────────
// Identity-scoped client caches — the sign-out hook (L2 pass, 2026-09-27)
// ─────────────────────────────────────────────
// Two client caches hold rows the server returned for ONE identity: the read
// layer's last-good store (`whacka:lastgood:v1:<uid>`, served during a 429
// cooldown) and useOffline's read cache (`__whacka_offline_readcache_v1:<uid>`,
// shown when a live read fails). Both are keyed by the app-user id so a later
// identity on the same device never reads them — and on sign-out the departing
// identity's entries are removed from the device altogether. auth.js announces
// the sign-out here; the cache owners (db.js, useOffline.js) register their
// clear functions. Dependency-free, so auth.js never has to import the data
// layer or React. Internal: not exposed to generated app code.

const clearers = new Set()

/** Register a clearer: fn(uid) removes everything cached for that identity. */
export function onIdentityCacheClear(fn) {
  if (typeof fn === 'function') clearers.add(fn)
  return () => clearers.delete(fn)
}

/** Called by auth.signOut() with the id that just signed out. Never throws. */
export function clearIdentityCaches(uid) {
  if (!uid) return
  for (const fn of [...clearers]) {
    try { fn(uid) } catch { /* a cache is never worth breaking sign-out over */ }
  }
}
