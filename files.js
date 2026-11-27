/**
 * Files helper — list the current user's stored files and total storage used.
 * Read-only. Pairs with download (to save a listed file) and storage (to add
 * files). Listing is scoped to the signed-in user.
 *
 *   import { files } from '../lib/files'
 *   import { download } from '../lib/download'
 *
 *   const { files: list, totalBytes } = await files.list()
 *   await download.saveFile(list[0], list[0].filename)   // each item is a ref
 *
 * Failures throw the SDK's standard Error (.message, .status, .code — e.g.
 * AUTH_REQUIRED, RATE_LIMITED; TIMEOUT / NETWORK without a status).
 */

import { getHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

async function getFiles(query, fallback) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/files${query}`, {
    headers: getHeaders(),
  }, { route: 'files' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, 'files')
  return res.json()
}

export const files = {
  /**
   * List the current user's files for this app.
   *
   * @param {object} [options]
   * @param {string} [options.mimePrefix] - filter by MIME, e.g. "image/" or "application/pdf"
   * @returns {Promise<{ files: Array<{id, filename, contentType, sizeBytes, bucket, path, createdAt}>, totalBytes: number, count: number }>}
   *   Each file is a ref you can pass straight to download.saveFile(file, file.filename).
   */
  async list(options = {}) {
    const qs = new URLSearchParams()
    if (options.mimePrefix) qs.set('mimePrefix', options.mimePrefix)
    return getFiles(qs.toString() ? `?${qs}` : '', 'Could not list files')
  },

  /**
   * Total storage used by the current user in this app.
   *
   * @returns {Promise<{ bytes: number, count: number }>}
   */
  async totalSize() {
    const { totalBytes, count } = await getFiles('?summary=1', 'Could not get storage usage')
    return { bytes: totalBytes, count }
  },
}
