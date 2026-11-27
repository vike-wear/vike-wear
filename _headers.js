/**
 * Shared HTTP headers for all preview-template API calls.
 * Ensures consistent auth credentials across db, ai, audio, storage, etc.
 */

// Explicit .js extensions keep this chain importable by plain node for
// share.test.mjs (Vite resolves both forms identically).
import { getAppUserId } from './user.js'
import { getPlatformToken } from './_platform-auth.js'
import { storeGet } from './_session-store.js'
import { sweepExpiredSession, isJwtExpired } from './_session-expiry.js'

const TOKEN_KEY = '__whacka_auth_token'
const GATE_TOKEN_KEY = '__whacka_gate_token'
// The anonymous device identity token minted by _supabase-token.js. Read
// straight from storage (same key) to keep the two SDK modules' imports
// one-way — _supabase-token.js imports getAuthHeaders from here.
const DEVICE_TOKEN_KEY = '__whacka_device_token'

/**
 * Auth headers without Content-Type — use for FormData requests
 * where the browser must set Content-Type with the boundary.
 *
 * @param {Record<string, string>} [extra] - Additional headers to merge
 * @returns {Record<string, string>}
 */
export function getAuthHeaders(extra = {}) {
  const headers = { ...extra }

  // An expired session is a sign-out, not a half-identity: drop it BEFORE the
  // uid is read, so this request goes out as the guest it really is and the app
  // hears onAuthChange(null) (see _session-expiry.js).
  try { sweepExpiredSession() } catch {}

  try {
    const userId = getAppUserId()
    if (userId) headers['X-Whacka-UID'] = userId
  } catch {}

  const pt = getPlatformToken()
  if (pt && !isJwtExpired(pt)) {
    headers['Authorization'] = `Bearer ${pt}`
  } else {
    const token = storeGet(TOKEN_KEY)
    if (token) headers['Authorization'] = `Bearer ${token}`
  }

  const previewToken = ((typeof import.meta !== 'undefined' && import.meta.env) || {}).VITE_PREVIEW_TOKEN
  if (previewToken) {
    headers['X-Whacka-Preview'] = previewToken
  }

  // Private-app access gate: the device pass earned by entering the code /
  // following the magic link. Lets every data/capability call clear the gate.
  const gate = storeGet(GATE_TOKEN_KEY)
  if (gate) headers['X-Whacka-Gate'] = gate

  // Anonymous device identity token (visitor-identity fix 2026-10-31): proves
  // this browser owns its device id, so a harvested id in a bare header no
  // longer acts as the visitor. Harmless when signed in (the server reads
  // Authorization first). Absent until the first guest-token round trip.
  try {
    const device = storeGet(DEVICE_TOKEN_KEY)
    if (device) headers['X-Whacka-Device'] = device
  } catch {}

  // SDK version stamp baked at publish (src/lib/publish/sdk-stamp.ts). The
  // guard counts requests and apps per stamp, so a client-side fix's reach
  // across the fleet can be read off the admin Runtime page (L2 pass, 2026-09-27).
  const sdk = ((typeof import.meta !== 'undefined' && import.meta.env) || {}).VITE_WHACKA_SDK
  if (sdk) headers['X-Whacka-SDK'] = String(sdk).slice(0, 40)

  return headers
}

/**
 * Auth headers with Content-Type: application/json — use for JSON requests.
 *
 * @returns {Record<string, string>}
 */
export function getHeaders() {
  return getAuthHeaders({ 'Content-Type': 'application/json' })
}
