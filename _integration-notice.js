/**
 * Platform-owned "connection awaiting approval" notice — the outbound-HTTP
 * sibling of _read-notice.js / _write-notice.js.
 *
 * Why this exists (V12 deep-dive 2026-08-06): when http.fetch is refused
 * because the owner never tapped the approval card (HOST_NOT_APPROVED) or
 * never entered the key (SECRET_MISSING), the app's own error handling almost
 * never renders the real cause — field specimens showed end users told
 * "check your internet connection" (sajada, EG visitors on a live prayer-times
 * app) or nothing at all, while 645 hosts sat forever pending platform-wide.
 * The app cannot be trusted to say it, so the shell says it in its own voice:
 * this is not a network problem, the app is waiting on its OWNER.
 *
 * Inherited constraints (each one a past bug — see _read-notice.js):
 *   • pointer-events: none — never intercept a tap (shell:38 dead-tap class).
 *   • closed shadow root + system fonts — app CSS can't restyle it.
 *   • auto-hide + re-arm throttle — a dead integration fails on every screen
 *     load; a permanent banner would be shouting.
 *   • Anchored above the write strip's bottom slot so both can be up at once.
 */

import { resolveFaceLang, isRtlLang } from './_lang.js';

const AUTO_HIDE_MS = 7000;     // visible window per arming
const REARM_MS = 90_000;       // ...then stay quiet even if calls keep failing

// Honest, blame-free, and actionable only for the one person who can act (the
// owner sees the same strip in their own preview). Never says "try again" —
// nothing changes until the owner taps.
const STRINGS_AR = {
  hostPending: 'هذه الميزة بانتظار موافقة صاحب التطبيق على اتصال خارجي — لا توجد مشكلة في الإنترنت لديك.',
  secretMissing: 'هذه الميزة بانتظار إضافة صاحب التطبيق لمفتاح الخدمة الخارجية.',
};
const STRINGS_EN = {
  hostPending: "This feature is waiting for the app owner to approve an external connection — nothing is wrong with your internet.",
  secretMissing: 'This feature is waiting for the app owner to add the API key for an external service.',
};
const STRINGS_PT = {
  hostPending: 'Este recurso está esperando o dono do app aprovar uma conexão externa — não há nada de errado com a sua internet.',
  secretMissing: 'Este recurso está esperando o dono do app adicionar a chave de API de um serviço externo.',
};
const STRINGS_ES = {
  hostPending: 'Esta función está esperando que el dueño de la app apruebe una conexión externa — no hay ningún problema con tu internet.',
  secretMissing: 'Esta función está esperando que el dueño de la app agregue la clave de API de un servicio externo.',
};
const STRINGS = { en: STRINGS_EN, ar: STRINGS_AR, pt: STRINGS_PT, es: STRINGS_ES };

const STYLES = `
  :host {
    position: fixed;
    /* One slot above the write strip (which owns the bottom edge) so a quota
       refusal and an integration wall can both be visible without overlap. */
    bottom: calc(max(8px, env(safe-area-inset-bottom)) + 52px);
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
`;

let host = null;
let hideTimer = null;
let quietUntil = 0;

function teardown() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (host) { try { host.remove(); } catch { /* ignore */ } host = null; }
}

/**
 * Arm the notice. Called from http.js when the proxy refuses with
 * HOST_NOT_APPROVED or SECRET_MISSING.
 * @param {object} info
 * @param {'hostPending'|'secretMissing'} [info.kind]
 */
export function showIntegrationNotice({ kind } = {}) {
  // SSR / node tests — no DOM, no notice.
  if (typeof document === 'undefined' || !document.body) return;
  const t = Date.now();
  if (t < quietUntil) return;      // still inside the post-show quiet window
  if (host) return;                // already up
  quietUntil = t + REARM_MS;

  // Language at SHOW time — the one cascade every platform face shares (_lang.js).
  const lang = resolveFaceLang();
  const T = STRINGS[lang] || STRINGS_EN;
  host = document.createElement('div');
  host.dir = isRtlLang(lang) ? 'rtl' : 'ltr';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);
  const chip = document.createElement('div');
  chip.className = 'chip';
  // Announce to screen readers without stealing focus.
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  chip.textContent = T[kind] || T.hostPending;
  shadow.appendChild(chip);
  document.body.appendChild(host);
  requestAnimationFrame(() => { try { chip.classList.add('in'); } catch { /* ignore */ } });

  hideTimer = setTimeout(teardown, AUTO_HIDE_MS);
}

/** Retire the notice immediately (symmetry/tests). */
export function hideIntegrationNotice() {
  quietUntil = 0;
  teardown();
}

/** Test-only introspection. */
export function integrationNoticeState() {
  return { mounted: !!host, quietUntil };
}
