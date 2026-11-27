/**
 * print.send's raster carries only the styles that change the picture
 * (2026-10-27).
 *
 * html-to-image draws an element by cloning it into an SVG image and writes
 * EVERY computed style property of every element onto the clone — about 300
 * per element in Chrome, whose computed cssText is empty — almost all of them
 * the value the clone would compute anyway. A one-item restaurant slip became
 * an 810 KB picture, and drawing it was the slowest step of a print on a
 * handheld POS (record: docs/_receipt-printing-2026-10-15.md § 2026-10-27).
 *
 * With `leanStyles` (print.js passes it to our copy of html-to-image,
 * ./_html-to-image/clone-node.js) a property is left off an element only when
 * the clone is sure to compute the same value without it: the browser's own
 * stylesheet gives this kind of element what it gives a plain div, the parent
 * computes the same value, and that value is either what a fresh element of
 * this kind computes on a blank page or one the parent passes down by itself
 * (an inherited property). Values the browser resolves from layout or from
 * another property — sizes, margins, paddings, offsets, border and outline
 * widths, the colours that default to the text colour, display, position,
 * grid tracks — are always written, and so is everything on elements whose
 * defaults depend on more than their kind (form controls, lists, tables with
 * border / cellpadding attributes, SVG, custom elements, shadow content). The
 * printed dots come out the same as with the full copy.
 *
 * The blank page is a hidden same-origin iframe made when a default is first
 * needed and removed at the end of each print (releaseLeanSandbox); the
 * defaults it gives are kept for the page, per element kind and the
 * attributes that can change them.
 *
 * The decisions are pure (leaveOutValue, leanKey) and node-tested in
 * _lean-style.test.mjs; the rest reads the live DOM.
 */

// Resolved from layout or from another property: always written.
export const LEAN_ALWAYS_WRITE = new RegExp('^(?:' + [
  'width', 'height', 'inline-size', 'block-size',
  '(?:min|max)-(?:width|height|inline-size|block-size)',
  'margin(?:-.+)?', 'padding(?:-.+)?',
  'top', 'right', 'bottom', 'left', 'inset(?:-.+)?',
  'border(?:-.+)?-width', 'outline-width', 'column-rule-width',
  'border(?:-.+)?-color', 'outline-color', 'column-rule-color', 'text-decoration-color', 'text-emphasis-color',
  'caret-color', 'accent-color', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-tap-highlight-color',
  'display', 'position', 'float', 'clear', 'z-index', 'vertical-align', 'box-sizing',
  'transform-origin', 'perspective-origin',
  'flex(?:-.+)?', 'order', 'align-self', 'justify-self', 'place-self', 'grid(?:-.+)?',
  'overflow(?:-.+)?', 'aspect-ratio', 'contain-intrinsic-.+',
].join('|') + ')$')

// Elements whose browser defaults depend on more than their kind: full copy.
export const LEAN_WRITE_ALL_TAGS = new Set([
  'input', 'select', 'textarea', 'button', 'option', 'optgroup', 'datalist', 'meter', 'progress', 'output',
  'fieldset', 'legend', 'details', 'summary', 'dialog',
  'iframe', 'frame', 'frameset', 'embed', 'object', 'video', 'audio', 'canvas', 'marquee',
  'ul', 'ol', 'li', 'menu', 'dir',
  'ruby', 'rt', 'rp', 'rb', 'rtc',
])
const TABLE_PARTS = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])
// A table's own attributes style its cells (border, padding): full copy inside one.
export const LEAN_HINTED_TABLE = 'table[border],table[rules],table[frame],table[cellpadding],table[cellspacing],table[bordercolor]'

// Attributes the browser never styles by: they do not change an element's defaults.
const KEY_IGNORED = /^(?:class|style|id|data-.*|aria-.*|role|title|alt|tabindex|src|srcset|loading|decoding|crossorigin|referrerpolicy|fetchpriority|draggable|translate|spellcheck|autocomplete|name|for|target|rel|download|ping|hreflang|nonce|part|exportparts|slot|key|xmlns(?::.*)?)$/i

/**
 * The defaults cache key: the element's kind and the attributes that can
 * change what the browser gives it (an href only by its presence).
 * @param {string} localName
 * @param {Array<[string, string]>} attrs - [name, value] pairs
 */
export function leanKey(localName, attrs) {
  const kept = []
  for (const [name, value] of attrs || []) {
    const n = String(name).toLowerCase()
    if (KEY_IGNORED.test(n)) continue
    kept.push(n === 'href' ? 'href' : `${n}=${value}`)
  }
  kept.sort()
  return kept.length ? `${localName}|${kept.join('|')}` : localName
}

