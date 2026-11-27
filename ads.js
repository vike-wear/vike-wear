/**
 * Ads — AdMob in the Google Play / App Store build of this app (2026-10-01).
 *
 * Ads exist ONLY when the app owner added them: the owner pastes the AdMob App
 * IDs and names ad placements with their unit ids (App stores → Show ads, or
 * the chat card the agent can request). The store build is then packaged with
 * the AdMob plugin and the App ID; the web/PWA build, the editor preview and
 * any store build made before the owner configured ads have NO ads — every call
 * here answers false / null there and the app goes on without them.
 *
 *   const ok = await ads.ready()                 // consent (EU/UK) + SDK init, once
 *   await ads.banner('home')                     // bottom banner; ads.hideBanner() / removeBanner()
 *   await ads.interstitial('between-levels')     // full screen at a natural break; resolves when closed
 *   const reward = await ads.rewarded('coins')   // { type, amount } when watched to the end, else null
 *
 * Placement names are the owner's (ads.status().placements lists them). The name
 * 'test' with no owner unit behind it serves Google's sample ads, so a build can
 * be checked before the owner has real unit ids. Rewards are granted on the
 * device — fine for in-app bonuses, not proof for anything worth real money.
 */

import { sdkFetch } from './_fetch.js'
import { getHeaders } from './_headers.js'
import { throwFromResponse } from './_errors.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID

const CONFIG_TTL_MS = 5 * 60_000
let _config = null
let _configAt = 0
let _ready = null
let _bannerShown = false

// Google's published sample unit ids — always serve test ads, never pay.
const TEST_UNITS = {
  ios: { banner: 'ca-app-pub-3940256099942544/2934735716', interstitial: 'ca-app-pub-3940256099942544/4411468910', rewarded: 'ca-app-pub-3940256099942544/1712485313' },
  android: { banner: 'ca-app-pub-3940256099942544/6300978111', interstitial: 'ca-app-pub-3940256099942544/1033173712', rewarded: 'ca-app-pub-3940256099942544/5224354917' },
}

function plugin() {
  try {
    const cap = window.Capacitor
    if (!cap?.isNativePlatform?.()) return null
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('AdMob')) return null
    return cap.Plugins?.AdMob || null
  } catch {
    return null
  }
}

function platform() {
  try {
    const p = window.Capacitor?.getPlatform?.()
    return p === 'ios' || p === 'android' ? p : null
  } catch {
    return null
  }
}

