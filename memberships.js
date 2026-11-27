/**
 * Memberships helper — tiers, pending payments, quotas, referrals.
 *
 * LEGACY (L2 pass, 2026-09-27): this module trusts the CLIENT — the admin check
 * is a client-side comparison, quotas are read-then-written from the browser,
 * and "approved" is whatever a browser wrote into a shared row. Do not use it
 * for money or anything a visitor must not be able to grant themselves: use
 * payments.checkout + payments.getEntitlements() (server-verified by the
 * provider's webhook) and licenses.* (server-enforced) instead. Kept for the
 * apps that already depend on it; no behaviour change.
 *
 * All state lives in `app_data` shared collections with the `__` prefix; no
 * new API routes. Access control uses two mechanisms:
 *   - `_createdBy` on a shared record (built in to data API) — record creator
 *     can update it without groupId.
 *   - groupId bypass — if the record creator isn't the current user, the
 *     current user can still update if they're in the group passed as
 *     groupId. We use this for admin approvals.
 *
 * ADMIN MODEL (v1):
 *   - The first user who calls `configureAdmin()` becomes the admin.
 *   - `configureAdmin()` creates a social group (sole member = admin) and
 *     stores `{ adminUserId, adminGroupId }` in a singleton config record.
 *   - Admin-only operations read the config, verify current user matches
 *     `adminUserId` client-side, and pass `adminGroupId` on the server call
 *     to bypass `_createdBy` on foreign records (e.g. approving a payer's
 *     pending record).
 *   - Only the project creator can approve payments in v1. Multi-admin is a
 *     future extension (add more group members).
 *
 * QUOTA MODEL:
 *   - Each approved membership has a `quotas` object: { [feature]: remaining }.
 *   - `consumeQuota(feature)` does a fetch-then-update: it reads the user's
 *     current membership, decrements the feature counter by 1, and writes it
 *     back. NOT atomic across concurrent tabs of the same user — tolerable
 *     trade-off; if quota matters strictly, the app should rate-limit the
 *     action in UI.
 *   - `resetQuotas()` resets all quotas to the tier's defaults. Apps call
 *     this lazily when they detect period rollover (e.g. on page load check
 *     `expiresAt`).
 *
 * COLLECTIONS USED (all shared, all protected by `__` prefix / token match):
 *   __config_membership   singleton id='singleton'
 *                         { adminUserId, adminGroupId, configuredAt }
 *   __tiers               id = tierId
 *                         { id, name, price, currency, period, quotas, perks }
 *   __memberships         id = 'mem_' + userId
 *                         { userId, tierId, status, startedAt, expiresAt, quotas }
 *   __pending_payments    id = auto
 *                         { userId, tierId, method, note, amount, status,
 *                           createdAt, decidedAt, decidedBy, reason }
 *   __referrals           id = userId
 *                         { userId, code, createdAt }
 *   __referral_claims     id = auto
 *                         { code, referrerId, claimerId, claimedAt }
 */

import { db } from './db'
import { social } from './social'
import { auth } from './auth'
import { getAppUserId } from './user'

const CFG_COLL = '__config_membership'
const CFG_ID = 'singleton'
const TIERS_COLL = '__tiers'
const MEM_COLL = '__memberships'
const PENDING_COLL = '__pending_payments'
const REF_COLL = '__referrals'
const CLAIMS_COLL = '__referral_claims'
const VALID_METHODS = new Set([
  'stripe', 'razorpay', 'momo_psb', 'paypal_me', 'pix', 'crypto', 'e_transfer', 'other',
])
const VALID_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'half_year', 'year', 'lifetime'])

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

const memId = (userId) => `mem_${userId}`

async function loadConfig() {
  const cfg = await db.getShared(CFG_COLL, CFG_ID)
  if (!cfg) {
    throw new Error(
      '[memberships] Not configured. Call memberships.configureAdmin() once as the project creator before using any other membership operation.',
    )
  }
  return cfg
}

