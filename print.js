/**
 * Print helper — send one element to the printer / "Save as PDF" as a clean
 * document: the target and nothing else.
 *
 *   import { print } from '../lib/print'
 *   print.printElement(reportRef, { title: 'Inspection Report' })
 *   print.printElement(certRef, { title: 'Certificate', size: 'A4' })
 *
 * HOW IT PRINTS (and why it is NOT `@media print` CSS over the live app)
 *
 * Earlier versions printed the target WHERE IT SITS, hiding the rest of the
 * app with `visibility: hidden`. Hidden elements still occupy layout, so the
 * panel around the document, its header and its action buttons reserved bands
 * on the page — and the target printed at its on-screen (often preview-scaled)
 * width instead of filling the sheet. Both were reported from real apps.
 *
 * So the target is no longer printed from the app document at all. We build a
 * throwaway same-origin <iframe> that owns its own document, put ONLY a clone
 * of the target in it (plus a copy of the app's stylesheets so class-based
 * styling still resolves, with form field values carried across), and print
 * THAT frame. There is physically nothing else in the printed document — no
 * app shell, no buttons — so nothing else can come out on paper, and long
 * targets paginate naturally at full page width.
 *
 * The page margin is applied as padding INSIDE the printed sheet with
 * `@page { margin: 0 }` — a zero page margin leaves the browser no band to
 * stamp its own header/footer (URL, date, page numbers) into.
 *
 * This only opens the print dialog — it is not a file. For a downloadable PDF
 * of THIS EXACT SHEET use docs.pdfFromElement(el) (same document, rendered
 * server-side by the same layout engine); for structured reports built from
 * data use docs.pdf. buildSheetHtml below is the shared serializer that makes
 * pdfFromElement print-identical.
 *
 * fit: 'page' — for sheets that must come out as EXACTLY ONE page (certificate,
 * warranty card, terms sheet, receipt). The sheet is laid out at paper width,
 * measured, and scaled down by the computed ratio so nothing spills to a second
 * page and nothing is clipped. The scale is measured once client-side and baked
 * into the document as static CSS, so Print and pdfFromElement use the same
 * number (the server render page runs with JS off — it could not measure).
 * Without fit, tall content paginates naturally, exactly as before.
 */

import { toCanvas } from './_html-to-image/index.js'
import { releaseLeanSandbox } from './_lean-style'
import { paperDots, pixelsToBits, escposFromBits, rawbtJobUrl, bytesToBase64, MAX_JOB_BYTES } from './_escpos'
import { fontFaceBlocks, importRefs, resolveRef, familyNames, styleClass, faceKey, contentText, pickFacesForText, inlineFontFiles } from './_font-css'
import { shouldUseHostBridge } from './_host-bridge'

const FRAME_ID = '__whacka_print_frame'
const SHEET_ID = '__whacka_print_sheet'
const FIT_STYLE_ID = '__whacka_print_fit'
const SEND_WRAP_ID = '__whacka_print_send'
// The PDF sheet's embedded fonts: at most 4 MB of CSS, and never enough to take
// the sheet past 20 MB (the server takes 24, nginx 25 — a sheet that exported
// before must not be refused for its fonts).
const SHEET_FONT_MAX_CHARS = 4 * 1024 * 1024
const SHEET_SAFE_CHARS = 20 * 1024 * 1024

// What the sheet prints is the element's SETTLED look (delivery ledger P20,
// 2026-10-19): every animation and transition jumps to its last frame (an
// entrance fade caught at its first frame printed a white page), and the target
// comes back onto the page — apps park a print-only copy off-screen or behind
// their UI. `relative`, not static, so an absolutely placed seal keeps its box.
// The sheet's margin (its padding — the page has none) repeats on every page
// it breaks onto (delivery ledger P83, 2026-10-25): a multi-page sheet used to
// touch the paper edge at every break.
// Byte-identical to SHEET_SETTLE_CSS in src/lib/files/pdf-element-render.ts,
// which adds it to sheets from apps published before it existed
// (_test-pdf-sheet-settle.ts asserts the two agree).
export const SHEET_SETTLE_CSS =
  `#${SHEET_ID} *,#${SHEET_ID} *::before,#${SHEET_ID} *::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}` +
  `#${SHEET_ID}>*,#${SHEET_ID}>[data-whacka-fit]>*{position:relative!important;inset:auto!important;z-index:auto!important;opacity:1!important;visibility:visible!important}` +
  `#${SHEET_ID}{box-decoration-break:clone!important;-webkit-box-decoration-break:clone!important}`

// ── where we are ──
const isNativeShell = () => {
  try { return !!window.Capacitor?.isNativePlatform?.() } catch { return false }
}
const isAndroid = () => /\bAndroid\b/i.test(navigator.userAgent || '')
// The installed app's print bridge (WhackaPrintPlugin): Android's WebView has
// no window.print(), so the shell renders the serialized sheet off-screen and
// hands it to the system print dialog. Older binaries carry no plugin — the
// SDK asks first and otherwise behaves as before.
function nativePrintPlugin() {
  try {
    const cap = window.Capacitor
    if (!cap?.isNativePlatform?.()) return null
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('WhackaPrint')) return null
    return cap.Plugins?.WhackaPrint || null
  } catch {
    return null
  }
}
// Whether THIS binary's plugin carries a method: the JS proxy answers a
// function for any name and only throws when called, so the native headers
// are the honest source. Older binaries lack the newer methods.
function nativeHasMethod(pluginName, method) {
  try {
    const header = (window.Capacitor?.PluginHeaders || []).find((h) => h.name === pluginName)
    return !!header?.methods?.some((m) => m.name === method)
  } catch {
    return false
  }
}

// Fonts and images inside `scope` have settled — fonts via the document's
// FontFaceSet, images via their load events — each capped, so a slow network
// never blocks a print job. One wait for the print frame, the fit measurement
// and the raster wrapper.
function waitForAssets(scope, { doc, fontMs, imageMs }) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    const afterImages = () => {
      const pending = Array.from(scope.querySelectorAll('img')).filter((i) => !i.complete)
      if (!pending.length) return setTimeout(finish, 30)
      let left = pending.length
      const tick = () => { if (--left <= 0) setTimeout(finish, 30) }
      pending.forEach((i) => { i.addEventListener('load', tick); i.addEventListener('error', tick) })
      setTimeout(finish, imageMs)
    }
    let fonts
    try { fonts = doc.fonts && doc.fonts.ready } catch { fonts = null }
    if (fonts && typeof fonts.then === 'function') {
      let once = false
      const go = () => { if (!once) { once = true; afterImages() } }
      fonts.then(go, go)
      setTimeout(go, fontMs)
    } else {
      afterImages()
    }
  })
}

