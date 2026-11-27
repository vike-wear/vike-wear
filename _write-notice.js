/**
 * Platform-owned "couldn't save" notice — the write-side twin of _read-notice.js.
 *
 * Why this exists (a store app, 2026-07-28): when the data API refuses a WRITE
 * (429 — per-minute burst, or the caller's per-day quota into its slow lane),
 * apps almost never render the error. Optimistic UI shows the message bubble,
 * the row never lands, and on reopen the message is gone — which a staff member
 * reads as "my messages disappear", i.e. suspected data loss. Same measured
 * root cause as the read side: ~99.6% of call sites drop the error.
 *
 * So the honest line is drawn HERE: the shell says, in its own voice, that the
 * save was refused by a usage limit and nothing already saved is lost. Ships to
 * every existing app on its next publish (template overlay).
 *
 * Inherited constraints (each one a past bug — see _read-notice.js):
 *   • pointer-events: none — never intercept a tap (shell:38 dead-tap class).
 *   • closed shadow root + system fonts — app CSS can't restyle it, it can't
 *     restyle the app.
 *   • auto-hide + re-arm throttle — a slow-laned caller keeps getting partial
 *     refusals; a permanent banner would be shouting.
 *   • BOTTOM-anchored (the read strip owns the top): a refused save happens at
 *     the moment the user taps send/save, and their attention is at the
 *     composer. Both strips can be up at once without overlap.
 */

import { resolveFaceLang, isRtlLang } from './_lang.js';

const AUTO_HIDE_MS = 6000;     // visible window per arming
const REARM_MS = 60_000;       // ...then stay quiet even if writes keep failing

// "usage limit" not "credits" — this is the infra quota, not the credits
// paywall. "Nothing is lost" refers to already-saved data; the save/upload
// copy must ask for a retry because the slow lane admits a trickle every hour.
// The *Full variants (capacity ceiling, QUOTA_EXCEEDED) must NOT say "try
// again" — a full app stays full until the owner acts, and "in a moment" would
// be a lie; instead they say the one true useful thing: the owner was told.
// uploadTooBig: a file over the per-file cap, refused on the device before it
// is sent (_too-large.js, delivery ledger P34) — most apps tell the visitor
// nothing, or the SDK's English sentence. {mb} / {max} are the file's size and
// the account's cap in MB.
// saveBusy: not a limit. The app could not take the save for a moment (a move between
// cells, _hold-codes.js) and the SDK has already tried again.
// teamFull / teamFullOwner: adding someone to the app's team was refused because the
// owner's plan has no team place left (QUOTA_EXCEEDED from the team route or
// social.inviteToGroup, delivery ledger P108). Apps' own approve buttons mostly
// swallow that error, so the add looked like a dead button. The owner is the one
// person who can act on it (remove someone; the project chat holds the card with the
// rest), so the owner's words name that, everyone else's say the owner was told.
const STRINGS_AR = {
  save: 'تعذّر الحفظ — تم الوصول لحد الاستخدام. ما تم حفظه سابقًا سليم؛ حاول مرة أخرى بعد قليل.',
  saveBusy: 'تعذّر الحفظ الآن. ما تم حفظه سابقًا سليم؛ حاول مرة أخرى بعد قليل.',
  upload: 'فشل الرفع — تم الوصول لحد الاستخدام. حاول مرة أخرى بعد قليل.',
  saveFull: 'تعذّر الحفظ — وصل التطبيق إلى سعته القصوى. ما تم حفظه سابقًا سليم، وقد تم إشعار مالك التطبيق.',
  uploadFull: 'فشل الرفع — امتلأت مساحة تخزين التطبيق. وقد تم إشعار مالك التطبيق.',
  uploadTooBig: 'فشل الرفع — حجم الملف {mb} ميجابايت، والحد {max} ميجابايت للملف.',
  teamFull: 'تعذّرت الإضافة — فريق هذا التطبيق مكتمل. تم إشعار مالك التطبيق.',
  teamFullOwner: 'تعذّرت الإضافة — فريقك مكتمل. احذف أحدًا من الفريق، أو راجع محادثة المشروع.',
};
const STRINGS_EN = {
  save: "Couldn't save — usage limit reached. Earlier data is safe; try again in a moment.",
  saveBusy: "Couldn't save just now. Earlier data is safe; try again in a moment.",
  upload: 'Upload failed — usage limit reached. Try again in a moment.',
  saveFull: "Couldn't save — this app is at its capacity limit. Earlier data is safe; the app owner has been notified.",
  uploadFull: "Upload failed — this app's storage is full. The app owner has been notified.",
  uploadTooBig: 'Upload failed — this file is {mb} MB; files up to {max} MB can be uploaded.',
  teamFull: "Couldn't add — this app's team is full. The app owner has been notified.",
  teamFullOwner: "Couldn't add — your team is full. Remove someone from the team, or see the project chat.",
};
const STRINGS_PT = {
  save: 'Não foi possível salvar — limite de uso atingido. Os dados anteriores estão seguros; tente de novo daqui a pouco.',
  saveBusy: 'Não foi possível salvar agora. Os dados anteriores estão seguros; tente de novo daqui a pouco.',
  upload: 'Falha no envio — limite de uso atingido. Tente de novo daqui a pouco.',
  saveFull: 'Não foi possível salvar — este app atingiu o limite de capacidade. Os dados anteriores estão seguros; o dono do app foi avisado.',
  uploadFull: 'Falha no envio — o armazenamento deste app está cheio. O dono do app foi avisado.',
  uploadTooBig: 'Falha no envio — este arquivo tem {mb} MB; é possível enviar arquivos de até {max} MB.',
  teamFull: 'Não foi possível adicionar — a equipe deste app está completa. O dono do app foi avisado.',
  teamFullOwner: 'Não foi possível adicionar — sua equipe está completa. Remova alguém da equipe ou veja o chat do projeto.',
};
const STRINGS_ES = {
  save: 'No se pudo guardar — se alcanzó el límite de uso. Los datos anteriores están a salvo; inténtalo de nuevo en un momento.',
  saveBusy: 'No se pudo guardar ahora. Los datos anteriores están a salvo; inténtalo de nuevo en un momento.',
  upload: 'Falló la subida — se alcanzó el límite de uso. Inténtalo de nuevo en un momento.',
  saveFull: 'No se pudo guardar — esta app llegó a su límite de capacidad. Los datos anteriores están a salvo; ya se avisó al dueño de la app.',
  uploadFull: 'Falló la subida — el almacenamiento de esta app está lleno. Ya se avisó al dueño de la app.',
  uploadTooBig: 'Falló la subida — este archivo pesa {mb} MB; se pueden subir archivos de hasta {max} MB.',
  teamFull: 'No se pudo agregar — el equipo de esta app está completo. Ya se avisó al dueño de la app.',
  teamFullOwner: 'No se pudo agregar — tu equipo está completo. Quita a alguien del equipo o mira el chat del proyecto.',
};
const STRINGS = { en: STRINGS_EN, ar: STRINGS_AR, pt: STRINGS_PT, es: STRINGS_ES };

