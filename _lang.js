/**
 * _lang.js — the ONE language rule for every platform-drawn face inside an
 * app: the corner badge, the update pill, the error boundary, the lock screen
 * (GateLock), the auth modal, the credits gate, the read/write/integration/
 * storage/embed notice chips, TeamLogin, TeamAdmin, the push hints and the
 * notice a 3D game shows a device that cannot open 3D.
 *
 * Why (2026-09-28, L4 pass): fourteen files each carried their own copy of
 * this cascade, in two variants. The badge also read the COMPUTED direction —
 * many Arabic apps flip the document with CSS `html,body{direction:rtl}` and
 * never set the dir attribute — while the other thirteen did not, so on such
 * an app the badge spoke Arabic and every other face spoke English. Everyone
 * now calls resolveFaceLang(), which is the badge's (richest) cascade,
 * evaluated at CALL time: apps set <html dir/lang> during their own boot,
 * after these modules load, so nothing may decide at module scope.
 *
 *   <html dir="rtl"> or <body dir="rtl">          → 'ar'
 *   <html lang="ar…">                             → 'ar'
 *   <html dir="ltr" lang="en|pt|es…">             → 'en' / 'pt' / 'es' (the app declared it)
 *   computed direction rtl on <html> or <body>    → 'ar'
 *   <html lang="pt…"> / <html lang="es…">         → 'pt' / 'es'
 *   navigator.language "ar…"                      → 'ar'
 *   navigator.language "pt…" / "es…"              → 'pt' / 'es'
 *   otherwise                                     → 'en'
 *
 * Four face languages: en, ar, pt, es (the platform's own four, 2026-11-09).
 * The shell ships <html lang="en">, so lang="en" says nothing; a pt / es lang
 * is the app declaring its language and beats the phone's, and so is lang="en"
 * when the app itself also wrote dir="ltr" on <html> (an AR/EN switch set to
 * English, delivery ledger T10, 2026-11-09). Arabic keeps its
 * place in front: an RTL page is an Arabic page whatever its lang says.
 * A face keeps one table per language and falls back to English for a string
 * it lacks (STRINGS[lang] || STRINGS.en). Nothing here touches the DOM at
 * module scope — the notice modules that import this are loaded in DOM-less
 * unit tests, and so is this file (scripts/_test-face-lang.ts).
 */

const AR_RE = /^ar\b/i
// pt-BR, pt_PT, es-419, ES: the language subtag alone ("ptx", "esp" are not these).
const PT_RE = /^pt(?:[-_]|$)/i
const ES_RE = /^es(?:[-_]|$)/i

/** 'pt' / 'es' from a language tag, else ''. */
function latinOf(v) {
  const t = String(v || '').trim()
  if (PT_RE.test(t)) return 'pt'
  if (ES_RE.test(t)) return 'es'
  return ''
}

const lower = (v) => String(v || '').toLowerCase()

/**
 * Pure core: the cascade over already-read signals. `s` may carry the two
 * computed directions as getters so they are only read when no attribute
 * decided (see resolveFaceLang). Exported for the test.
 */
export function resolveFaceLangFrom(s) {
  const sig = s || {}
  if (lower(sig.htmlDir) === 'rtl' || lower(sig.bodyDir) === 'rtl') return 'ar'
  if (AR_RE.test(String(sig.htmlLang || ''))) return 'ar'
  // The shell ships <html lang="en"> with no dir, so lang="en" alone says nothing. An app that
  // writes dir="ltr" on <html> itself has chosen a left-to-right language: its lang is a
  // declaration, English included, and it outranks a stylesheet that still pins RTL.
  const declared = latinOf(sig.htmlLang)
  if (lower(sig.htmlDir) === 'ltr' && (declared || /^en(?:[-_]|$)/i.test(String(sig.htmlLang || '').trim()))) return declared || 'en'
  if (lower(sig.htmlDirection) === 'rtl' || lower(sig.bodyDirection) === 'rtl') return 'ar'
  if (declared) return declared
  if (AR_RE.test(String(sig.navLang || ''))) return 'ar'
  const device = latinOf(sig.navLang)
  if (device) return device
  return 'en'
}

/** The language a platform face should speak RIGHT NOW. Never throws. */
export function resolveFaceLang() {
  let de = null
  let body = null
  try { de = document.documentElement || null; body = document.body || null } catch { /* no DOM */ }
  let navLang = ''
  try { navLang = navigator.language || '' } catch { /* no navigator */ }
  const computed = (el) => { try { return el ? getComputedStyle(el).direction : '' } catch { return '' } }
  return resolveFaceLangFrom({
    htmlDir: de ? de.dir : '',
    bodyDir: body ? body.dir : '',
    htmlLang: de ? de.lang : '',
    // Lazy: computed style is consulted only when no attribute decided.
    get htmlDirection() { return computed(de) },
    get bodyDirection() { return computed(body) },
    navLang,
  })
}

/** True for a face language written right-to-left. */
export function isRtlLang(lang) {
  return /^(ar|he|fa|ur)\b/i.test(String(lang || ''))
}

/**
 * Live re-read: calls cb(lang) after <html>/<body> dir or lang changes (in-app
 * language toggles), one call per burst. Returns the unsubscribe. The badge
 * uses it to switch editions without a reload; faces that decide at open
 * time (modal, chips, lock screen) do not need it.
 */
export function onFaceLangChange(cb, debounceMs = 50) {
  let timer = null
  let mo = null
  let closed = false
  const fire = () => {
    timer = null
    if (closed) return
    try { cb(resolveFaceLang()) } catch { /* a listener never breaks the app */ }
  }
  // `closed` also covers a record delivered after unsubscribe (an unmounted
  // React component must never receive a late setState).
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  }
  try {
    mo = new MutationObserver(schedule)
    const opts = { attributes: true, attributeFilter: ['dir', 'lang'] }
    mo.observe(document.documentElement, opts)
    if (document.body) mo.observe(document.body, opts)
  } catch { /* no observer → no live re-read; the caller's own re-reads still apply */ }
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
    if (mo) { try { mo.disconnect() } catch { /* ignore */ } }
  }
}
