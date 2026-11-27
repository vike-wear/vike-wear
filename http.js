/**
 * Outbound HTTP — call real third-party REST APIs from your app.
 *
 * Requests are proxied through the platform server: no CORS problems, and
 * API keys never appear in the browser. A stored key ("{{secrets.NAME}}") is
 * used only inside an ACTION — a named request template in src/actions.json
 * that the server fills in (http.action / http.actionJSON below); the page
 * passes the action's name and parameters, never the request itself (page
 * code is on the visitor's phone).
 *
 * The app builder must approve each hostname once (the agent requests it
 * during the build; the owner taps Approve in chat).
 *
 * Limits: 30 requests/min per user, a daily ceiling per user set by the
 * owner's plan, 2MB response max, up to 120s for the remote host to answer.
 * Text/JSON responses only.
 */

import { getHeaders } from './_headers'
import { showIntegrationNotice } from './_integration-notice'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { KEEPALIVE_HEADERS, readKeepaliveJson, throwFromEnvelope } from './_keepalive'
import { absorbSessionRenewal } from './_session-expiry'
import { withVisitorCheck } from './_visitor-check'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// The server waits up to 120s for the remote host under the keep-alive
// envelope (http/fetch/route.ts UPSTREAM_TIMEOUT_KEEPALIVE_MS — an LLM asked
// for a page of text takes 30–90s; the flat 10s before 2026-10-11 cut every
// such call). This is the client's ceiling above the server's so a genuinely
// stuck call still ends; the headers come back at once under keep-alive, so
// sdkFetch's own 30s deadline is already satisfied.
const HTTP_TIMEOUT_MS = 150_000

