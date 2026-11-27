import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { getAuthHeaders } from './lib/_headers'
import { installHostBridge } from './lib/_host-bridge'
import { installEmbedShims } from './lib/_embed-shims'
import { setSupabaseToken } from './lib/_supabase-token'
import { installClientErrorReporting } from './lib/_client-report'
import { installStorageNotice } from './lib/_storage-notice'
import { storeSet, storageDenied } from './lib/_session-store'
import { popMagicKey, fetchGateStatus, submitGateCode, clearGateToken, gateSeedIsOpen, gateSeedIsLocked, setGateSeed, noteGateScreen } from './lib/_gate'
import { sdkFetch } from './lib/_fetch'
import { brandingHidden, brandingKnown, onBrandingChange, refreshBranding } from './lib/_branding'
import { parseOAuthReturnHash } from './lib/_oauth-return'
import { resolveFaceLang, onFaceLangChange } from './lib/_lang.js'
import { onIdentityChange, identityAccountEpoch } from './lib/_identity-change'
import { pagePublish, askWorkerPublish, isSamePublish } from './lib/_update-check'
import GateLock from './components/GateLock'

// Error capture is now in index.html (regular <script>) so it runs
// BEFORE ESM module linking — catching import/export errors that would
// otherwise kill the module graph before any in-module code executes.

// ── Sync theme-color meta with CSS --color-bg (fallback to --color-primary) ──
;(() => {
  function sync() {
    try {
      const style = getComputedStyle(document.documentElement)
      let raw = style.getPropertyValue('--color-bg').trim()
      if (!raw) raw = style.getPropertyValue('--color-primary').trim()
      if (raw) {
        const rgb = raw.split(/\s+/).map(Number)
        if (rgb.length === 3 && rgb.every(n => !isNaN(n))) {
          const hex = '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('')
          const meta = document.querySelector('meta[name="theme-color"]')
          if (meta) meta.setAttribute('content', hex)
        }
      }
    } catch { /* ignore */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(sync))
  } else {
    requestAnimationFrame(sync)
  }
})()

// ── iOS keyboard fix: track visualViewport so #root stays within visible area ──
;(() => {
  const vv = window.visualViewport
  const root = document.getElementById('root')
  if (!vv || !root) return

  const doc = document.documentElement

  const sync = () => {
    const kbH = Math.max(0, Math.round(window.innerHeight - vv.height))
    doc.style.setProperty('--keyboard-height', kbH + 'px')
    doc.style.setProperty('--visual-height', vv.height + 'px')

    if (vv.offsetTop === 0 && vv.height >= window.innerHeight - 1) {
      root.style.height = ''
    } else {
      root.style.height = vv.height + 'px'
    }
  }

  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)

  const pin = () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0)
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0
  }
  window.addEventListener('scroll', pin, { passive: false })

  // Prevent iOS scroll-into-view flash on keyboard-triggering inputs.
  // Only intercept text-like types; leave file/checkbox/radio etc. alone.
  document.addEventListener('touchend', (e) => {
    const el = e.target
    const dominated = el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|search|url|email|password|number|tel)$/.test(el.type))
    if (!dominated || document.activeElement === el) return
    e.preventDefault()
    el.focus({ preventScroll: true })
  }, false)

  sync()
})()

// Clear proxy retry backoff counter (set by the "Preview Loading..." error page)
try { sessionStorage.removeItem('_pr') } catch { /* iframe sandbox */ }

// Suppress the browser's native PWA install prompt
window.addEventListener('beforeinstallprompt', (e) => e.preventDefault())

// Bridge share/clipboard requests to the host page when this app is embedded
// in Whacka Explore. Chromium increasingly blocks these APIs inside sandboxed
// cross-origin iframes even when the app is otherwise fully trusted.
installHostBridge()

// Embedded-frame honesty shims (no-op when top-level): surface a notice when
// the browser suppresses a native confirm()/alert() dialog, and reroute
// same-tab external links to a new tab instead of letting the sandboxed frame
// navigate itself into a frame-refusing site.
installEmbedShims()