function requireSignedIn() {
  const user = auth.getCurrentUser()
  if (!user || !user.id) {
    throw new Error('[memberships] This operation requires a signed-in user. Call auth.signIn() first.')
  }
  return user
}

async function requireAdmin() {
  const user = requireSignedIn()
  const cfg = await loadConfig()
  if (cfg.adminUserId !== user.id) {
    throw new Error('[memberships] Admin-only operation. Only the user who called configureAdmin() can approve / reject / manage tiers.')
  }
  return { user, cfg }
}

function addPeriodMs(period) {
  const day = 86400_000
  switch (period) {
    case 'day': return day
    case 'week': return 7 * day
    case 'month': return 30 * day
    case 'quarter': return 90 * day
    case 'half_year': return 182 * day
    case 'year': return 365 * day
    case 'lifetime': return null
    default: return 30 * day
  }
}

// A short, human-friendly referral code. 3 uppercase letters + '-' + 4 chars
// from an unambiguous alphabet (no 0/O/1/I/L). Stable per user: stored on
// first issue, returned verbatim on repeat calls.
function randomReferralCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const alnum = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const rand = (chars, n) => {
    let out = ''
    const a = new Uint32Array(n)
    crypto.getRandomValues(a)
    for (let i = 0; i < n; i++) out += chars[a[i] % chars.length]
    return out
  }
  return `${rand(letters, 3)}-${rand(alnum, 4)}`
}

// ─────────────────────────────────────────────
// Setup — admin configuration (one-time)
// ─────────────────────────────────────────────

