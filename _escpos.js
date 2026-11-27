/**
 * ESC/POS raster + RawBT hand-off — the pure half of print.send (no DOM).
 *
 * A receipt printer takes a bitmap: ESC/POS `GS v 0` (raster bit image), one
 * bit per dot, 8 dots per byte, MSB = leftmost. We render the sheet to pixels
 * (print.js, html-to-image) and turn it into those bytes here — so Arabic,
 * logos and any font print exactly as the browser laid them out, on every
 * printer, without a code page in sight (thermal printers cannot shape Arabic
 * in text mode).
 *
 * Standard dot widths at 203 dpi: 58 mm paper = 384 dots, 80 mm = 576 dots.
 *
 * The bytes reach the printer through RawBT (Android print service for
 * thermal printers — Bluetooth / USB / network / the built-in printer of POS
 * terminals): its own demo site hands a page's job over as
 * `rawbt:base64,<bytes>` or, from a browser, the Chrome intent form
 * `intent:base64,<bytes>#Intent;scheme=rawbt;package=…;end;`. The intent form
 * also carries a fallback URL (the Play listing) for a device without RawBT.
 */

export const ESC = 0x1b
export const GS = 0x1d

export const PAPER_DOTS = { '58mm': 384, '80mm': 576 }
export const DEFAULT_PAPER = '58mm'

export const RAWBT_PACKAGE = 'ru.a402d.rawbtprinter'
export const RAWBT_PLAY_URL = `https://play.google.com/store/apps/details?id=${RAWBT_PACKAGE}`

/** Luminance below this (0–255, alpha composited on white) prints black. Text
 *  wants a hard threshold (crisp strokes); dithering is for photos, which a
 *  receipt does not carry. */
export const DEFAULT_THRESHOLD = 160

/** Rows per `GS v 0` command. One huge raster is legal but some firmware
 *  stalls on it; bands of 256 rows are the common practice. */
export const BAND_ROWS = 256

/** The whole job travels inside ONE Android intent (as a `rawbt:` / `intent:`
 *  URL), and a Binder parcel holds about 1 MB: past that `startActivity`
 *  throws and an installed app would crash on the tap. 192 KiB raw = 256 KiB
 *  of base64 — 80 mm paper × ~2,700 rows, a third of a metre of receipt. */
export const MAX_JOB_BYTES = 192 * 1024

export function paperDots(paper) {
  const key = String(paper || DEFAULT_PAPER).trim().toLowerCase().replace(/\s+/g, '')
  if (PAPER_DOTS[key]) return PAPER_DOTS[key]
  const n = Number(key)
  if (Number.isFinite(n) && n >= 8 && n <= 4096) return Math.floor(n)
  return PAPER_DOTS[DEFAULT_PAPER]
}

