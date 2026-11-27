/**
 * Google sign-in return path — the platform side of "come back to the page
 * you were on".
 *
 * "Continue with Google" is a full-page round trip (modal → whacka.app/api/
 * auth/app-google/start → Google → /auth/app-callback → back to the app's
 * origin with a one-time `#wk_code=`). The modal sends the visitor's current
 * page as `to=`, /start signs it into the OAuth state, the callback hands it
 * back as `&wk_to=`, and main.jsx writes it into the address bar
 * (history.replaceState) BEFORE exchanging the code and reloading — so the app
 * boots signed-in on that page instead of its root.
 *
 * Only ROOT-anchored pages ride: `/#/store/abc`, `/?store=abc`, `/?x=1#/p/2`.
 * Published apps are hash/query-routed (the CF worker 302s any dotless path to
 * `/#path` and 404s dotted ones), so a non-root pathname is never something a
 * reload can serve better than the root — it is dropped, which is the pre-fix
 * behavior. That shape rule is also the whole security argument: a value that
 * starts with "/" followed by "?" or "#" cannot name another origin.
 *
 * Twin of sanitizeAppReturnPath in src/lib/auth/utils.ts — the two bodies must
 * stay identical (scripts/_test-oauth-return-path.ts cross-checks them).
 * Pure helpers, no DOM; unit-tested in _oauth-return.test.mjs.
 */

// Twin of MAX_APP_RETURN_PATH (utils.ts) — see the note there.
export const MAX_RETURN_PATH = 512

/**
 * Accept a return path ONLY when it is root-anchored: "/" followed by "?" or
 * "#", no C0 control chars / DEL (URL parsers strip tab/newline — the classic
 * "/\t/evil" trick), bounded length. "/" alone → null (nothing to restore).
 * Anything else → null: the app boots at its root, never an error.
 */
export function safeReturnPath(to) {
  if (typeof to !== 'string' || !to || to.length > MAX_RETURN_PATH) return null
  if (to[0] !== '/' || (to[1] !== '?' && to[1] !== '#')) return null
  if (/[\u0000-\u001f\u007f]/.test(to)) return null
  return to
}

// The platform's own markers never ride along: `?wk_auth_error=1` (a failed
// attempt's flag — it would otherwise be replayed onto a later SUCCESSFUL
// sign-in) and a leftover `#wk_code=…` / `#wk_to=…` fragment.
function stripPlatformMarkers(search, hash) {
  let s = search || ''
  if (s.includes('wk_auth_error')) {
    const p = new URLSearchParams(s.replace(/^\?/, ''))
    p.delete('wk_auth_error')
    const q = p.toString()
    s = q ? `?${q}` : ''
  }
  const h = /(^|[#&?])wk_(code|to)=/.test(hash || '') ? '' : (hash || '')
  return { search: s, hash: h }
}

/** The relative page to come back to, from a Location-like object (path + query + hash). */
export function currentReturnPath(loc) {
  try {
    const l = loc || window.location
    const { search, hash } = stripPlatformMarkers(l.search, l.hash)
    return safeReturnPath(`${l.pathname || '/'}${search}${hash}`)
  } catch {
    return null
  }
}

/**
 * Parse the fragment /auth/app-callback lands us with:
 *   #wk_code=<code>[&wk_to=<encoded page>]   (success)
 *   #wk_to=<encoded page>                    (failure — ?wk_auth_error=1)
 * `matched` = the fragment IS an OAuth return (strip it even when `to` fails
 * the shape rule); `code` / `to` may each be null; `to` comes back sanitized.
 */
export function parseOAuthReturnHash(hash) {
  const out = { matched: false, code: null, to: null }
  if (typeof hash !== 'string' || !hash) return out
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const code = p.get('wk_code')
  const to = p.get('wk_to')
  out.matched = code !== null || to !== null
  out.code = code || null
  out.to = safeReturnPath(to)
  return out
}