// ── fit: 'page' geometry ──
// Paper sizes in mm; ' landscape' in opts.size swaps the axes. Anything
// unrecognized falls back to A4 portrait — the same fallback the server's
// PDF renderer uses when the sheet declares no size.
const PAPER_MM = {
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
}
const MM_PX = 96 / 25.4

// Headroom absorbing font-metric drift between the on-screen measurement, the
// print engine, and the server PDF renderer (which substitutes vendored Noto
// faces when app webfonts can't load in its network-blocked render page).
const FIT_SAFETY = 0.97

export function paperSizePx(size) {
  const s = String(size || '').trim().toLowerCase()
  const landscape = /\blandscape\b/.test(s)
  const name = s.replace(/\s*(landscape|portrait)\s*/g, '').trim()
  // Explicit dimensions ("80mm 200mm" receipt rolls, "8.5in 11in") — @page
  // accepts these, so fit must measure against them, not an A4 guess.
  const pair = name.match(/^(\d+(?:\.\d+)?)(mm|cm|in)\s+(\d+(?:\.\d+)?)(mm|cm|in)$/)
  if (pair) {
    const unit = { mm: MM_PX, cm: 10 * MM_PX, in: 96 }
    const w = Number(pair[1]) * unit[pair[2]]
    const h = Number(pair[3]) * unit[pair[4]]
    return landscape ? { w: h, h: w } : { w, h }
  }
  const dims = PAPER_MM[name] || PAPER_MM.a4
  const [w, h] = landscape ? [dims[1], dims[0]] : dims
  return { w: w * MM_PX, h: h * MM_PX }
}

/**
 * The paper a fit measurement must hold on. With no explicit size the print
 * dialog uses the printer's default — A4 in most of the world, Letter in the
 * US — so measure conservatively on BOTH: lay out at the narrower width (A4,
 * lines wrap sooner → measured height errs tall) and fit the shorter height
 * (Letter). The result closes inside one page on either paper.
 */
export function fitPaperPx(opts = {}) {
  if (opts.size) return paperSizePx(opts.size)
  return { w: PAPER_MM.a4[0] * MM_PX, h: PAPER_MM.letter[1] * MM_PX }
}

const warnedFit = new Set()
const wantsFit = (opts) => {
  const v = opts && opts.fit
  if (v == null || v === false) return false
  if (v === true || String(v).toLowerCase() === 'page') return true
  if (!warnedFit.has(v)) {
    warnedFit.add(v)
    console.warn(`[print] unknown fit value "${v}" — expected 'page'`)
  }
  return false
}

/**
 * Measure the (already laid-out) sheet and return the one-page numbers, or
 * null when the content already fits. `height` is the wrapper's layout height:
 * the scaled content fills it exactly, so the page box closes right under the
 * sheet and the print engine has nothing left to paginate.
 */
function computeFit(frameDoc, opts) {
  const sheet = frameDoc.getElementById(SHEET_ID)
  const wrap = sheet && sheet.querySelector('[data-whacka-fit]')
  if (!wrap) return null
  const natural = wrap.scrollHeight
  if (!natural) return null
  const view = frameDoc.defaultView
  const cs = view ? view.getComputedStyle(sheet) : null
  const pad = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0
  const available = fitPaperPx(opts).h - pad
  const scale = Math.min(1, (available * FIT_SAFETY) / natural)
  if (scale >= 1) return null
  return { scale, height: Math.ceil(natural * scale) }
}

// The measured numbers as CSS. Higher specificity than the sheet's neutralizer
// rules AND appended after them, so it wins on both counts. overflow:hidden on
// the wrapper keeps the clone's untransformed layout box (wider/taller than the
// page) from spawning overflow pages — visually lossless, because the scaled
// content ends exactly at the wrapper's edges.
// The negative right margin pins the widened clone to the wrapper's LEFT edge
// in either direction (delivery ledger P20, 2026-10-20): on a right-to-left
// page (the app's <html dir="rtl"> or its CSS) a block wider than its box
// overflows to the left, so the top-left scale origin sat off the paper — the
// sheet came out cut on the left, or white below half size. With margins that
// add up to the wrapper, the direction has nothing left to decide.
// pdf-element-render.ts adds the same pin to sheets from older bundles.
function fitCssText(fit) {
  const pct = 100 / fit.scale
  return `
      #${SHEET_ID} > [data-whacka-fit] {
        height: ${fit.height}px !important; overflow: hidden !important;
      }
      #${SHEET_ID} > [data-whacka-fit] > * {
        transform: scale(${fit.scale}) !important;
        width: ${pct}% !important;
        margin-right: ${100 - pct}% !important;
      }
    `
}

// The frame's own rules — shared verbatim between the printed iframe and the
// serialized document (docs.pdfFromElement), so paper and PDF paginate alike.
function sheetCss(opts = {}) {
  const size = opts.size ? String(opts.size).replace(/[^A-Za-z0-9 .-]/g, '') : ''
  // With fit, the wrapper (not the clone) is the sheet's direct child, so the
  // > * neutralizer above lands on it — repeat the neutralizer one level down
  // to keep on-screen transforms/fixed sizes off the clone itself.
  const fitBase = wantsFit(opts)
    ? `
      #${SHEET_ID} > [data-whacka-fit] > * {
        transform: none !important; transform-origin: top left !important;
        width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important;
        margin: 0 !important; overflow: visible !important;
      }`
    : ''
  return `
      @page { ${size ? `size: ${size}; ` : ''}margin: 0; }
      html, body {
        margin: 0 !important; padding: 0 !important;
        height: auto !important; max-height: none !important;
        overflow: visible !important;
        background: #ffffff !important;
        position: static !important;
      }
      #${SHEET_ID} {
        display: block !important; position: static !important;
        width: 100% !important; max-width: none !important;
        padding: ${opts.margin || '12mm'}; box-sizing: border-box;
        background: #ffffff; color: #141414;
      }
      /* The on-screen target is often a fixed-width, preview-scaled box; on
         paper it fills the page instead. */
      #${SHEET_ID} > * {
        transform: none !important; transform-origin: top left !important;
        width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important;
        margin: 0 !important; overflow: visible !important;
      }${fitBase}
      ${SHEET_SETTLE_CSS}
      .no-print, [data-no-print] { display: none !important; }
    `
}