// A count option as the app passed it (a number, a numeric string, nothing,
// nonsense) → an integer inside [lo, hi], `dflt` when it is not a number.
function clampInt(value, dflt, lo, hi) {
  const n = value == null || value === '' ? dflt : Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

/**
 * RGBA pixels → packed 1-bit rows (1 = black). `width` is padded up to a
 * multiple of 8 dots; padding dots stay white.
 * @returns {{ width: number, height: number, bytesPerRow: number, bits: Uint8Array }}
 */
export function pixelsToBits(rgba, width, height, threshold = DEFAULT_THRESHOLD) {
  const bytesPerRow = Math.ceil(width / 8)
  const bits = new Uint8Array(bytesPerRow * height)
  const cut = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_THRESHOLD
  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerRow
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = rgba[i + 3] / 255
      // composite over white, then luminance
      const r = rgba[i] * a + 255 * (1 - a)
      const g = rgba[i + 1] * a + 255 * (1 - a)
      const b = rgba[i + 2] * a + 255 * (1 - a)
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      if (l < cut) bits[rowOff + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { width: bytesPerRow * 8, height, bytesPerRow, bits }
}

/**
 * Packed bits → the ESC/POS job: init, raster bands, feed, cut.
 * @param {{ bytesPerRow: number, height: number, bits: Uint8Array }} packed
 * @param {{ copies?: number, feed?: number, cut?: boolean, bandRows?: number }} [opts]
 * @returns {Uint8Array}
 */
export function escposFromBits(packed, opts = {}) {
  const copies = clampInt(opts.copies, 1, 1, 10)
  const feed = clampInt(opts.feed, 4, 0, 20)
  const cut = opts.cut !== false
  const bandRows = clampInt(opts.bandRows, BAND_ROWS, 1, 65535)
  const { bytesPerRow, height, bits } = packed
  if (bytesPerRow < 1 || bytesPerRow > 65535) throw new Error('[print] raster too wide')

  const bands = Math.ceil(height / bandRows)
  // ESC @ (2) + ESC a 0 (3) + 8 per band header + the bits + feed (3) + cut (3)
  const oneLen = 5 + bands * 8 + bytesPerRow * height + (feed ? 3 : 0) + (cut ? 3 : 0)
  const out = new Uint8Array(oneLen * copies)
  let p = 0
  out[p++] = ESC; out[p++] = 0x40 // ESC @  initialize
  out[p++] = ESC; out[p++] = 0x61; out[p++] = 0x00 // ESC a 0  left-align (the image already fills the width)
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    const rows = Math.min(bandRows, height - y0)
    // GS v 0 m xL xH yL yH d1…dk   m=0 normal density; x in BYTES, y in dots
    out[p++] = GS; out[p++] = 0x76; out[p++] = 0x30; out[p++] = 0x00
    out[p++] = bytesPerRow & 0xff; out[p++] = (bytesPerRow >> 8) & 0xff
    out[p++] = rows & 0xff; out[p++] = (rows >> 8) & 0xff
    const start = y0 * bytesPerRow
    out.set(bits.subarray(start, start + rows * bytesPerRow), p)
    p += rows * bytesPerRow
  }
  if (feed) { out[p++] = ESC; out[p++] = 0x64; out[p++] = feed } // ESC d n  feed n lines
  if (cut) { out[p++] = GS; out[p++] = 0x56; out[p++] = 0x01 } // GS V 1  partial cut (ignored by printers without a cutter)
  if (p !== oneLen) throw new Error('[print] job size mismatch')
  for (let c = 1; c < copies; c++) out.copyWithin(c * oneLen, 0, oneLen)
  return out
}

/** Bytes → base64, in the browser or node. */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof btoa !== 'function') return Buffer.from(bytes).toString('base64')
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

/**
 * The URL that hands the job to RawBT.
 *   inShell (Capacitor WebView): `rawbt:base64,…` — the shell opens an
 *     unknown scheme as an Android VIEW intent (Capacitor's launchIntent).
 *     Binaries from 2026-10-15 on do not navigate at all: the SDK calls the
 *     shell plugin's printRaw, which builds the intent and falls back to the
 *     Play listing itself; this form is for older binaries.
 *   browser (Chrome / WebAPK on Android): the intent form, which also names
 *     the package and a fallback URL — a phone without RawBT lands on its
 *     Play listing instead of a dead tap.
 */
export function rawbtJobUrl(bytes, { inShell = false, fallbackUrl = RAWBT_PLAY_URL } = {}) {
  const data = `base64,${bytesToBase64(bytes)}`
  if (inShell) return `rawbt:${data}`
  return `intent:${data}#Intent;scheme=rawbt;package=${RAWBT_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end;`
}

/**
 * Test / preview helper: read our own job back into packed rows (every `GS v 0`
 * band concatenated), so a test can turn the bytes into an image again.
 * @returns {{ width: number, height: number, bytesPerRow: number, bits: Uint8Array, copies: number }}
 */
export function decodeEscposRaster(bytes) {
  let bytesPerRow = 0
  const rows = []
  let copies = 0
  for (let i = 0; i < bytes.length; ) {
    if (bytes[i] === ESC && bytes[i + 1] === 0x40) { copies++; i += 2; continue }
    if (bytes[i] === ESC && bytes[i + 1] === 0x61) { i += 3; continue }
    if (bytes[i] === ESC && bytes[i + 1] === 0x64) { i += 3; continue }
    if (bytes[i] === GS && bytes[i + 1] === 0x56) { i += 3; continue }
    if (bytes[i] === GS && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const bpr = bytes[i + 4] | (bytes[i + 5] << 8)
      const h = bytes[i + 6] | (bytes[i + 7] << 8)
      if (bytesPerRow && bpr !== bytesPerRow) throw new Error('[print] mixed band widths')
      bytesPerRow = bpr
      i += 8
      if (copies <= 1) for (let y = 0; y < h; y++) rows.push(bytes.subarray(i + y * bpr, i + (y + 1) * bpr))
      i += bpr * h
      continue
    }
    throw new Error(`[print] unexpected byte 0x${bytes[i].toString(16)} at ${i}`)
  }
  const bits = new Uint8Array(rows.length * bytesPerRow)
  rows.forEach((r, y) => bits.set(r, y * bytesPerRow))
  return { width: bytesPerRow * 8, height: rows.length, bytesPerRow, bits, copies }
}
