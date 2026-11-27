/**
 * A random v4 UUID that works in every browser an app can run in.
 *
 * crypto.randomUUID exists only from Chrome 92 / Safari 15.4 / Firefox 95 on,
 * while the bundle runs from Chrome 87 / Safari 14 (vite's default target) —
 * an iPhone on iOS 14–15.3 or an Android WebView that was never updated has
 * `crypto` but not this one method. Minting the visitor's anonymous id threw
 * there: every SDK path that reads the id unguarded crashed the page
 * (realtime.presence first among them), and the guarded one (the request
 * headers) sent the visitor out with no identity, so their private writes were
 * refused (2026-10-04). crypto.getRandomValues is in all of those browsers;
 * Math.random only if even that is missing. Same 36-character shape either way
 * — the server checks it (runtime-identity UUID_RE).
 *
 * @param {Crypto} [c] - injectable for tests; defaults to the page's crypto
 * @returns {string}
 */
export function randomUuid(c = globalThis.crypto) {
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID() } catch { /* fall through to the byte path */ }
  }
  const b = new Uint8Array(16)
  let filled = false
  if (c && typeof c.getRandomValues === 'function') {
    try { c.getRandomValues(b); filled = true } catch { /* fall through */ }
  }
  if (!filled) for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