/** The notice's words for a kind, in a face language ('en' | 'ar' | 'pt' | 'es'; `true`
 *  reads as Arabic, as the first callers passed it), numbers filled in. Pure. */
export function writeNoticeText(kind, { mb, max } = {}, lang = 'en') {
  const T = STRINGS[lang === true ? 'ar' : lang] || STRINGS_EN;
  // A size as a Portuguese reader reads it («25,3», «1.000»); every other face keeps «25.3».
  const num = (n) => (T === STRINGS_PT && typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('pt-BR') : String(n ?? ''));
  return (T[kind] || T.save).replace('{mb}', num(mb)).replace('{max}', num(max));
}

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
`;

let host = null;
let hideTimer = null;
let quietUntil = 0;

function teardown() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (host) { try { host.remove(); } catch { /* ignore */ } host = null; }
}

/**
 * Arm the notice. Called from db.js's write path and the storage/audio upload
 * clients on a 429, by db.js for a save a move kept out, by _too-large.js for
 * a file over the per-file cap, and by _seat-notice.js for an add the team's
 * places refused.
 * @param {object} info
 * @param {'save'|'saveBusy'|'upload'|'saveFull'|'uploadFull'|'uploadTooBig'|'teamFull'|'teamFullOwner'} [info.kind] —
 *   which wording to show; the *Full kinds are the capacity-ceiling
 *   (QUOTA_EXCEEDED) variants, saveBusy a save a move kept out, uploadTooBig a file
 *   over the per-file cap, teamFull / teamFullOwner an add refused for want of a
 *   team place (the owner's own words, or everyone else's)
 * @param {number} [info.mb] — uploadTooBig: the file's size in MB
 * @param {number} [info.max] — uploadTooBig: the account's per-file cap in MB
 */
export function showWriteLimitNotice({ kind, mb, max } = {}) {
  // SSR / node tests — no DOM, no notice.
  if (typeof document === 'undefined' || !document.body) return;
  const t = Date.now();
  if (t < quietUntil) return;      // still inside the post-show quiet window
  if (host) return;                // already up
  quietUntil = t + REARM_MS;

  // Language at SHOW time via the one cascade every platform face shares (_lang.js).
  const lang = resolveFaceLang();
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
  chip.textContent = writeNoticeText(kind, { mb, max }, lang);
  shadow.appendChild(chip);
  document.body.appendChild(host);
  requestAnimationFrame(() => { try { chip.classList.add('in'); } catch { /* ignore */ } });

  hideTimer = setTimeout(teardown, AUTO_HIDE_MS);
}

/** Retire the notice immediately (kept for symmetry/tests; the write path
 *  deliberately does NOT hide on a later success — in the slow lane passes and
 *  refusals interleave, and a flapping chip is worse than one that overstates
 *  by a few seconds). */
export function hideWriteLimitNotice() {
  quietUntil = 0;
  teardown();
}

/** Test-only introspection. */
export function writeNoticeState() {
  return { mounted: !!host, quietUntil };
}
