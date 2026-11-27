/**
 * Payments helper — two tiers:
 *
 * 1. CONNECTED CHECKOUT (preferred): the app owner connects their own Stripe /
 *    PayPal account in the builder; payments.checkout() opens a hosted checkout
 *    on THEIR account, the provider confirms via signed webhook, and the app
 *    unlocks from server-verified records (getEntitlements / hasPurchased /
 *    hasActiveSub). Whacka never holds the money.
 *
 * 2. LEGACY LINK/QR BUILDERS: pure URL / QR-code builders for 5 providers
 *    (Stripe links, Razorpay, MoMo PSB, PayPal.me, Pix). No confirmation —
 *    pair with memberships.js manual admin approval.
 *
 * Pair with memberships.js to record payment intent + gate features on payment
 * confirmation. Typical flow:
 *
 *   // 1) record intent
 *   const pending = await memberships.startPending({ tierId: 'yearly', method: 'stripe' })
 *   // 2) send user to pay
 *   payments.openStripe({ linkUrl: TIER_LINKS.yearly, userId: pending.userId })
 *   // 3) later, admin approves → memberships.approvePending(pending.id)
 *
 * IMPORTANT: whacka never sees the money. The app operator brings their own
 * Stripe / Razorpay / etc. account; this helper only redirects users to the
 * operator's payment-link URL (or generates a local Pix QR payload).
 */

// Explicit .js extensions: keeps this module importable by plain node for
// payments.test.mjs (Vite resolves both forms identically).
import { createClient } from '@supabase/supabase-js'
import { getAppUserId } from './user.js'
import { getHeaders } from './_headers.js'
import { sdkFetch } from './_fetch.js'
import { throwFromResponse, sdkError } from './_errors.js'
import { storeGet, storeSet, storeRemove } from './_session-store.js'
import { absorbSessionRenewal } from './_session-expiry.js'
import { realtimeClientOptions, registerRealtimeClient } from './_realtime-options.js'
import { createChannelShare } from './_realtime-share.js'
import { getSupabaseToken, getRealtimeTokenFor, replaceRefusedToken } from './_supabase-token.js'
import { tokenRefusal } from './_live-broadcast.js'
import { appRealtimeHome } from './_realtime-ask.js'
import { notePageMoved, paymentsTopic, privateChannels, REALTIME_MOVED_EVENT } from './_realtime-home.js'
import { unsubscribeHandle } from './_unsubscribe.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID
// The app's PUBLIC url (custom domain if connected, else {subdomain}.whacka.app).
// Only used to build checkout return URLs in the native shell — see absoluteUrl.
const APP_URL = ENV.VITE_APP_URL || ''

// ─────────────────────────────────────────────
// Connected-checkout helpers (payments bridge)
// ─────────────────────────────────────────────
// The owner connects their own Stripe/PayPal in the builder; checkout() then
// runs on THEIR account and the provider confirms each payment to the server
// via a signed webhook. Entitlements read those server-verified records —
// NEVER mark anything as paid from client state alone.

// Amounts are sent in MAJOR units (4.99 = $4.99). Minor-unit conversion is
// provider-specific per currency and happens ON THE SERVER (which knows the
// routing) — never here. (A client-side map shipped briefly in review and got
// Stripe's KRW/HUF conventions wrong by 100×.)