function resolveEl(elOrRef) {
  if (!elOrRef) return null
  return elOrRef.nodeType === 1 ? elOrRef : elOrRef.current || null
}

// Carry live form state across cloneNode (which copies attributes, not current
// values): inputs, textareas, selects, and canvas bitmaps.
function syncFormState(srcRoot, dstRoot) {
  const pick = (root, sel) => Array.from(root.querySelectorAll(sel))
  const srcFields = pick(srcRoot, 'input, textarea, select')
  const dstFields = pick(dstRoot, 'input, textarea, select')
  for (let i = 0; i < srcFields.length && i < dstFields.length; i++) {
    const s = srcFields[i]
    const d = dstFields[i]
    // Set the property AND the attribute — the property is what the live
    // frame renders; the attribute keeps the clone self-describing if the
    // document is ever serialized or re-parsed.
    try {
      if (s.tagName === 'SELECT') {
        for (let o = 0; o < s.options.length && o < d.options.length; o++) {
          d.options[o].selected = s.options[o].selected
          if (s.options[o].selected) d.options[o].setAttribute('selected', '')
          else d.options[o].removeAttribute('selected')
        }
      } else if (s.type === 'checkbox' || s.type === 'radio') {
        d.checked = s.checked
        if (s.checked) d.setAttribute('checked', '')
        else d.removeAttribute('checked')
      } else if (s.tagName === 'TEXTAREA') {
        d.value = s.value
        d.textContent = s.value
      } else {
        d.value = s.value
        d.setAttribute('value', s.value)
      }
    } catch {}
  }
  const srcCanvas = pick(srcRoot, 'canvas')
  const dstCanvas = pick(dstRoot, 'canvas')
  for (let i = 0; i < srcCanvas.length && i < dstCanvas.length; i++) {
    try {
      dstCanvas[i].getContext('2d')?.drawImage(srcCanvas[i], 0, 0)
    } catch {} // tainted canvas — print it blank rather than fail the job
  }
}

const escAttr = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// outerHTML drops canvas bitmaps — swap each (already-synced) canvas for an
// equal-sized <img> so drawings and signature pads survive serialization. A
// blank canvas (or one whose bitmap could not be read) becomes a blank box of
// the same size, keeping layout stable.
function freezeCanvases(root, doc) {
  for (const c of Array.from(root.querySelectorAll('canvas'))) {
    let el
    try {
      el = doc.createElement('img')
      el.src = c.toDataURL('image/png')
    } catch {
      el = doc.createElement('span')
      el.style.display = 'inline-block'
    }
    if (c.getAttribute('width')) el.setAttribute('width', c.getAttribute('width'))
    if (c.getAttribute('height')) el.setAttribute('height', c.getAttribute('height'))
    if (c.getAttribute('class')) el.setAttribute('class', c.getAttribute('class'))
    if (c.getAttribute('style')) el.setAttribute('style', c.getAttribute('style'))
    c.replaceWith(el)
  }
}

// ── pictures at print size ──
//
// Every picture the page can read (same-origin, or cross-origin with CORS) is
// inlined as a data URI so the server's network-blocked render page can draw
// it; the rest stay absolute URLs for the server's guarded fetch. Inlined as
// taken, a phone photo is 3–8 MB of text, and a quote or an evidence file with
// a few of them outgrew the PDF service's request limit (delivery ledger P20).
// So each picture goes in at the size it prints: its on-screen box stretched to
// the paper width, at 2 device pixels per CSS pixel (about 200 dpi), never
// larger than it was and never past 2400 px on the long edge. A picture used
// several times (a logo on every page) is fetched and encoded once. SVG, GIF,
// pictures already that small, and anything that cannot be decoded keep their
// own bytes. Three pictures are worked on at a time — a phone holds a few
// decoded photos, not fifty.
const PRINT_DPR = 2
const PRINT_MAX_EDGE = 2400
const PRINT_JPEG_QUALITY = 0.85

// Where each picture lands on paper, recorded on the clone before anything
// else touches it (the live element and the clone list their <img> in the same
// order until freezeCanvases adds its own).
function markPrintSizes(srcRoot, dstRoot, opts) {
  const src = srcRoot.querySelectorAll('img')
  const dst = dstRoot.querySelectorAll('img')
  let stretch = 1
  try {
    const rootW = srcRoot.getBoundingClientRect().width
    if (rootW > 0) stretch = Math.max(1, fitPaperPx(opts).w / rootW)
  } catch {}
  for (let i = 0; i < src.length && i < dst.length; i++) {
    try {
      const r = src[i].getBoundingClientRect()
      if (!r.width || !r.height) continue
      dst[i].setAttribute('data-wk-print-w', String(Math.ceil(r.width * stretch * PRINT_DPR)))
      dst[i].setAttribute('data-wk-print-h', String(Math.ceil(r.height * stretch * PRINT_DPR)))
    } catch {}
  }
}

const readAsDataURL = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(fr.result)
  fr.onerror = reject
  fr.readAsDataURL(blob)
})

function fetchImageBlob(url) {
  return Promise.race([
    fetch(url, url.startsWith('data:') ? undefined : { mode: 'cors' }).then((r) => (r.ok ? r.blob() : null)),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]).catch(() => null)
}

// Some pixel is see-through: keep PNG so the paper shows through it.
function hasAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 255) return true
  return false
}