// Forward client-side crashes (white-screen class) to the server in the
// published app, so app_health surfaces them to the build agent. Drains the
// buffer that index.html's inline handler filled before modules loaded.
installClientErrorReporting()

// Tell a visitor whose browser blocks site storage why they get signed out on
// every reopen (identity itself survives the visit via _session-store).
installStorageNotice()

// ── Record app session for analytics (skip preview/editor mode) ──
;(() => {
  const projectId = import.meta.env.VITE_PROJECT_ID
  if (!projectId || import.meta.env.VITE_PREVIEW_TOKEN) return
  const base = import.meta.env.VITE_API_BASE || ''

  const ua = navigator.userAgent || ''
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
  const isMobile =
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    ((navigator.maxTouchPoints || 0) > 1 && window.innerWidth < 1024)
  const isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true

  fetch(`${base}/api/app/${projectId}/session`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ isStandalone, isMobile, isIOS }),
  }).catch(() => {})
})()

// The app moved to another Whacka region (cells M2b; the SDK fires this once, on the
// move notice its old region posts): offer the same refresh a publish offers — the
// refreshed page asks where its live updates are and lands in the new region.
try {
  window.addEventListener('whacka:realtime-moved', () => {
    showUpdatePill(() => { try { window.location.reload() } catch { /* ignore */ } }, () => {})
  })
} catch { /* no window events: the page keeps working on its reads */ }

// The shell's own words — the update pill, the corner badge and the error
// boundary — in every face language (_lang.js). The badge's Arabic edition is
// its own brand-first row (ran 0817); the other editions read "Made with Whacka".
const SHELL_WORDS = {
  en: { updated: 'Updated — tap to refresh', dismiss: 'Dismiss', madeWith: 'Made with', wrong: 'Something went wrong', reload: 'Reload', details: 'Details' },
  ar: { updated: 'تم التحديث — اضغط للتحديث', dismiss: 'إغلاق', madeWith: '', wrong: 'حدث خطأ ما', reload: 'إعادة التحميل', details: 'التفاصيل' },
  pt: { updated: 'Atualizado — toque para recarregar', dismiss: 'Fechar', madeWith: 'Feito com', wrong: 'Algo deu errado', reload: 'Recarregar', details: 'Detalhes' },
  es: { updated: 'Actualizado — toca para recargar', dismiss: 'Cerrar', madeWith: 'Hecho con', wrong: 'Algo salió mal', reload: 'Recargar', details: 'Detalles' },
}
const shellWords = (lang) => SHELL_WORDS[lang] || SHELL_WORDS.en

// Small "Updated — tap to refresh" pill shown when the owner publishes while
// this visitor has the app open AND visible. Styled like the corner badge
// (translucent black, above the safe area). Plain DOM — it must work even if
// React is mid-render of soon-to-be-stale code.
function showUpdatePill(onRefresh, onDismiss) {
  try {
    if (document.getElementById('_wk_update_pill')) return
    // Language at show time — the one cascade every platform face shares
    // (_lang.js); apps set documentElement.dir/lang during their own boot.
    const lang = resolveFaceLang()
    const words = shellWords(lang)
    const pill = document.createElement('div')
    pill.id = '_wk_update_pill'
    pill.dir = lang === 'ar' ? 'rtl' : 'ltr'
    pill.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);' +
      'bottom:max(16px, env(safe-area-inset-bottom, 16px));z-index:99999;' +
      'display:flex;align-items:center;max-width:calc(100vw - 32px);' +
      'background:rgba(0,0,0,0.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'color:#fff;border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,0.18);' +
      'font-family:system-ui,-apple-system,sans-serif;font-size:12px;'
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.textContent = words.updated
    refresh.style.cssText =
      'background:none;border:none;color:inherit;font:inherit;cursor:pointer;' +
      'padding:9px 4px;padding-inline-start:14px;'
    refresh.addEventListener('click', onRefresh)
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.setAttribute('aria-label', words.dismiss)
    dismiss.textContent = '✕'
    dismiss.style.cssText =
      'background:none;border:none;color:rgba(255,255,255,0.7);font:inherit;font-size:11px;' +
      'cursor:pointer;padding:9px 8px;padding-inline-end:13px;'
    dismiss.addEventListener('click', () => {
      pill.remove()
      // Dismiss means "I'm mid-task, don't refresh" — so it must also disarm
      // the pending reload-on-hidden, or the app still reloads (and wipes a
      // half-filled form) the next time the tab is hidden.
      if (typeof onDismiss === 'function') { try { onDismiss() } catch { /* ignore */ } }
    })
    pill.appendChild(refresh)
    pill.appendChild(dismiss)
    document.body.appendChild(pill)
  } catch { /* never let the update affordance break the app */ }
}