function isNativeShell() {
  try {
    return !!window.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

// Return URLs the PROVIDER sends the payer back to. checkout() opens the hosted
// page in the SYSTEM browser on native (store-compliance posture below), and
// that browser cannot come back to the webview's own origin — https://localhost
// / capacitor://localhost resolve to nothing outside the app. So on native these
// resolve against the app's public URL instead, which is what the checkout()
// comment has always promised. Same class of bug as the native download 404
// (see download.js, 2026-08-02); web behaviour is byte-identical to before.
// (The server also validates these against the app's own domain — localhost is
// allowlisted for local dev, which is why the broken URLs passed and the payer
// only found out after paying. VITE_APP_URL is baked at build time, so a
// renamed subdomain / detached custom domain stays stale until the next
// Publish re-cuts the bundle.)
function absoluteUrl(pathOrUrl, fallbackParam) {
  const nativeBase = isNativeShell() && APP_URL ? APP_URL : null
  if (pathOrUrl) return new URL(pathOrUrl, nativeBase || window.location.origin).toString()
  // No explicit path: come back to where the payer was. On the web that's the
  // exact current URL; in the native shell the current URL is local-only, so the
  // app's public root is the closest reachable equivalent.
  const u = nativeBase ? new URL(nativeBase) : new URL(window.location.href)
  u.searchParams.set('payment', fallbackParam)
  return u.toString()
}

// Failures throw the SDK's standard Error (.message = the server's sentence,
// .status, .code — e.g. AUTH_REQUIRED, NOT_CONFIGURED, RATE_LIMITED; TIMEOUT /
// NETWORK without a status when the server never answered).
async function readPaymentsApi(view) {
  // A store app whose last verified purchase was a SANDBOX / test one (a
  // TestFlight tester, a Play license tester) reads its test ledger — the same
  // test-vs-live separation the web rails keep, keyed on what this install saw.
  const testEnv = (view === 'entitlements' || view === 'mine') && storeGet(STORE_ENV_KEY) === 'test'
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/payments?view=${view}${testEnv ? '&livemode=0' : ''}`, {
    headers: getHeaders(),
  }, { route: 'payments' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Payments request failed', 'payments')
  return res.json()
}

// ─────────────────────────────────────────────
// Store purchases — the STORE build buys through the store (2026-10-01)
// ─────────────────────────────────────────────
// In the Google Play / App Store build, a DIGITAL product the owner mapped to a
// store product (Integrations → Products & prices, or App stores → Sell inside
// the app) is bought through StoreKit 2 / Play Billing: same payments.checkout
// call, no redirect, the server verifies the store's own proof (Apple's signed
// transaction, Google's purchase token) and writes the same ledger the web
// rails write — hasPurchased / hasActiveSub / onPayment then work unchanged.
// Everything here is guarded: on the web, in the preview, or in an older store
// binary without the purchases plugin, the web path below runs exactly as before.

const STORE_ENV_KEY = 'whacka:store:env'       // 'test' after a sandbox / license-tester purchase
const STORE_PENDING_KEY = 'whacka:store:pending' // purchases the server has not recorded yet
const STORE_CATALOG_TTL_MS = 60_000
let _storeCatalog = null
let _storeCatalogAt = 0
let _storeFlushing = null

function nativePurchases() {
  try {
    const cap = window.Capacitor
    if (!cap?.isNativePlatform?.()) return null
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('NativePurchases')) return null
    return cap.Plugins?.NativePurchases || null
  } catch {
    return null
  }
}

function nativePlatform() {
  try {
    const p = window.Capacitor?.getPlatform?.()
    return p === 'ios' || p === 'android' ? p : null
  } catch {
    return null
  }
}

async function loadStoreCatalog() {
  if (_storeCatalog && Date.now() - _storeCatalogAt < STORE_CATALOG_TTL_MS) return _storeCatalog
  const data = await readPaymentsApi('store')
  _storeCatalog = data && typeof data === 'object' ? data : { products: [] }
  _storeCatalogAt = Date.now()
  return _storeCatalog
}

function storeIdFor(product, platform) {
  if (!product) return null
  return platform === 'ios' ? product.appleProductId || null : product.googleProductId || null
}

// UUID v5 of (project, app user) in the server's namespace
// (src/lib/payments/store/account-token.ts) — the token the purchase is tagged
// with so the server knows who bought from the transaction alone. SHA-1 via
// SubtleCrypto; without it the purchase goes untagged and the link table decides.
const STORE_TOKEN_NAMESPACE = '2f8d4a1e-7c33-4b7e-9a21-5d6c0b9e7f10'
async function storeAccountToken() {
  try {
    const uid = getAppUserId()
    if (!uid || !PROJECT_ID || !globalThis.crypto?.subtle) return null
    const ns = STORE_TOKEN_NAMESPACE.replace(/-/g, '')
    const nsBytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16)
    const name = new TextEncoder().encode(`${PROJECT_ID}:${uid}`)
    const input = new Uint8Array(16 + name.length)
    input.set(nsBytes, 0)
    input.set(name, 16)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input))
    const b = hash.slice(0, 16)
    b[6] = (b[6] & 0x0f) | 0x50
    b[8] = (b[8] & 0x3f) | 0x80
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return null
  }
}

function readPending() {
  try {
    const raw = storeGet(STORE_PENDING_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
function writePending(list) {
  if (!list.length) storeRemove(STORE_PENDING_KEY)
  else storeSet(STORE_PENDING_KEY, JSON.stringify(list.slice(-20)))
}
function pendingKey(e) {
  return `${e.platform}:${e.transactionId || e.purchaseToken || (e.jws || '').slice(-32)}`
}

/** Hand the store's proof to the server. Resolves the server's answer; throws
 *  the SDK error on refusal (a 4xx is final, a network/5xx failure keeps the
 *  entry queued for the next flush). */
async function verifyStorePurchase(entry) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/payments/store/verify`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      platform: entry.platform,
      productId: entry.productId,
      kind: entry.kind,
      jws: entry.jws || undefined,
      purchaseToken: entry.purchaseToken || undefined,
      transactionId: entry.transactionId || undefined,
      source: entry.source || 'device',
    }),
  }, { route: 'payments/store/verify', timeoutMs: 45_000 })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Purchase could not be verified', 'payments/store/verify')
  const data = await res.json().catch(() => ({}))
  if (data && typeof data.livemode === 'boolean') storeSet(STORE_ENV_KEY, data.livemode ? 'live' : 'test')
  return data
}

/** A 202 "pending at Google" answer: nothing recorded yet, keep the proof queued. */
function isPendingAnswer(data) {
  return !!(data && data.ok === false && data.pending)
}

/** Which of the store's listed transactions are worth re-verifying: the live
 *  ones, one per product (the plugin lists the current entitlement first, then
 *  the whole history — older renewals and spent consumables add nothing). */
function restorableTransactions(purchases, platform) {
  const seen = new Set()
  const out = []
  for (const p of purchases || []) {
    if (!p || !p.productIdentifier) continue
    if (platform === 'ios' && (p.isActive === false || p.revocationDate)) continue
    if (seen.has(p.productIdentifier)) continue
    seen.add(p.productIdentifier)
    out.push(p)
  }
  return out
}

