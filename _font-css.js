/**
 * Web fonts for print.send's raster and the PDF sheet — the pure half (no DOM,
 * no network).
 *
 * html-to-image draws an element by putting a copy of it inside an SVG image,
 * and an SVG image loads nothing from the network: every web font the element
 * uses has to travel inside it as a data: URL. Left to find those fonts itself,
 * html-to-image re-inserts every @import-ed and cross-origin @font-face into the
 * live page on EVERY call and then embeds all the copies it finds, so a screen
 * that stays open grows by one set of faces per print and each print is slower
 * than the last — 16 more faces per receipt for an app on Google Fonts' Cairo
 * (4 weights) + Lalezar (2026-10-21: cashier terminals in Misrata spent 4–6 s
 * per receipt on this step). print.js reads the page's @font-face text itself,
 * builds the embedded CSS once with these helpers and hands it to html-to-image
 * as `fontEmbedCSS`; nothing is written into the page.
 *
 * The server's PDF render page loads nothing either, so docs.pdfFromElement's
 * sheet carries the same embedded faces (2026-10-23: until then every PDF came
 * out in the server's default font, whatever font the app chose).
 *
 * The raster's boxes are measured in the fonts the page itself has, so it
 * embeds only the faces the page has loaded (faceKey, pickFacesForText's
 * `loaded`): a cashier terminal whose web font failed when the app started
 * laid the slip out in a fallback font, the same font read here at print time
 * drew wider, and words fell out of their boxes onto the next line
 * (2026-10-26, Misrata; reproduced 2026-10-29).
 */

