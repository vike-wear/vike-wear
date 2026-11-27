/**
 * Push Notifications helper — request permissions, subscribe to push,
 * and send notifications to app users.
 *
 * Failures of send / broadcast / sendToGroup / sendToRole / sendToAdmins /
 * schedule / cancelSchedule throw the SDK's standard Error: .message = the
 * server's sentence, .status, .code — NOT_ALLOWED (a stranger's userId),
 * OWNER_REQUIRED / FORBIDDEN (broadcast / group sends), INVALID_SOUND,
 * INVALID_REPEAT, BAD_REQUEST, QUOTA_EXCEEDED (subscriber ceiling), DAILY_LIMIT,
 * RATE_LIMITED …; TIMEOUT / NETWORK carry no status (the server never answered).
 * subscribe() keeps its boolean contract: false on any failure, with the code
 * in a console.warn.
 */

import { getAppUserId } from './user'
import { getHeaders } from './_headers'
import { PUSH_SOUND_IDS, pushSoundChannels } from './_push-sounds'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { resolveFaceLang } from './_lang.js'
import { onIdentityChange } from './_identity-change'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// A broadcast fans out to every subscriber server-side before it answers.
const SEND_TIMEOUT_MS = 60_000

// One request path for the push routes (L2 pass, 2026-09-27).
async function pushRequest(path, init, { timeoutMs, fallback } = {}) {
  const route = `push/${path}`
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/push/${path}`, init, { timeoutMs, route })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, route)
  return res.json()
}

function warnSubscribeFailure(err) {
  console.warn('[push] subscribe failed' + (err && err.code ? ` (${err.code})` : ''), (err && err.message) || err)
}

let vapidPublicKey = null

// ─────────────────────────────────────────────
// Native shell (Capacitor) adapter — the Android WebView has NO Web Push API
// (no window.Notification / PushManager), so inside the native shell the
// FCM plugin takes over: same push.* surface, native transport. Detected at
// call time so one bundle serves web + native (OTA parity). All guarded —
// on the web every helper returns null and the web paths run unchanged.
// ─────────────────────────────────────────────

function nativePush() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      return window.Capacitor.Plugins?.PushNotifications || null
    }
  } catch { /* web */ }
  return null
}

const NATIVE_PERM_KEY = '__whacka_push_perm'
function nativeCachedPermission() {
  try { return localStorage.getItem(NATIVE_PERM_KEY) || 'default' } catch { return 'default' }
}
function nativeRememberPermission(receive) {
  const state = receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'default'
  try { localStorage.setItem(NATIVE_PERM_KEY, state) } catch { /* ignore */ }
  return state
}

async function nativeSubscribe(pn) {
  try {
    let perm = await pn.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await pn.requestPermissions()
    }
    nativeRememberPermission(perm.receive)
    if (perm.receive !== 'granted') {
      console.warn('[push] Notification permission not granted')
      return false
    }
    // register() resolves out-of-band via the 'registration' event. The two
    // listeners are removed once it answers — this runs again on every change
    // of who is signed in (P11), and each run would otherwise leave two behind.
    const token = await new Promise((resolve, reject) => {
      let done = false
      const handles = []
      const finish = (fn, v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const h of handles) Promise.resolve(h).then((x) => x && x.remove && x.remove()).catch(() => {})
        fn(v)
      }
      const timer = setTimeout(() => finish(reject, new Error('push registration timed out')), 20000)
      handles.push(pn.addListener('registration', (t) => finish(resolve, t.value)))
      handles.push(pn.addListener('registrationError', (e) => finish(reject, new Error((e && e.error) || 'registration error'))))
      pn.register()
    })
    // Reuses the existing subscription row shape: a synthetic {lane}://
    // endpoint satisfies the endpoint-keyed upsert/dedupe; the sender fans
    // out on subscription.type. The token is whatever the OS gave the plugin:
    // FCM registration token on Android, RAW APNs device token on iOS (no
    // Firebase in the iOS shell) — routing them into the wrong lane sends
    // garbage, so the lane is keyed off the platform.
    let lane = 'fcm'
    try { if (window.Capacitor?.getPlatform?.() === 'ios') lane = 'apns' } catch { /* default android */ }
    // The binary's build number (Android versionCode / iOS CFBundleVersion).
    // The server sends a library SOUND (channel id) only to Android builds it
    // knows carry the sound files — an older binary would play nothing.
    let nativeBuild
    try {
      const info = await window.Capacitor?.Plugins?.App?.getInfo?.()
      const n = Number(info?.build)
      if (Number.isFinite(n) && n > 0) nativeBuild = n
    } catch { /* old shell without the App plugin — no sound, default tone */ }
    await pushRequest('subscribe', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        subscription: { endpoint: `${lane}://${token}`, type: lane, token, ...(nativeBuild ? { nativeBuild } : {}) },
        userId: getAppUserId(),
      }),
    }, { fallback: 'Failed to register subscription' })
    console.log(`[push] Subscribed successfully (native ${lane})`)
    return true
  } catch (err) {
    warnSubscribeFailure(err)
    return false
  }
}