/** Retry queued purchases (the device paid but the server never answered). */
async function flushStorePending() {
  if (_storeFlushing) return _storeFlushing
  _storeFlushing = (async () => {
    let list = readPending()
    for (const entry of list.slice()) {
      try {
        const answer = await verifyStorePurchase(entry)
        if (isPendingAnswer(answer)) continue // still pending at the store: ask again next time
        list = list.filter((e) => pendingKey(e) !== pendingKey(entry))
        writePending(list)
      } catch (err) {
        // Final answers (bad proof, another account's purchase, unmapped) stop
        // the retries; anything without a status, or a 5xx, waits for next
        // time — and so does STORE_NOT_READY: the device has paid, the owner's
        // store setup is what is missing, and the record must land once it is
        // finished (a consumable the store already handed over has no other way back).
        if (err && typeof err.status === 'number' && err.status < 500 && err.code !== 'STORE_NOT_READY') {
          list = list.filter((e) => pendingKey(e) !== pendingKey(entry))
          writePending(list)
          console.warn('[payments] store purchase dropped from the retry queue:', err.message)
        }
      }
    }
  })().finally(() => { _storeFlushing = null })
  return _storeFlushing
}

function isUserCancel(err) {
  const m = String(err && (err.message || err.code || err)).toLowerCase()
  return /cancel|user_canceled|usercancel|purchase was canceled|aborted/.test(m)
}

/** Buy a mapped product through the store and record it. */
async function storePurchase(product, platform, np) {
  const productId = storeIdFor(product, platform)
  const isSub = product.mode === 'subscription'
  const purchaseOpts = { productIdentifier: productId, productType: isSub ? 'subs' : 'inapp', quantity: 1 }
  if (platform === 'android') {
    if (isSub) {
      // Play Billing buys a subscription by (product, base plan). The plugin
      // refuses an EMPTY plan but picks the product's first base plan when the
      // given one matches none — so the owner's plan id when set, else the
      // product id itself (= the first base plan, the common single-plan case).
      purchaseOpts.planIdentifier = product.googlePlanId || productId
    } else {
      // One-time products are consumed so the same item can be bought again
      // (credit packs); ownership lives in the Whacka ledger, not in Play's
      // "owned" list, so a restore reads the ledger by account.
      purchaseOpts.isConsumable = true
    }
  }
  const token = await storeAccountToken()
  if (token) purchaseOpts.appAccountToken = token

  await flushStorePending().catch(() => {})
  let tx
  try {
    tx = await np.purchaseProduct(purchaseOpts)
  } catch (err) {
    if (isUserCancel(err)) throw sdkError('Purchase cancelled', { code: 'STORE_CANCELLED', route: 'payments/store', cause: err })
    throw sdkError(`The store could not complete the purchase: ${err && err.message ? err.message : 'unknown error'}`, { code: 'STORE_FAILED', route: 'payments/store', cause: err })
  }
  const entry = {
    platform,
    productId,
    kind: isSub ? 'subscription' : 'payment',
    jws: tx && tx.jwsRepresentation ? tx.jwsRepresentation : null,
    purchaseToken: tx && tx.purchaseToken ? tx.purchaseToken : null,
    transactionId: tx && tx.transactionId ? tx.transactionId : null,
    source: 'device',
    at: Date.now(),
  }
  if ((platform === 'ios' && !entry.jws) || (platform === 'android' && !entry.purchaseToken)) {
    throw sdkError('The store returned no proof of purchase', { code: 'STORE_FAILED', route: 'payments/store' })
  }
  // The device has paid. Queue first, then tell the server: if the network
  // dies here the next call (or launch) finishes the recording.
  writePending([...readPending().filter((e) => pendingKey(e) !== pendingKey(entry)), entry])
  let verified = null
  try {
    verified = await verifyStorePurchase(entry)
    if (isPendingAnswer(verified)) {
      // Google has not completed the payment yet (a slow method): the proof
      // stays queued and is asked about again at the next call / launch.
      return {
        url: null, provider: 'google', store: true, pending: true,
        sku: product.sku, transactionId: entry.transactionId, livemode: null, entitlements: null,
        priceSource: 'store', amount: null, amountMinor: null, currency: null, priceOverridden: false,
      }
    }
    writePending(readPending().filter((e) => pendingKey(e) !== pendingKey(entry)))
  } catch (err) {
    if (err && typeof err.status === 'number' && err.status < 500 && err.code !== 'STORE_NOT_READY') {
      writePending(readPending().filter((e) => pendingKey(e) !== pendingKey(entry)))
      throw err
    }
    // No answer (or the owner's store setup is unfinished): the purchase
    // stands, the record follows when the server can take it.
    return {
      url: null, provider: platform === 'ios' ? 'apple' : 'google', store: true, pending: true,
      sku: product.sku, transactionId: entry.transactionId, livemode: null, entitlements: null,
      priceSource: 'store', amount: null, amountMinor: null, currency: null, priceOverridden: false,
    }
  }
  return {
    url: null, provider: platform === 'ios' ? 'apple' : 'google', store: true, pending: false,
    sku: verified.sku || product.sku, transactionId: verified.transactionId || entry.transactionId,
    livemode: verified.livemode, entitlements: verified.entitlements || null, duplicate: !!verified.duplicate,
    priceSource: 'store', amount: null, amountMinor: null, currency: null, priceOverridden: false,
  }
}

