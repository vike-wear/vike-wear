/**
 * Embedded-context shims — C8 (2026-08-17).
 *
 * When an app runs inside an iframe (the editor preview, or the app-details
 * page embedding the published app), two browser behaviors silently break
 * generated apps in ways that read as "my app is broken":
 *
 *   • Native dialogs: Chrome ≥92 unconditionally suppresses alert()/confirm()/
 *     prompt() in cross-origin iframes — confirm() returns false INSTANTLY
 *     with no dialog, so every "Are you sure?" delete button looks dead
 *     (sandbox allow-modals does not override this). The editor preview is
 *     same-origin, so dialogs work there; the details-page embed is not.
 *   • Same-tab external links: the sandboxed frame navigates ITSELF to the
 *     external site (wa.me, OAuth pages, …), which then refuses to render in
 *     a frame — the preview appears to die.
 *
 * The shims keep the app honest instead of silently broken: a suppressed
 * dialog surfaces a one-time notice chip (same visual family + constraints as
 * _write-notice.js — pointer-events none, closed shadow root, auto-hide), and
 * external same-tab navigations are rerouted to a new top-level tab while the
 * click's user activation is still live (a postMessage round-trip to the host
 * would lose the activation and get popup-blocked).
 *
 * Everything is a no-op when the app IS the top-level window (published app
 * opened directly), so wild behavior is untouched.
 *
 * Case: docs/platform-review/cases/2026-08-17-c8-preview-false-bugs.md
 */

import { resolveFaceLang, isRtlLang } from './_lang.js'

const AUTO_HIDE_MS = 8000

// A human can't see + dismiss a real dialog this fast; a browser-suppressed
// dialog returns its "cancelled" value in ~0ms.
export const BLOCKED_DIALOG_MS = 25

const STRINGS_AR = {
  dialog: 'نوافذ التأكيد المنبثقة محجوبة داخل هذه المعاينة المضمّنة — افتح التطبيق من رابطه المباشر لتنفيذ هذا الإجراء.',
}
const STRINGS_EN = {
  dialog: 'Confirmation pop-ups are blocked inside this embedded preview — open the app by its direct link to use this action.',
}
const STRINGS_PT = {
  dialog: 'As janelas de confirmação estão bloqueadas nesta prévia incorporada — abra o app pelo link direto para usar esta ação.',
}
const STRINGS_ES = {
  dialog: 'Las ventanas de confirmación están bloqueadas en esta vista previa incrustada — abre la app desde su enlace directo para usar esta acción.',
}
const STRINGS = { en: STRINGS_EN, ar: STRINGS_AR, pt: STRINGS_PT, es: STRINGS_ES }

/**
 * Pure classifier: did the native dialog get suppressed by the browser?
 * Suppressed dialogs return synchronously with their cancelled value
 * (confirm → false, prompt → null); alert has no return value, so timing is
 * the only signal there.
 */
export function dialogLooksBlocked(kind, result, elapsedMs, embedded) {
  if (!embedded) return false
  if (elapsedMs >= BLOCKED_DIALOG_MS) return false
  if (kind === 'confirm') return result === false
  if (kind === 'prompt') return result === null
  if (kind === 'alert') return true
  return false
}

/**
 * Pure decision for a click on an <a>: return an absolute http(s) URL to open
 * in a new top-level tab, or null to leave the click alone. Only same-tab
 * navigations to a DIFFERENT origin are rerouted — relative/SPA links,
 * target="_blank" (allow-popups already handles those), downloads
 * (download.js owns that path), modified clicks, and non-http schemes all
 * pass through untouched.
 */
export function externalLinkTarget({ embedded, defaultPrevented, button, modifier, hasDownload, target, href, baseHref }) {
  if (!embedded || defaultPrevented || button !== 0 || modifier || hasDownload) return null
  if ((target || '').toLowerCase() === '_blank') return null
  if (!href) return null
  let u
  try { u = new URL(href, baseHref) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  let base
  try { base = new URL(baseHref) } catch { return null }
  if (u.origin === base.origin) return null
  return u.href
}

// ── notice chip (visual family of _write-notice.js) ─────────────────────────

const STYLES = `
  :host {
    position: fixed;
    bottom: max(8px, env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    /* Informational only — must never intercept a tap (shell:38 dead-tap class). */
    pointer-events: none;
    max-width: min(92vw, 420px);
  }
  .chip {
    font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif;
    color: #FFFFFF;
    background: rgba(24, 24, 27, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    padding: 9px 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    text-align: center;
    opacity: 0;
    transition: opacity 180ms ease;
  }
  .chip.in { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .chip { transition: none; } }
`

let shown = false

function showDialogBlockedNotice() {
  // Once per page load — the first dead confirm explains all the others.
  if (shown) return
  if (typeof document === 'undefined' || !document.body) return
  shown = true

  // Language at SHOW time — the one cascade every platform face shares (_lang.js).
  const lang = resolveFaceLang()
  const T = STRINGS[lang] || STRINGS_EN
  const host = document.createElement('div')
  host.dir = isRtlLang(lang) ? 'rtl' : 'ltr'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)
  const chip = document.createElement('div')
  chip.className = 'chip'
  chip.setAttribute('role', 'status')
  chip.setAttribute('aria-live', 'polite')
  chip.textContent = T.dialog
  shadow.appendChild(chip)
  document.body.appendChild(host)
  requestAnimationFrame(() => { try { chip.classList.add('in') } catch { /* ignore */ } })
  setTimeout(() => { try { host.remove() } catch { /* ignore */ } }, AUTO_HIDE_MS)
}

/** Test-only introspection. */
export function embedShimState() {
  return { noticeShown: shown }
}

// ── install ─────────────────────────────────────────────────────────────────

export function installEmbedShims() {
  if (typeof window === 'undefined') return
  let embedded = false
  try { embedded = window.self !== window.top } catch { embedded = true }
  if (!embedded) return

  // Native dialogs: pass straight through, but when the browser suppresses
  // one, say so once instead of letting the button look dead.
  const origs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const orig = origs[kind]
    if (typeof orig !== 'function') continue
    window[kind] = function (...args) {
      const t0 = Date.now()
      const r = orig.apply(window, args)
      try {
        if (dialogLooksBlocked(kind, r, Date.now() - t0, true)) showDialogBlockedNotice()
      } catch { /* never break the caller */ }
      return r
    }
  }

  // Same-tab external links: bubble phase so app-level handlers (SPA routers,
  // custom preventDefault flows) run first and win by preventing default.
  document.addEventListener('click', (e) => {
    try {
      const t = e.target
      const a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null
      if (!a) return
      const url = externalLinkTarget({
        embedded: true,
        defaultPrevented: e.defaultPrevented,
        button: typeof e.button === 'number' ? e.button : 0,
        modifier: !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey),
        hasDownload: a.hasAttribute('download'),
        target: a.getAttribute('target') || '',
        href: a.getAttribute('href'),
        baseHref: window.location.href,
      })
      if (!url) return
      e.preventDefault()
      const w = window.open(url, '_blank', 'noopener')
      if (!w) window.location.href = url // popup refused → original behavior, not worse
    } catch { /* never break a click */ }
  })
}