// One picture's data URI at print size (want = { w, h } device pixels, or null
// when its box is unknown). Never bigger than the original bytes.
async function printSizedDataUri(blob, want) {
  const keep = () => readAsDataURL(blob)
  if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) return keep()
  const url = URL.createObjectURL(blob)
  try {
    // Loaded, not decode()d: with a few phone photos in flight Chromium refuses
    // decode() for one of them (EncodingError) that drawImage decodes fine.
    // EXIF orientation applied, as on screen.
    const im = new Image()
    await new Promise((resolve, reject) => {
      im.onload = resolve
      im.onerror = reject
      im.src = url
    })
    const nw = im.naturalWidth
    const nh = im.naturalHeight
    if (!nw || !nh) return keep()
    let scale = want ? Math.max(want.w / nw, want.h / nh) : 1
    scale = Math.min(scale, 1, PRINT_MAX_EDGE / Math.max(nw, nh))
    if (scale >= 1) return keep()
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(im, 0, 0, w, h)
    const type = blob.type !== 'image/jpeg' && hasAlpha(ctx, w, h) ? 'image/png' : 'image/jpeg'
    const out = await new Promise((resolve) => canvas.toBlob(resolve, type, PRINT_JPEG_QUALITY))
    canvas.width = canvas.height = 0
    if (!out || out.size >= blob.size) return keep()
    return readAsDataURL(out)
  } catch {
    return keep()
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function inlineImages(root) {
  const byUrl = new Map() // url → { imgs, want }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    // srcset would override src at render time (and its candidates can't load
    // in the network-blocked render page); lazy-loading never fires there.
    img.removeAttribute('srcset')
    img.removeAttribute('loading')
    const abs = img.src // property resolves relative → absolute
    if (!abs) continue
    if (!abs.startsWith('data:')) img.setAttribute('src', abs)
    const w = Number(img.getAttribute('data-wk-print-w')) || 0
    const h = Number(img.getAttribute('data-wk-print-h')) || 0
    img.removeAttribute('data-wk-print-w')
    img.removeAttribute('data-wk-print-h')
    const entry = byUrl.get(abs) || { imgs: [], want: null, unknown: false }
    entry.imgs.push(img)
    if (w && h) entry.want = { w: Math.max(w, entry.want?.w || 0), h: Math.max(h, entry.want?.h || 0) }
    else entry.unknown = true
    byUrl.set(abs, entry)
  }
  // An inlined data URI is already in the document: only a large one is worth
  // decoding again.
  const queue = [...byUrl].filter(([abs]) => !(abs.startsWith('data:') && abs.length < 400 * 1024))
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [abs, entry] = job
      try {
        const blob = await fetchImageBlob(abs)
        if (!blob || !blob.type.startsWith('image/')) continue
        const dataUri = await printSizedDataUri(blob, entry.unknown ? null : entry.want)
        for (const img of entry.imgs) img.setAttribute('src', dataUri)
      } catch {}
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

// Every stylesheet the app loaded, as text — CSSOM for same-origin sheets,
// a fetch fallback for CORS-readable links, unreadable ones skipped.
async function collectCssText() {
  const parts = []
  for (const sheet of Array.from(document.styleSheets)) {
    let css = null
    try {
      css = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n')
    } catch {}
    if (css == null && sheet.href) {
      try {
        const res = await fetch(sheet.href, { mode: 'cors' })
        if (res.ok) css = await res.text()
      } catch {}
    }
    if (!css) continue
    const media = sheet.media && sheet.media.mediaText
    parts.push(media && media !== 'all' ? `@media ${media}{${css}}` : css)
  }
  return parts.join('\n')
}

/**
 * Serialize one element into the SAME standalone document printElement prints
 * — target clone + app stylesheets + live form values + sheet/page rules — as
 * a self-contained HTML string. docs.pdfFromElement sends this to the server,
 * where the same layout engine renders it to a real PDF, so the downloaded
 * file matches the printed sheet.
 *
 * @param {HTMLElement|{current: HTMLElement}} elOrRef
 * @param {object} [opts] - { title?, margin?, size? } — same meaning as printElement
 * @returns {Promise<string>} complete HTML document
 */
export async function buildSheetHtml(elOrRef, opts = {}) {
  const el = resolveEl(elOrRef)
  if (!el) throw new Error('[print] no element to serialize')

  const clone = el.cloneNode(true)
  syncFormState(el, clone)
  markPrintSizes(el, clone, opts)
  freezeCanvases(clone, document)
  await inlineImages(clone)

  const htmlAttrs = Array.from(document.documentElement.attributes)
    .map((a) => ` ${a.name}="${escAttr(a.value)}"`)
    .join('')
  const bodyAttrs = Array.from(document.body.attributes)
    .filter((a) => a.name !== 'style' && a.name !== 'id')
    .map((a) => ` ${a.name}="${escAttr(a.value)}"`)
    .join('')

  // "</" inside CSS (e.g. a content string) would terminate the <style> tag
  // early; "<\/" is the same characters to CSS and inert to the HTML parser.
  const appCss = (await collectCssText()).replace(/<\//g, '<\\/')
  const title = opts.title || document.title || 'Document'

  const fitOn = wantsFit(opts)
  const inner = fitOn ? `<div data-whacka-fit="">${clone.outerHTML}</div>` : clone.outerHTML
  // The server's render page loads nothing, so the web fonts the element is
  // drawn with travel inside the sheet, after the app's own @font-face rules so
  // they win (2026-10-23: every PDF came out in the server's default font).
  // Faces past the budget draw with a system font, as all of them did before.
  const fontCss = (await fontCssFor(el, {
    filesOnly: true,
    maxBytes: Math.min(SHEET_FONT_MAX_CHARS, SHEET_SAFE_CHARS - appCss.length - inner.length),
  })).replace(/<\//g, '<\\/')
  const html =
    `<!DOCTYPE html><html${htmlAttrs}><head><meta charset="utf-8">` +
    `<title>${escAttr(title)}</title>` +
    `<style>${appCss}</style>` +
    (fontCss ? `<style>${fontCss}</style>` : '') +
    `<style>${sheetCss(opts)}</style>` +
    `</head><body${bodyAttrs} data-whacka-print-root="">` +
    `<div id="${SHEET_ID}" data-whacka-print-target="">${inner}</div>` +
    `</body></html>`
  if (!fitOn) return html

  const fit = await measureFitInHiddenFrame(html, opts)
  if (!fit) return html
  return html.replace(
    '</head>',
    `<style id="${FIT_STYLE_ID}">${fitCssText(fit)}</style></head>`,
  )
}

// Render the serialized sheet in a throwaway hidden frame AT PAPER WIDTH (the
// live element may sit in a phone-width or preview-scaled layout, where lines
// wrap differently and the measured height would be wrong), wait for fonts and
// images to settle, and read the fit numbers. Never blocks an export: any
// failure or timeout resolves null and the sheet ships unscaled.
function measureFitInHiddenFrame(html, opts) {
  return new Promise((resolve) => {
    let frame
    let settled = false
    const finish = (fit) => {
      if (settled) return
      settled = true
      try { frame?.remove() } catch {}
      resolve(fit)
    }
    try {
      const paper = fitPaperPx(opts)
      frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText =
        `position:fixed;left:-10000px;top:0;width:${paper.w}px;height:${paper.h}px;` +
        'border:0;opacity:0;pointer-events:none;visibility:hidden;'
      document.body.appendChild(frame)
      const doc = frame.contentDocument
      if (!doc) return finish(null)
      doc.open()
      doc.write(html)
      doc.close()

      waitForAssets(doc.body, { doc, fontMs: 1500, imageMs: 2000 }).then(() => finish(computeFit(doc, opts)))
      setTimeout(() => finish(null), 4000)
    } catch (e) {
      console.warn('[print] fit measurement failed', e)
      finish(null)
    }
  })
}

// ── print.send: the sheet as printer dots ──
//
// A receipt printer takes a bitmap, so the sheet is laid out at the paper's
// dot width (58 mm = 384, 80 mm = 576) in a hidden wrapper INSIDE the app
// document — the app's stylesheets apply as on screen — and rasterized there
// by html-to-image (fonts and images embedded, Arabic shaped by the browser).
// _escpos.js turns the pixels into the ESC/POS raster job; RawBT carries it
// to the printer. No print dialog anywhere on that path.
//
// html-to-image is our copy (./_html-to-image, 1.11.13 + one change): with
// leanStyles the picture carries only the styles that change it, not ~300
// per element — a one-item slip went from 810 KB to 370 KB of SVG, and the
// drawing was the slowest step of a print on a handheld POS (2026-10-27,
// _lean-style.js). Same dots on paper.

function sendCssText(dots, opts) {
  const margin = opts.margin == null ? '2mm' : String(opts.margin).replace(/[^0-9a-z.% ]/gi, '')
  return `
      #${SEND_WRAP_ID} {
        position: fixed !important; left: -10000px !important; top: 0 !important;
        width: ${dots}px !important; max-width: none !important; min-width: 0 !important;
        box-sizing: border-box !important; padding: ${margin} !important; margin: 0 !important;
        background: #ffffff !important; color: #000000 !important;
        display: block !important; overflow: visible !important;
        pointer-events: none !important; z-index: -1 !important; transform: none !important;
      }
      #${SEND_WRAP_ID} > * {
        transform: none !important; transform-origin: top left !important;
        width: 100% !important; max-width: none !important; min-width: 0 !important;
        height: auto !important; max-height: none !important; min-height: 0 !important;
        margin: 0 !important; overflow: visible !important; position: static !important;
        box-shadow: none !important; border-radius: 0 !important;
        opacity: 1 !important; visibility: visible !important;
      }
      #${SEND_WRAP_ID} *, #${SEND_WRAP_ID} *::before, #${SEND_WRAP_ID} *::after {
        animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
        transition-duration: 0s !important; transition-delay: 0s !important;
      }
      #${SEND_WRAP_ID} .no-print, #${SEND_WRAP_ID} [data-no-print] { display: none !important; }
    `
}

// The raster's web fonts (see _font-css.js): html-to-image is handed them as
// `fontEmbedCSS` instead of collecting them itself, which re-inserted every
// imported font into the live page on each call — each receipt slower than the
// last on a cashier screen open all day. Read once per page and never written
// back: each stylesheet's text, each font file, the finished CSS per set of
// faces. A failed read is forgotten so the next print tries it again.
const FONT_FACE_RULE = 5
const IMPORT_RULE = 3
const FONT_READ = { mode: 'cors', cache: 'force-cache' }
const fontReads = { sheets: new Map(), files: new Map(), css: new Map(), faces: null }

function readOnce(map, url, read) {
  let pending = map.get(url)
  if (!pending) {
    pending = read(url).catch(() => null).then((value) => {
      if (value == null) map.delete(url)
      return value
    })
    map.set(url, pending)
  }
  return pending
}

const readSheetText = (url) => readOnce(fontReads.sheets, url, async (u) => {
  const res = await fetch(u, FONT_READ)
  return res.ok ? res.text() : null
})

const readFontFile = (url) => readOnce(fontReads.files, url, async (u) => {
  const res = await fetch(u, FONT_READ)
  if (!res.ok) return null
  const blob = await res.blob()
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
})

// Every @font-face the page's stylesheets declare, with the URL its files are
// relative to; @import-ed and cross-origin sheets are read as text (the page
// may not read their rules). Walked again only when the stylesheets change.
async function pageFontFaces() {
  const sheets = Array.from(document.styleSheets || [])
  const sig = sheets.map((s) => {
    let n = 'x'
    try { n = s.cssRules.length } catch { /* cross-origin */ }
    return `${s.href || ''}#${n}`
  }).join('|')
  if (fontReads.faces && fontReads.faces.sig === sig) return fontReads.faces.list
  const list = []
  const seen = new Set()
  let complete = true
  const fromText = async (url, depth) => {
    if (!url || seen.has(url) || depth > 3) return
    seen.add(url)
    const text = await readSheetText(url)
    if (text == null) { complete = false; return }
    for (const block of fontFaceBlocks(text)) list.push({ block, base: url })
    for (const ref of importRefs(text)) await fromText(resolveRef(ref, url), depth + 1)
  }
  const fromRules = async (rules, base, depth) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === FONT_FACE_RULE) list.push({ block: rule.cssText, base })
      else if (rule.type === IMPORT_RULE) {
        const url = resolveRef(rule.href, base)
        let inner = null
        try { inner = rule.styleSheet && rule.styleSheet.cssRules } catch { inner = null }
        if (inner && depth < 3) await fromRules(inner, url || base, depth + 1)
        else await fromText(url, depth + 1)
      }
    }
  }
  for (const sheet of sheets) {
    let rules = null
    try { rules = sheet.cssRules } catch { rules = null }
    if (rules) await fromRules(rules, sheet.href || document.baseURI, 0)
    else await fromText(sheet.href, 0)
  }
  if (complete) fontReads.faces = { sig, list }
  return list
}