// Native shell (Capacitor): the same app code ships inside the Android/iOS
// shell, where the web SW/caching machinery must stay off (the OTA updater
// owns bundle freshness there) and the updater needs a boot heartbeat —
// without notifyAppReady() within its timeout, @capgo/capacitor-updater
// rolls the bundle back (that's the crash watchdog, so only call it once
// the module graph actually evaluated). No-op everywhere else: on the web
// `window.Capacitor` doesn't exist.
const IS_NATIVE_SHELL = (() => {
  try { return !!window.Capacitor?.isNativePlatform?.() } catch { return false }
})()
if (IS_NATIVE_SHELL) {
  setTimeout(() => {
    try { window.Capacitor?.Plugins?.CapacitorUpdater?.notifyAppReady?.() } catch { /* ignore */ }
  }, 0)
  // Google OAuth deep-link return: the system browser (Custom Tab) finishes
  // the flow at /auth/app-callback, which redirects to
  // {applicationId}://auth#wk_code=… — Android routes that intent back here
  // and the App plugin surfaces it as appUrlOpen. Exchange exactly like the
  // web #wk_code boot path (exchangeWkCode is hoisted from below). Guarded
  // end-to-end: on binaries without the App/Browser plugins this whole block
  // is a no-op and the auth modal shows its update hint instead.
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appUrlOpen', (event) => {
      try {
        const m = String(event?.url || '').match(/[#&?]wk_code=([^&]+)/)
        if (!m) return
        try {
          const closing = window.Capacitor.Plugins.Browser?.close?.()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch { /* Browser.close is a no-op on Android Custom Tabs */ }
        exchangeWkCode(decodeURIComponent(m[1]))
      } catch { /* never let an auth return break the running app */ }
    })
  } catch { /* plugin absent (old binary) */ }
}

// Register Service Worker (skip in iframe / preview mode, and in the native
// shell — see above)
try {
  if ('serviceWorker' in navigator && window.self === window.top && !IS_NATIVE_SHELL) {
    window.addEventListener('load', () => {
      // Capture before registration — false on first visit, true on return visits
      let isFirstInstall = !navigator.serviceWorker.controller
      let refreshing = false

      // When a new SW takes over (skipWaiting + clients.claim in sw.js), get
      // the visitor onto the latest published version WITHOUT yanking the page
      // out from under them: reloading while visible destroys in-progress
      // state (half-typed forms/orders). Hidden → reload immediately (the
      // reload is invisible). Visible → show a tap-to-refresh pill and reload
      // on the NEXT visibilitychange→hidden. `refreshing` makes this fire at
      // most once per page load (guards reload loops when publishes stack).
      // Skip the first controllerchange which is the initial SW install.
      // A page opened after a publish already IS that publish (navigations go
      // to the network first) and only meets the new worker a moment later:
      // the worker is asked for its publish mark first, and the page's own
      // mark answered back means nothing to refresh — no pill, no reload. Any
      // doubt (no answer, no mark) keeps the pill (_update-check.js).
      const pageMark = pagePublish(document)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (isFirstInstall) {
          isFirstInstall = false
          return
        }
        if (refreshing) return
        refreshing = true
        askWorkerPublish(navigator.serviceWorker.controller).then((served) => {
          if (isSamePublish(pageMark, served)) { refreshing = false; return }
          const reload = () => window.location.reload()
          if (document.visibilityState === 'hidden') { reload(); return }
          const onHidden = () => { if (document.visibilityState === 'hidden') reload() }
          document.addEventListener('visibilitychange', onHidden)
          showUpdatePill(reload, () => {
            // User dismissed — respect it: disarm the auto-reload and let a later
            // publish re-offer instead of forcing this one.
            document.removeEventListener('visibilitychange', onHidden)
            refreshing = false
          })
        })
      })

      navigator.serviceWorker.register('/sw.js').then(reg => {
        // When app returns from background, check for SW updates
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            reg.update().catch(() => {})
          }
        })
      }).catch(() => {})
    });
  }
} catch { /* cross-origin iframe, skip */ }