// Notification tap → in-app navigation (the native analog of the service
// worker's notificationclick). Registered once at module load, native only.
;(() => {
  const pn = nativePush()
  if (!pn) return
  try {
    pn.addListener('pushNotificationActionPerformed', (action) => {
      try {
        const url = action?.notification?.data?.url
        if (typeof url === 'string' && url.startsWith('/')) window.location.href = url
      } catch { /* never break the app on a tap */ }
    })
  } catch { /* plugin absent (old binary) */ }
})()

// Sound channels (Android only). On Android 8+ a notification's sound comes
// from its CHANNEL, so the shell must own one channel per library sound
// BEFORE the first message names it (a message addressed to a channel that
// does not exist falls back to the default channel = default tone). Creating
// an existing channel is a no-op for its sound (immutable per channel id), so
// this runs on every launch. iOS has no channels — aps.sound names the file.
;(() => {
  const pn = nativePush()
  if (!pn) return
  try { if (window.Capacitor?.getPlatform?.() !== 'android') return } catch { return }
  try {
    for (const ch of pushSoundChannels()) {
      const p = pn.createChannel?.(ch)
      if (p && typeof p.catch === 'function') p.catch(() => { /* old binary without res/raw — default tone */ })
    }
  } catch { /* never break the app over a channel */ }
})()

// True inside the native shell — the ONLY runtime where `sound` is honored.
function nativeSoundCapable() {
  return Boolean(nativePush())
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

async function getVapidKey() {
  if (vapidPublicKey) return vapidPublicKey
  const res = await sdkFetch(`${API_BASE}/api/app/push/vapid`, {}, { route: 'push/vapid' })
  if (!res.ok) await throwFromResponse(res, 'Push notifications not available', 'push/vapid')
  const data = await res.json()
  vapidPublicKey = data.publicKey
  return vapidPublicKey
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

async function getServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser')
  }
  const registration = await navigator.serviceWorker.ready
  return registration
}

