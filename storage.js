/**
 * Storage helper — fetch remote files and upload local files to
 * project-scoped persistent storage. Returns a URL: permanent and public, or —
 * with { private: true } — one that opens only for people who can read the
 * row it is saved in (the server swaps in a working link on every read;
 * src/lib/files/private-files.ts).
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence,
 * .status, .code — PAYLOAD_TOO_LARGE (also a file over the per-file cap,
 * refused on the device before it is sent), QUOTA_EXCEEDED (storage ceiling),
 * DAILY_LIMIT, RATE_LIMITED, HOST_NOT_APPROVED / SECRET_MISSING (fromUrl with
 * headers), UPSTREAM_FAILED / RESPONSE_TOO_LARGE (the remote file), BAD_REQUEST …;
 * TIMEOUT / NETWORK carry no status (the server never answered).
 */

import { getAuthHeaders, getHeaders } from './_headers'
import { absorbSessionRenewal } from './_session-expiry'
import { showWriteLimitNotice } from './_write-notice'

// The account's per-file upload cap in MB, stamped at publish (default 25).
function uploadMaxMb() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  const n = Number(env.VITE_WHACKA_UPLOAD_MAX_MB)
  return Number.isFinite(n) && n > 0 ? n : 25
}
import { showIntegrationNotice } from './_integration-notice'
import { sdkFetch } from './_fetch'
import { withVisitorCheck } from './_visitor-check'
import { throwFromResponse } from './_errors'
import { overUploadCap } from './_too-large'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// A 25MB upload on a slow uplink, or a slow remote host behind from-url. An
// account with a raised per-file cap gets the same time per megabyte.
const UPLOAD_TIMEOUT_MS = 120_000
const uploadTimeoutMs = () => Math.round(UPLOAD_TIMEOUT_MS * Math.max(1, uploadMaxMb() / 25))

export const storage = {
  /**
   * Fetch a file from a remote URL and save it to project storage.
   * This uses a server-side proxy to avoid CORS restrictions.
   *
   * @param {string|{action: string, params?: object}} source - The remote URL
   *   to fetch, or — for an authenticated download — an action from
   *   src/actions.json ({ action: 'name', params }): a GET template whose
   *   headers carry the owner's {{secrets.NAME}}, filled server-side so the
   *   key never reaches the browser. The target host must be on the app's
   *   approved-hosts list (the same approval http.fetch uses).
   * @param {object} [options]
   * @param {string} [options.filename] - Custom filename (e.g. "hero.jpg"). Auto-generated if omitted.
   * @param {object} [options.headers] - Extra request headers (no {{secrets.*}}
   *   here — a stored key goes through an action).
   * @param {boolean} [options.private] - Store it as a private file.
   * @returns {Promise<{ url: string }>} URL of the stored file
   */
  async fromUrl(source, options = {}) {
    const spec = source && typeof source === 'object' ? source : null
    const url = spec ? '' : String(source || '')
    console.log('[storage] fromUrl:', spec ? `action ${spec.action}` : url.substring(0, 80))

    const body = spec ? { action: spec.action, params: spec.params || {} } : { url }
    if (options.filename) body.filename = options.filename
    if (options.private) body.private = true
    if (!spec && options.headers && typeof options.headers === 'object') body.headers = options.headers

    const res = await withVisitorCheck((extra) => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/storage/from-url`, {
      method: 'POST',
      headers: { ...getHeaders(), ...extra },
      body: JSON.stringify(body),
    }, { timeoutMs: uploadTimeoutMs(), route: 'storage/from-url' }))
    absorbSessionRenewal(res)

    if (!res.ok) {
      try {
        await throwFromResponse(res, 'Failed to fetch and store URL', 'storage/from-url')
      } catch (e) {
        // Usage-limit refusal: surface it in the shell's own voice — apps rarely
        // render upload errors (a store app, 2026-07-28). Capacity ceiling
        // (QUOTA_EXCEEDED) gets the honest permanent-wall wording.
        if (e.status === 429) showWriteLimitNotice({ kind: (e.code === 'QUOTA_EXCEEDED') ? 'uploadFull' : 'upload' })
        // fromUrl with headers rides the SAME owner-approved-host allowlist as
        // http.fetch, so it hits the same approval walls — and this path used to
        // throw a generic message with no code, which apps render as a plain
        // failure (V12 2026-08-06). Same honest strip as the http client.
        else if (e.code === 'HOST_NOT_APPROVED') showIntegrationNotice({ kind: 'hostPending' })
        else if (e.code === 'SECRET_MISSING') showIntegrationNotice({ kind: 'secretMissing' })
        throw e
      }
    }

    const data = await res.json()
    console.log('[storage] fromUrl done:', data.url)
    return data
  },

  /**
   * Upload a local file (Blob, File, or canvas data) to project storage.
   *
   * @param {Blob|File} blob - The file data to upload
   * @param {string} [filename] - Filename with extension (e.g. "photo.png"). Defaults to "file.bin".
   * @param {object} [options]
   * @param {boolean} [options.private] - Store it as a private file.
   * @returns {Promise<{ url: string }>} URL of the stored file
   */
  async upload(blob, filename = 'file.bin', options = {}) {
    // upload(blob, { private: true }) — the options where the name goes.
    if (filename && typeof filename === 'object') {
      options = filename
      filename = (blob && blob.name) || 'file.bin'
    }
    console.log('[storage] upload:', filename, `(${blob.size} bytes)`)

    // The account's per-file cap, stamped into the bundle at publish
    // (VITE_WHACKA_UPLOAD_MAX_MB, default 25 — a raised cap lands at the next
    // publish): refused here, before the upload, as PAYLOAD_TOO_LARGE / 413 —
    // reported as the size limit and told to the visitor (_too-large.js).
    const maxMb = uploadMaxMb()
    if (blob.size > maxMb * 1024 * 1024) throw overUploadCap('storage/upload', blob.size, maxMb)

    const formData = new FormData()
    formData.append('file', blob, filename)
    if (options && options.private) formData.append('private', 'true')

    const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/storage/upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    }, { timeoutMs: uploadTimeoutMs(), route: 'storage/upload' })
    absorbSessionRenewal(res)

    if (!res.ok) {
      try {
        await throwFromResponse(res, 'Upload failed', 'storage/upload')
      } catch (e) {
        // Usage-limit refusal: surface it in the shell's own voice — apps rarely
        // render upload errors (a store app, 2026-07-28). Capacity ceiling
        // (QUOTA_EXCEEDED) gets the honest permanent-wall wording.
        if (e.status === 429) showWriteLimitNotice({ kind: (e.code === 'QUOTA_EXCEEDED') ? 'uploadFull' : 'upload' })
        throw e
      }
    }

    const data = await res.json()
    console.log('[storage] upload done:', data.url)
    return data
  },
}