const COMMENTS = /\/\*[\s\S]*?\*\//g
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi
const IMPORT = /@import\s+(?:url\(\s*(['"]?)([^'")]+?)\1\s*\)|(['"])([^'"]+)\3)/gi
const URL_REF = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g
const FAMILY = /font-family\s*:\s*([^;}]+)/i

// Generic families and keywords never name an @font-face of the page.
const GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji', 'fangsong',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert',
])

/** Every @font-face block in a stylesheet's text. */
export function fontFaceBlocks(cssText) {
  return String(cssText || '').replace(COMMENTS, '').match(FONT_FACE) || []
}

/** The @import targets in a stylesheet's text, as written. */
export function importRefs(cssText) {
  const out = []
  for (const m of String(cssText || '').replace(COMMENTS, '').matchAll(IMPORT)) out.push((m[2] || m[4]).trim())
  return out
}

/** A family name as CSS compares it: unquoted, trimmed, case-folded. */
export function normalizeFamily(name) {
  return String(name || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase()
}

/** The families a computed `font-family` value names, generic keywords dropped. */
export function familyNames(value) {
  return String(value || '').split(',').map(normalizeFamily).filter((n) => n && !GENERIC.has(n))
}

/** The family an @font-face block declares (null when it names none). */
export function blockFamily(block) {
  const m = FAMILY.exec(String(block || ''))
  return m ? normalizeFamily(m[1]) : null
}

/** A reference resolved against the stylesheet it was written in (null when it cannot be). */
export function resolveRef(ref, base) {
  try {
    return new URL(ref, base || undefined).href
  } catch {
    return null
  }
}

/** The files an @font-face block loads, with the exact text to replace (data: URLs are inline already). */
export function blockUrls(block) {
  const out = []
  for (const m of String(block || '').matchAll(URL_REF)) {
    const ref = m[2].trim()
    if (ref && !/^data:/i.test(ref)) out.push({ token: m[0], ref })
  }
  return out
}

/** A font-style value (descriptor or computed) as one of the three classes CSS matches on. */
export function styleClass(value) {
  const v = String(value || '').trim().toLowerCase()
  return v.startsWith('italic') ? 'italic' : v.startsWith('oblique') ? 'oblique' : 'normal'
}

const descriptor = (block, name) => {
  const m = new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;}]+)`, 'i').exec(String(block || ''))
  return m ? m[1].trim() : ''
}

/** The weights an @font-face block declares, as [min, max] (one value → [v, v]; none → 400). */
export function weightRange(block) {
  return weightsOf(descriptor(block, 'font-weight'))
}

// A font-weight descriptor's value — as written, or as a FontFace object reports it.
function weightsOf(value) {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return [400, 400]
  if (v === 'auto') return [1, 1000]
  const n = v.split(/\s+/).map((t) => (t === 'normal' ? 400 : t === 'bold' ? 700 : Number(t)))
  if (!n.length || n.some((x) => !Number.isFinite(x))) return [400, 400]
  return [Math.min(...n), Math.max(...n)]
}

/** The code points an @font-face block covers, as sorted, merged [start, end] pairs; null = every one. */
export function unicodeRanges(block) {
  return rangesOf(descriptor(block, 'unicode-range'))
}

// A unicode-range descriptor's value — as written, or as a FontFace object reports it.
function rangesOf(value) {
  const v = String(value || '').trim()
  if (!v) return null
  const out = []
  for (const raw of v.split(',')) {
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(raw.trim())
    // One unreadable part voids the whole descriptor, and the face covers everything.
    if (!m || (m[2] && m[1].includes('?'))) return null
    const a = parseInt(m[1].replace(/\?/g, '0'), 16)
    const b = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'f'), 16)
    if (a > b) return null
    out.push([a, b])
  }
  if (!out.length) return null
  out.sort((p, q) => p[0] - q[0])
  const merged = [out[0]]
  for (const [a, b] of out.slice(1)) {
    const last = merged[merged.length - 1]
    if (a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

/**
 * One @font-face as CSS matches it — family, style class, weights, code points —
 * whether read from a FontFace object (its family / style / weight /
 * unicodeRange strings: what the page's FontFaceSet holds, with its load status)
 * or from the block's text (blockFaceKey): the two give the same key, so the
 * faces the page has loaded can be told apart from those it has not.
 */
export function faceKey({ family, style, weight, unicodeRange } = {}) {
  const ranges = rangesOf(unicodeRange)
  // A FontFace with no unicode-range reports the whole of Unicode.
  const every = !ranges || (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 0x10ffff)
  return [normalizeFamily(family), styleClass(style), weightsOf(weight).join('-'), every ? '*' : ranges.map((r) => r.join('-')).join(',')].join('|')
}

/** faceKey of an @font-face block's text (null when it names no family). */
export function blockFaceKey(block) {
  const family = blockFamily(block)
  if (!family) return null
  return faceKey({ family, style: descriptor(block, 'font-style'), weight: descriptor(block, 'font-weight'), unicodeRange: descriptor(block, 'unicode-range') })
}

function covers(ranges, cp) {
  if (!ranges) return true
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < ranges[mid][0]) hi = mid - 1
    else if (cp > ranges[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

// How close a face's weights are to the wanted weight, in the order CSS Fonts 4
// §5.2 tries them (smaller first): inside the range; for 400–500, heavier up to
// 500, then lighter, then heavier past 500; below 400, lighter then heavier;
// above 500, heavier then lighter.
function weightRank(want, [min, max]) {
  if (want >= min && want <= max) return 0
  if (want >= 400 && want <= 500) {
    if (min > want && min <= 500) return 1 + (min - want) / 1e4
    if (max < want) return 2 + (want - max) / 1e4
    return 3 + (min - want) / 1e4
  }
  if (want < 400) return max < want ? 1 + (want - max) / 1e4 : 2 + (min - want) / 1e4
  return min > want ? 1 + (min - want) / 1e4 : 2 + (want - max) / 1e4
}

const STYLE_ORDER = {
  normal: ['normal', 'oblique', 'italic'],
  italic: ['italic', 'oblique', 'normal'],
  oblique: ['oblique', 'italic', 'normal'],
}

// The faces of one family the browser chooses for a style and weight: the
// nearest style that has faces, then the nearest weight among those.
function matchFaces(list, style, weight) {
  for (const s of STYLE_ORDER[style] || STYLE_ORDER.normal) {
    const same = list.filter((f) => f.style === s)
    if (!same.length) continue
    const best = Math.min(...same.map((f) => weightRank(weight, f.weight)))
    return same.filter((f) => weightRank(weight, f.weight) === best)
  }
  return []
}

/** The characters a pseudo-element's computed `content` draws (strings, counter digits, attr() values). */
export function contentText(content, attr = () => '') {
  const v = String(content || '')
  if (!v || v === 'none' || v === 'normal') return ''
  let out = ''
  for (const m of v.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) out += (m[1] ?? m[2]).replace(/\\(.)/g, '$1')
  if (/counters?\(/i.test(v)) out += '0123456789'
  for (const m of v.matchAll(/attr\(\s*([\w-]+)/gi)) out += attr(m[1]) || ''
  return out
}

/**
 * The page's faces an element's text is drawn with, as the browser matches
 * them (CSS Fonts 4 §5): for each character, the first family of its stack
 * whose faces for the run's style and weight cover it — a family later in the
 * stack draws only what the ones before it cannot. Each (stylesheet, block)
 * once, in the page's order (the later face wins, as in the page). A face that
 * loads nothing (local() only) never draws here: the next family does — and so
 * with `loaded`, a face outside it: the weight is still chosen first, as the
 * browser does, but a face the page could not load draws nothing, and the
 * page's text in it went to the next family. `key` names the set — the same
 * key means the same embedded CSS.
 * @param {{ block: string, base: string }[]} faces
 * @param {{ families: string[], weight: number, style: string, text: string }[]} runs - text grouped by
 *   the font it is drawn with; families normalized (familyNames), style a font-style value
 * @param {{ filesOnly?: boolean, loaded?: Set<string>|null }} [opts] - filesOnly: only faces loaded from a
 *   file (their data: faces already travel); loaded: the faceKey of every face the page has loaded — only
 *   those draw (null = every face)
 * @returns {{ picked: { block: string, base: string, urls: { token: string, ref: string }[] }[], key: string }}
 */
export function pickFacesForText(faces, runs, { filesOnly = false, loaded = null } = {}) {
  const seen = new Set()
  const all = []
  const byFamily = new Map()
  for (const f of faces || []) {
    const family = blockFamily(f && f.block)
    if (!family) continue
    const id = `${f.base || ''}\n${f.block}`
    if (seen.has(id)) continue
    seen.add(id)
    const urls = blockUrls(f.block)
    const face = {
      block: f.block,
      base: f.base || '',
      urls,
      loads: urls.length > 0 || /url\(\s*(['"]?)data:/i.test(f.block),
      style: styleClass(descriptor(f.block, 'font-style')),
      weight: weightRange(f.block),
      ranges: unicodeRanges(f.block),
      key: blockFaceKey(f.block),
      needed: false,
    }
    all.push(face)
    if (!byFamily.has(family)) byFamily.set(family, [])
    byFamily.get(family).push(face)
  }
  const matched = new Map()
  for (const run of runs || []) {
    let left = new Set()
    for (const ch of String(run.text || '')) left.add(ch.codePointAt(0))
    const style = styleClass(run.style)
    const weight = Number(run.weight) || 400
    for (const family of run.families || []) {
      if (!left.size) break
      const list = byFamily.get(family)
      if (!list) continue
      const mk = `${family}\n${style}\n${weight}`
      if (!matched.has(mk)) matched.set(mk, matchFaces(list, style, weight).filter((f) => f.loads && (!loaded || loaded.has(f.key))))
      const chosen = matched.get(mk)
      if (!chosen.length) continue
      const rest = new Set()
      for (const cp of left) {
        let drawn = false
        for (const face of chosen) {
          if (covers(face.ranges, cp)) {
            face.needed = true
            drawn = true
          }
        }
        if (!drawn) rest.add(cp)
      }
      left = rest
    }
  }
  const picked = all
    .filter((f) => f.needed && (!filesOnly || f.urls.length))
    .map(({ block, base, urls }) => ({ block, base, urls }))
  return { picked, key: picked.map((p) => `${p.base}\n${p.block}`).join('\n\n') }
}

/**
 * The picked faces as one CSS text with every file inlined through
 * `readFile(absoluteUrl)` → a data: URL, or null when it cannot be read.
 * `complete` is false when a file could not be inlined: that face falls back
 * to a system font this time, and the caller does not keep the result. Faces
 * past `maxBytes` of CSS are left out (`dropped` counts them) and draw with a
 * system font.
 * @param {{ block: string, base: string, urls: { token: string, ref: string }[] }[]} picked
 * @param {(url: string) => Promise<string|null>} readFile
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ css: string, complete: boolean, dropped: number }>}
 */
export async function inlineFontFiles(picked, readFile, { maxBytes = Infinity } = {}) {
  let complete = true
  const parts = await Promise.all((picked || []).map(async ({ block, base, urls }) => {
    let css = block
    for (const { token, ref } of urls) {
      const abs = resolveRef(ref, base)
      const data = abs ? await readFile(abs) : null
      if (!data) {
        complete = false
        continue
      }
      css = css.split(token).join(`url(${data})`)
    }
    return css
  }))
  const kept = []
  let size = 0
  let dropped = 0
  for (const css of parts) {
    if (size + css.length + 1 > maxBytes) {
      dropped++
      continue
    }
    kept.push(css)
    size += css.length + 1
  }
  return { css: kept.join('\n'), complete, dropped }
}