// ── Desktop phone frame ──
// The phone-era shell draws a phone on screens ≥ 480 px in Whacka's colours
// (blue border, pink shadow). Under an app whose branding answer hides Whacka
// (W3, 2026-10-28 — src/lib/app/brand.ts) the frame turns neutral. index.html
// stays byte-frozen, so the override is a style element; where the shell
// draws no frame (#app-shell display: contents — the responsive shell, phones)
// there is no box for it to paint.
const _WK_FRAME_ID = 'wk-frame-neutral'
function _wkApplyFrame(hidden) {
  try {
    const el = document.getElementById(_WK_FRAME_ID)
    if (!hidden) { if (el) el.remove(); return }
    if (el) return
    const style = document.createElement('style')
    style.id = _WK_FRAME_ID
    style.textContent = 'html #app-shell{border-color:#D4D4D8 !important;box-shadow:0 24px 50px -26px rgba(24,24,27,0.38) !important}'
    document.head.appendChild(style)
  } catch { /* cosmetic */ }
}
_wkApplyFrame(brandingHidden())
onBrandingChange((hidden) => _wkApplyFrame(hidden))

// ── "Made with Whacka" badge ──
// Print wordmark — same stack/weight as the site's wordmark (WhackaLogo.tsx),
// shared by both editions (ran 0817: one wordmark, not a script face here and
// print everywhere else). lineHeight 1.6 × 13px ≈ 21px line box → 33px pill.
const _WK_WORDMARK = { fontFamily: "'Helvetica Neue', Helvetica, system-ui, -apple-system, sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: '-0.02em', lineHeight: 1.6 }

// Arabic edition of the badge — "Whacka · اصنع تطبيقك" (brand first, print
// wordmark; ran 0817). The badge's cascade — app-declared dir/lang, then the
// COMPUTED direction (many Arabic apps flip the whole document with a CSS
// `html,body{direction:rtl}` and never set the dir attribute — wisenest), then
// the device language — became every face's rule in _lang.js (2026-09-28).
// The badge's language (en | ar | pt | es, 2026-11-09): Arabic is the brand-first
// edition, every other one reads "Made with Whacka" in its own words.
function _wkBadgeLang() {
  return resolveFaceLang()
}

// A game shows no badge at all (ran 2026-11-06: 针对游戏就完全不要): stamped at publish for a game project.
const _WK_GAME = import.meta.env.VITE_WHACKA_GAME === '1'

function WhackaBadge() {
  // Per-device dismiss (the ✕). Kept for everyone.
  const [dismissed, setDismissed] = React.useState(() => {
    try { return localStorage.getItem('_whacka_badge_hidden') === '1' } catch { return false }
  })
  // Pro/Ultra owners can remove Whacka branding for ALL visitors — the badge
  // here plus the sign-in surfaces (see lib/_branding.js). Seeded from the
  // cached answer so repeat loads don't flicker, then confirmed with the
  // server. This mount is the app's launch-time fetch point.
  const [proHidden, setProHidden] = React.useState(brandingHidden)
  // First-ever visit (no cached branding answer): hold the badge's first
  // paint briefly so a white-labeled app never flashes it while the server
  // confirms. Devices with a cached answer keep today's instant behavior;
  // fail-open stands — normal apps just show the badge ~1.2s later once.
  const [holdFirstPaint, setHoldFirstPaint] = React.useState(() => !brandingKnown())
  // Language of the badge. Re-read after the app's first paint and whenever
  // the app flips <html>/<body> dir/lang (in-app language toggles; the
  // observer lives in _lang.js) — apps set these during their own boot, after
  // this component first renders.
  const [lang, setLang] = React.useState(_wkBadgeLang)
  const ar = lang === 'ar'
  const words = shellWords(lang)
  React.useEffect(() => {
    const sync = () => setLang(_wkBadgeLang())
    const t = setTimeout(sync, 900)
    const off = onFaceLangChange(sync)
    return () => { clearTimeout(t); off() }
  }, [])

  React.useEffect(() => {
    refreshBranding()
    return onBrandingChange(setProHidden)
  }, [])

  React.useEffect(() => {
    if (!holdFirstPaint) return
    const t = setTimeout(() => setHoldFirstPaint(false), 1200)
    return () => clearTimeout(t)
  }, [holdFirstPaint])

  const visible = !dismissed && !proHidden && !holdFirstPaint

  // Lift the badge above the app's own fixed bottom bar / FAB so it never covers
  // the app's primary action. Probe a few points along the bottom edge for a
  // bottom-anchored fixed/sticky element (skipping the badge's own corner) and
  // sit just above the tallest one; re-check on resize/orientation.
  const [liftPx, setLiftPx] = React.useState(0)
  React.useEffect(() => {
    if (!visible) return
    const measure = () => {
      setLang(_wkBadgeLang())
      try {
        const vw = window.innerWidth, vh = window.innerHeight
        // A real bottom bar / FAB is bottom-anchored AND short. The platform shell
        // wraps the app in a full-viewport `position:fixed` #root — it must NOT be
        // mistaken for a bar (that sent the badge flying to the top). So require
        // the matched element to sit in the lower portion and be at most ~a third
        // of the viewport tall, and hard-cap the lift.
        const MAX_BAR = Math.min(vh * 0.34, 200)
        const MAX_LIFT = Math.round(vh * 0.35)
        let best = 0
        for (const x of [vw * 0.5, vw * 0.28, vw * 0.72]) {
          let n = document.elementFromPoint(Math.round(x), vh - 6)
          for (let i = 0; n && n !== document.body && i < 6; i++) {
            if (n.closest && n.closest('[data-whacka-badge]')) break
            const cs = getComputedStyle(n)
            if (cs.position === 'fixed' || cs.position === 'sticky') {
              const r = n.getBoundingClientRect()
              if (r.bottom >= vh - 16 && r.height >= 28 && r.height <= MAX_BAR &&
                  r.top >= vh * 0.5 && (r.width >= vw * 0.5 || r.width >= 48)) {
                best = Math.max(best, vh - r.top)
              }
              break
            }
            n = n.parentElement
          }
        }
        setLiftPx(best > 0 ? Math.min(Math.round(best + 10), MAX_LIFT) : 0)
      } catch { setLiftPx(0) }
    }
    measure()
    const t = setTimeout(measure, 900) // after the app finishes its first paint
    window.addEventListener('resize', measure)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure) }
  }, [visible])

  if (!visible) return null

  // utm_campaign = which app referred this visitor: the subdomain on
  // *.whacka.app, the full host on custom domains. Editor preview, platform
  // apex, and native-shell/local hosts send no campaign (nothing meaningful
  // to attribute them to).
  // Landing follows the APP's language, not the phone's (2026-09-02): 90% of
  // Arabic-country badge visitors ran English phone UIs and landed on the
  // English home while the app they came from was Arabic. The app is the
  // better signal — an Arabic app's visitor reads Arabic.
  let campaign = ''
  try {
    const h = window.location.hostname
    if (h.endsWith('.whacka.app')) campaign = h.slice(0, -'.whacka.app'.length)
    else if (h && h !== 'whacka.app' && !/^(localhost|127\.|192\.168\.|10\.)/.test(h)) campaign = h
  } catch { /* keep source-only */ }
  // Twin for the landing: Arabic from the badge's own `ar` read (dir/lang/
  // device), Portuguese/Spanish only when the APP declares it on <html lang>
  // (a pt/es phone is already redirected by the middleware; the app's
  // language is the signal the middleware can't see).
  let twin = ar ? 'ar' : ''
  try {
    const l = (document.documentElement.lang || '').toLowerCase()
    if (!twin && /^pt\b/.test(l)) twin = 'pt'
    else if (!twin && /^es\b/.test(l)) twin = 'es'
  } catch { /* English */ }

  return (
    <a
      href={`https://whacka.app/${twin}?utm_source=whacka_badge${campaign ? `&utm_campaign=${encodeURIComponent(campaign)}` : ''}`}
      target="_blank"
      rel="noopener noreferrer"
      data-whacka-badge=""
      dir={ar ? 'rtl' : 'ltr'}
      lang={lang}
      onClick={(e) => { e.stopPropagation() }}
      style={{
        // Clear the iOS home-indicator gesture area in installed standalone mode,
        // and lift above the app's own bottom bar/FAB when one is detected.
        // v5 pill silhouette (ran preferred it), re-inked to the Riso deep blue;
        // print wordmark since 0817 (the script face was the badge's alone).
        // Always the bottom-RIGHT corner, whatever the app's direction (ran
        // 0817) — the badge is platform chrome, not part of the app's reading
        // flow. The 0703 `insetInlineEnd` put it bottom-left on every RTL app
        // AND mirrored the flex row into "✕ Whacka Made with"; the explicit
        // dir above keeps the row's own order stable in both editions.
        position: 'fixed',
        bottom: liftPx > 0 ? liftPx : 'max(16px, env(safe-area-inset-bottom))',
        right: 16, zIndex: 99998,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 0', paddingInlineStart: 12, paddingInlineEnd: 14,
        background: 'rgba(32,37,92,0.85)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        color: '#fff', fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
        borderRadius: 20, textDecoration: 'none',
        boxShadow: '0 2px 12px rgba(32,37,92,0.25)',
      }}
    >
      {ar ? (
        // Arabic edition: brand-first, then the tagline. With dir="rtl" the row
        // reads right→left: Whacka · اصنع تطبيقك ✕.
        <>
          <span style={_WK_WORDMARK}>Whacka</span>
          <span aria-hidden="true" style={{ opacity: 0.45, lineHeight: 1 }}>·</span>
          <span style={{ opacity: 0.85, fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif", fontSize: 13, lineHeight: 1.6 }}>اصنع تطبيقك</span>
        </>
      ) : (
        <>
          <span style={{ opacity: 0.7 }}>{words.madeWith}</span>
          <span style={_WK_WORDMARK}>Whacka</span>
        </>
      )}
      {/* Real button, ≥44px hit area via padding + negative margin (visual size
          unchanged), keyboard-focusable, labeled for screen readers. */}
      <button
        type="button"
        aria-label={words.dismiss}
        onClick={(e) => {
          e.stopPropagation(); e.preventDefault()
          setDismissed(true)
          try { localStorage.setItem('_whacka_badge_hidden', '1') } catch {}
        }}
        style={{
          margin: -14, marginInlineStart: -12, padding: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'inherit', font: 'inherit',
        }}
      >
        <span
          style={{
            width: 16, height: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '50%', background: 'rgba(255,255,255,0.15)',
            fontSize: 10, lineHeight: 1,
          }}
        >✕</span>
      </button>
    </a>
  )
}

class ErrorBoundary extends React.Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) {
    if (window.__previewReport) {
      window.__previewReport(error.message, 'react-error-boundary')
    }
  }
  render() {
    if (this.state.error) {
      // Language at render time — the one cascade every platform face shares
      // (_lang.js); the app set documentElement.dir/lang during its boot.
      const lang = resolveFaceLang()
      const words = shellWords(lang)
      return (
        <div
          dir={lang === 'ar' ? 'rtl' : 'ltr'}
          style={{
            minHeight: '100dvh', padding: 24,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            textAlign: 'center', fontFamily: "system-ui, -apple-system, 'Noto Sans Arabic', sans-serif",
            background: '#fafafa', color: '#18181b',
          }}
        >
          <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>
            {words.wrong}
          </h2>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '10px 24px', fontSize: 14, fontWeight: 600, borderRadius: 10, border: 'none', background: '#18181b', color: '#fff', cursor: 'pointer' }}
          >
            {words.reload}
          </button>
          {/* Raw error text is for the owner debugging, not the end user —
              collapsed by default, always LTR (it's code). */}
          <details style={{ marginTop: 24, maxWidth: 480, width: '100%', fontSize: 12, color: '#71717a' }}>
            <summary style={{ cursor: 'pointer' }}>{words.details}</summary>
            <pre dir="ltr" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left', fontSize: 12, color: '#52525b', background: '#f4f4f5', padding: 12, borderRadius: 8, border: '1px solid #e4e4e7', marginTop: 8 }}>
              {this.state.error.message}
            </pre>
          </details>
        </div>
      )
    }
    return this.props.children
  }
}

