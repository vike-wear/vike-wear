// ─────────────────────────────────────────────
// Who the page acts as — one signal when it changes (delivery ledger P11, 2026-10-19)
// ─────────────────────────────────────────────
// A sign-in, a sign-out, a Teams login, an adopted OAuth session or an expired
// session changes who every data call goes out as (getAppUserId()), without a
// page reload. Before this only the realtime sockets heard about it: the live
// lists kept the previous person's rows on screen, db.subscribe kept filtering
// for the previous person's rows (the new person's own saves never showed),
// and this device's push subscription stayed with whoever was signed in when
// the page loaded (a shop tablet rang with the morning shift's notifications
// all afternoon). auth.js and the expiry paths announce here; useLive.js,
// useOffline.js and push.js follow (db.subscribe reads the identity per event).
//
// `epoch` moves on every change of the data identity; announcing the same
// person again moves nothing. `accountEpoch` moves when a DIFFERENT account
// signs in after one left this page (or replaces one directly) and the app
// root starts over (main.jsx). A sign-out on its own, a guest signing in and
// the same person signing back in keep the screens — what the app shows
// right after a sign-out (its own notice, its own sign-in screen) stays.
// Dependency-free apart from the identity readers; internal, not exposed to
// app code.

import { getAppUserId } from './user.js'
import { storeGet } from './_session-store.js'
import { onSessionExpired } from './_session-expiry.js'

const TOKEN_KEY = '__whacka_auth_token'
const USER_KEY = '__whacka_auth_user'

function readId() {
  try { return getAppUserId() || null } catch { return null }
}
// Signed in with an account (not the device's own guest id).
function signedIn() {
  try { return !!(storeGet(TOKEN_KEY) && storeGet(USER_KEY)) } catch { return false }
}

let current = readId()
let currentIsAccount = signedIn()
let leftId = null // the account that left since the app last started over
let epoch = 0
let accountEpoch = 0
const listeners = new Set()

/** Called after anything that may have changed who is signed in. Never throws. */
export function noteIdentityChange() {
  const next = readId()
  if (next === current) return
  if (currentIsAccount && leftId === null) leftId = current
  current = next
  currentIsAccount = signedIn()
  epoch++
  if (currentIsAccount && leftId !== null) {
    if (next !== leftId) accountEpoch++
    leftId = null
  }
  for (const fn of [...listeners]) {
    try { fn({ epoch, accountEpoch }) } catch { /* a follower never breaks sign-in */ }
  }
}

/** fn({ epoch, accountEpoch }) on every change; returns the unsubscribe. */
export function onIdentityChange(fn) {
  if (typeof fn === 'function') listeners.add(fn)
  return () => listeners.delete(fn)
}

export function identityEpoch() { return epoch }
export function identityAccountEpoch() { return accountEpoch }

// An expiry found before a request, or a seat the owner ended (SESSION_ENDED),
// is a sign-out like any other.
onSessionExpired(() => noteIdentityChange())
