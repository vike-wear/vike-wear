import { storeGet, storeSet } from './_session-store.js'
import { randomUuid } from './_uuid.js'

const STORAGE_KEY = '__whacka_user_id'
const AUTH_TOKEN_KEY = '__whacka_auth_token'
const AUTH_USER_KEY = '__whacka_auth_user'

/**
 * Get the current user ID for data scoping.
 * - If the user is authenticated (via auth.signIn/signUp), returns their real user ID.
 * - Otherwise, returns an anonymous device-level UUID (created on first visit).
 *
 * This function is used by db.js to scope data per user.
 *
 * Reads go through _session-store: when the browser blocks site storage the
 * identity lives in memory for the page's lifetime instead of being re-minted
 * on every call (taswikpro 2026-09-02).
 */
export function getAppUserId() {
  // Check if user is authenticated first
  try {
    const token = storeGet(AUTH_TOKEN_KEY)
    const userJson = storeGet(AUTH_USER_KEY)
    if (token && userJson) {
      const user = JSON.parse(userJson)
      if (user?.id) return user.id
    }
  } catch {
    // Malformed stored user — fall through to anonymous
  }

  // Fall back to anonymous UUID (persisted when storage allows; page-stable otherwise)
  let id = storeGet(STORAGE_KEY)
  if (!id) {
    id = randomUuid()
    storeSet(STORAGE_KEY, id)
    console.log('[user] New anonymous user created:', id)
  }
  return id
}

/**
 * Start over as a new anonymous visitor (2026-11-01): a fresh device id
 * replaces the stored one. Called only when the server says another browser
 * already holds this id (DEVICE_TAKEN) — this browser can never prove it, and
 * every request under it would be answered as nobody. Returns the new id.
 */
export function startFreshAnonymousId() {
  const id = randomUuid()
  storeSet(STORAGE_KEY, id)
  return id
}

/**
 * Get the anonymous user ID (even when authenticated).
 * Used internally for data migration during sign-up/sign-in.
 */
export function getAnonymousId() {
  return storeGet(STORAGE_KEY) || null
}