// Dismiss the inline cold-boot splash (injected into published HTML at build
// time) once we've mounted SOMETHING — the app or the lock screen. Called from
// the mounters (not on a timer) so the splash never fades to an empty #root
// while the async gate check is still in flight. No-op in the editor preview.
function dismissSplash() {
  const el = document.getElementById('app-splash')
  if (!el) return
  const hide = () => {
    el.classList.add('hide')
    setTimeout(() => el.remove(), 450)
  }
  // Double rAF: let React commit, then let the browser paint the first frame,
  // before fading the splash out — avoids a flash of empty #root.
  requestAnimationFrame(() => requestAnimationFrame(hide))
}

// One shared React root: the seed/reconcile boot path below may need to swap
// an already-mounted app for the lock screen — calling createRoot twice on the
// same container is a React error, so both mounters render into this root.
let _reactRoot = null
function getReactRoot() {
  if (!_reactRoot) _reactRoot = ReactDOM.createRoot(document.getElementById('root'))
  return _reactRoot
}

// When a different account signs in after one left the page — or replaces
// one directly (a shop tablet, a family phone) — every screen of the app
// starts over, so nothing the previous person saw stays on screen for the
// next one. The platform's own lists follow any change by themselves; this
// covers what the app keeps in its own state. A sign-out on its own, a guest
// signing in and the same person signing back in keep the screens. The
// restart waits for the code that signed in to finish (`await team.login();
// navigate(…)` must land on the restarted app, not on the router it just
// left). P11.
function AccountBoundary({ children }) {
  const [k, setK] = React.useState(identityAccountEpoch)
  React.useEffect(() => {
    const off = onIdentityChange(({ accountEpoch }) => { setTimeout(() => setK(accountEpoch), 0) })
    setK(identityAccountEpoch()) // a change between the first render and this subscription
    return off
  }, [])
  return <React.Fragment key={k}>{children}</React.Fragment>
}