// diagnose() hints — human-readable guidance apps surface verbatim, so it is
// localized like every other platform-authored end-user string.
const DIAGNOSE_HINTS = {
  en: {
    preview: 'This is the Whacka editor preview — push notifications cannot be tested here. Publish the app, open its own URL, add it to your Home Screen, then enable notifications.',
    unsupported: 'This browser does not support push notifications. Use Chrome on Android, or Safari on iPhone (iOS 16.4+).',
    ios_needs_install: 'On iPhone/iPad, add this app to your Home Screen (Share → Add to Home Screen) and open it from the new icon before enabling notifications.',
    denied: 'Notifications are blocked. Re-enable them for this app in your browser or system settings.',
    needs_permission: 'Tap to enable notifications.',
    works_better_installed: 'Notifications are on. For the most reliable delivery, add the app to your Home Screen.',
    ok: '',
  },
  ar: {
    preview: 'هذه معاينة محرر Whacka — لا يمكن اختبار الإشعارات هنا. انشر التطبيق، افتح رابطه الخاص، أضفه إلى الشاشة الرئيسية ثم فعّل الإشعارات.',
    unsupported: 'هذا المتصفح لا يدعم الإشعارات. استخدم Chrome على أندرويد، أو Safari على آيفون (iOS 16.4 أو أحدث).',
    ios_needs_install: 'على آيفون/آيباد، أضف هذا التطبيق إلى الشاشة الرئيسية (مشاركة ← إضافة إلى الشاشة الرئيسية) وافتحه من الأيقونة الجديدة قبل تفعيل الإشعارات.',
    denied: 'الإشعارات محظورة. أعد تفعيلها لهذا التطبيق من إعدادات المتصفح أو النظام.',
    needs_permission: 'اضغط لتفعيل الإشعارات.',
    works_better_installed: 'الإشعارات مفعّلة. لتوصيل أكثر موثوقية، أضف التطبيق إلى الشاشة الرئيسية.',
    ok: '',
  },
  pt: {
    preview: 'Esta é a prévia do editor do Whacka — as notificações não podem ser testadas aqui. Publique o app, abra o link dele, adicione-o à Tela de Início e então ative as notificações.',
    unsupported: 'Este navegador não suporta notificações. Use o Chrome no Android ou o Safari no iPhone (iOS 16.4 ou mais recente).',
    ios_needs_install: 'No iPhone/iPad, adicione este app à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra pelo novo ícone antes de ativar as notificações.',
    denied: 'As notificações estão bloqueadas. Ative-as de novo para este app nas configurações do navegador ou do sistema.',
    needs_permission: 'Toque para ativar as notificações.',
    works_better_installed: 'As notificações estão ativadas. Para receber com mais confiabilidade, adicione o app à Tela de Início.',
    ok: '',
  },
  es: {
    preview: 'Esta es la vista previa del editor de Whacka — las notificaciones no se pueden probar aquí. Publica la app, abre su propio enlace, añádela a la pantalla de inicio y luego activa las notificaciones.',
    unsupported: 'Este navegador no admite notificaciones. Usa Chrome en Android o Safari en iPhone (iOS 16.4 o posterior).',
    ios_needs_install: 'En iPhone/iPad, añade esta app a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) y ábrela desde el nuevo ícono antes de activar las notificaciones.',
    denied: 'Las notificaciones están bloqueadas. Vuelve a activarlas para esta app en la configuración del navegador o del sistema.',
    needs_permission: 'Toca para activar las notificaciones.',
    works_better_installed: 'Las notificaciones están activadas. Para recibirlas de forma más confiable, añade la app a la pantalla de inicio.',
    ok: '',
  },
}

// ─────────────────────────────────────────────
// PWA install — capture beforeinstallprompt at module load so we can
// trigger the native install dialog from a user gesture later.
// Fires at most once per page load on Chromium browsers; never on iOS Safari.
// ─────────────────────────────────────────────

let deferredInstallPrompt = null

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstallPrompt = e
  })
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
  })
}

function detectIsIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports as Mac — disambiguate via touch support
  if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true
  return false
}

function detectIsInstalled() {
  if (typeof window === 'undefined') return false
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
  const iosStandalone = window.navigator.standalone === true
  return Boolean(standalone || iosStandalone)
}