// The text the element draws, grouped by the font it is drawn with (family
// stack, weight, style), for pickFacesForText. Pseudo-element strings, form
// values and list numbers draw too; style and script text does not. A hidden
// part counts: print CSS may show it on the sheet.
const NO_TEXT = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'])
const LIST_MARKER_TEXT = '0123456789٠١٢٣٤٥٦٧٨٩.•◦▪-'
function drawnTextRuns(root) {
  const runs = new Map()
  const add = (cs, text) => {
    if (!cs || !text) return
    const families = familyNames(cs.fontFamily)
    if (!families.length) return
    const key = `${cs.fontFamily}\n${cs.fontWeight}\n${cs.fontStyle}`
    let run = runs.get(key)
    if (!run) runs.set(key, (run = { families, stack: cs.fontFamily, weight: Number.parseFloat(cs.fontWeight) || 400, style: cs.fontStyle, text: '' }))
    run.text += text
    // uppercase / capitalize draw letters the source text does not hold
    if (cs.textTransform && cs.textTransform !== 'none') run.text += text.toUpperCase() + text.toLowerCase()
  }
  const walk = (el) => {
    if (NO_TEXT.has(el.tagName)) return
    let cs
    try { cs = getComputedStyle(el) } catch { return } // not an element we can read
    for (const pseudo of ['::before', '::after']) {
      try {
        const ps = getComputedStyle(el, pseudo)
        add(ps, contentText(ps.content, (name) => el.getAttribute(name)))
      } catch { /* no pseudo-element style here */ }
    }
    if (cs.display === 'list-item' && cs.listStyleType !== 'none') add(cs, LIST_MARKER_TEXT)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') add(cs, `${el.value || ''}${el.placeholder || ''}`)
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) add(cs, node.nodeValue)
      else if (node.nodeType === 1) walk(node)
    }
  }
  walk(root)
  return Array.from(runs.values())
}