// Which screen is up decides what a gate refusal does: the app reloads into
// the lock screen, the lock screen stays put (_gate.js handleGatedResponse, P65).
function mountApp() {
  noteGateScreen('app')
  getReactRoot().render(
    <React.StrictMode>
      <ErrorBoundary>
        <AccountBoundary>
          <App />
        </AccountBoundary>
        {_WK_GAME ? null : <WhackaBadge />}
      </ErrorBoundary>
    </React.StrictMode>,
  )
  dismissSplash()
}

function mountLock(status) {
  noteGateScreen('lock')
  getReactRoot().render(
    <React.StrictMode>
      <ErrorBoundary>
        <GateLock status={status} />
      </ErrorBoundary>
    </React.StrictMode>,
  )
  dismissSplash()
}

// Private-app gate: before rendering ANY app content, ask the server whether
// this app is locked and whether this device is already through. A magic link
// (`#k=`) auto-unlocks first. Locked + not unlocked → the lock screen; otherwise
// the app. The splash covers the round trip. The server gates data regardless —
// this is the UX layer. Fail-open on any error (mount the app; the server still
// protects the data) so a hiccup never bricks a public app.
//
// Fast path (mirrors _branding.js's seed/reconcile): when the last
// server-confirmed answer for this device was "not gated", mount immediately —
// no awaited US round trip on every launch of a public app — and reconcile
// with the server async. If the owner has since enabled the gate, swap to the
// lock screen. No cached answer, a cached "gated", or a magic-link key in the
// URL → the awaited path (a private app must never flash its content).
async function bootGated() {
  const projectId = import.meta.env.VITE_PROJECT_ID
  if (!projectId || import.meta.env.VITE_PREVIEW_TOKEN) { mountApp(); return }
  const magic = popMagicKey()

  if (!magic && gateSeedIsOpen()) {
    mountApp()
    fetchGateStatus().then((status) => {
      if (!status) return
      setGateSeed(!status.gated)
      if (!status.gated) { clearGateToken(); return }
      if (!status.unlocked) mountLock(status)
    }).catch(() => { /* fail-open — app is already mounted */ })
    return
  }

  try {
    if (magic) { try { await submitGateCode(magic) } catch {} }
    const status = await fetchGateStatus()
    if (status) setGateSeed(!status.gated)
    if (!status || !status.gated || status.unlocked) {
      // Gate was turned off → drop any leftover pass so it doesn't cause a wasted
      // claim refetch on every boot.
      if (status && !status.gated) clearGateToken()
      mountApp(); return
    }
    mountLock(status)
  } catch {
    // Probe failed (timeout / network / 5xx). Fail open — unless an earlier boot
    // confirmed the gate: then the lock, so a slow link never loops
    // mount → 401 gated → reload → probe timeout → mount … (review 2026-09-27).
    if (gateSeedIsLocked()) mountLock({ gated: true, unlocked: false })
    else mountApp()
  }
}