export const memberships = {
  /**
   * Bootstrap the membership system. The caller becomes the sole admin.
   * Idempotent: calling again throws a clear error (config is a singleton).
   *
   * @returns {Promise<{adminUserId, adminGroupId, configuredAt}>}
   */
  async configureAdmin() {
    const user = requireSignedIn()

    // Singleton — if it already exists, refuse rather than silently overwrite.
    const existing = await db.getShared(CFG_COLL, CFG_ID)
    if (existing) {
      if (existing.adminUserId === user.id) return existing
      throw new Error(
        `[memberships] Already configured by another user (${existing.adminUserId}). Admin reassignment is not supported in v1.`,
      )
    }

    const group = await social.createGroup({
      name: '__membership_admins',
      description: 'Auto-created by memberships helper — grants approval authority over pending payments.',
    })
    const adminGroupId = group?.id || group?.groupId || group?.group?.id
    if (!adminGroupId) {
      throw new Error('[memberships] Failed to create admin group; cannot configure.')
    }

    const cfg = {
      adminUserId: user.id,
      adminGroupId,
      configuredAt: new Date().toISOString(),
    }
    return db.insertShared(CFG_COLL, cfg, CFG_ID)
  },

  /**
   * Read current membership config (admin id, admin group id).
   * Returns null if `configureAdmin()` hasn't been called yet.
   */
  async getConfig() {
    return db.getShared(CFG_COLL, CFG_ID)
  },

  // ─────────────────────────────────────────────
  // Tier management (admin only)
  // ─────────────────────────────────────────────

  /**
   * Define (or replace) tier definitions. Idempotent — call again with the
   * same ids to update price / quotas / perks.
   *
   * @param {Array<{id,name,price,currency?,period?,quotas?,perks?}>} tiers
   */
  async defineTiers(tiers) {
    const { cfg } = await requireAdmin()
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new Error('[memberships] defineTiers expects a non-empty array.')
    }
    const out = []
    for (const t of tiers) {
      if (!t.id || !t.name || typeof t.price !== 'number') {
        throw new Error('[memberships] Each tier needs { id, name, price }.')
      }
      const period = t.period || 'month'
      if (!VALID_PERIODS.has(period)) {
        throw new Error(`[memberships] Invalid period "${period}". Use one of: ${[...VALID_PERIODS].join(', ')}.`)
      }
      const row = await db.upsertShared(TIERS_COLL, {
        id: t.id,
        name: t.name,
        price: Number(t.price),
        currency: (t.currency || 'USD').toUpperCase(),
        period,
        quotas: t.quotas && typeof t.quotas === 'object' ? { ...t.quotas } : {},
        perks: Array.isArray(t.perks) ? t.perks.slice(0, 20) : [],
        updatedAt: new Date().toISOString(),
      }, t.id, cfg.adminGroupId)
      out.push(row)
    }
    return out
  },

  /** List all defined tiers (any user). Sorted by ascending price. */
  async listTiers() {
    const rows = await db.selectShared(TIERS_COLL, {}, { limit: 100 })
    return rows.sort((a, b) => (a.price || 0) - (b.price || 0))
  },

  /** Delete a tier by id (admin only). Doesn't affect already-active memberships. */
  async deleteTier(tierId) {
    const { cfg } = await requireAdmin()
    return db.deleteShared(TIERS_COLL, tierId, cfg.adminGroupId)
  },

  // ─────────────────────────────────────────────
  // Pending payment flow
  // ─────────────────────────────────────────────

  /**
   * Record a user's intent to pay. Does NOT redirect — the app should call a
   * payments.* method to send the user to the external payment page, then
   * show them a "I've paid" confirmation that relies on admin approval.
   *
   * Creates both a record in __pending_payments (history) and upserts the
   * user's __memberships record with status='pending'. Either the current
   * user (default) or a named userId (for admin-initiated requests).
   *
   * @param {object} p
   * @param {string} p.tierId — must match a defined tier
   * @param {string} p.method — 'stripe'|'razorpay'|'momo_psb'|'paypal_me'|'pix'|'crypto'|'e_transfer'|'other'
   * @param {string=} p.note — proof text (txn hash, e-transfer reference, etc.)
   * @param {number=} p.amount — what the user expects to pay (for admin reconciliation)
   * @param {string=} p.userId — defaults to getAppUserId()
   */
  async startPending({ tierId, method, note, amount, userId } = {}) {
    // Membership collections are protected — anonymous identity can't write them.
    // We want every payer to have an account on file anyway (for admin
    // approvals, quota tracking, renewal reminders).
    requireSignedIn()
    await loadConfig() // ensures configured
    if (!tierId) throw new Error('[memberships] startPending requires tierId.')
    if (!method || !VALID_METHODS.has(method)) {
      throw new Error(`[memberships] method must be one of: ${[...VALID_METHODS].join(', ')}.`)
    }
    const tier = await db.getShared(TIERS_COLL, tierId)
    if (!tier) throw new Error(`[memberships] Unknown tierId "${tierId}". Define it with defineTiers() first.`)

    const uid = userId || getAppUserId()
    const now = new Date().toISOString()

    // History record — admin approves/rejects this one later.
    const pending = await db.insertShared(PENDING_COLL, {
      userId: uid,
      tierId,
      method,
      note: note ? String(note).slice(0, 500) : null,
      amount: amount != null ? Number(amount) : tier.price,
      currency: tier.currency,
      status: 'pending',
      createdAt: now,
    })

    // Current-membership record — flips to 'active' on approval.
    await db.upsertShared(MEM_COLL, {
      userId: uid,
      tierId,
      status: 'pending',
      startedAt: null,
      expiresAt: null,
      quotas: {},
      pendingId: pending.id,
      updatedAt: now,
    }, memId(uid))

    return pending
  },

  /**
   * List pending payments (admin only). Defaults to status='pending'; pass
   * `{status: 'all'}` to see approved + rejected too.
   */
  async listPending({ status = 'pending' } = {}) {
    await requireAdmin()
    const filter = status === 'all' ? {} : { status }
    return db.selectShared(PENDING_COLL, filter, { limit: 500, order: '-createdAt' })
  },

  /**
   * Approve a pending payment (admin only). Activates the user's membership,
   * sets quotas from the tier, and computes `expiresAt` from the tier period.
   */
  async approvePending(pendingId) {
    const { user, cfg } = await requireAdmin()
    const pending = await db.getShared(PENDING_COLL, pendingId)
    if (!pending) throw new Error(`[memberships] Pending payment ${pendingId} not found.`)
    if (pending.status !== 'pending') {
      throw new Error(`[memberships] Pending payment already ${pending.status}.`)
    }
    const tier = await db.getShared(TIERS_COLL, pending.tierId)
    if (!tier) throw new Error(`[memberships] Tier "${pending.tierId}" no longer exists.`)

    const now = new Date()
    const periodMs = addPeriodMs(tier.period)
    const expiresAt = periodMs == null ? null : new Date(now.getTime() + periodMs).toISOString()

    // Flip pending record to approved — need groupId bypass because we're not
    // the payer (record's _createdBy).
    await db.updateShared(PENDING_COLL, pendingId, {
      status: 'approved',
      decidedAt: now.toISOString(),
      decidedBy: user.id,
    }, cfg.adminGroupId)

    // Activate membership — same reason for groupId (the payer created it).
    await db.updateShared(MEM_COLL, memId(pending.userId), {
      status: 'active',
      tierId: pending.tierId,
      startedAt: now.toISOString(),
      expiresAt,
      quotas: { ...(tier.quotas || {}) },
      updatedAt: now.toISOString(),
    }, cfg.adminGroupId)

    return { approved: true, userId: pending.userId, tierId: pending.tierId, expiresAt }
  },

  /** Reject a pending payment (admin only). Leaves membership in 'pending' state for retry. */
  async rejectPending(pendingId, reason) {
    const { user, cfg } = await requireAdmin()
    const pending = await db.getShared(PENDING_COLL, pendingId)
    if (!pending) throw new Error(`[memberships] Pending payment ${pendingId} not found.`)
    if (pending.status !== 'pending') {
      throw new Error(`[memberships] Pending payment already ${pending.status}.`)
    }

    await db.updateShared(PENDING_COLL, pendingId, {
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: user.id,
      reason: reason ? String(reason).slice(0, 500) : null,
    }, cfg.adminGroupId)

    // Wipe the pending membership so user can retry cleanly.
    await db.updateShared(MEM_COLL, memId(pending.userId), {
      status: 'none',
      tierId: null,
      updatedAt: new Date().toISOString(),
    }, cfg.adminGroupId)

    return { rejected: true, userId: pending.userId }
  },

  // ─────────────────────────────────────────────
  // Membership state + quotas
  // ─────────────────────────────────────────────

  /**
   * Read a user's current membership. Defaults to the signed-in / anonymous
   * caller. Returns null if the user has never started a membership flow.
   *
   * The returned object also carries a `isActive` convenience flag that
   * accounts for `expiresAt`.
   */
  async getCurrent(userId) {
    const uid = userId || getAppUserId()
    const row = await db.getShared(MEM_COLL, memId(uid))
    if (!row) return null
    const now = Date.now()
    const expired = row.expiresAt && Date.parse(row.expiresAt) <= now
    return {
      ...row,
      isActive: row.status === 'active' && !expired,
      isExpired: !!expired,
    }
  },

  /**
   * Decrement a quota counter for a feature. Throws if no active membership
   * or the remaining quota is 0. Returns the new remaining count.
   *
   * Not atomic across concurrent tabs of the same user — for features where
   * exactly-one matters, rate-limit the action in the UI.
   */
  async consumeQuota(feature, userId) {
    requireSignedIn()
    if (!feature) throw new Error('[memberships] consumeQuota: feature name is required.')
    const uid = userId || getAppUserId()
    const row = await db.getShared(MEM_COLL, memId(uid))
    if (!row) throw new Error('[memberships] No membership on file. Call startPending() first.')
    if (row.status !== 'active') throw new Error(`[memberships] Membership is ${row.status}, not active.`)
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
      throw new Error('[memberships] Membership expired. Resubscribe or call resetQuotas() after renewal.')
    }
    const quotas = { ...(row.quotas || {}) }
    const remaining = Number(quotas[feature] ?? 0)
    if (remaining <= 0) {
      throw new Error(`[memberships] No "${feature}" quota remaining.`)
    }
    quotas[feature] = remaining - 1
    await db.updateShared(MEM_COLL, memId(uid), {
      quotas,
      updatedAt: new Date().toISOString(),
    })
    return quotas[feature]
  },

  /**
   * Reset quotas to tier defaults. Generated apps typically call this when
   * they detect a period rollover (e.g. first page load after `expiresAt`,
   * or after a fresh approval extends the period).
   *
   * The caller can reset their own quotas; admin can reset anyone's.
   */
  async resetQuotas(userId) {
    requireSignedIn()
    const uid = userId || getAppUserId()
    const signedIn = auth.getCurrentUser()
    const row = await db.getShared(MEM_COLL, memId(uid))
    if (!row) throw new Error('[memberships] No membership on file.')
    const tier = await db.getShared(TIERS_COLL, row.tierId)
    if (!tier) throw new Error(`[memberships] Tier "${row.tierId}" no longer exists.`)

    // If resetting somebody else, must be admin (needs groupId bypass anyway).
    let groupId
    if (uid !== (signedIn?.id || getAppUserId())) {
      const cfg = await loadConfig()
      if (cfg.adminUserId !== signedIn?.id) {
        throw new Error('[memberships] Resetting another user\'s quotas requires admin.')
      }
      groupId = cfg.adminGroupId
    }

    await db.updateShared(MEM_COLL, memId(uid), {
      quotas: { ...(tier.quotas || {}) },
      updatedAt: new Date().toISOString(),
    }, groupId)
    return { ...tier.quotas }
  },

  // ─────────────────────────────────────────────
  // Referrals
  // ─────────────────────────────────────────────

  /**
   * Get (or create) the referral code owned by the current user. Stable —
   * repeat calls return the same code.
   */
  async issueReferralCode(userId) {
    requireSignedIn()
    const uid = userId || getAppUserId()
    const existing = await db.getShared(REF_COLL, uid)
    if (existing?.code) return existing.code
    const code = randomReferralCode()
    await db.insertShared(REF_COLL, {
      userId: uid,
      code,
      createdAt: new Date().toISOString(),
    }, uid)
    return code
  },

  /** Look up which user owns a given code. Returns null if the code is unknown. */
  async lookupReferralOwner(code) {
    if (!code) return null
    const rows = await db.selectShared(REF_COLL, { code: String(code).toUpperCase() }, { limit: 1 })
    return rows[0]?.userId || null
  },

  /**
   * Register a claim: the current user is joining because of someone else's
   * referral code. Idempotent per (code, claimer) — calling twice is a no-op.
   */
  async claimReferral(code, claimerId) {
    requireSignedIn()
    const uid = claimerId || getAppUserId()
    const referrerId = await this.lookupReferralOwner(code)
    if (!referrerId) throw new Error(`[memberships] Referral code "${code}" not found.`)
    if (referrerId === uid) throw new Error('[memberships] A user cannot claim their own referral code.')
    const existing = await db.selectShared(CLAIMS_COLL, { code: String(code).toUpperCase(), claimerId: uid }, { limit: 1 })
    if (existing[0]) return existing[0]
    return db.insertShared(CLAIMS_COLL, {
      code: String(code).toUpperCase(),
      referrerId,
      claimerId: uid,
      claimedAt: new Date().toISOString(),
    })
  },

  /** Count how many claims a referrer has. */
  async countReferrals(userId) {
    const uid = userId || getAppUserId()
    const res = await db.countShared(CLAIMS_COLL, { referrerId: uid })
    return res.count ?? 0
  },
}
