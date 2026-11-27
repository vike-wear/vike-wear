// Licensing — sell access to THIS app with activation codes and timed trials.
// Server-enforced: entitlements bind to the signed-in identity when present
// (survive device changes), to this device otherwise (lost with browser
// data — have buyers sign in first). Owner mints codes and sells them
// out-of-band (WhatsApp, cash, bank transfer); revoking a code is the refund
// path. Issuing needs a paid owner plan (QUOTA_EXCEEDED otherwise).
//
// Trial lengths are capped SERVER-SIDE: startTrial({ hours }) accepts at most
// 30 days (720h; TRIAL_TOO_LONG above it), a code's trialHours at most a year.
//
// Failures throw the SDK's standard Error: .message = the server's sentence,
// .status, .code — INVALID_CODE / EXPIRED / EXHAUSTED / REVOKED (redeem),
// TRIAL_TOO_LONG, QUOTA_EXCEEDED, OWNER_REQUIRED, RATE_LIMITED …; TIMEOUT /
// NETWORK carry no status (the server never answered).

import { getHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

async function licensesAction(action, params = {}) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/licenses`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ action, ...params }),
  }, { route: 'licenses' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'License request failed', 'licenses')
  return res.json().catch(() => ({}))
}

export const licenses = {
  // ── Buyer side (public) ──

  /** Current caller's entitlement: { licensed, kind, sku, trialEndsAt, all }.
   *  Gate features on THIS — never on localStorage. */
  async check({ sku } = {}) {
    return licensesAction('check', sku ? { sku } : {})
  },

  /** Redeem an activation code (idempotent — re-redeeming a code you already
   *  hold returns the same activation). → { licensed, kind, sku, trialEndsAt,
   *  already }. Failure codes: INVALID_CODE / EXPIRED / EXHAUSTED / REVOKED. */
  async redeem(code) {
    const value = typeof code === 'string' ? code : code?.code
    return licensesAction('redeem', { code: value })
  },

  /** Codeless timed trial: the FIRST call starts the clock server-side; every
   *  later call returns the SAME deadline (clearing browser data does not
   *  restart it for signed-in users). → { licensed, trialEndsAt, already }.
   *  `licensed` reflects ALL of this caller's entitlements — a redeemed code
   *  keeps it true after the trial expires, so gating on it is safe.
   *  `hours` is capped at 30 days (720) server-side — TRIAL_TOO_LONG above it.
   *  Throws QUOTA_EXCEEDED when the app owner's plan has no licensing —
   *  show "not included in the owner's plan", not a network error. */
  async startTrial({ hours } = {}) {
    return licensesAction('startTrial', { hours })
  },

  // ── Owner/admin side (app owner or Teams admin) ──

  /** Mint codes: issue({ sku, label, maxActivations, trialHours, expiresAt,
   *  quantity }) → [{ id, code, ... }]. All fields optional; quantity ≤ 100.
   *  Throws QUOTA_EXCEEDED on a free owner plan (licensing is paid-plan). */
  async issue(opts = {}) {
    const data = await licensesAction('issue', opts)
    return data.licenses
  },

  /** All codes for this app, newest first (owner support screen). Each row:
   *  { id, code, sku, label, maxActivations, activationsCount, trialHours,
   *    expiresAt, revokedAt, createdAt } — a code is revoked iff `revokedAt`
   *  is set (there is no `status`/`revoked` field). */
  async list() {
    const data = await licensesAction('list')
    return data.licenses
  },

  /** One code's activations (who redeemed it, when, trial state) — the ids
   *  feed revoke({ activationId }) for per-seat management. Each row:
   *  { id, subject, activatedAt, trialEndsAt, revokedAt, lastSeenAt }. */
  async listActivations({ licenseId } = {}) {
    const data = await licensesAction('listActivations', { licenseId })
    return data.activations
  },

  /** Revoke one code ({ licenseId }) — kills ALL of its activations — or one
   *  activation ({ activationId }) — locks that person out and frees their
   *  seat for someone else. Irreversible; the out-of-band refund path. */
  async revoke({ licenseId, activationId } = {}) {
    return licensesAction('revoke', { licenseId, activationId })
  },
}
