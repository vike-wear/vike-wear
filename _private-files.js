/**
 * Private files on the page (2026-10-21; the server half is
 * src/lib/files/private-files.ts).
 *
 * A file uploaded with { private: true } is stored by its STABLE address,
 * which opens for no one. Every read the server answers swaps in a link that
 * works for about a day, so `<img src={row.photo}>` keeps working. Two things
 * remain for the page:
 *   - a row that arrived straight from the database stream (the change-stream
 *     fallback, a live chat message) still names the stable address: read it
 *     again through the server, which hands back the links;
 *   - a list that stays on screen re-reads once before its links expire.
 */

// No imports: the node tests load this module as it is.

const STABLE = /\/storage\/v1\/object\/authenticated\/app-documents\/[0-9a-f-]{36}\/p\//
const SIGNED_TOKEN = /\/storage\/v1\/object\/sign\/app-documents\/[0-9a-f-]{36}\/p\/[^"'\s?]+\?token=([A-Za-z0-9._-]+)/g

/** A list re-reads this long before its links expire. */
export const LINK_RENEW_MARGIN_MS = 15 * 60 * 1000

function text(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) || ''
  } catch {
    return ''
  }
}

/** Does the value name a private file by its stable address (no working link yet)? */
export function hasUnsignedPrivateFile(value) {
  return STABLE.test(text(value))
}

function tokenExpiryMs(token) {
  try {
    const part = token.split('.')[1]
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4)
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
    const exp = JSON.parse(json).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

/** When the first private-file link in the value stops working (ms), or null. */
export function earliestLinkExpiry(value) {
  const s = text(value)
  if (!s.includes('/object/sign/app-documents/')) return null
  let min = null
  for (const m of s.matchAll(SIGNED_TOKEN)) {
    const exp = tokenExpiryMs(m[1])
    if (exp != null && (min == null || exp < min)) min = exp
  }
  return min
}

/**
 * Hand events to `callback` in the order they came, reading an event's row
 * again first when it names a private file by its stable address (`readRow`
 * answers with the row as the server hands it out, or null). Events with no
 * such file go straight through while nothing is waiting.
 */
export function inOrderWithFileLinks(callback, needsLinks, readRow) {
  let chain = null
  let waiting = 0
  return (event) => {
    if (waiting === 0 && !needsLinks(event)) {
      callback(event)
      return
    }
    waiting += 1
    const prev = chain || Promise.resolve()
    chain = prev.then(async () => {
      let out = event
      if (needsLinks(event)) {
        try {
          const fresh = await readRow(event)
          if (fresh) out = fresh
        } catch {
          // The row goes through as it came: the file shows once the page reads it again.
        }
      }
      waiting -= 1
      try { callback(out) } catch (e) { console.error('[private-files] listener error:', e) }
    })
  }
}
