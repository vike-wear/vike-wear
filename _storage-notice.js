/**
 * Platform-owned "this browser blocks site storage" notice.
 *
 * Why (taswikpro 2026-09-02): a visitor whose browser refuses site storage
 * (Chrome "on-device site data" off, a webview with DOM storage disabled) is
 * signed out on every reopen and, before _session-store, lost every row they
 * wrote. The runtime now keeps the session in memory, but the visitor still
 * has no idea WHY they must sign in each time — and the build agent used to
 * read the resulting errors as a platform bug. The honest line is drawn here,
 * in the shell's own voice, once per page load.
 *
 * Inherited constraints (each one a past bug — see _read-notice.js):
 *   • pointer-events: none — never intercept a tap.
 *   • closed shadow root + system fonts — app CSS can't restyle it.
 *   • auto-hide — informational, not a wall.
 *   • published top-level app only — the editor preview has its own surfaces.
 */

import { probeStorage } from './_session-store'
import { resolveFaceLang, isRtlLang } from './_lang.js'

const SHOW_DELAY_MS = 1500   // let the app's first render set dir/lang first
const AUTO_HIDE_MS = 12000

const STRINGS = {
  en: "This browser is blocking the app from saving data on this device, so you'll be signed out each time you reopen it. Allow site data in the browser settings to keep your session.",
  ar: 'المتصفح يمنع التطبيق من حفظ البيانات على هذا الجهاز، لذلك سيتم تسجيل خروجك في كل مرة تفتحه فيها. اسمح بحفظ بيانات المواقع من إعدادات المتصفح للحفاظ على جلستك.',
  pt: 'Este navegador está impedindo o app de salvar dados neste dispositivo, então você vai sair da conta toda vez que abrir o app de novo. Permita os dados de sites nas configurações do navegador para continuar conectado.',
  es: 'Este navegador no deja que la app guarde datos en este dispositivo, así que se cerrará tu sesión cada vez que la vuelvas a abrir. Permite los datos de sitios en la configuración del navegador para mantener tu sesión.',
}

const STYLES = `
  :host {
    position: fixed;
    bottom: max(8px, env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
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

let host = null

function show() {
  if (host || typeof document === 'undefined' || !document.body) return
  // Language at SHOW time — the one cascade every platform face shares (_lang.js).
  const lang = resolveFaceLang()
  host = document.createElement('div')
  host.dir = isRtlLang(lang) ? 'rtl' : 'ltr'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)
  const chip = document.createElement('div')
  chip.className = 'chip'
  chip.setAttribute('role', 'status')
  chip.setAttribute('aria-live', 'polite')
  chip.textContent = STRINGS[lang] || STRINGS.en
  shadow.appendChild(chip)
  document.body.appendChild(host)
  requestAnimationFrame(() => { try { chip.classList.add('in') } catch { /* ignore */ } })
  setTimeout(() => { try { host.remove() } catch { /* ignore */ } host = null }, AUTO_HIDE_MS)
}

/** Called once from main.jsx at boot. No-op unless storage is actually blocked. */
export function installStorageNotice() {
  try {
    if (typeof window === 'undefined' || window.self !== window.top) return
    if (probeStorage()) return
    setTimeout(show, SHOW_DELAY_MS)
  } catch { /* never let a notice throw into the app */ }
}