// The faces the sheet's text is drawn with, asked for and waited on before the
// sheet is measured: a weight the screen never showed starts loading only when
// text is laid out in it, and until it arrives that text is measured in a
// fallback font. A face that settled (loaded or failed) stays as it is, so the
// sheet is measured in what loadedFaceKeys() reports. Capped: a face still
// loading when the cap passes is measured, and drawn, without.
const FONT_SETTLE_MS = 1500
function settleRunFonts(runs) {
  const set = document.fonts
  if (!set || typeof set.load !== 'function' || !runs.length) return Promise.resolve()
  const loads = runs.map((r) => {
    try {
      return set.load(`${styleClass(r.style)} ${r.weight} 16px ${r.stack}`, r.text).catch(() => null)
    } catch {
      return null // a family stack the font shorthand cannot hold
    }
  })
  return new Promise((resolve) => {
    Promise.all(loads).then(resolve, resolve)
    setTimeout(resolve, FONT_SETTLE_MS)
  })
}

// The page's own faces that have loaded (faceKey): what its text is laid out in
// right now. null when the browser cannot say — every face then travels.
function loadedFaceKeys() {
  const set = document.fonts
  if (!set || typeof set.forEach !== 'function') return null
  const keys = new Set()
  set.forEach((f) => { if (f.status === 'loaded') keys.add(faceKey(f)) })
  return keys
}

// The embedded @font-face CSS for the faces `root`'s text is drawn with — for
// html-to-image (print.send) and for the PDF sheet. A font problem never stops
// the receipt or the export: it draws with a system font instead. The raster
// passes `loaded` (loadedFaceKeys): its boxes are measured in the page's own
// fonts, so it draws only with the faces the page has loaded — a terminal whose
// web font failed when the app started laid the slip out in a fallback, and
// the same font read here drew wider than those boxes (2026-10-26). The PDF
// sheet passes none: the server lays it out in what it embeds.
async function fontCssFor(root, { filesOnly = false, maxBytes = Infinity, runs = null, loaded = null } = {}) {
  try {
    const drawn = runs || drawnTextRuns(root)
    if (!drawn.length) return ''
    const { picked, key } = pickFacesForText(await pageFontFaces(), drawn, { filesOnly, loaded })
    if (!picked.length) return ''
    const kept = fontReads.css.get(key)
    if (kept != null && kept.length <= maxBytes) return kept
    const { css, complete, dropped } = await inlineFontFiles(picked, readFontFile, { maxBytes })
    if (complete && !dropped) fontReads.css.set(key, css)
    return css
  } catch (e) {
    console.warn('[print] web fonts not embedded', e)
    return ''
  }
}

/**
 * Lay the element out at the paper's dot width and read it back as pixels.
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number, dots: number }>}
 */
async function renderSheetPixels(el, opts = {}) {
  const dots = paperDots(opts.paper)
  document.getElementById(SEND_WRAP_ID)?.remove()
  const style = document.createElement('style')
  style.textContent = sendCssText(dots, opts)
  const wrap = document.createElement('div')
  wrap.id = SEND_WRAP_ID
  wrap.setAttribute('aria-hidden', 'true')
  wrap.setAttribute('data-whacka-print-root', '')
  // The wrapper hangs off <body>, so what the element INHERITS on screen
  // (dir="rtl" on an ancestor, the app's font) would be lost — an Arabic slip
  // came out mirrored. Carry the inherited text context across.
  const cs = getComputedStyle(el)
  wrap.setAttribute('dir', cs.direction === 'rtl' ? 'rtl' : 'ltr')
  const lang = el.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang
  if (lang) wrap.setAttribute('lang', lang)
  wrap.style.fontFamily = cs.fontFamily
  const clone = el.cloneNode(true)
  syncFormState(el, clone)
  wrap.appendChild(clone)
  document.head.appendChild(style)
  document.body.appendChild(wrap)
  try {
    // The clone's fonts and images are the on-screen ones (already loaded), so
    // this resolves in a few ms; the caps are tight because the hand-off that
    // follows is a navigation Chrome allows only inside the tap's activation
    // window (~5 s).
    await waitForAssets(wrap, { doc: document, fontMs: 400, imageMs: 1000 })
    // …except a weight only the receipt uses, which loads now (settleRunFonts).
    const runs = drawnTextRuns(wrap)
    await settleRunFonts(runs)
    const fontEmbedCSS = await fontCssFor(wrap, { runs, loaded: loadedFaceKeys() })
    const canvas = await toCanvas(wrap, {
      width: dots,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      cacheBust: false,
      // html-to-image copies every computed style onto its clone — including
      // the wrapper's off-screen placement, which would draw the sheet outside
      // the picture. Pin the clone's root in place.
      style: { position: 'static', left: 'auto', top: 'auto', zIndex: 'auto', opacity: '1', visibility: 'visible' },
      // The page's web fonts, read once per page (fontCssFor) — never
      // collected by html-to-image itself. NOT preferredFontFormat
      // (html-to-image drops every face after the first with it — see
      // share-card/rasterize.ts).
      fontEmbedCSS,
      fetchRequestInit: { mode: 'cors', cache: 'force-cache' },
      leanStyles: true,
    })
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    if (!width || !height) throw new Error('[print] empty raster')
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, dots }
  } finally {
    wrap.remove()
    style.remove()
    releaseLeanSandbox()
  }
}