// Launch refresh (store build): subscriptions renew on the STORE's side. Apple
// tells the server by notification; Google only once its notification topic is
// wired on our side. So once per launch the store build re-verifies the
// subscriptions this device holds — idempotent on the server, and a renewed
// subscription is recorded before its old period runs out, whichever store.
let _storeLaunchRefreshed = false
async function refreshStoreSubscriptionsOnce() {
  if (_storeLaunchRefreshed) return
  _storeLaunchRefreshed = true
  const np = nativePurchases()
  const platform = nativePlatform()
  if (!np || !platform) return
  try {
    const res = await np.getPurchases({ productType: 'subs' })
    for (const p of restorableTransactions((res && res.purchases) || [], platform)) {
      // iOS lists every transaction; only renewable ones (an expiry) matter here.
      if (platform === 'ios' && !p.expirationDate) continue
      const entry = {
        platform,
        productId: p.productIdentifier,
        kind: 'subscription',
        jws: p.jwsRepresentation || null,
        purchaseToken: p.purchaseToken || null,
        transactionId: p.transactionId || null,
        source: 'restore',
      }
      if (!entry.productId || (platform === 'ios' && !entry.jws) || (platform === 'android' && !entry.purchaseToken)) continue
      await verifyStorePurchase(entry).catch(() => {})
    }
  } catch { /* a quiet refresh never surfaces */ }
}

// Finish recording anything a previous session paid for but never reported,
// then refresh the subscriptions this device holds.
if (typeof window !== 'undefined') {
  try {
    if (nativePurchases()) {
      if (readPending().length > 0) setTimeout(() => { flushStorePending().catch(() => {}) }, 2500)
      setTimeout(() => { refreshStoreSubscriptionsOnce().catch(() => {}) }, 4000)
    }
  } catch { /* never block module load */ }
}

// ONE realtime client per page for payment pokes (L2 pass, 2026-09-27) — every
// onPayment() used to open its own client and WebSocket, and a component that
// re-mounted a few times left that many sockets behind. Same options and
// re-auth as the other realtime clients; the channel itself is shared by every
// listener and retained for the page lifetime (see _realtime-share.js — the
// same-topic reuse inside supabase-js makes a per-listener channel unsafe).
// Payment pokes are not live data: their drops stay out of the app_data drop
// counters and never trigger the live hooks' resync.
// Cells M2b: the client is built where the app's cell says its Realtime is
// (_realtime-home.js; the bundle's own when the server names none), so it is a promise.
let _paymentsClient = null
let _paymentsHome = null
function getPaymentsClient() {
  if (_paymentsClient) return _paymentsClient
  if (!PROJECT_ID) return Promise.resolve(null)
  _paymentsClient = (async () => {
    const home = await appRealtimeHome()
    if (!home.url || !home.publishableKey) return null
    _paymentsHome = home
    const client = createClient(home.url, home.publishableKey, realtimeClientOptions(home))
    registerRealtimeClient(client, home)
    try {
      const token = home.kid ? getRealtimeTokenFor(home) : getSupabaseToken()
      Promise.resolve(token).then((t) => {
        if (t) client.realtime.setAuth(t).catch(() => {})
      }).catch(() => {})
    } catch { /* token is optional for a public broadcast channel */ }
    return client
  })()
  return _paymentsClient
}
const _joinPaymentsChannel = createChannelShare('[payments]', {
  countDrops: false,
  resync: false,
  // Refused for the token itself (a move changed which Realtime this page is on, cells M4): one fresh token, which the channel's own rejoin carries.
  onChannelError: (err, client) => {
    if (!tokenRefusal(err)) return
    void replaceRefusedToken(_paymentsHome).then((fresh) => {
      if (fresh) Promise.resolve(client.realtime.setAuth(fresh)).catch(() => {})
    }).catch(() => {})
  },
})

// ─────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────

function appendQuery(url, params) {
  if (!url) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    u.searchParams.set(k, String(v))
  }
  return u.toString()
}

function openInNewTab(url) {
  if (typeof window === 'undefined') return url
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    window.location.href = url
  }
  return url
}

function requireUrl(url, provider) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`[payments] ${provider}: linkUrl must be an https URL`)
  }
  return url
}

// ─────────────────────────────────────────────
// Pix — EMV BR-code + CRC16/CCITT-FALSE
// ─────────────────────────────────────────────

// Wraps a value as a TLV (tag + 2-digit length + value).
function tlv(tag, value) {
  const v = String(value)
  const len = v.length.toString().padStart(2, '0')
  return `${tag}${len}${v}`
}

// CRC16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflect, no xor-out.
// This is the exact variant the Pix spec mandates.
function crc16CcittFalse(str) {
  let crc = 0xffff
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff
      else crc = (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

function sanitizeMerchant(str, maxLen) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (BR spec is ASCII-safe)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, maxLen)
    .toUpperCase()
}