// ── Google OAuth return ──────────────────────────────────────────────
// Exchange a single-use wk_code for the session bundle, persist it, then
// reload so auth.js / getAppUserId() pick up the signed-in identity on a
// clean boot. Shared by the web return path (handleOAuthReturn below) and the
// native deep-link path (appUrlOpen while the app is running). `continueBoot`
// (web path only) runs on failure — and on success when the browser blocks
// site storage, where a reload would come back signed OUT because the session
// only exists in memory (taswikpro 0902: two Google round-trips, both "failed").
function exchangeWkCode(code, continueBoot) {
  const API_BASE = import.meta.env.VITE_API_BASE || ''
  // The one first-screen-blocking request outside lib/: give it a deadline too
  // (a stalled exchange used to hold the splash for good — review 2026-09-27).
  sdkFetch(`${API_BASE}/api/auth/exchange-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }, { timeoutMs: 15_000, route: 'auth/exchange-code' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('exchange failed'))))
    .then(({ token, supabaseToken, user }) => {
      // Data written on this device before signing in stays with the device
      // (ran 0928: by design) — the `__whacka_migration_pending` flag once
      // written here was read by nothing and is gone (2026-09-28).
      try {
        storeSet('__whacka_auth_token', token)
        storeSet('__whacka_auth_user', JSON.stringify(user))
      } catch { /* ignore */ }
      if (supabaseToken) setSupabaseToken(supabaseToken)
      if (storageDenied() && typeof continueBoot === 'function') {
        // Adopt the in-memory session and boot in place. Dynamic import: apps
        // that never touch auth don't pay for the modal bundle on this rare path.
        import('./lib/auth')
          .then(({ adoptSession }) => adoptSession(user || null))
          .catch(() => {})
          .finally(continueBoot)
        return
      }
      window.location.reload()
    })
    .catch((err) => {
      console.error('[auth] Google sign-in exchange failed:', err)
      if (typeof continueBoot === 'function') continueBoot()
    })
}

// /auth/app-callback lands here with `#wk_code=<one-time>&wk_to=<page>` (or
// `?wk_auth_error=1#wk_to=<page>` when the sign-in failed). The shell
// (index.html) consumes that fragment BEFORE any module evaluates — stashes
// it on window.__wkOAuth and puts the page back in the address bar — so app
// code that normalises the address at module scope can never erase the code
// or the page. Then: exchange the code, reload — the reload, or the plain
// mount on failure, boots on that page instead of the app root. The fragment
// fallback below covers a shell that predates the stash (same order: restore
// FIRST — root-anchored by construction, so it only rewrites the bar).
;(function handleOAuthReturn() {
  let code = null
  try {
    const stashed = window.__wkOAuth
    const ret = stashed || parseOAuthReturnHash(location.hash)
    if (stashed || ret.matched) {
      code = ret.code || null
      if (!stashed) history.replaceState(null, '', ret.to || (location.pathname + location.search))
      try { delete window.__wkOAuth } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  if (!code) { bootGated(); return }
  exchangeWkCode(code, bootGated)
})()