async function loadConfig() {
  if (_config && Date.now() - _configAt < CONFIG_TTL_MS) return _config
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/ads`, { headers: getHeaders() }, { route: 'ads' })
  if (!res.ok) await throwFromResponse(res, 'Ads configuration unavailable', 'ads')
  const data = await res.json().catch(() => ({}))
  _config = data && typeof data === 'object' ? data : { enabled: false, units: {} }
  _configAt = Date.now()
  return _config
}

/** The unit this placement resolves to on this platform, or Google's sample for 'test'. */
function unitFor(cfg, name, kind, plat) {
  const u = cfg && cfg.units && cfg.units[name]
  const id = u && u[plat]
  if (id) return { adId: id, isTesting: false }
  if (name === 'test') return { adId: TEST_UNITS[plat][kind], isTesting: true }
  return null
}

async function ensureReady(ad) {
  if (!_ready) {
    _ready = (async () => {
      // EU/UK consent through Google's own form when it says one is required;
      // elsewhere this returns NOT_REQUIRED at once. No tracking prompt: ads
      // serve without the advertising identifier.
      try {
        const info = await ad.requestConsentInfo()
        if (info && info.isConsentFormAvailable && info.status === 'REQUIRED') await ad.showConsentForm()
      } catch (err) {
        console.warn('[ads] consent step skipped:', err && err.message ? err.message : err)
      }
      await ad.initialize({})
      return true
    })().catch((err) => {
      _ready = null
      throw err
    })
  }
  return _ready
}

async function prepared(name, kind) {
  const ad = plugin()
  const plat = platform()
  if (!ad || !plat) return null
  let cfg
  try { cfg = await loadConfig() } catch { return null }
  const enabled = cfg && cfg.appIds && cfg.appIds[plat]
  if (!enabled) return null
  const unit = unitFor(cfg, name, kind, plat)
  if (!unit) {
    console.warn(`[ads] no ${kind} unit named "${name}" for ${plat} — the owner adds it in App stores → Show ads`)
    return null
  }
  try { await ensureReady(ad) } catch (err) { console.warn('[ads] not ready:', err && err.message ? err.message : err); return null }
  return { ad, unit, plat }
}

function once(ad, eventName, timeoutMs) {
  return new Promise((resolve) => {
    let handle = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { handle && handle.remove && handle.remove() } catch { /* ignore */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    Promise.resolve(ad.addListener(eventName, (payload) => finish(payload === undefined ? null : payload)))
      .then((h) => { handle = h; if (done) { try { h && h.remove && h.remove() } catch { /* ignore */ } } })
      .catch(() => finish(undefined))
  })
}

export const ads = {
  /**
   * Where ads stand for THIS install.
   * @returns {Promise<{native: boolean, platform: ('ios'|'android'|null), available: boolean, placements: string[], reason: (string|null)}>}
   */
  async status() {
    const plat = platform()
    if (!plat) return { native: false, platform: null, available: false, placements: [], reason: 'web' }
    const ad = plugin()
    if (!ad) return { native: true, platform: plat, available: false, placements: [], reason: 'This version of the app was built without ads' }
    let cfg
    try { cfg = await loadConfig() } catch (err) { return { native: true, platform: plat, available: false, placements: [], reason: err && err.message ? err.message : 'configuration unavailable' } }
    const enabled = !!(cfg.appIds && cfg.appIds[plat])
    const placements = Object.keys(cfg.units || {}).filter((n) => cfg.units[n] && cfg.units[n][plat])
    return { native: true, platform: plat, available: enabled, placements, reason: enabled ? null : 'The app owner has not set up AdMob for this platform' }
  },

  /** Initialise the ads SDK (consent first where required). Safe to call often. @returns {Promise<boolean>} */
  async ready() {
    const ad = plugin()
    if (!ad || !platform()) return false
    try {
      const cfg = await loadConfig()
      if (!(cfg.appIds && cfg.appIds[platform()])) return false
      await ensureReady(ad)
      return true
    } catch {
      return false
    }
  },

  /**
   * Show a banner (anchored, adaptive width). Leave room for it in the layout
   * (about 60px) at the chosen edge.
   * @param {string=} name placement name (default 'banner')
   * @param {{position?: ('top'|'bottom')}=} opts
   * @returns {Promise<boolean>} shown
   */
  async banner(name = 'banner', opts = {}) {
    const p = await prepared(name, 'banner')
    if (!p) return false
    try {
      await p.ad.showBanner({ adId: p.unit.adId, isTesting: p.unit.isTesting, adSize: 'ADAPTIVE_BANNER', position: opts.position === 'top' ? 'TOP_CENTER' : 'BOTTOM_CENTER', margin: 0 })
      _bannerShown = true
      return true
    } catch (err) {
      console.warn('[ads] banner failed:', err && err.message ? err.message : err)
      return false
    }
  },

  /** Hide the banner (keeps it loaded). @returns {Promise<boolean>} */
  async hideBanner() {
    const ad = plugin()
    if (!ad || !_bannerShown) return false
    try { await ad.hideBanner(); return true } catch { return false }
  },

  /** Show a hidden banner again. @returns {Promise<boolean>} */
  async resumeBanner() {
    const ad = plugin()
    if (!ad || !_bannerShown) return false
    try { await ad.resumeBanner(); return true } catch { return false }
  },

  /** Remove the banner entirely. @returns {Promise<boolean>} */
  async removeBanner() {
    const ad = plugin()
    if (!ad || !_bannerShown) return false
    try { await ad.removeBanner(); _bannerShown = false; return true } catch { return false }
  },

  /**
   * Full-screen ad at a natural pause (after a level, between steps). Resolves
   * when the person closes it — never block anything they need on it.
   * @param {string=} name placement name (default 'interstitial')
   * @returns {Promise<boolean>} shown
   */
  async interstitial(name = 'interstitial') {
    const p = await prepared(name, 'interstitial')
    if (!p) return false
    try {
      await p.ad.prepareInterstitial({ adId: p.unit.adId, isTesting: p.unit.isTesting })
      const dismissed = once(p.ad, 'interstitialAdDismissed', 120_000)
      await p.ad.showInterstitial()
      await dismissed
      return true
    } catch (err) {
      console.warn('[ads] interstitial failed:', err && err.message ? err.message : err)
      return false
    }
  },

  /**
   * Rewarded video: the person chooses to watch, and earns the reward only if
   * they watch to the end. Grant the bonus when this resolves non-null.
   * @param {string=} name placement name (default 'rewarded')
   * @returns {Promise<{type: string, amount: number}|null>}
   */
  async rewarded(name = 'rewarded') {
    const p = await prepared(name, 'rewarded')
    if (!p) return null
    try {
      await p.ad.prepareRewardVideoAd({ adId: p.unit.adId, isTesting: p.unit.isTesting })
      const rewardEvent = once(p.ad, 'onRewardedVideoAdReward', 180_000)
      const dismissed = once(p.ad, 'onRewardedVideoAdDismissed', 180_000)
      const shown = await p.ad.showRewardVideoAd()
      // The plugin resolves show() with the reward on most versions; the event
      // is the fallback. Either way wait for the close so the UI resumes after.
      const fromEvent = await Promise.race([rewardEvent, dismissed.then(() => undefined)])
      const reward = (shown && typeof shown === 'object' && 'type' in shown) ? shown : fromEvent
      await dismissed
      if (reward && typeof reward === 'object') return { type: String(reward.type || 'reward'), amount: Number(reward.amount) || 1 }
      return null
    } catch (err) {
      console.warn('[ads] rewarded failed:', err && err.message ? err.message : err)
      return null
    }
  },
}