export const http = {
  /**
   * Make an outbound HTTP request via the platform proxy. Keyless: a request
   * that needs a stored key is an action (http.action below).
   *
   * @param {string} url - Full https URL.
   * @param {object} [options]
   * @param {string} [options.method] - GET (default), POST, PUT, PATCH, DELETE, HEAD
   * @param {object} [options.headers] - Request headers.
   * @param {string} [options.body] - Raw request body (string).
   * @returns {Promise<{ status: number, contentType: string, body: string }>}
   *   Resolves for ANY upstream status — check `status` yourself.
   *   Throws only when the proxy refuses or the request fails entirely;
   *   the Error then has `.code`: 'HOST_NOT_APPROVED' | 'SECRET_MISSING' |
   *   'QUOTA_EXCEEDED' | 'DAILY_LIMIT' | 'RATE_LIMITED' | 'RESPONSE_TOO_LARGE' |
   *   'UPSTREAM_FAILED' (plus `.status`, `.hostname` when the server named the
   *   host); 'TIMEOUT' / 'NETWORK' / 'KEEPALIVE_CUT' without a status when the
   *   proxy never finished answering.
   *
   * @example
   * // A public API, no key:
   * const res = await http.fetch('https://api.example.com/v1/items', {
   *   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }),
   * })
   * const data = JSON.parse(res.body)
   */
  async fetch(url, { method = 'GET', headers, body } = {}) {
    if (!url) throw new Error('http.fetch: "url" is required')
    const res = await withVisitorCheck((extra) => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/http/fetch`, {
      method: 'POST',
      headers: { ...getHeaders(), ...KEEPALIVE_HEADERS, ...extra },
      body: JSON.stringify({ url, method, headers, body }),
    }, { route: 'http/fetch' }))
    absorbSessionRenewal(res)
    // Refusals before the send (approval, quota, secrets) arrive as real
    // statuses; the send itself runs inside the keep-alive envelope (a
    // heartbeat space every 15s, then ONE {__wk:'envelope',status,body}) so a
    // remote host that answers in a minute is waited for instead of being cut
    // at Cloudflare's 100s. Both paths throw the same Error shape.
    try {
      if (!res.ok) await throwFromResponse(res, 'Request failed', 'http/fetch')
      const out = await readKeepaliveJson(res, 'http/fetch', { timeoutMs: HTTP_TIMEOUT_MS })
      if (!out.ok) throwFromEnvelope(out, res, 'Request failed', 'http/fetch')
      return out.body && typeof out.body === 'object' ? out.body : {}
    } catch (err) {
      // Approval walls get the shell's own honest strip: app error handling
      // almost never renders the real cause, and end users were being told to
      // check their internet while the fix was one owner tap (V12 2026-08-06).
      // A redirect onto an unapproved host is refused mid-send, so the same
      // code can arrive inside the envelope — the strip covers both.
      if (err.code === 'HOST_NOT_APPROVED') showIntegrationNotice({ kind: 'hostPending' })
      else if (err.code === 'SECRET_MISSING') showIntegrationNotice({ kind: 'secretMissing' })
      if (err.body && err.body.hostname) err.hostname = err.body.hostname
      throw err
    }
  },

  /**
   * GET a JSON endpoint and return the parsed object.
   * Throws when the upstream status is not 2xx (error has `.status`).
   *
   * @example
   * const books = await http.getJSON('https://openlibrary.org/search.json?q=' + encodeURIComponent(title))
   */
  async getJSON(url, options = {}) {
    const res = await this.fetch(url, { ...options, method: options.method || 'GET' })
    return parseJsonResult(res)
  },

  /**
   * Run a named action from src/actions.json — the request template (url,
   * method, headers, body, the owner's {{secrets.*}}) lives on the server; the
   * page sends only the parameters the template exposes as {{name}}.
   *
   * @param {string} name - The action's key in src/actions.json
   * @param {object} [params] - Values for the template's {{name}} placeholders
   *   (strings, numbers, objects, arrays — a JSON body field that is exactly
   *   "{{name}}" takes the value as-is)
   * @returns {Promise<{ status: number, contentType: string, body: string }>}
   *   Same shape and error codes as http.fetch, plus `.code`:
   *   'ACTION_NOT_FOUND' (no such action — for a published app, in the LIVE
   *   version) | 'ACTION_PARAM_MISSING' (a placeholder got no value) |
   *   'ACTION_INVALID' (src/actions.json has errors; the message lists them) |
   *   'ACTION_FORBIDDEN' (the action set "allow" and the signed-in caller is
   *   not in scope).
   *
   * An action may add "allow" to say who can call it — "owner" (the signed-in
   * app owner), "members" (any signed-in Teams member), "role:<name>" or
   * "signed-in" (anyone signed in to the app). Omit it and anyone on the internet
   * can call it (the default). Set it on anything that acts on the owner's
   * account, sends on their behalf, or returns their data.
   *
   * @example
   * // src/actions.json:
   * // { "notifyOrder": { "method": "POST", "allow": "owner",
   * //     "url": "https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage",
   * //     "body": { "chat_id": "{{secrets.TELEGRAM_CHAT_ID}}", "text": "{{text}}" } } }
   * await http.action('notifyOrder', { text: `Order #${order.no} is ready` })
   */
  async action(name, params = {}) {
    if (!name) throw new Error('http.action: "name" is required')
    const res = await withVisitorCheck((extra) => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/http/action`, {
      method: 'POST',
      headers: { ...getHeaders(), ...KEEPALIVE_HEADERS, ...extra },
      body: JSON.stringify({ name, params }),
    }, { route: 'http/action' }))
    absorbSessionRenewal(res)
    try {
      if (!res.ok) await throwFromResponse(res, 'Request failed', 'http/action')
      const out = await readKeepaliveJson(res, 'http/action', { timeoutMs: HTTP_TIMEOUT_MS })
      if (!out.ok) throwFromEnvelope(out, res, 'Request failed', 'http/action')
      return out.body && typeof out.body === 'object' ? out.body : {}
    } catch (err) {
      if (err.code === 'HOST_NOT_APPROVED') showIntegrationNotice({ kind: 'hostPending' })
      else if (err.code === 'SECRET_MISSING') showIntegrationNotice({ kind: 'secretMissing' })
      if (err.body && err.body.hostname) err.hostname = err.body.hostname
      throw err
    }
  },

  /**
   * Run an action and return the parsed JSON body.
   * Throws when the upstream status is not 2xx (error has `.status`).
   *
   * @example
   * const quote = await http.actionJSON('price', { symbol: 'XAU/USD' })
   */
  async actionJSON(name, params = {}) {
    const res = await this.action(name, params)
    return parseJsonResult(res)
  },
}

function parseJsonResult(res) {
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`Upstream returned ${res.status}`)
    err.status = res.status
    err.body = res.body
    throw err
  }
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error('Upstream response is not valid JSON')
  }
}