function buildPixBrCode({ pixKey, merchantName, merchantCity, amount, description, txId }) {
  if (!pixKey) throw new Error('[payments] Pix: pixKey is required (CPF/CNPJ/email/phone/random key)')
  if (!merchantName) throw new Error('[payments] Pix: merchantName is required')
  if (!merchantCity) throw new Error('[payments] Pix: merchantCity is required')

  const name = sanitizeMerchant(merchantName, 25)
  const city = sanitizeMerchant(merchantCity, 15)
  const tx = String(txId || '***').slice(0, 25) || '***'

  // Merchant Account Info (tag 26): nested TLV
  //   00 = GUI   br.gov.bcb.pix
  //   01 = Pix key
  //   02 = Optional message / description
  let mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', String(pixKey))
  if (description) {
    const desc = String(description).slice(0, 72 - mai.length - 4) // keep mai within field limit
    if (desc) mai += tlv('02', desc)
  }

  let payload = ''
  payload += tlv('00', '01')           // Payload format indicator
  payload += tlv('26', mai)            // Merchant Account Info
  payload += tlv('52', '0000')         // Merchant Category Code (unknown/generic)
  payload += tlv('53', '986')          // Currency BRL
  if (amount != null) {
    const amt = Number(amount).toFixed(2)
    payload += tlv('54', amt)
  }
  payload += tlv('58', 'BR')           // Country code
  payload += tlv('59', name)           // Merchant name
  payload += tlv('60', city)           // Merchant city
  payload += tlv('62', tlv('05', tx))  // Additional data: TxID (tag 05)

  // CRC is computed over payload + '6304' (tag + length of CRC field itself).
  const base = payload + '6304'
  const crc = crc16CcittFalse(base)
  return base + crc
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const payments = {
  // ── Connected checkout (preferred when the owner has connected an account) ──

  /**
   * Send the buyer to a hosted checkout on the OWNER'S connected account.
   * Redirects the page. The payment is confirmed asynchronously by the
   * provider's webhook: unlock via getEntitlements()/hasPurchased() (or
   * onPayment for a live poke) — never by assuming the redirect back means
   * "paid".
   *
   * @example await payments.checkout({ sku: 'pro-pack', name: 'Pro pack', amount: 4.99, currency: 'USD' })
   * @example await payments.checkout({ sku: 'club', name: 'Membership', amount: 7, kind: 'subscription', interval: 'month' })
   *
   * @param {Object} opts
   * @param {string} opts.sku       - Your product id (letters/digits/._-:), the key you check at unlock time
   * @param {string=} opts.name     - Display name on the payment page (default: sku)
   * @param {number} opts.amount    - Price in MAJOR units (4.99 = $4.99). A FALLBACK for skus the
   *                                  owner has not priced in the Integrations panel: when the owner
   *                                  set a price for this sku, THAT price is charged and the result
   *                                  carries priceOverridden:true with the real amount / currency —
   *                                  show those, never the number the code passed.
   * @param {string=} opts.currency - 3-letter ISO, default 'USD' (same fallback rule as amount)
   * @param {number=} opts.quantity - default 1
   * @param {('payment'|'subscription')=} opts.kind - subscription = recurring (Stripe connections only)
   * @param {('day'|'week'|'month'|'year')=} opts.interval - subscription billing interval (default month)
   * @param {('stripe'|'paypal'|'tap'|'moyasar')=} opts.provider - only needed when several rails are connected (Tap=GCC, Moyasar=Saudi SAR)
   * @param {string=} opts.successPath - lands here after paying (default: current page + ?payment=success)
   * @param {string=} opts.cancelPath  - lands here on cancel (default: current page + ?payment=canceled)
   * @param {Object=} opts.metadata    - small string map echoed back on the payment record
   * @param {boolean=} opts.redirect   - false to get {url} back instead of navigating
   * @returns {Promise<{ url, provider, priceSource: 'owner'|'client', amount, amountMinor, currency, priceOverridden }>}
   *   the pricing facts as the server settled them (priceSource 'owner' = the
   *   owner-set price was charged; amount / currency are the charged ones).
   */
  async checkout(opts = {}) {
    // STORE build: a digital product the owner mapped to a store product is
    // bought through the store, right here, no redirect (store purchases,
    // 2026-10-01). A product the owner declared DIGITAL but never mapped for
    // this platform is refused — the store build may not send a digital good
    // to an external checkout (Apple 3.1.1 / Play's billing rule). Anything
    // else (physical goods, undeclared products, the web, an older binary)
    // takes the web path below exactly as before.
    const np = nativePurchases()
    const platform = nativePlatform()
    if (np && platform && typeof opts.sku === 'string' && opts.sku) {
      let catalog = null
      try { catalog = await loadStoreCatalog() } catch { /* the catalog read failed: fall through to the web path */ }
      const product = catalog && Array.isArray(catalog.products) ? catalog.products.find((p) => p.sku === opts.sku) : null
      if (product && storeIdFor(product, platform)) {
        // Never let the store charge for something the server cannot record:
        // the owner's store connection must exist before the sheet opens.
        const ready = platform === 'ios' ? !!(catalog.apple && catalog.apple.ready) : !!(catalog.google && catalog.google.ready)
        if (!ready) {
          throw sdkError(
            'Purchases in this app are not ready yet — the app owner has to finish the store setup (App stores → Sell inside the app)',
            { status: 409, code: 'STORE_NOT_READY', route: 'payments/store', say: 'unavailable' },
          )
        }
        return storePurchase(product, platform, np)
      }
      if (product && product.goods === 'digital') {
        throw sdkError(
          'This item is sold through the app store in this version, but it is not linked to a store product yet — the app owner adds it in App stores → Sell inside the app',
          { status: 409, code: 'STORE_UNMAPPED', route: 'payments/store', say: 'unavailable' },
        )
      }
    }
    const currency = (opts.currency || 'USD').toUpperCase()
    const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/payments/checkout`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        provider: opts.provider,
        kind: opts.kind === 'subscription' ? 'subscription' : 'payment',
        interval: opts.interval,
        sku: opts.sku,
        name: opts.name,
        amount: Number(opts.amount),
        currency,
        quantity: opts.quantity,
        success_url: absoluteUrl(opts.successPath, 'success'),
        cancel_url: absoluteUrl(opts.cancelPath, 'canceled'),
        metadata: opts.metadata,
      }),
    }, { route: 'payments/checkout' })
    absorbSessionRenewal(res)
    // .code: NOT_CONFIGURED (no connected rail), BAD_REQUEST (amount / currency /
    // sku), AUTH_REQUIRED, RATE_LIMITED, PROVIDER_ERROR …
    if (!res.ok) await throwFromResponse(res, 'Checkout failed', 'payments/checkout')
    const data = await res.json().catch(() => ({}))
    const result = {
      url: data.url,
      provider: data.provider,
      // Pricing as the server settled it: the owner-set price (Integrations
      // panel) wins over the amount the app passed — pass the facts through so
      // the app can show the real price.
      priceSource: data.priceSource,
      amount: data.amount,
      amountMinor: data.amountMinor,
      currency: data.currency,
      priceOverridden: data.priceOverridden === true,
    }
    if (result.priceOverridden) {
      console.warn(`[payments] the owner-set price for sku ${opts.sku} was charged instead of the amount the app passed (${opts.amount} ${currency} → ${data.amount} ${data.currency})`)
    }
    if (opts.redirect === false) return result
    // Native shell: checkout opens in the SYSTEM browser, never inside the
    // app's webview. This is the store-compliance line on BOTH platforms —
    // Apple 3.1.3(e) requires external payment for physical goods and bans
    // in-app non-IAP rails for digital content; Google Play mirrors it for
    // digital goods — so app-external is the one posture that's safe for
    // every app (the 2026-07-24 decision). The purchase still lands via
    // entitlements / onPayment; the success page opens on the app's web URL
    // and the app reflects it when the user switches back.
    if (isNativeShell()) {
      const nativeBrowser = window.Capacitor?.Plugins?.Browser
      if (nativeBrowser?.open) {
        await nativeBrowser.open({ url: data.url })
      } else {
        openInNewTab(data.url)
      }
      return result
    }
    // In the editor preview the app runs in a sandboxed iframe WITHOUT
    // allow-top-navigation, and Stripe/PayPal hosted pages refuse to render
    // inside a frame (frame-ancestors deny) — navigating the frame would show
    // a blank refusal page. Open a new tab instead (sandbox allows popups);
    // the purchase still lands via entitlements / onPayment.
    if (window.self !== window.top) {
      openInNewTab(data.url)
    } else {
      window.location.href = data.url
    }
    return result
  },

  /**
   * Server-verified entitlements for the current user.
   * @returns {Promise<{purchases: Array<{sku, count, lastAt}>, subscriptions: Array<{sku, status, periodEnd}>, hasActiveSub: boolean}>}
   */
  async getEntitlements() {
    return readPaymentsApi('entitlements')
  },

  /** True if the current user has a verified purchase of this sku. */
  async hasPurchased(sku) {
    const ent = await readPaymentsApi('entitlements')
    return (ent.purchases || []).some((p) => p.sku === sku && p.count > 0)
  },

  /** True if the current user has an active subscription (past_due counts — paid up to period end). */
  async hasActiveSub(sku) {
    const ent = await readPaymentsApi('entitlements')
    const live = (ent.subscriptions || []).filter((s) => s.status === 'active' || s.status === 'past_due')
    return sku ? live.some((s) => s.sku === sku) : live.length > 0
  },

  /** The current user's own verified payment history (most recent first). */
  async myPayments() {
    const data = await readPaymentsApi('mine')
    return data.payments || []
  },

  /**
   * Which rails the owner has connected. `available` = real confirmed
   * checkout possible; `hostedLink` = a PayPal.me-style link for a simple
   * tip button (no automatic confirmation).
   */
  async status() {
    const data = await readPaymentsApi('status')
    const connections = data.connections || []
    const active = connections.filter((c) => c.status === 'active')
    return {
      connections,
      available: active.some((c) => c.method !== 'paypal_link'),
      hostedLink: active.find((c) => c.method === 'paypal_link')?.hosted_link || null,
    }
  },

  /**
   * Live poke when a payment confirms for this app — re-check the current
   * user's entitlements in the callback. The payload is a bare
   * {type, mode, livemode} poke (deliberately: no buyer/product info is
   * broadcast); it is never proof of anything by itself.
   * @example useEffect(() => payments.onPayment(() => refresh()).unsubscribe, [])
   */
  onPayment(callback) {
    let stopped = false
    let leave = null
    void getPaymentsClient().then((client) => {
      if (stopped || !client) return
      // <app>:payments — private where the app's cell takes private channels only (cells M2b).
      const home = _paymentsHome
      const name = paymentsTopic(home, PROJECT_ID)
      leave = _joinPaymentsChannel(client, name, (fanout) =>
        client.channel(name, privateChannels(home) ? { config: { private: true } } : undefined).on('broadcast', { event: 'payment' }, fanout)
          .on('broadcast', { event: REALTIME_MOVED_EVENT }, () => notePageMoved()),
      (msg) => {
        const payload = msg && msg.payload
        if (stopped || !payload) return
        try { callback(payload) } catch (e) { console.error('[payments] listener error:', e) }
      })
    }).catch(() => {})
    return unsubscribeHandle(() => {
      stopped = true
      if (leave) { try { leave() } catch { /* ignore */ } leave = null }
    })
  },

  /**
   * Parse the ?payment= result after a checkout redirect lands back.
   * @returns {{status: string, orderId: (string|undefined)}|null}
   */
  checkoutResult() {
    const q = new URLSearchParams(window.location.search)
    const status = q.get('payment')
    if (!status) return null
    return { status, orderId: q.get('order') || undefined }
  },

  // ── Store purchases (the Google Play / App Store build) ──

  /**
   * Is this the STORE build, and can it sell through the store? Branch the UI
   * on it: show "Restore purchases" and store prices only when `available`.
   * @returns {Promise<{native: boolean, platform: ('ios'|'android'|null), available: boolean, products: Array<{sku, name, mode, interval, storeProductId}>, reason: (string|null)}>}
   */
  async storeStatus() {
    const np = nativePurchases()
    const platform = nativePlatform()
    if (!platform) return { native: false, platform: null, available: false, products: [], reason: 'web' }
    if (!np) return { native: true, platform, available: false, products: [], reason: 'This version of the app has no store purchases — a newer store build is needed' }
    let catalog
    try { catalog = await loadStoreCatalog() } catch (err) { return { native: true, platform, available: false, products: [], reason: err && err.message ? err.message : 'catalog unavailable' } }
    const ready = platform === 'ios' ? !!(catalog.apple && catalog.apple.ready) : !!(catalog.google && catalog.google.ready)
    const products = (catalog.products || [])
      .filter((p) => storeIdFor(p, platform))
      .map((p) => ({ sku: p.sku, name: p.name, mode: p.mode, interval: p.interval || null, storeProductId: storeIdFor(p, platform) }))
    const available = ready && products.length > 0
    return {
      native: true, platform, available, products,
      reason: available ? null : !ready ? 'The app owner has not finished the store setup for this platform' : 'No products are linked to store products yet',
    }
  },

  /**
   * Localized store prices for the mapped products (what the store will charge
   * this device) — show THESE on a store-build paywall, never the web price.
   * @returns {Promise<Record<string, {price: number, priceString: string, currency: string, title: string}>>} keyed by sku
   */
  async storePrices() {
    const np = nativePurchases()
    const platform = nativePlatform()
    const out = {}
    if (!np || !platform) return out
    const { products } = await payments.storeStatus()
    const bySku = new Map(products.map((p) => [p.storeProductId, p]))
    for (const type of ['inapp', 'subs']) {
      const ids = products.filter((p) => (type === 'subs') === (p.mode === 'subscription')).map((p) => p.storeProductId)
      if (!ids.length) continue
      try {
        const res = await np.getProducts({ productIdentifiers: ids, productType: type })
        for (const sp of (res && res.products) || []) {
          // Android lists a subscription under its BASE PLAN id and carries the
          // product id as planIdentifier; iOS and one-time products use identifier.
          const p = bySku.get(sp.planIdentifier) || bySku.get(sp.identifier)
          if (p) out[p.sku] = { price: sp.price, priceString: sp.priceString, currency: sp.currencyCode, title: sp.title }
        }
      } catch (err) {
        console.warn('[payments] store prices unavailable:', err && err.message ? err.message : err)
      }
    }
    return out
  },

  /**
   * Re-check every purchase this store account made and record the ones this
   * app user is entitled to (a new phone, a reinstall). Apple requires a
   * visible "Restore purchases" button wherever you sell.
   * @returns {Promise<{restored: number, found: number, entitlements: Object|null}>}
   */
  async restorePurchases() {
    const np = nativePurchases()
    const platform = nativePlatform()
    if (!np || !platform) throw sdkError('Restore purchases works in the store app only', { code: 'STORE_UNAVAILABLE', route: 'payments/store', say: 'unavailable' })
    if (platform === 'ios') { try { await np.restorePurchases() } catch { /* AppStore.sync may be refused offline — getPurchases still answers from the device */ } }
    let purchases = []
    try { purchases = ((await np.getPurchases()) || {}).purchases || [] } catch (err) { console.warn('[payments] restore: could not list purchases:', err && err.message ? err.message : err) }
    let restored = 0
    for (const p of restorableTransactions(purchases, platform)) {
      const entry = {
        platform,
        productId: p.productIdentifier,
        kind: p.productType === 'subs' || p.expirationDate ? 'subscription' : 'payment',
        jws: p.jwsRepresentation || null,
        purchaseToken: p.purchaseToken || null,
        transactionId: p.transactionId || null,
        source: 'restore',
      }
      if (!entry.productId || (platform === 'ios' && !entry.jws) || (platform === 'android' && !entry.purchaseToken)) continue
      try {
        await verifyStorePurchase(entry)
        restored++
      } catch (err) {
        console.warn(`[payments] restore skipped ${entry.productId}:`, err && err.message ? err.message : err)
      }
    }
    await flushStorePending().catch(() => {})
    let entitlements = null
    try { entitlements = await readPaymentsApi('entitlements') } catch { /* the caller re-reads */ }
    return { restored, found: purchases.length, entitlements }
  },

  /** Open the store's own subscription management screen (store build only). @returns {Promise<boolean>} */
  async manageSubscriptions() {
    const np = nativePurchases()
    if (!np) return false
    try { await np.manageSubscriptions(); return true } catch { return false }
  },

  // ── Legacy link/QR helpers (no payment confirmation — pair with memberships manual approval) ──

  /**
   * Open a Stripe Payment Link in a new tab. User brings their own link from
   * the Stripe dashboard (Payment Links → Create link). Returns the URL opened
   * so callers can log or test.
   *
   * @param {object} p
   * @param {string} p.linkUrl — https://buy.stripe.com/... from Stripe dashboard
   * @param {string=} p.userId — defaults to getAppUserId(); passed as client_reference_id
   * @param {string=} p.promoCode — Stripe promo code to prefill (optional)
   */
  openStripe({ linkUrl, userId, promoCode } = {}) {
    requireUrl(linkUrl, 'Stripe')
    const uid = userId || getAppUserId()
    const url = appendQuery(linkUrl, {
      client_reference_id: uid,
      prefilled_promo_code: promoCode,
    })
    return openInNewTab(url)
  },

  /**
   * Open a Razorpay Payment Page / Payment Link. User brings the rzp.io/l/...
   * URL from their Razorpay dashboard. userId is attached via notes[userId]
   * (Razorpay convention for custom metadata).
   */
  openRazorpay({ linkUrl, userId } = {}) {
    requireUrl(linkUrl, 'Razorpay')
    const uid = userId || getAppUserId()
    const url = appendQuery(linkUrl, {
      'notes[userId]': uid,
    })
    return openInNewTab(url)
  },

  /**
   * Open an MTN MoMo PSB payment link. User brings a hosted link from MoMo
   * business dashboard. userId is appended as a query param; MoMo typically
   * echoes this back in the payment notification webhook.
   */
  openMomoPsb({ linkUrl, userId } = {}) {
    requireUrl(linkUrl, 'MoMo PSB')
    const uid = userId || getAppUserId()
    const url = appendQuery(linkUrl, {
      reference: uid,
    })
    return openInNewTab(url)
  },

  /**
   * Build a PayPal.me URL and open it. PayPal.me needs only the handle and
   * (optionally) amount + currency. The handle is set by the app operator on
   * paypal.com/paypalme — whacka never holds it.
   *
   * @param {object} p
   * @param {string} p.handle — the PayPal.me handle, e.g. 'johnsmith' (no leading @)
   * @param {number=} p.amount
   * @param {string=} p.currency — 3-letter ISO code, e.g. 'USD', 'CAD', 'EUR'
   */
  openPayPalMe({ handle, amount, currency } = {}) {
    if (!handle) throw new Error('[payments] PayPal.me: handle is required')
    const cleanHandle = String(handle).replace(/^@/, '').replace(/^paypal\.me\//i, '')
    let path = `https://paypal.me/${encodeURIComponent(cleanHandle)}`
    if (amount != null) {
      const amt = Number(amount).toFixed(2)
      path += `/${amt}`
      if (currency) path += String(currency).toUpperCase().slice(0, 3)
    }
    return openInNewTab(path)
  },

  /**
   * Generate a Pix BR-code payload (EMV format). Returns the copy-paste string.
   * The app is responsible for rendering the QR code (recommended lib: qrcode.react).
   *
   * @param {object} p
   * @param {string} p.pixKey — CPF / CNPJ / email / phone / random Pix key
   * @param {string} p.merchantName — ≤ 25 chars, ASCII, uppercased by helper
   * @param {string} p.merchantCity — ≤ 15 chars, ASCII, uppercased by helper
   * @param {number=} p.amount — in BRL; omit for a dynamic-amount code
   * @param {string=} p.description — ≤ 40 chars; shown in payer's banking app
   * @param {string=} p.txId — reference id ≤ 25 chars, default '***'
   * @returns {{ brCode: string, amount: number|null, pixKey: string }}
   */
  generatePix({ pixKey, merchantName, merchantCity, amount, description, txId } = {}) {
    const brCode = buildPixBrCode({ pixKey, merchantName, merchantCity, amount, description, txId })
    return {
      brCode,
      amount: amount != null ? Number(amount) : null,
      pixKey: String(pixKey),
    }
  },
}

// Exposed for internal testing only — not part of the public contract.
export const _internal = { crc16CcittFalse, buildPixBrCode, tlv }
