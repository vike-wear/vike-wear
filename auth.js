/**
 * Auth helper — Whacka ID authentication for generated apps.
 * One account across all Whacka apps. auth.signIn() opens a
 * platform-provided modal that handles sign-up, sign-in, and
 * password recovery.
 */

import { showAuthModal } from './auth-modal'
import { clearSupabaseToken } from './_supabase-token'
import { storeGet, storeRemove } from './_session-store'
import { sweepExpiredSession, onSessionExpired } from './_session-expiry'
import { clearIdentityCaches } from './_identity-cache'
import { reauthRealtimeClients } from './_realtime-options'
import { noteIdentityChange } from './_identity-change'

const TOKEN_KEY = '__whacka_auth_token'
const USER_KEY = '__whacka_auth_user'

const listeners = new Set()
let currentUser = null

function getStoredToken() {
  return storeGet(TOKEN_KEY)
}

function getStoredUser() {
  try {
    const raw = storeGet(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function notifyListeners(user) {
  for (const fn of listeners) {
    try { fn(user) } catch (err) { console.error('[auth] Listener error:', err) }
  }
}

// A session whose token already expired boots signed OUT (the store is cleared
// before the user is read); one that expires mid-visit signs out on its next
// request and listeners hear null — same path as auth.signOut().
try { sweepExpiredSession() } catch {}
currentUser = getStoredUser()
onSessionExpired((info) => {
  const prevId = currentUser && currentUser.id
  currentUser = null
  notifyListeners(null)
  // A seat the owner ended (SESSION_ENDED) also leaves no client caches
  // behind — the same hygiene as signOut().
  if (info && info.ended) clearIdentityCaches(prevId)
  // The realtime sockets were authenticated as the expired session — move them
  // to the guest identity the requests now go out as (L2 pass, 2026-09-27).
  void reauthRealtimeClients()
})

// Every identity change (sign-in, sign-out, team seat login, an OAuth return
// adopted in place) re-authenticates the page's realtime clients so RLS on the
// socket follows the identity the requests carry — before this a visitor who
// signed in kept missing group-visible live events until a reload, and a
// signed-out device kept receiving the previous account's stream. The live
// lists and the device's push registration follow the same change
// (_identity-change.js, P11).
function identityChanged() {
  void reauthRealtimeClients()
  noteIdentityChange()
}

export const auth = {
  /**
   * Open the Whacka login modal. Handles sign-up, sign-in, and
   * password recovery in a single flow.
   *
   * @returns {Promise<{ id, email, displayName, avatarUrl } | null>}
   *   Resolves with user object on success, or null if dismissed.
   *
   * @example
   * const user = await auth.signIn()
   * if (user) console.log('Welcome', user.displayName)
   */
  async signIn(options = {}) {
    const before = currentUser
    const result = await showAuthModal(options)
    if (!result) return null

    // Signed-in sessions open the ACCOUNT sheet instead of the login form —
    // the modal reports sign-out / account-deletion back here so listeners
    // (and the app's UI) update without a reload.
    if (result.signedOut || result.accountDeleted) {
      currentUser = null
      notifyListeners(null)
      // Same hygiene as signOut(): the departing identity's client caches leave
      // the device, the sockets move to the guest identity.
      clearIdentityCaches(before && before.id)
      identityChanged()
      return null
    }

    currentUser = result.user
    notifyListeners(currentUser)
    identityChanged()
    return currentUser
  },

  /**
   * Sign out the current user. Clears stored credentials.
   * After sign-out, data operations fall back to anonymous identity.
   */
  signOut() {
    const prevId = currentUser && currentUser.id
    storeRemove(TOKEN_KEY)
    storeRemove(USER_KEY)
    clearSupabaseToken()
    currentUser = null
    notifyListeners(null)
    // Identity-scoped client caches (the read layer's last-good, useOffline's
    // read cache) are removed for the identity that just left — the next person
    // on this device can never be shown them (L2 pass, 2026-09-27).
    clearIdentityCaches(prevId)
    identityChanged()
  },

  /**
   * Get the currently signed-in user, or null.
   * Returns cached data — no network request.
   *
   * @returns {{ id, email, displayName, avatarUrl } | null}
   */
  getCurrentUser() {
    return currentUser
  },

  /**
   * Check if a user is currently signed in.
   * @returns {boolean}
   */
  isAuthenticated() {
    return currentUser !== null && getStoredToken() !== null
  },

  /**
   * Subscribe to auth state changes. Fires immediately with the
   * current state, then again on every sign-in or sign-out.
   *
   * @param {function} callback - Called with user object or null
   * @returns {function} unsubscribe
   *
   * @example
   * const unsub = auth.onAuthChange((user) => {
   *   if (user) console.log('Signed in:', user.email)
   *   else console.log('Signed out')
   * })
   */
  onAuthChange(callback) {
    listeners.add(callback)
    try { callback(currentUser) } catch (err) {
      console.error('[auth] onAuthChange initial callback error:', err)
    }
    return () => listeners.delete(callback)
  },

  /**
   * Is the signed-in user the BUILDER/owner of this app? True only for the person
   * who created the app in Whacka. The builder is automatically the highest-privilege
   * admin of the app's shared data + every group (server-enforced). Use this to gate
   * admin/manager-only UI — it is a UX hint, NOT a security boundary (the server
   * enforces the real privilege independently).
   *
   * @returns {boolean}
   * @example if (auth.isAppOwner()) showManagerControls()
   */
  isAppOwner() {
    const ownerId = import.meta.env.VITE_APP_OWNER_ID
    return !!ownerId && !!currentUser && currentUser.id === ownerId
  },

  /**
   * Get the current auth token (for custom API calls).
   * @returns {string | null}
   */
  getToken() {
    return getStoredToken()
  },
}

/**
 * Adopt an externally-established session. Used by the Teams lib (team.js) after a
 * seat login / accept-invite: it persists the same __whacka_auth_token /
 * __whacka_auth_user keys this module reads, then calls this so auth.getCurrentUser()
 * and onAuthChange() reflect the seat immediately (no reload). The caller writes the
 * token/user/supabase-token first; this only updates the in-memory state + listeners.
 *
 * @param {{ id, email, displayName, avatarUrl } | null} user
 */
export function adoptSession(user) {
  currentUser = user
  notifyListeners(currentUser)
  identityChanged()
}
