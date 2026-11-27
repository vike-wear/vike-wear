/**
 * Platform-owned "can't load right now" notice.
 *
 * Why this exists (a store app, 2026-07-26): when the data API refuses a read
 * (429 — per-minute burst, or the caller's per-day quota spent), the app's own
 * code almost never distinguishes that from "there is nothing here". Measured
 * across 600 published apps: 99.6% of live-data call sites (3,938 of 3,954)
 * destructure only `data` and drop the hook's `error`, and 95.4% of hook-using
 * apps pair that with a `length === 0` empty state. So the platform's own
 * failure surfaced to a shop owner as "no matching conversations" on 292 intact
 * conversations, he reinstalled the app to fix it, and the incident escalated as
 * suspected data loss.
 *
 * Teaching the agent to render `error` cannot repair 24k already-published
 * apps, so the honest line is drawn HERE: the platform says, in its own voice,
 * that the failure is a usage limit and that the data is fine. Ships to every
 * existing app on its next publish (this file is overlaid from the template).
 *
 * Deliberate constraints, each one a past bug:
 *   • pointer-events: none — a fixed overlay that eats taps is the shell:38
 *     dead-tap class (722 published apps). This strip can never take a tap.
 *   • closed shadow root + system fonts — same isolation contract as
 *     credits-gate.js / auth-modal.js; the app's CSS can't restyle it and it
 *     can't restyle the app.
 *   • top: max(8px, safe-area) — under the notch, above app chrome, and it
 *     auto-retires, so it never permanently covers a header.
 *   • auto-hide + re-arm throttle — a spent quota keeps rejecting every read
 *     for the rest of the UTC day; a permanent banner would be shouting.
 */

import { resolveFaceLang, isRtlLang } from './_lang.js';

const AUTO_HIDE_MS = 6000;     // visible window per arming
const REARM_MS = 60_000;       // ...then stay quiet for a minute even if reads keep failing

// Kept to ~2 lines at 390px: the strip sits over the app's own header, and it
// auto-retires, so it must say the one thing that matters (your data is fine)
// without becoming a wall. "usage limit" not "credits" — this is the infra
// quota, a different thing from the credits paywall in credits-gate.js.
const STRINGS_AR = {
  stale: 'تظهر بيانات محفوظة — تم الوصول لحد الاستخدام. لا شيء مفقود.',
  empty: 'تعذّر التحميل — تم الوصول لحد الاستخدام. لا شيء مفقود.',
};
const STRINGS_EN = {
  stale: 'Showing saved data — usage limit reached. Nothing is lost.',
  empty: "Can't load right now — usage limit reached. Nothing is lost.",
};
const STRINGS_PT = {
  stale: 'Mostrando dados salvos — limite de uso atingido. Nada foi perdido.',
  empty: 'Não foi possível carregar agora — limite de uso atingido. Nada foi perdido.',
};
const STRINGS_ES = {
  stale: 'Mostrando datos guardados — se alcanzó el límite de uso. No se perdió nada.',
  empty: 'No se puede cargar ahora — se alcanzó el límite de uso. No se perdió nada.',
};
const STRINGS = { en: STRINGS_EN, ar: STRINGS_AR, pt: STRINGS_PT, es: STRINGS_ES };

const STYLES = `
  :host {
    position: fixed;
    top: max(8px, env(safe-area-inset-top));
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
 * Arm the notice. Called from db.js's read layer on a 429.
 * @param {object} info
 * @param {boolean} info.servedStale — true when saved data was shown instead
 * @param {string} [info.message] — the server's own 429 wording (unused in the
 *        copy on purpose: it is English-only and written for developers)
 */
export function showReadLimitNotice({ servedStale } = {}) {
  // SSR / node tests / the editor preview before mount — no DOM, no notice.
  if (typeof document === 'undefined' || !document.body) return;
  const t = Date.now();
  if (t < quietUntil) return;      // still inside the post-show quiet window
  if (host) return;                // already up
  quietUntil = t + REARM_MS;

  // Language at SHOW time (apps set documentElement.dir/lang during their own
  // boot, after modules load) — the one cascade every platform face shares.
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
  // Announce to screen readers without stealing focus (it is informational and
  // self-dismissing; `assertive` would interrupt whatever the user is doing).
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  chip.textContent = servedStale ? T.stale : T.empty;
  shadow.appendChild(chip);
  document.body.appendChild(host);
  // Next frame so the opacity transition actually runs.
  requestAnimationFrame(() => { try { chip.classList.add('in'); } catch { /* ignore */ } });

  hideTimer = setTimeout(teardown, AUTO_HIDE_MS);
}

/** A healthy read landed after a cooldown — retire the notice immediately. */
export function hideReadLimitNotice() {
  quietUntil = 0;
  teardown();
}

/** Test-only introspection. */
export function readNoticeState() {
  return { mounted: !!host, quietUntil };
}