// True when the app is running inside the Whacka editor preview (an iframe),
// as opposed to the published, top-level app. Push notifications cannot be
// tested here — permission and the push subscription belong to the published
// app's own origin, not the editor.
function isEmbedded() {
  if (typeof window === 'undefined') return true
  try {
    return window.self !== window.top
  } catch {
    // Cross-origin access throws — that only happens when embedded.
    return true
  }
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// Format an absolute instant as a wall-clock string 'YYYY-MM-DDTHH:MM:SS' in
// the given IANA timezone. en-CA yields the YYYY-MM-DD ordering; hourCycle h23
// avoids rendering midnight as "24".
function wallClockInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

// Matches an ISO string that carries a zone designator (…Z or …+08:00) — i.e.
// an absolute instant, such as anything produced by Date.prototype.toISOString().
const ABSOLUTE_INSTANT_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

// Normalises the many ways a caller might express `at` into the wall-clock
// string + timezone the schedule endpoint expects. This is the safeguard that
// makes `at: someDate` and `at: someDate.toISOString()` fire at the SAME
// instant — without it, passing a UTC string fires hours off.
//
//  - Date            → wall-clock in the target timezone
//  - number (epoch)  → wall-clock in the target timezone
//  - ISO with Z/offset (absolute instant) → wall-clock in the target timezone
//  - plain 'YYYY-MM-DDTHH:MM:SS' (no zone) → used as-is (already local)
function normalizeSchedule(at, timezone) {
  const tz = timezone || localTimezone()

  let instant = null
  if (at instanceof Date) {
    instant = at
  } else if (typeof at === 'number') {
    instant = new Date(at)
  } else if (typeof at === 'string') {
    const trimmed = at.trim()
    if (ABSOLUTE_INSTANT_RE.test(trimmed)) {
      const d = new Date(trimmed)
      if (!isNaN(d.getTime())) instant = d
    } else {
      // Already a local wall-clock string — pass through unchanged.
      return { at: trimmed, timezone: tz }
    }
  }

  if (!instant || isNaN(instant.getTime())) {
    throw new Error('push.schedule: "at" must be a Date, epoch ms, or a local "YYYY-MM-DDTHH:MM:SS" string')
  }
  return { at: wallClockInTimezone(instant, tz), timezone: tz }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const push = {
  /**
   * Check if push notifications are supported in this browser.
   * @returns {boolean}
   */
  isSupported() {
    if (nativePush()) return true
    return 'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
  },

  /**
   * Whether the app is currently running as an installed PWA
   * (launched from Home Screen / app icon, not in a browser tab).
   * On iOS, push notifications ONLY work when installed.
   * @returns {boolean}
   */
  isInstalled() {
    // Native shell IS an installed app — the PWA display-mode heuristics
    // below read false inside a WebView and send apps down the
    // add-to-home-screen dead end (bit GlowRun's reminder card 2026-07-24:
    // the push doc teaches isInstalled() gating, so EVERY app following the
    // documented pattern hits this without the short-circuit).
    if (nativePush()) return true
    return detectIsInstalled()
  },

  /**
   * Whether this device is iOS (iPhone/iPad).
   * iOS requires the user to manually "Add to Home Screen" via Safari Share —
   * there is no browser API to trigger install. Use this to branch your UX.
   * @returns {boolean}
   */
  isIOS() {
    return detectIsIOS()
  },

  /**
   * Whether the browser has offered native install capability for this app.
   * True on Android Chrome / Edge after `beforeinstallprompt` has fired.
   * Always false on iOS Safari (no such API exists).
   * @returns {boolean}
   */
  canInstall() {
    return deferredInstallPrompt !== null
  },

  /**
   * Trigger the native install prompt (Android/Chromium only).
   * Must be called from a user gesture (button click).
   * Returns 'accepted' | 'dismissed' | 'unavailable'.
   * The prompt can only be shown once per page load — check canInstall() first.
   * @returns {Promise<'accepted' | 'dismissed' | 'unavailable'>}
   */
  async promptInstall() {
    if (!deferredInstallPrompt) return 'unavailable'
    try {
      const evt = deferredInstallPrompt
      deferredInstallPrompt = null // consumed after prompt()
      evt.prompt()
      const choice = await evt.userChoice
      return choice.outcome === 'accepted' ? 'accepted' : 'dismissed'
    } catch (err) {
      console.warn('[push] Install prompt error:', err)
      return 'unavailable'
    }
  },

  /**
   * Get the current notification permission state.
   * @returns {'granted' | 'denied' | 'default'}
   */
  getPermission() {
    // Native: checkPermissions is async, this API is sync — serve the cached
    // state (updated by requestPermission/subscribe; fresh installs 'default').
    if (nativePush()) return nativeCachedPermission()
    if (!('Notification' in window)) return 'denied'
    return Notification.permission
  },

  /**
   * Request permission to show notifications.
   * Returns the permission state after the request.
   *
   * @returns {Promise<'granted' | 'denied' | 'default'>}
   *
   * @example
   * const permission = await push.requestPermission()
   * if (permission === 'granted') {
   *   await push.subscribe()
   * }
   */
  async requestPermission() {
    const pn = nativePush()
    if (pn) {
      const r = await pn.requestPermissions()
      const state = nativeRememberPermission(r.receive)
      console.log('[push] Permission (native):', state)
      return state
    }
    if (!('Notification' in window)) return 'denied'
    const result = await Notification.requestPermission()
    console.log('[push] Permission:', result)
    return result
  },

  /**
   * Subscribe this device to push notifications for this app.
   * Must call requestPermission() first and get 'granted'.
   * The subscription is stored on the server for later use.
   *
   * @returns {Promise<boolean>} true if subscribed successfully
   *
   * @example
   * const permission = await push.requestPermission()
   * if (permission === 'granted') {
   *   const ok = await push.subscribe()
   *   if (ok) console.log('Subscribed to push!')
   * }
   */
  async subscribe() {
    const pn = nativePush()
    if (pn) return nativeSubscribe(pn)

    if (!push.isSupported()) {
      console.warn('[push] Push notifications not supported')
      return false
    }

    if (Notification.permission !== 'granted') {
      console.warn('[push] Notification permission not granted')
      return false
    }

    try {
      const publicKey = await getVapidKey()
      const registration = await getServiceWorkerRegistration()

      // Check for existing subscription
      let subscription = await registration.pushManager.getSubscription()

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
      }

      // Send subscription to server
      const userId = getAppUserId()
      await pushRequest('subscribe', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ subscription: subscription.toJSON(), userId }),
      }, { fallback: 'Failed to register subscription' })

      console.log('[push] Subscribed successfully')
      return true
    } catch (err) {
      warnSubscribeFailure(err)
      return false
    }
  },

  /**
   * Send a push notification to a specific user.
   *
   * @param {string} userId - Target user's ID
   * @param {object} notification
   * @param {string} notification.title - Notification title
   * @param {string} notification.body - Notification body text
   * @param {string} [notification.icon] - Icon URL
   * @param {string} [notification.url] - URL to open when notification is clicked
   * @param {string} [notification.sound] - Library sound (8 ids, see push.sounds()); plays in the native store build, default tone on the web
   * @returns {Promise<{ sent: number, failed: number }>}
   *
   * @example
   * await push.send(userId, {
   *   title: 'New message',
   *   body: 'Alice sent you a photo',
   *   url: '#/messages'   // hash route — published apps are hash-routed
   * })
   */
  async send(userId, notification) {
    const resolvedUserId = userId || getAppUserId()
    console.log('[push] Sending to user:', resolvedUserId?.substring(0, 8))
    return pushRequest('send', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        userId: resolvedUserId,
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        url: notification.url,
        badge: notification.badge,
        sound: notification.sound,
      }),
    }, { timeoutMs: SEND_TIMEOUT_MS, fallback: 'Send failed' })
  },

  /**
   * Send a push notification to ALL subscribed users of this app.
   *
   * @param {object} notification
   * @param {string} notification.title
   * @param {string} notification.body
   * @param {string} [notification.icon]
   * @param {string} [notification.url]
   * @returns {Promise<{ sent: number, failed: number }>}
   *
   * @example
   * await push.broadcast({
   *   title: 'App Update',
   *   body: 'New features available!',
   * })
   */
  async broadcast(notification) {
    console.log('[push] Broadcasting')
    return pushRequest('send', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        broadcast: true,
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        url: notification.url,
        badge: notification.badge,
        sound: notification.sound,
      }),
    }, { timeoutMs: SEND_TIMEOUT_MS, fallback: 'Broadcast failed' })
  },

  /**
   * Send a push notification to every member of a social group (see the roles skill) —
   * e.g. notify all members of a team / class / building. Caller must be the app owner
   * (auth.isAppOwner) or an admin of that group.
   *
   * @param {string} groupId
   * @param {object} notification  { title, body, icon?, url?, badge? }
   * @returns {Promise<{ sent: number, failed: number }>}
   * @example await push.sendToGroup(team.id, { title: 'Shift posted', body: 'Check the new rota' })
   */
  async sendToGroup(groupId, notification) {
    return pushRequest('send', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        groupId,
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        url: notification.url,
        badge: notification.badge,
        sound: notification.sound,
      }),
    }, { timeoutMs: SEND_TIMEOUT_MS, fallback: 'Group send failed' })
  },

  /**
   * Send a push notification to every member of a group who holds a specific role —
   * e.g. notify only the managers, only the drivers, only the site-managers. Caller must
   * be the app owner or a group admin.
   *
   * @param {string} groupId
   * @param {string} role  the role name (as assigned via social.setRole / appointAdmin)
   * @param {object} notification  { title, body, icon?, url?, badge? }
   * @returns {Promise<{ sent: number, failed: number }>}
   * @example await push.sendToRole(company.id, 'manager', { title: 'New report', body: 'A worker filed a report' })
   */
  async sendToRole(groupId, role, notification) {
    return pushRequest('send', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        groupId,
        role,
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        url: notification.url,
        badge: notification.badge,
        sound: notification.sound,
      }),
    }, { timeoutMs: SEND_TIMEOUT_MS, fallback: 'Role send failed' })
  },

  /**
   * Notify the ADMINS of a group — the owner + anyone they appointed admin/manager. This is
   * the "notify-up" case: a regular member triggers it (e.g. a worker submits a report and
   * the reviewers get pinged). Any signed-in member of the group may call it (unlike sendToGroup /
   * sendToRole, which only an admin can use to broadcast). Recipients resolved server-side.
   *
   * @param {string} groupId
   * @param {object} notification  { title, body, icon?, url?, badge? }
   * @returns {Promise<{ sent: number, failed: number }>}
   * @example await push.sendToAdmins(team.id, { title: 'New report', body: 'Awaiting review', url: '#/review' })
   */
  async sendToAdmins(groupId, notification) {
    return pushRequest('send', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        groupId,
        admins: true,
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        url: notification.url,
        badge: notification.badge,
        sound: notification.sound,
      }),
    }, { timeoutMs: SEND_TIMEOUT_MS, fallback: 'Admin notify failed' })
  },

  /**
   * Schedule a push notification for a specific time in the future.
   * The notification is sent from the server — works even if the app is closed.
   *
   * Recurring: pass `repeat` to fire on a recurring schedule. Time-of-day is
   * preserved across DST. A single `id` represents the whole series — cancelling
   * it stops all future firings. If `repeatUntil` is omitted, recurrence stops
   * after 1 year.
   *
   * `at` accepts a Date, an epoch-millisecond number, or a local
   * 'YYYY-MM-DDTHH:MM:SS' string. Passing a Date (or `new Date(...)`) is the
   * safest option — the helper converts it to the user's local wall-clock for
   * you, so the notification fires at the moment you mean regardless of UTC.
   *
   * @param {object} options
   * @param {Date|number|string} options.at - When to fire: a Date, epoch ms, or local 'YYYY-MM-DDTHH:MM:SS' string
   * @param {string} [options.timezone] - IANA timezone (auto-detected if omitted)
   * @param {string} options.title - Notification title
   * @param {string} options.body - Notification body text
   * @param {string} [options.icon] - Icon URL
   * @param {string} [options.url] - URL to open when clicked
   * @param {number} [options.badge] - App icon badge count
   * @param {string} [options.sound] - Library sound (8 ids, see push.sounds()); plays in the native store build, default tone on the web
   * @param {string} [options.userId] - Target user (omit for current user; set broadcast=true for all)
   * @param {boolean} [options.broadcast] - Send to all subscribed users
   * @param {'daily'|'weekly'|'weekdays'|'weekends'|'monthly'} [options.repeat] - Recurrence rule (monthly = same day-of-month, clamped to short months)
   * @param {string[]} [options.repeatExcept] - Skip these weekdays ('sun'..'sat'), e.g. ['fri'] for a Fri–Sat weekend region
   * @param {string} [options.repeatUntil] - Stop-by datetime (ISO); defaults to 1 year after `at`
   * @returns {Promise<{ id: string, fireAt: string }>}
   *
   * @example
   * // One-shot
   * await push.schedule({
   *   at: '2026-03-08T15:00:00',
   *   title: 'Meeting reminder',
   *   body: 'Your meeting starts in 15 minutes',
   * })
   *
   * @example
   * // Daily recurring at 8am
   * await push.schedule({
   *   at: '2026-03-09T08:00:00',
   *   title: 'Good morning ☀️',
   *   body: "Today's meditation is ready",
   *   repeat: 'daily',
   * })
   */
  async schedule({ at, timezone, title, body, icon, url, badge, sound, userId, broadcast, groupId, role, repeat, repeatExcept, repeatUntil }) {
    const norm = normalizeSchedule(at, timezone)
    // Don't default to the current user when targeting a group/role.
    const resolvedUserId = userId || (!broadcast && !groupId ? getAppUserId() : undefined)
    if (isEmbedded()) {
      console.warn('[push] schedule() called inside the Whacka editor preview — the notification will NOT be delivered here. It works only on the published app once added to the Home Screen.')
    }
    const tag = repeat ? ` repeat=${repeat}` : ''
    console.log('[push] Scheduling for', norm.at, 'in', norm.timezone, resolvedUserId ? `user=${resolvedUserId.substring(0, 8)}` : 'broadcast', tag, sound ? `sound=${sound}` : '')
    return pushRequest('schedule', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ at: norm.at, timezone: norm.timezone, title, body, icon, url, badge, sound, userId: resolvedUserId, broadcast, groupId, role, repeat, repeatExcept, repeatUntil }),
    }, { fallback: 'Schedule failed' })
  },

  /**
   * Schedule a one-shot notification a relative amount of time from now.
   * Convenience wrapper over schedule() — no date math, no timezone pitfalls.
   *
   * @param {number} ms - Delay from now in milliseconds
   * @param {object} notification - Same fields as schedule() (title, body, icon, url, badge, userId, broadcast)
   * @returns {Promise<{ id: string, fireAt: string }>}
   *
   * @example
   * // Remind in 25 minutes
   * await push.scheduleIn(25 * 60 * 1000, {
   *   title: 'Break over',
   *   body: 'Back to focus 🎯',
   * })
   */
  async scheduleIn(ms, notification) {
    return push.schedule({ ...notification, at: new Date(Date.now() + ms) })
  },

  /**
   * One call that tells you whether push can work right now and, if not, why —
   * so you can show the user the right next step instead of failing silently.
   *
   * Prefer this over hand-rolling isSupported()/isInstalled()/isIOS() checks.
   *
   * @returns {{
   *   supported: boolean,   // browser has the push APIs at all
   *   installed: boolean,   // running as an installed PWA (Home Screen)
   *   ios: boolean,         // iPhone/iPad
   *   embedded: boolean,    // running inside the Whacka editor preview (push won't deliver)
   *   permission: 'granted'|'denied'|'default',
   *   canSchedule: boolean, // scheduling is meaningful in this context
   *   reason: string|null,  // machine-readable blocker: 'preview'|'unsupported'|'ios_needs_install'|'denied'|'needs_permission'|'works_better_installed'|null
   *   hint: string          // human-readable guidance for the current situation
   * }}
   *
   * @example
   * const d = push.diagnose()
   * if (!d.canSchedule) return showHint(d.hint)
   * if (d.permission !== 'granted') await push.requestPermission()
   * await push.subscribe()
   */
  /**
   * The library sound ids accepted as `sound` on send/schedule. They play in
   * the native Google Play / App Store build; the web app plays the phone's
   * default tone (see diagnose().customSound for where you are right now).
   * @returns {string[]}
   */
  sounds() {
    return [...PUSH_SOUND_IDS]
  },

  diagnose() {
    // Native shell: it IS an installed app with first-class notifications —
    // the web-centric checks below (SW/iOS-A2HS/embedded) don't apply.
    if (nativePush()) {
      const permission = nativeCachedPermission()
      const hints = DIAGNOSE_HINTS[resolveFaceLang()] || DIAGNOSE_HINTS.en
      const reason = permission === 'denied' ? 'denied' : permission !== 'granted' ? 'needs_permission' : null
      return {
        supported: true,
        installed: true,
        ios: false,
        embedded: false,
        permission,
        canSchedule: permission !== 'denied',
        reason,
        hint: reason ? hints[reason] : hints.ok,
        native: true,
        customSound: nativeSoundCapable(),
      }
    }
    const supported = push.isSupported()
    const installed = detectIsInstalled()
    const ios = detectIsIOS()
    const embedded = isEmbedded()
    const permission = push.getPermission()
    // Language when diagnose() is CALLED (apps set documentElement.dir/lang
    // during their own boot) via the one cascade every platform face shares
    // (_lang.js, 2026-09-28) — apps show `hint` verbatim.
    const hints = DIAGNOSE_HINTS[resolveFaceLang()] || DIAGNOSE_HINTS.en

    let reason = null

    if (embedded) {
      reason = 'preview'
    } else if (!supported) {
      reason = 'unsupported'
    } else if (ios && !installed) {
      reason = 'ios_needs_install'
    } else if (permission === 'denied') {
      reason = 'denied'
    } else if (permission !== 'granted') {
      reason = 'needs_permission'
    } else if (!installed) {
      reason = 'works_better_installed'
    }

    const hint = reason ? hints[reason] : hints.ok
    const canSchedule = supported && !embedded && !(ios && !installed) && permission !== 'denied'
    // native/customSound: honest answers for copy like "the siren plays in the
    // store app" — on the web a `sound` is accepted but the default tone plays.
    return { supported, installed, ios, embedded, permission, canSchedule, reason, hint, native: false, customSound: false }
  },

  /**
   * Cancel a previously scheduled push notification.
   *
   * @param {string} id - The job ID returned by push.schedule()
   * @returns {Promise<{ ok: boolean }>}
   *
   * @example
   * await push.cancelSchedule(jobId)
   */
  async cancelSchedule(id) {
    console.log('[push] Cancelling schedule:', id?.substring(0, 8))
    return pushRequest('schedule', {
      method: 'DELETE',
      headers: getHeaders(),
      body: JSON.stringify({ id }),
    }, { fallback: 'Cancel failed' })
  },

  /**
   * Listen for incoming push notifications (foreground only).
   * For background notifications, the service worker handles display automatically.
   *
   * @param {function} callback - Called with { title, body, icon, data }
   * @returns {function} unsubscribe
   *
   * @example
   * push.onNotification((notification) => {
   *   console.log('Received:', notification.title)
   * })
   */
  onNotification(callback) {
    // Native shell: the FCM plugin surfaces foreground pushes directly.
    const pn = nativePush()
    if (pn) {
      let removed = false
      let handle = null
      try {
        const p = pn.addListener('pushNotificationReceived', (n) => {
          try { callback({ title: n?.title, body: n?.body, data: n?.data || {} }) } catch { /* app callback */ }
        })
        if (p && typeof p.then === 'function') p.then((h) => { if (removed) h?.remove?.(); else handle = h })
        else handle = p
      } catch { /* plugin absent */ }
      return () => { removed = true; try { handle?.remove?.() } catch { /* ignore */ } }
    }

    if (!('serviceWorker' in navigator)) return () => {}

    const handler = (event) => {
      if (event.data?.type === 'PUSH_RECEIVED') {
        callback(event.data.payload)
      }
    }

    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  },

  /**
   * Set the app icon badge count (e.g. unread messages).
   * On supported platforms, shows a number on the app icon.
   *
   * @param {number} [count] - Badge number. Omit for a plain indicator dot.
   * @returns {Promise<void>}
   *
   * @example
   * await push.setBadge(3) // show "3" on the app icon
   * await push.setBadge()  // show a plain dot
   */
  async setBadge(count) {
    if ('setAppBadge' in navigator) {
      await navigator.setAppBadge(count)
    }
  },

  /**
   * Clear the app icon badge.
   * @returns {Promise<void>}
   *
   * @example
   * await push.clearBadge()
   */
  async clearBadge() {
    if ('clearAppBadge' in navigator) {
      await navigator.clearAppBadge()
    }
  },
}

