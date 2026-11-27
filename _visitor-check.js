/**
 * The platform's visitor check (2026-11-02; server: src/lib/runtime/visitor-check.ts).
 *
 * A request that uses the owner's stored key may be asked to show it comes from a
 * browser: the server answers 403 VISITOR_CHECK, and this module loads Cloudflare's
 * widget in a frame nobody sees, trades its token for a short pass, and sends the
 * request once more. Most visitors are never asked: the first calls of a day need no
 * pass. Nothing is drawn unless Cloudflare is not sure of this visitor: then the frame
 * comes into view, one tap settles it, and it goes away.
 *
 * The check belongs to the page, not to the call that started it. It downloads about
 * 1.7 MB and on a slow line needs a minute or more, and cut off it starts again from
 * nothing, so such a phone would never finish. It runs until Cloudflare answers: a call
 * waits a while and then takes its refusal, and a later call finds the pass.
 *
 * If the check cannot run (the network blocks it, the browser is too old) or the tap
 * does not come, the caller gets the original refusal, a normal SDK error with code
 * VISITOR_CHECK.
 */

import { getHeaders } from './_headers.js'
import { sdkFetch } from './_fetch.js'
import { storeGet, storeSet, storeRemove } from './_session-store.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID
const PASS_KEY = '__whacka_visitor_pass'
const CODE_HEADER = 'X-Whacka-Code'
const CHECK_CODE = 'VISITOR_CHECK'
/** A call waits this long on the check, then gets its refusal. The check goes on. */
export const CALL_WAIT_MS = 60000
/** The check runs this long at most. With the production key (2026-11-02): 4 s on a fast machine,
 *  5 to 16 s on real phones, 38 s at 400 kbps, over 70 s at 250 kbps with a phone's CPU. */
export const CHECK_LIFE_MS = 180000
/** Once Cloudflare asks for a tap, the tap is waited for this long. The page stays usable meanwhile. */
export const TAP_WAIT_MS = 60000
/** A check that got no pass: no new one for this long, twice that after the next, up to the most.
 *  Each costs the visitor megabytes, and in between a call gets its refusal at once. */
export const CHECK_REST_MS = 30000
export const CHECK_REST_MOST_MS = 480000
const FRAME_UNSEEN = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
// At the top: a keyboard or an app's own bottom bar never covers it. The widget is 300 by 65.
const FRAME_SHOWN = 'position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top, 0px));transform:translateX(-50%);width:300px;height:65px;max-width:100vw;border:0;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,.3);z-index:2147483647'

function storedPass() {
  try {
    const held = JSON.parse(storeGet(PASS_KEY) || 'null')
    if (held && typeof held.pass === 'string' && typeof held.until === 'number' && held.until > Date.now()) return held.pass
  } catch {}
  return null
}

/** The header for the pass this browser holds, if any. */
export function visitorPassHeaders() {
  const pass = storedPass()
  return pass ? { 'X-Whacka-Pass': pass } : {}
}

/** The widget always runs on the platform's own host: a custom domain is not one it names. */
function frameOrigin() {
  return API_BASE || 'https://whacka.app'
}

function tokenFromFrame() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const origin = frameOrigin()
    const frame = document.createElement('iframe')
    frame.src = `${origin}/api/app/${PROJECT_ID}/visitor-check`
    frame.title = ''
    frame.tabIndex = -1
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = FRAME_UNSEEN
    let settled = false
    let timer = null
    const finish = (token) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      try { frame.remove() } catch {}
      resolve(token)
    }
    function onMessage(e) {
      if (e.source !== frame.contentWindow || e.origin !== origin) return
      const m = e.data
      if (!m || m.wkVisitorCheck !== 1) return
      if (m.show === 1) {
        frame.removeAttribute('aria-hidden')
        frame.tabIndex = 0
        frame.style.cssText = FRAME_SHOWN
        clearTimeout(timer)
        tapUntil = Date.now() + TAP_WAIT_MS
        timer = setTimeout(() => finish(null), TAP_WAIT_MS)
        return
      }
      finish(typeof m.token === 'string' ? m.token : null)
    }
    window.addEventListener('message', onMessage)
    timer = setTimeout(() => finish(null), CHECK_LIFE_MS)
    ;(document.body || document.documentElement).appendChild(frame)
  })
}

let running = null
let tapUntil = 0
let restUntil = 0
let rest = CHECK_REST_MS

/** The page's one check, started if none is running and none just failed. Null = resting. */
function startCheck() {
  if (running) return running
  if (Date.now() < restUntil) return null
  running = (async () => {
    let pass = null
    try {
      const token = await tokenFromFrame()
      if (token) {
        const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/visitor-check`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ token }),
        }, { route: 'visitor-check' })
        const out = res.ok ? await res.json() : null
        if (out && typeof out.pass === 'string') {
          storeSet(PASS_KEY, JSON.stringify({ pass: out.pass, until: Date.now() + (Number(out.expiresIn) || 0) * 1000 }))
          pass = out.pass
        }
      }
    } catch {}
    running = null
    tapUntil = 0
    if (pass) {
      rest = CHECK_REST_MS
    } else {
      restUntil = Date.now() + rest
      rest = Math.min(rest * 2, CHECK_REST_MOST_MS)
    }
    return pass
  })()
  return running
}

/**
 * A fresh pass, or null. Calls share the page's one check, each waiting CALL_WAIT_MS on it
 * (and for as long as a person is being asked to tap); the check does not stop for them.
 */
export function obtainVisitorPass() {
  const check = startCheck()
  if (!check) return Promise.resolve(null)
  return new Promise((resolve) => {
    let timer = null
    const giveUp = () => {
      const left = tapUntil - Date.now()
      if (left > 0) timer = setTimeout(giveUp, left)
      else resolve(null)
    }
    timer = setTimeout(giveUp, CALL_WAIT_MS)
    check.then((pass) => {
      clearTimeout(timer)
      resolve(pass)
    })
  })
}

function isAsked(res) {
  return !!res && res.status === 403 && !!res.headers && typeof res.headers.get === 'function' && res.headers.get(CODE_HEADER) === CHECK_CODE
}

/**
 * Send a request that may use a stored key. `send(extraHeaders)` makes the call and
 * returns its Response; it runs again at most once, with a fresh pass, only when the
 * server asked. The answer to a refused request carried no work, so nothing is sent twice.
 */
export async function withVisitorCheck(send) {
  const sent = storedPass()
  const res = await send(sent ? { 'X-Whacka-Pass': sent } : {})
  if (!isAsked(res)) return res
  // Only the pass this call carried is spent: a check may have finished while it was on its way.
  const held = storedPass()
  if (held === sent) storeRemove(PASS_KEY)
  const pass = held && held !== sent ? held : await obtainVisitorPass()
  if (!pass) return res
  return send({ 'X-Whacka-Pass': pass })
}