// A slip print.renderEscPos already drew (print.send's `job`): sent as it is.
// Anything else is drawn again.
function preparedJob(job) {
  return job && job.bytes instanceof Uint8Array && job.bytes.length > 0 && job.width > 0 && job.height > 0 ? job : null
}

export const print = {
  /**
   * Print one element on a receipt printer — no print dialog.
   *
   * On Android (the browser, an installed PWA, or the store build) the sheet
   * is rendered to printer dots and handed to the RawBT print service, which
   * drives the printer — Bluetooth, USB, network, or the built-in printer of
   * a POS terminal. The device needs RawBT installed and pointed at its
   * printer once; a phone without it is sent to the Play listing on the first
   * tap. Anywhere else (desktop, iPhone) the same element opens the print
   * dialog — the OS printer driver then prints it.
   *
   * Call it from a tap (the hand-off is a navigation the browser allows on a
   * user action). The paper comes out of the printer; nothing comes back to
   * the app beyond the result below. Never throws: a sheet that cannot be
   * rendered (hidden, empty), a job too long for one hand-off, or a phone
   * without the print service answers `failed` with a reason.
   *
   * To lose no time when something must be saved first (the order's status, a
   * one-print lock), draw the slip with print.renderEscPos while that save runs
   * and pass what it returned as `job`: the slip goes to the printer the
   * moment the save answers, without being drawn again.
   *
   * In the installed Android app (a build made since 2026-10-26) the slip goes
   * to RawBT's print service directly: no RawBT window covers the app, slips
   * queue one after another, and the call resolves when RawBT has answered —
   * `printed: true`, or `failed` with RawBT's reason (the printer cannot be
   * reached, …). Android asks once per device to let the app use RawBT; if
   * that is refused, or RawBT is too old, the slip goes through RawBT's print
   * window as before (`sent`). Anywhere else `sent` means handed to RawBT —
   * whether it printed is not known.
   *
   * @param {HTMLElement|{current: HTMLElement}} elOrRef - element or React ref
   * @param {object} [opts]
   * @param {string} [opts.paper]  - '58mm' (default, handheld POS / small printers)
   *                                 or '80mm' (desktop receipt printers)
   * @param {number} [opts.copies] - 1..10
   * @param {string} [opts.margin] - inset inside the paper, default '2mm'
   * @param {string} [opts.title]  - the print dialog's document title (fallback path)
   * @param {{ bytes: Uint8Array, width: number, height: number }} [opts.job] - what
   *                                 print.renderEscPos(elOrRef, opts) returned for this
   *                                 element: sent as it is (Android); the dialog elsewhere
   *                                 still prints the element
   * @returns {Promise<{ status: 'sent'|'dialog'|'failed'|'noop', printed?: boolean, error?: string, dots?: number, rows?: number, bytes?: number }>}
   */
  async send(elOrRef, opts = {}) {
    const el = resolveEl(elOrRef)
    if (!el) {
      console.warn('[print] no element to print')
      return { status: 'noop' }
    }
    // Not Android → the dialog. Inside the editor preview (an iframe on the
    // builder's page) too: the hand-off is a navigation, and it would carry
    // the preview frame off to RawBT or the Play listing.
    if (!isAndroid() || shouldUseHostBridge()) {
      print.printElement(el, { title: opts.title, margin: opts.margin == null ? '4mm' : opts.margin })
      return { status: 'dialog' }
    }
    try {
      const { bytes, width, height } = preparedJob(opts.job) || await print.renderEscPos(el, opts)
      const size = { dots: width, rows: height, bytes: bytes.length }
      if (bytes.length > MAX_JOB_BYTES) {
        // One intent carries the whole job; past the parcel limit the tap
        // would crash an installed app or die silently in the browser.
        console.warn(`[print] job too long for one hand-off: ${bytes.length} bytes / ${height} rows (max ${MAX_JOB_BYTES})`)
        return { status: 'failed', error: 'too long for one job', ...size }
      }
      if (isNativeShell() && nativeHasMethod('WhackaPrint', 'printRawJob')) {
        // Installed app, binary from 2026-10-26 on: the shell hands the job to
        // RawBT's print service (no RawBT window over the app) and answers with
        // RawBT's outcome; it takes the intent itself when it cannot.
        const r = await nativePrintPlugin().printRawJob({ base64: bytesToBase64(bytes) })
        if (r && r.status === 'no_service') return { status: 'failed', error: 'print service not installed', ...size }
        if (r && r.status === 'failed') return { status: 'failed', error: r.error || 'printer error', ...size }
        if (r && r.status === 'printed') return { status: 'sent', printed: true, ...size }
        return { status: 'sent', ...size }
      }
      if (isNativeShell() && nativeHasMethod('WhackaPrint', 'printRaw')) {
        // Installed app, binary from 2026-10-15 on: the shell builds the
        // intent itself — a device without RawBT is sent to its Play listing
        // and the outcome comes back, where a navigation would fail silently.
        const r = await nativePrintPlugin().printRaw({ base64: bytesToBase64(bytes) })
        if (r && r.status === 'no_service') return { status: 'failed', error: 'print service not installed', ...size }
        return { status: 'sent', ...size }
      }
      window.location.href = rawbtJobUrl(bytes, { inShell: isNativeShell() })
      return { status: 'sent', ...size }
    } catch (e) {
      console.error('[print] send failed', e)
      return { status: 'failed', error: e && e.message ? e.message : String(e) }
    }
  },

  /**
   * The raw printer job for one element (ESC/POS raster, `GS v 0` bands +
   * feed + cut) — what print.send hands to the printer. For a transport of
   * your own, or drawn ahead and handed to print.send as `job`
   * (print.send(ref, { paper, job })).
   * @returns {Promise<{ bytes: Uint8Array, width: number, height: number }>}
   */
  async renderEscPos(elOrRef, opts = {}) {
    const el = resolveEl(elOrRef)
    if (!el) throw new Error('[print] no element to print')
    const { data, width, height } = await renderSheetPixels(el, opts)
    const packed = pixelsToBits(data, width, height, opts.threshold)
    const bytes = escposFromBits(packed, { copies: opts.copies, cut: opts.cut })
    return { bytes, width: packed.width, height: packed.height }
  },

  /**
   * @param {HTMLElement|{current: HTMLElement}} elOrRef - element or React ref
   * @param {object} [opts]
   * @param {string} [opts.title]  - sets the print/PDF document title
   * @param {string} [opts.margin] - paper inset, e.g. "12mm" (default) or "0";
   *                                 applied as padding inside the printed sheet
   * @param {string} [opts.size]   - fixed paper size for the print dialog, e.g.
   *                                 "A4", "A4 landscape", "Letter", "A3 landscape".
   *                                 Omit to use the printer's default.
   * @param {string} [opts.fit]    - 'page' scales the sheet down to fit exactly
   *                                 ONE page (measured, never clipped). Use for
   *                                 certificates / cards / terms / receipts that
   *                                 must never spill to a second page.
   */
  printElement(elOrRef, opts = {}) {
    const el = resolveEl(elOrRef)
    if (!el) {
      console.warn('[print] no element to print')
      return
    }
    const native = nativePrintPlugin()
    if (native) {
      // The store build: no window.print() in the WebView. The shell prints
      // the same serialized sheet docs.pdfFromElement sends the server. The
      // shell's own origin (https://localhost / capacitor://localhost) is
      // reachable only from the bridge web view, so the absolute URLs the
      // serialized CSS carries for bundled fonts / images are re-anchored on
      // the published app, which serves the same content-hashed assets.
      const appUrl = String(import.meta.env.VITE_APP_URL || '').replace(/\/+$/, '')
      const origin = window.location.origin
      buildSheetHtml(el, opts)
        .then((html) => {
          const sheet = appUrl && origin ? html.split(`${origin}/`).join(`${appUrl}/`) : html
          return native.printHtml({ html: sheet, title: opts.title || document.title || 'Document', baseUrl: appUrl || origin })
        })
        .catch((e) => console.error('[print] native print failed', e))
      return
    }
    const fitOn = wantsFit(opts)

    // Clear any leftovers from an interrupted previous print.
    document.getElementById(FRAME_ID)?.remove()

    const frame = document.createElement('iframe')
    frame.id = FRAME_ID
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', 'print')
    // Off-screen rather than display:none — a display:none frame doesn't lay
    // out, so images never load and some browsers refuse to print it. With fit
    // the frame takes the paper's own dimensions, so the sheet is measured at
    // the width it will actually print at.
    const paper = fitOn ? fitPaperPx(opts) : { w: 900, h: 1200 }
    frame.style.cssText =
      `position:fixed;left:-10000px;top:0;width:${paper.w}px;height:${paper.h}px;border:0;opacity:0;pointer-events:none;`
    document.body.appendChild(frame)

    const doc = frame.contentDocument
    if (!doc) { frame.remove(); return }

    doc.open()
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>')
    doc.close()

    // Carry the root/body attributes across so CSS custom properties and
    // class-keyed styling (theme palette, dark mode) resolve as on screen.
    for (const a of Array.from(document.documentElement.attributes)) {
      try { doc.documentElement.setAttribute(a.name, a.value) } catch {}
    }
    for (const a of Array.from(document.body.attributes)) {
      if (a.name === 'style' || a.name === 'id') continue
      try { doc.body.setAttribute(a.name, a.value) } catch {}
    }
    // Compat: app print CSS written against the previous in-place mechanism
    // (e.g. ink remaps keyed on these attributes) keeps applying in the frame.
    doc.body.setAttribute('data-whacka-print-root', '')

    // Copy the app's stylesheets so anything styled by class looks on paper as
    // it does on screen.
    document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
      doc.head.appendChild(node.cloneNode(true))
    })

    const prevTitle = document.title
    if (opts.title) {
      document.title = opts.title
      const t = doc.createElement('title')
      t.textContent = opts.title
      doc.head.appendChild(t)
    }

    // The frame's own rules, appended last so they win.
    const style = doc.createElement('style')
    style.textContent = sheetCss(opts)
    doc.head.appendChild(style)

    const wrap = doc.createElement('div')
    wrap.id = SHEET_ID
    wrap.setAttribute('data-whacka-print-target', '')
    const clone = el.cloneNode(true)
    syncFormState(el, clone)
    if (fitOn) {
      const fitWrap = doc.createElement('div')
      fitWrap.setAttribute('data-whacka-fit', '')
      fitWrap.appendChild(clone)
      wrap.appendChild(fitWrap)
    } else {
      wrap.appendChild(clone)
    }
    doc.body.appendChild(wrap)

    let done = false
    let started = false
    const cleanup = () => {
      if (done) return
      done = true
      document.title = prevTitle
      window.removeEventListener('afterprint', cleanup)
      setTimeout(() => frame.remove(), 300)
    }
    // Chrome fires afterprint on the printed frame; some browsers surface it on
    // the top window instead — listen on both, cleanup is idempotent.
    window.addEventListener('afterprint', cleanup)

    const go = () => {
      if (started) return
      started = true
      // Fonts and images have settled — measure now, right before printing.
      if (fitOn) {
        try {
          const fit = computeFit(doc, opts)
          if (fit) {
            const fitStyle = doc.createElement('style')
            fitStyle.id = FIT_STYLE_ID
            fitStyle.textContent = fitCssText(fit)
            doc.head.appendChild(fitStyle)
          }
        } catch (e) {
          console.warn('[print] fit measurement failed', e)
        }
      }
      try {
        frame.contentWindow.addEventListener('afterprint', cleanup)
        frame.contentWindow.focus()
        frame.contentWindow.print()
      } catch (e) {
        console.error('[print]', e)
      }
      // Some browsers never fire afterprint (and a print cancelled from the OS
      // dialog often doesn't) — never leave the frame behind.
      setTimeout(cleanup, 60000)
    }

    // Wait for cloned images (logos, signatures, photos), the copied
    // stylesheets and the fonts loading fresh in the frame to settle, so
    // nothing prints half-drawn — capped, so a slow network never blocks the job.
    waitForAssets(doc.body, { doc, fontMs: 1500, imageMs: 2500 }).then(() => setTimeout(go, 120))
  },
}