/**
 * Whether one computed value can be left off the clone.
 * @param {object} p
 * @param {boolean} p.always       - resolved from layout / another property
 * @param {string}  p.value        - the element's computed value
 * @param {string}  p.tagDefault   - what a fresh element of its kind computes on a blank page
 * @param {string}  p.divDefault   - what a plain div computes there
 * @param {string}  p.parentValue  - the parent's computed value
 * @param {boolean|null} p.inherited - whether the parent passes it down (null: not known)
 */
export function leaveOutValue({ always, value, tagDefault, divDefault, parentValue, inherited }) {
  if (always) return false
  if (tagDefault !== divDefault) return false // the browser's own style for this kind sets it
  if (value !== parentValue) return false
  return value === tagDefault || inherited === true
}

// ── the live DOM ──

const XHTML = 'http://www.w3.org/1999/xhtml'
const MAX_KINDS = 500
const kinds = new Map() // leanKey → computed defaults
const inheritance = new Map() // property → true / false
const alwaysByList = new WeakMap() // style property list → Set of the always-written names
let sandbox = null

function sandboxDoc() {
  if (sandbox && sandbox.isConnected && sandbox.contentDocument && sandbox.contentDocument.body) return sandbox.contentDocument
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;height:600px;border:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write('<!doctype html><html><head></head><body></body></html>')
  doc.close()
  sandbox = frame
  return doc
}

/** The print is over: the blank page goes; the defaults it gave are kept. */
export function releaseLeanSandbox() {
  if (sandbox) {
    try { sandbox.remove() } catch { /* already gone */ }
    sandbox = null
  }
}

function defaultsOf(localName, attrs, props) {
  const key = leanKey(localName, attrs)
  let d = kinds.get(key)
  if (d) return d
  const doc = sandboxDoc()
  const el = doc.createElement(localName)
  for (const [name, value] of attrs) {
    if (!KEY_IGNORED.test(String(name).toLowerCase())) el.setAttribute(name, String(name).toLowerCase() === 'href' ? '#' : value)
  }
  doc.body.appendChild(el)
  const cs = doc.defaultView.getComputedStyle(el)
  d = Object.create(null)
  for (const name of props) d[name] = cs.getPropertyValue(name)
  el.remove()
  if (kinds.size >= MAX_KINDS) kinds.clear()
  kinds.set(key, d)
  return d
}

// Whether a child computes the parent's value of `prop`, tested on the blank
// page with a value this page uses. null when the blank page will not take it.
function inheritedProp(prop, value) {
  if (inheritance.has(prop)) return inheritance.get(prop)
  const doc = sandboxDoc()
  const win = doc.defaultView
  const parent = doc.createElement('div')
  const child = doc.createElement('div')
  parent.appendChild(child)
  doc.body.appendChild(parent)
  const before = win.getComputedStyle(parent).getPropertyValue(prop)
  parent.style.setProperty(prop, value)
  const set = win.getComputedStyle(parent).getPropertyValue(prop)
  const passed = win.getComputedStyle(child).getPropertyValue(prop)
  parent.remove()
  if (set === before) return null
  const inherited = passed === set
  inheritance.set(prop, inherited)
  return inherited
}

function leanEligible(el) {
  if (!el || el.namespaceURI !== XHTML) return false
  const tag = el.localName
  if (LEAN_WRITE_ALL_TAGS.has(tag) || tag.includes('-')) return false
  if (!el.parentElement || el.assignedSlot || el.getRootNode() !== el.ownerDocument) return false
  if (TABLE_PARTS.has(tag) && el.closest(LEAN_HINTED_TABLE)) return false
  return true
}

/**
 * For our copy of html-to-image (clone-node.js): null → copy every property as
 * before; else `leaveOut(name, value)` says which computed values the clone of
 * `el` computes by itself. Any failure answers null — a print never fails here.
 * @param {Element} el - the element being cloned (never the clone's root)
 * @param {string[]} props - the property list html-to-image copies
 */
export function leanStyleOf(el, props) {
  try {
    if (!leanEligible(el)) return null
    const attrs = Array.from(el.attributes, (a) => [a.name, a.value])
    const tagD = defaultsOf(el.localName, attrs, props)
    const divD = defaultsOf('div', [], props)
    const parentStyle = window.getComputedStyle(el.parentElement)
    let always = alwaysByList.get(props)
    if (!always) {
      always = new Set(props.filter((name) => LEAN_ALWAYS_WRITE.test(name)))
      alwaysByList.set(props, always)
    }
    return {
      leaveOut(name, value) {
        try {
          if (always.has(name)) return false
          const tagDefault = tagD[name]
          const divDefault = divD[name]
          const parentValue = parentStyle.getPropertyValue(name)
          // the blank page is asked about inheritance only when that alone decides
          const ask = tagDefault === divDefault && value === parentValue && value !== tagDefault
          return leaveOutValue({ always: false, value, tagDefault, divDefault, parentValue, inherited: ask ? inheritedProp(name, value) : null })
        } catch {
          return false
        }
      },
    }
  } catch {
    return null
  }
}