// ─────────────────────────────────────────────
// Auto-refresh the push subscription on every launch — and on every change of
// who is signed in.
//
// iOS (and sometimes Android) silently drop a web-push subscription after
// periods of disuse or an OS update — after which scheduled/sent notifications
// vanish with no error and the user assumes the app is broken. Re-subscribing
// when permission is ALREADY granted re-registers the device and re-syncs the
// (possibly new) endpoint to the server. subscribe() is idempotent, so this is
// cheap when nothing changed.
//
// Guards: never prompts (only runs when permission === 'granted'); skips the
// editor preview (no service worker there); top-level only.
//
// Who (delivery ledger P11, 2026-10-18): the server files the subscription
// under whoever the page acts as when it is sent. A sign-in, sign-out or Teams
// login without a reload left the device with the previous person until the
// next launch — the new person got none of theirs, the previous person's kept
// ringing here. The same refresh now runs after every identity change, so the
// device follows the person signed in now (its own anonymous id after a
// sign-out). Refreshes run one after another: two in flight could land out of
// order and leave the device with the person who already left.
// ─────────────────────────────────────────────

let _refreshChain = Promise.resolve()
function refreshSubscription() {
  _refreshChain = _refreshChain.then(refreshSubscriptionNow, refreshSubscriptionNow)
  return _refreshChain
}

function refreshSubscriptionNow() {
  try {
    // Native shell: same idea, native transport — re-registers the token
    // (FCM rotates them) and re-reports the binary's build number, so a
    // device that just updated the store app becomes sound-capable on the
    // server without the app calling subscribe() again. Never prompts.
    const pn = nativePush()
    if (pn) {
      if (nativeCachedPermission() === 'granted') return nativeSubscribe(pn).catch(() => {})
      return
    }
    if (isEmbedded()) return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    // Re-registers if the OS dropped the subscription.
    return push.subscribe().catch(() => {})
  } catch {
    /* never let a refresh throw */
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') {
    refreshSubscription()
  } else {
    window.addEventListener('load', () => { refreshSubscription() }, { once: true })
  }
  onIdentityChange(() => { refreshSubscription() })
}
